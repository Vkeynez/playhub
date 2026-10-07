// RemoteRoom: the server-authoritative RoomTransport (ARCHITECTURE §4.4, §6.2, §6.3, §6.6).
//
// Connection: hello gate → clock sync (median of 5 clock:ping) → room:join → room:state stream.
// Every payload in and out is checked with the @gp/protocol schemas. Reconnects are ours, not
// Socket.IO's: after `server:moving`, a server-side disconnect, or a dropped transport (Render cuts
// sockets on deploy without sending `server:moving`, ARCHITECTURE D-045), it reconnects after a
// random 0.5–3 s and rejoins with `lastStateVersion`. Actions carry a clientActionId (idempotent
// on the server) and the baseVersion they were decided on; an action queued while offline is
// dropped when the rejoin snapshot shows the game moved on.
import type { GameEvent, MatchResult, Seat } from '@gp/game-sdk/core';
import type { EngineMeta } from '@gp/game-sdk/engine';
import { parseClientAck, parseServerEvent } from '@gp/protocol';
import type {
  AckedClientEventName,
  ClientEventAck,
  ClientEventInput,
  Hello,
  LobbyAck,
  RoomJoinError,
  RoomRole,
  RoomSnapshot,
} from '@gp/protocol';

import { realTimers } from './clock';
import type { TimerApi } from './clock';
import type { RoomState, RoomTransport, SubmitResult } from './types';

export type SocketHandler = (payload: unknown) => void;

/** The slice of a socket.io-client Socket that RemoteRoom uses (a fake one in tests). */
export interface SocketLike {
  readonly connected: boolean;
  connect(): void;
  disconnect(): void;
  on(event: string, fn: SocketHandler): void;
  off(event: string, fn: SocketHandler): void;
  emit(event: string, payload: unknown, ack?: (response: unknown) => void): void;
}

export type RoomStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  /** hello said CLIENT_TOO_OLD (terminal) or SERVER_TOO_OLD (retries by itself). */
  | 'blocked'
  /** room:join failed for good, the room closed, or we were kicked. */
  | 'failed'
  | 'left';

export type RoomFailure = RoomJoinError | 'CLIENT_TOO_OLD' | 'SERVER_TOO_OLD' | 'ROOM_CLOSED';

export interface RemoteRoomInfo {
  status: RoomStatus;
  failure: RoomFailure | null;
  role: RoomRole | null;
  snapshot: RoomSnapshot | null;
}

export interface RemoteRoomOptions {
  socket: SocketLike;
  roomId: string;
  asSpectator?: boolean;
  hello(): Hello;
  /** Called once per `connect_error` that looks like an expired token, before reconnecting. */
  refreshAuth?(): Promise<void>;
  /** Waits for a cold server (GET /health) after repeated connect failures. */
  waitForServer?(): Promise<void>;
  newActionId(): string;
  timers?: TimerApi;
  /** Monotonic ms (performance.now). */
  now?(): number;
  /** Wall-clock ms, used until clock sync finishes. */
  wallNow?(): number;
  /** [0, 1). */
  random?(): number;
  ackTimeoutMs?: number;
}

const EPOCH = 2 ** 32;
const CLOCK_PINGS = 5;
const SERVER_TOO_OLD_RETRY_MS = 20_000;
const AUTH_ERRORS = new Set(['AUTH_EXPIRED', 'UNAUTHORIZED', 'INVALID_TOKEN']);

interface Intent {
  clientActionId: string;
  baseVersion: number;
  action: unknown;
  /** Bumped on every send, so an ack from an earlier socket session is ignored. */
  attempt: number;
  sent: boolean;
  resolve(result: SubmitResult): void;
}

class Disconnected extends Error {}

function isGameEvent(value: unknown): value is GameEvent {
  return (
    typeof value === 'object' && value !== null && typeof (value as GameEvent).type === 'string'
  );
}

/** Fallback when a snapshot has no `meta` (a lobby, or a server older than CHANGES-P0). */
function metaFromDeadlines(snapshot: RoomSnapshot, result: MatchResult | null): EngineMeta {
  const turn = snapshot.deadlines.find((d) => d.kind === 'turn');
  return {
    version: snapshot.version,
    awaiting: { seats: turn ? [...turn.seats] : [], deadlineAt: turn?.at ?? null },
    paused: false,
    finished: snapshot.phase === 'FINISHED' || snapshot.phase === 'CLOSED' || result !== null,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export class RemoteRoom implements RoomTransport<unknown, unknown, GameEvent> {
  private readonly socket: SocketLike;
  private readonly timers: TimerApi;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly ackTimeoutMs: number;
  private offset: number;
  private info: RemoteRoomInfo = {
    status: 'connecting',
    failure: null,
    role: null,
    snapshot: null,
  };
  private state: RoomState<unknown, GameEvent>;
  private readonly stateListeners = new Set<(s: RoomState<unknown, GameEvent>) => void>();
  private readonly infoListeners = new Set<(info: RemoteRoomInfo) => void>();
  private readonly pendingRequests = new Set<(e: Error) => void>();
  private intents: Intent[] = [];
  /** Bumped per connection, so a handshake that outlives its socket session stops. */
  private session = 0;
  private reconnectTimer: unknown = null;
  private failures = 0;
  private authRetried = false;
  private ownDisconnect = false;
  private started = false;
  private readonly handlers: Record<string, SocketHandler>;

  constructor(private readonly opts: RemoteRoomOptions) {
    this.socket = opts.socket;
    this.timers = opts.timers ?? realTimers;
    this.clock = opts.now ?? (() => performance.now());
    this.random = opts.random ?? Math.random;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 10_000;
    this.offset = (opts.wallNow ?? Date.now)() - this.clock();
    this.state = {
      version: 0,
      view: null,
      events: [],
      meta: {
        version: 0,
        awaiting: { seats: [], deadlineAt: null },
        paused: false,
        finished: false,
      },
      result: null,
    };
    this.handlers = {
      connect: () => void this.onConnect(),
      disconnect: (reason) => this.onDisconnect(String(reason)),
      connect_error: (err) => void this.onConnectError(err),
      'room:state': (payload) => this.onRoomState(payload),
      'room:closed': (payload) => this.onClosed(payload),
      'room:kicked': (payload) => this.onKicked(payload),
      'server:moving': () => this.onMoving(),
      error: (payload) => console.warn('server error event', payload),
    };
  }

  // ---- RoomTransport ------------------------------------------------------------------------

  get seat(): Seat | null {
    return this.info.snapshot?.yourSeat ?? null;
  }

  get roomId(): string {
    return this.info.snapshot?.roomId ?? this.opts.roomId;
  }

  subscribe(fn: (state: RoomState<unknown, GameEvent>) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  getState(): RoomState<unknown, GameEvent> {
    return this.state;
  }

  /** Estimated server wall time, the unit of every deadline in a snapshot. */
  serverNow(): number {
    return this.clock() + this.offset;
  }

  submit(action: unknown): Promise<SubmitResult> {
    const { status } = this.info;
    if (status === 'failed' || status === 'left' || status === 'blocked') {
      return Promise.resolve({ ok: false, reason: 'NOT_IN_ROOM' });
    }
    if (this.info.snapshot && this.info.snapshot.yourSeat === null) {
      return Promise.resolve({ ok: false, reason: 'NOT_SEATED' });
    }
    return new Promise((resolve) => {
      const intent: Intent = {
        clientActionId: this.opts.newActionId(),
        baseVersion: this.state.version,
        action,
        attempt: 0,
        sent: false,
        resolve,
      };
      this.intents.push(intent);
      if (status === 'live' && this.socket.connected) this.send(intent);
    });
  }

  // ---- Room info & lobby commands -----------------------------------------------------------

  getInfo(): RemoteRoomInfo {
    return this.info;
  }

  subscribeInfo(fn: (info: RemoteRoomInfo) => void): () => void {
    this.infoListeners.add(fn);
    return () => this.infoListeners.delete(fn);
  }

  /** Measured clock offset (server wall time − local monotonic), for diagnostics. */
  get clockOffset(): number {
    return this.offset;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const [event, fn] of Object.entries(this.handlers)) this.socket.on(event, fn);
    this.socket.connect();
  }

  setReady(ready: boolean, loaded: boolean): Promise<LobbyAck> {
    return this.command('room:ready', { roomId: this.roomId, ready, loaded });
  }

  startMatch(): Promise<LobbyAck> {
    return this.command('room:start', { roomId: this.roomId });
  }

  rematch(accept: boolean): Promise<LobbyAck> {
    return this.command('room:rematch', { roomId: this.roomId, accept });
  }

  async leave(): Promise<void> {
    if (this.info.status === 'live') {
      await this.command('room:leave', { roomId: this.roomId }).catch(() => undefined);
    }
    this.setInfo({ status: 'left' });
    this.dispose();
  }

  /** App foregrounded/backgrounded (§6.6): presence while live; rejoin at once on return. */
  setActive(active: boolean): void {
    if (this.info.status === 'live' && this.socket.connected) {
      this.socket.emit('presence', { roomId: this.roomId, state: active ? 'active' : 'away' });
    } else if (active && this.info.status === 'reconnecting') {
      this.scheduleReconnect(0);
    }
  }

  dispose(): void {
    this.clearReconnect();
    for (const [event, fn] of Object.entries(this.handlers)) this.socket.off(event, fn);
    this.dropIntents('NOT_IN_ROOM');
    this.rejectRequests();
    this.ownDisconnect = true;
    this.socket.disconnect();
    this.stateListeners.clear();
    this.infoListeners.clear();
  }

  // ---- Connection ---------------------------------------------------------------------------

  private async onConnect(): Promise<void> {
    const session = ++this.session;
    this.ownDisconnect = false;
    try {
      const hello = await this.request('hello', this.opts.hello());
      if (session !== this.session) return;
      if (!hello.ok) {
        this.setInfo({ status: 'blocked', failure: hello.reason });
        this.disconnectOwn();
        if (hello.reason === 'SERVER_TOO_OLD') this.scheduleReconnect(SERVER_TOO_OLD_RETRY_MS);
        return;
      }
      await this.syncClock(session);
      if (session !== this.session) return;
      const last = this.info.snapshot?.version;
      const join = await this.request('room:join', {
        roomId: this.roomId,
        ...(last !== undefined ? { lastStateVersion: last } : {}),
        ...(this.opts.asSpectator ? { asSpectator: true } : {}),
      });
      if (session !== this.session) return;
      if (!join.ok) {
        if (join.error === 'MOVING' || join.error === 'SERVER_BUSY') {
          this.disconnectOwn();
          this.setInfo({ status: 'reconnecting' });
          this.scheduleReconnect(this.backoff());
        } else {
          this.fail(join.error);
        }
        return;
      }
      this.failures = 0;
      this.authRetried = false;
      this.setInfo({ status: 'live', failure: null, role: join.role });
      this.applySnapshot(join.snapshot, true);
      this.flushIntents();
    } catch (e) {
      if (session !== this.session || e instanceof Disconnected) return;
      // A handshake ack timed out: start over on a fresh connection.
      this.disconnectOwn();
      this.setInfo({ status: 'reconnecting' });
      this.scheduleReconnect(this.backoff());
    }
  }

  private async syncClock(session: number): Promise<void> {
    const offsets: number[] = [];
    for (let i = 0; i < CLOCK_PINGS && session === this.session; i++) {
      const t0 = this.clock();
      try {
        const pong = await this.request('clock:ping', { t0 });
        const t1 = this.clock();
        if (pong.t0 === t0) offsets.push(pong.ts - (t0 + t1) / 2);
      } catch (e) {
        if (e instanceof Disconnected) throw e;
      }
    }
    if (offsets.length > 0) this.offset = median(offsets);
  }

  private onDisconnect(reason: string): void {
    this.session += 1;
    this.rejectRequests();
    for (const intent of this.intents) intent.sent = false;
    if (this.ownDisconnect || reason === 'io client disconnect') return;
    if (this.info.status === 'failed' || this.info.status === 'left') return;
    this.setInfo({ status: 'reconnecting' });
    this.scheduleReconnect(this.backoff());
  }

  private async onConnectError(err: unknown): Promise<void> {
    if (this.info.status === 'failed' || this.info.status === 'left') return;
    this.setInfo({ status: this.info.snapshot ? 'reconnecting' : 'connecting' });
    const message = err instanceof Error ? err.message : String(err);
    if (AUTH_ERRORS.has(message) && !this.authRetried && this.opts.refreshAuth) {
      this.authRetried = true;
      await this.opts.refreshAuth().catch(() => undefined);
      this.scheduleReconnect(0);
      return;
    }
    this.failures += 1;
    if (this.failures >= 2 && this.opts.waitForServer) {
      await this.opts.waitForServer().catch(() => undefined);
    }
    this.scheduleReconnect(this.backoff());
  }

  private onMoving(): void {
    this.disconnectOwn();
    this.setInfo({ status: 'reconnecting' });
    this.scheduleReconnect(500 + this.random() * 2_500);
  }

  private onClosed(payload: unknown): void {
    const parsed = parseServerEvent('room:closed', payload);
    if (!parsed.ok || parsed.data.roomId !== this.roomId) return;
    this.fail('ROOM_CLOSED');
  }

  private onKicked(payload: unknown): void {
    const parsed = parseServerEvent('room:kicked', payload);
    if (!parsed.ok || parsed.data.roomId !== this.roomId) return;
    this.fail('KICKED');
  }

  private fail(failure: RoomFailure): void {
    this.clearReconnect();
    this.setInfo({ status: 'failed', failure });
    this.dropIntents('NOT_IN_ROOM');
    this.disconnectOwn();
  }

  /** First retry after 0.5–3 s (§4.4); later ones back off to ~10 s. */
  private backoff(): number {
    const cap = Math.min(10_000, 3_000 * 2 ** Math.max(0, this.failures - 1));
    return 500 + this.random() * (cap - 500);
  }

  private scheduleReconnect(delayMs: number): void {
    this.clearReconnect();
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.info.status === 'failed' || this.info.status === 'left') return;
      if (this.socket.connected) this.disconnectOwn();
      this.ownDisconnect = false;
      this.socket.connect();
    }, delayMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private disconnectOwn(): void {
    this.ownDisconnect = true;
    this.session += 1;
    if (this.socket.connected) this.socket.disconnect();
  }

  // ---- Requests -----------------------------------------------------------------------------

  private request<E extends AckedClientEventName>(
    event: E,
    payload: ClientEventInput<E>,
  ): Promise<ClientEventAck<E>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        this.pendingRequests.delete(onDisconnect);
        fn();
      };
      const onDisconnect = (e: Error) => settle(() => reject(e));
      const timer = this.timers.setTimeout(
        () => settle(() => reject(new Error(`${event} timed out`))),
        this.ackTimeoutMs,
      );
      this.pendingRequests.add(onDisconnect);
      this.socket.emit(event, payload, (response) => {
        const parsed = parseClientAck(event, response);
        settle(() =>
          parsed.ok ? resolve(parsed.data) : reject(new Error(`invalid ${event} ack`)),
        );
      });
    });
  }

  private rejectRequests(): void {
    const pending = [...this.pendingRequests];
    this.pendingRequests.clear();
    for (const reject of pending) reject(new Disconnected('disconnected'));
  }

  private async command<E extends 'room:ready' | 'room:start' | 'room:rematch' | 'room:leave'>(
    event: E,
    payload: ClientEventInput<E>,
  ): Promise<LobbyAck> {
    if (this.info.status !== 'live') return { ok: false, reason: 'NOT_IN_ROOM' };
    try {
      return await this.request(event, payload);
    } catch {
      return { ok: false, reason: 'NOT_IN_ROOM' };
    }
  }

  // ---- Actions ------------------------------------------------------------------------------

  private send(intent: Intent): void {
    intent.sent = true;
    intent.attempt += 1;
    const attempt = intent.attempt;
    const timer = this.timers.setTimeout(() => {
      if (intent.attempt === attempt && intent.sent)
        this.finish(intent, { ok: false, reason: 'TIMEOUT' });
    }, this.ackTimeoutMs);
    this.socket.emit(
      'game:action',
      {
        roomId: this.roomId,
        clientActionId: intent.clientActionId,
        baseVersion: intent.baseVersion,
        action: intent.action,
      },
      (response) => {
        this.timers.clearTimeout(timer);
        if (intent.attempt !== attempt || !this.intents.includes(intent)) return;
        const parsed = parseClientAck('game:action', response);
        this.finish(
          intent,
          parsed.ok
            ? parsed.data.ok
              ? { ok: true, version: parsed.data.version }
              : { ok: false, reason: parsed.data.reason }
            : { ok: false, reason: 'INVALID_ACK' },
        );
      },
    );
  }

  private finish(intent: Intent, result: SubmitResult): void {
    this.intents = this.intents.filter((i) => i !== intent);
    intent.resolve(result);
  }

  /**
   * After a (re)join: resend what was in flight (the server dedupes by clientActionId and rejects
   * STALE ones itself) and what was queued for this exact version; drop the rest.
   */
  private flushIntents(): void {
    const version = this.state.version;
    for (const intent of [...this.intents]) {
      if (intent.attempt > 0 || intent.baseVersion === version) this.send(intent);
      else this.finish(intent, { ok: false, reason: 'STALE' });
    }
  }

  private dropIntents(reason: string): void {
    const intents = this.intents;
    this.intents = [];
    for (const intent of intents) intent.resolve({ ok: false, reason });
  }

  // ---- State --------------------------------------------------------------------------------

  private onRoomState(payload: unknown): void {
    const parsed = parseServerEvent('room:state', payload);
    if (!parsed.ok) {
      console.warn('invalid room:state', parsed.error.issues[0]);
      return;
    }
    this.applySnapshot(parsed.data, false);
  }

  /**
   * The room version only grows (epoch × 2³² + n, CHANGES-P0), so an older snapshot is stale; the
   * same version again (re-sent state) is applied without replaying its events. A rejoin snapshot
   * (`resync`) is authoritative and always applied.
   */
  private applySnapshot(snapshot: RoomSnapshot, resync: boolean): void {
    if (snapshot.roomId !== this.roomId) return;
    const previous = this.info.snapshot;
    if (!resync && previous && snapshot.version < previous.version) return;
    const repeat = previous !== null && snapshot.version === previous.version;

    // A jump to another epoch (the server restored the room) invalidates everything in flight.
    if (previous && Math.floor(previous.version / EPOCH) !== Math.floor(snapshot.version / EPOCH)) {
      this.dropIntents('STALE');
    }

    const result: MatchResult | null = snapshot.result
      ? { placements: snapshot.result.placements }
      : null;
    this.state = {
      version: snapshot.version,
      view: snapshot.view,
      events: repeat ? [] : snapshot.events.filter(isGameEvent),
      meta: snapshot.meta ?? metaFromDeadlines(snapshot, result),
      result,
    };
    this.setInfo({ snapshot });
    for (const fn of this.stateListeners) fn(this.state);
  }

  private setInfo(patch: Partial<RemoteRoomInfo>): void {
    this.info = { ...this.info, ...patch };
    for (const fn of this.infoListeners) fn(this.info);
  }
}
