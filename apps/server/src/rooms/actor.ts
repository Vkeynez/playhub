// RoomActor (ARCHITECTURE §4.1, §4.2): one room's serialized queue, lobby and seat rules, the match
// engine, persistence at transitions and per-viewer publishing.
//
// - Every input (socket commands, engine timers, debounced writes) runs through `run()`, one at a
//   time, so there is no await between "seat free?" and "assign" (the last-seat race).
// - Hidden information leaves only through `engine.outputFor(viewer)` (viewFor / eventFor).
// - Decision boundaries are written before they are published (capped at 2 s); intra-turn entries
//   are written behind (≤ 250 ms). Idle closes, abandon and grace are decided in memory: no timer
//   in this file writes to Postgres except the debounced lobby write and the write-behind, which
//   only ever follow a state transition.

import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { VERSION_EPOCH_FACTOR } from '@gp/game-sdk/engine';
import {
  isDraw,
  type MatchResult,
  type Seat,
  type SeatInfo,
  type Seed128,
  type Viewer,
} from '@gp/game-sdk/core';
import {
  MatchPlacementsSchema,
  ReasonCodeSchema,
  type ConnectionState,
  type Deadline,
  type GameActionAck,
  type LobbyAck,
  type MatchMeta,
  type MatchPlacements,
  type Platform,
  type ReactionEmoji,
  type ResolveRoomResponse,
  type RoomJoinAck,
  type RoomPhase,
  type RoomSnapshot,
  type SeatState,
} from '@gp/protocol';
import type { Profile } from '../profiles';
import type { RoomSocket } from '../socket-types';
import { Slot, type Timers } from '../timers';
import {
  NO_EVENTS,
  type EventBatch,
  type GameEntry,
  type LiveMatch,
  type MatchDeps,
  type StepInfo,
} from './registry';
import {
  EXPIRY_SEC,
  FencedError,
  toLogRow,
  type LogRow,
  type ParticipantRow,
  type RoomStore,
  type StoredMatch,
} from './store';

export const LOBBY_IDLE_MS = 30 * 60_000;
export const HOST_ONLY_MS = 10 * 60_000;
export const FINISHED_CLOSE_MS = 10 * 60_000;
export const ABANDON_MS = 5 * 60_000;
export const GRACE_MS = 60_000;
export const HOST_AWAY_MS = 5 * 60_000;
export const LOBBY_WRITE_DEBOUNCE_MS = 2_000;
export const WRITE_BEHIND_MS = 250;
export const PUBLISH_AFTER_MS = 2_000;
export const MAX_SPECTATORS = 20;
export const SPECTATOR_INTERVAL_MS = 1_000;
const SNAPSHOT_EVERY = 50;
const VERSION_MAP_CAP = 1_024;
const WRITE_ATTEMPTS = 3;
const MAX_EVENTS = 256;
const MAX_SPECTATOR_BATCHES = 64;

export type CloseReason = 'IDLE' | 'FINISHED' | 'REPLACED' | 'ABANDONED' | 'SERVER';
type LobbyRejection = Extract<LobbyAck, { ok: false }>['reason'];

interface Conn {
  socket: RoomSocket;
  userId: string;
  seat: Seat | null;
  away: boolean;
}

interface SeatSlot {
  seat: Seat;
  team: number | null;
  userId: string | null;
  name: string;
  avatarSeed: string;
  platform: Platform;
  ready: boolean;
  loaded: boolean;
  sockets: Set<string>;
  /** Restored after a restart and not seen since: no grace countdown yet (§5.6). */
  reconnecting: boolean;
  disconnectedAt: number | null;
  graceUntil: number | null;
  grace: Slot;
}

interface ActiveMatch {
  id: string;
  engine: LiveMatch | null;
  pending: StepInfo[];
  unsaved: LogRow[];
  sinceSnapshot: number;
  /** [room version, engine version] at each publish, to map a client's baseVersion (STALE). */
  versions: [number, number][];
  result: MatchPlacements | null;
}

export interface ActorDeps {
  store: RoomStore;
  timers: Timers;
  epoch: number;
  log: FastifyBaseLogger;
  /** The actor is gone from memory; `closed` = closed for good (not fenced out). */
  onGone(roomId: string, code: string, closed: boolean): void;
}

export interface RoomInit {
  id: string;
  code: string;
  game: GameEntry;
  mode: string;
  seatCount: number;
  /** Parsed with the game's configSchema. */
  options: unknown;
  hostUserId: string;
  status: RoomPhase;
  kicked: string[];
  seats: { seat: Seat; team: number | null; userId: string | null; profile: Profile | null }[];
}

export interface JoinRequest {
  socket: RoomSocket;
  userId: string;
  profile: Profile;
  platform: Platform;
  asSpectator: boolean;
}

const lobbyFail = (reason: LobbyRejection): LobbyAck => ({ ok: false, reason });
const OK: LobbyAck = { ok: true };

function seedFromBytes(bytes: Buffer): Seed128 {
  const words: [number, number, number, number] = [
    bytes.readUInt32BE(0),
    bytes.readUInt32BE(4),
    bytes.readUInt32BE(8),
    bytes.readUInt32BE(12),
  ];
  // An all-zero xoshiro state is invalid; 2⁻¹²⁸ odds, but cheap to rule out.
  if (words.every((word) => word === 0)) words[0] = 1;
  return words;
}

function retryDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export class RoomActor {
  readonly id: string;
  readonly code: string;
  readonly game: GameEntry;
  readonly mode: string;
  readonly seatCount: number;
  private options: unknown;
  private hostUserId: string;
  private status: RoomPhase;
  private readonly kicked: Set<string>;
  private readonly kickedSpectators = new Set<string>();
  private readonly seats: SeatSlot[];
  private readonly conns = new Map<string, Conn>();
  private match: ActiveMatch | null = null;
  private rematch: Set<Seat> | null = null;
  private version: number;
  private closed = false;
  private fenced = false;

  private chain: Promise<unknown> = Promise.resolve();
  private persistChain: Promise<unknown> = Promise.resolve();

  private lastActivity: number;
  private onlyHostSince: number | null = null;
  private finishedCloseAt: number | null = null;
  private lobbyDirty = false;
  private lastLobbyWriteAt = 0;
  private spectatorBatches: EventBatch[] = [];
  private lastSpectatorAt = Number.NEGATIVE_INFINITY;

  private readonly lobbyClose: Slot;
  private readonly finishedClose: Slot;
  private readonly abandonSlot: Slot;
  private readonly hostAway: Slot;
  private readonly lobbyWrite: Slot;
  private readonly writeBehind: Slot;
  private readonly spectatorSlot: Slot;

  constructor(
    init: RoomInit,
    private readonly deps: ActorDeps,
  ) {
    const timers = deps.timers;
    this.id = init.id;
    this.code = init.code;
    this.game = init.game;
    this.mode = init.mode;
    this.seatCount = init.seatCount;
    this.options = init.options;
    this.hostUserId = init.hostUserId;
    this.status = init.status;
    this.kicked = new Set(init.kicked);
    this.version = deps.epoch * VERSION_EPOCH_FACTOR;
    this.lastActivity = timers.now();
    this.lobbyClose = new Slot(timers);
    this.finishedClose = new Slot(timers);
    this.abandonSlot = new Slot(timers);
    this.hostAway = new Slot(timers);
    this.lobbyWrite = new Slot(timers);
    this.writeBehind = new Slot(timers);
    this.spectatorSlot = new Slot(timers);
    this.seats = [];
    for (let seat = 0; seat < init.seatCount; seat++) {
      const stored = init.seats.find((s) => s.seat === seat);
      const userId = stored?.userId ?? null;
      this.seats.push({
        seat,
        team: stored?.team ?? null,
        userId,
        name: stored?.profile?.name ?? '',
        avatarSeed: stored?.profile?.avatarSeed ?? '',
        platform: 'web',
        ready: false,
        loaded: false,
        sockets: new Set(),
        reconnecting: userId !== null && init.status === 'IN_PROGRESS',
        disconnectedAt: userId === null ? null : timers.now(),
        graceUntil: null,
        grace: new Slot(timers),
      });
    }
    this.armLobbyClose();
  }

  // ---------------------------------------------------------------- queue

  /** Runs `task` after every earlier input of this room has finished. */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get phase(): RoomPhase {
    return this.status;
  }

  // ---------------------------------------------------------------- restore

  /** Rebuilds the latest match from its snapshot and logged tail (§5.2 restore). In the queue. */
  async restoreMatch(stored: StoredMatch): Promise<void> {
    const match = this.newMatch(stored.id);
    if (stored.ended) {
      const parsed = MatchPlacementsSchema.safeParse(stored.result);
      match.result = parsed.success ? parsed.data : { placements: [], abandoned: true };
    }
    this.match = match;
    try {
      match.engine = this.game.restore(stored.snapshot, stored.tail, {
        ...this.matchDeps(match),
        connectedSeats: [],
      });
    } catch (error) {
      this.deps.log.warn({ err: error, roomId: this.id }, 'match restore failed');
      match.engine = null;
      match.pending = [];
      if (!stored.ended) {
        // A rules change with a non-empty tail (§5.2): abandoned (server update), no W/L.
        match.result = { placements: [], abandoned: true };
        await this.awaitWrite(
          this.persist('abandon', () =>
            this.deps.store.endMatch(
              this.id,
              match.id,
              [],
              { value: stored.snapshot, version: 0 },
              match.result,
              this.participants(null),
            ),
          ),
        );
        this.status = 'FINISHED';
      }
    }
    if (this.status === 'FINISHED' || match.result) this.enterFinished();
    await this.settle(false);
  }

  // ---------------------------------------------------------------- lobby commands

  async join(request: JoinRequest): Promise<RoomJoinAck> {
    if (this.closed) return { ok: false, error: 'CLOSED' };
    // The socket may have dropped while the room was being activated.
    if (!request.socket.connected) return { ok: false, error: 'NOT_FOUND' };
    const socketId = request.socket.id;
    const existing = this.conns.get(socketId);
    if (existing) {
      return { ok: true, roomId: this.id, role: role(existing), snapshot: this.ackFor(existing) };
    }
    let slot = this.seats.find((s) => s.userId === request.userId) ?? null;
    if (!slot && !request.asSpectator) {
      if (this.kicked.has(request.userId)) return { ok: false, error: 'KICKED' };
      if (this.status !== 'LOBBY') return { ok: false, error: 'ROOM_FULL' };
      slot = this.seats.find((s) => s.userId === null) ?? null;
      if (!slot) return { ok: false, error: 'ROOM_FULL' };
      slot.userId = request.userId;
      slot.ready = false;
      slot.loaded = false;
      slot.reconnecting = false;
      this.scheduleLobbyWrite();
    }
    if (!slot) {
      if (this.kickedSpectators.has(request.userId)) return { ok: false, error: 'KICKED' };
      if (this.spectatorCount() >= MAX_SPECTATORS) return { ok: false, error: 'ROOM_FULL' };
    }

    const conn: Conn = { socket: request.socket, userId: request.userId, seat: null, away: false };
    this.conns.set(socketId, conn);
    request.socket.data.rooms.add(this.id);
    if (slot) {
      conn.seat = slot.seat;
      slot.name = request.profile.name;
      slot.avatarSeed = request.profile.avatarSeed;
      slot.platform = request.platform;
      const wasEmpty = slot.sockets.size === 0;
      slot.sockets.add(socketId);
      if (wasEmpty) this.seatConnected(slot);
    }
    this.touchLobby();
    await this.settle(true, socketId);
    return { ok: true, roomId: this.id, role: role(conn), snapshot: this.ackFor(conn) };
  }

  async ready(socketId: string, ready: boolean, loaded: boolean): Promise<LobbyAck> {
    const slot = this.seatOf(socketId);
    if (!slot) return lobbyFail(this.conns.has(socketId) ? 'NOT_SEATED' : 'NOT_IN_ROOM');
    if (this.status !== 'LOBBY') return lobbyFail('WRONG_PHASE');
    slot.ready = ready;
    slot.loaded = loaded;
    this.touchLobby();
    this.publish(NO_EVENTS);
    return OK;
  }

  async setOptions(
    socketId: string,
    change: { options: unknown; mode?: string | undefined; seatCount?: number | undefined },
  ): Promise<LobbyAck> {
    const rejected = this.hostCheck(socketId);
    if (rejected) return rejected;
    if (this.status !== 'LOBBY') return lobbyFail('WRONG_PHASE');
    if (change.mode !== undefined && change.mode !== this.mode) return lobbyFail('INVALID_OPTIONS');
    if (change.seatCount !== undefined && change.seatCount !== this.seatCount) {
      return lobbyFail('INVALID_OPTIONS');
    }
    const parsed = this.game.parseConfig(change.options);
    if (!parsed.ok) return lobbyFail('INVALID_OPTIONS');
    this.options = parsed.config;
    this.touchLobby();
    this.scheduleLobbyWrite();
    this.publish(NO_EVENTS);
    return OK;
  }

  async kick(socketId: string, userId: string, fromSpectating: boolean): Promise<LobbyAck> {
    const rejected = this.hostCheck(socketId);
    if (rejected) return rejected;
    if (this.status !== 'LOBBY') return lobbyFail('WRONG_PHASE');
    if (userId === this.hostUserId) return lobbyFail('UNKNOWN_USER');
    const slot = this.seats.find((s) => s.userId === userId) ?? null;
    const conns = [...this.conns.values()].filter((c) => c.userId === userId);
    if (!slot && conns.length === 0) return lobbyFail('UNKNOWN_USER');
    this.kicked.add(userId);
    if (fromSpectating) this.kickedSpectators.add(userId);
    for (const conn of conns) {
      conn.socket.emit('room:kicked', { roomId: this.id, fromSpectating });
      this.detach(conn);
    }
    if (slot) this.freeSeat(slot);
    this.touchLobby();
    this.scheduleLobbyWrite();
    this.publish(NO_EVENTS);
    return OK;
  }

  async start(socketId: string): Promise<LobbyAck> {
    const rejected = this.hostCheck(socketId);
    if (rejected) return rejected;
    if (this.status !== 'LOBBY') return lobbyFail('WRONG_PHASE');
    if (!this.seats.every((s) => s.userId !== null && s.ready && s.loaded)) {
      return lobbyFail('NOT_ALL_READY');
    }
    await this.beginMatch();
    return OK;
  }

  async requestRematch(socketId: string, accept: boolean): Promise<LobbyAck> {
    const slot = this.seatOf(socketId);
    if (!slot) return lobbyFail(this.conns.has(socketId) ? 'NOT_SEATED' : 'NOT_IN_ROOM');
    if (this.status !== 'FINISHED' || !this.rematch) return lobbyFail('WRONG_PHASE');
    const first = this.rematch.size === 0 && accept;
    if (accept) this.rematch.add(slot.seat);
    else this.rematch.delete(slot.seat);
    const everyone = this.seats.every((s) => s.userId !== null && this.rematch?.has(s.seat));
    if (everyone) {
      await this.beginMatch();
      return OK;
    }
    if (first) {
      // The room closes 10 min after the last rematch prompt; the DB learns it via expires_at.
      this.armFinishedClose();
      void this.persist('rematch', () => this.deps.store.touch(this.id, EXPIRY_SEC.FINISHED));
    }
    this.publish(NO_EVENTS);
    return OK;
  }

  async leave(socketId: string): Promise<LobbyAck> {
    const conn = this.conns.get(socketId);
    if (!conn) return lobbyFail('NOT_IN_ROOM');
    if (conn.seat === null) {
      this.detach(conn);
      this.publish(NO_EVENTS);
      return OK;
    }
    const slot = this.seats[conn.seat];
    if (!slot) return lobbyFail('NOT_SEATED');
    const userId = conn.userId;
    for (const other of [...this.conns.values()]) {
      if (other.userId === userId) this.detach(other);
    }
    if (this.status === 'IN_PROGRESS') {
      // The seat stays theirs (they can reclaim it); turn timers auto-move it meanwhile.
      this.seatDisconnected(slot);
      if (userId === this.hostUserId) this.passHost(true);
      await this.settle(true);
      return OK;
    }
    this.freeSeat(slot);
    if (this.status === 'FINISHED') {
      // Someone left after the match: back to the lobby so the code can bring in someone else.
      this.status = 'LOBBY';
      this.rematch = null;
      this.finishedCloseAt = null;
      this.finishedClose.cancel();
    }
    if (userId === this.hostUserId) this.passHost(false);
    if (this.seats.every((s) => s.userId === null)) {
      await this.awaitWrite(this.writeLobbyNow('CLOSED'));
      this.close('IDLE');
      return OK;
    }
    this.touchLobby();
    this.scheduleLobbyWrite();
    this.publish(NO_EVENTS);
    return OK;
  }

  async presence(socketId: string, away: boolean): Promise<void> {
    const conn = this.conns.get(socketId);
    if (!conn || conn.away === away) return;
    conn.away = away;
    this.publish(NO_EVENTS);
  }

  async react(socketId: string, emoji: ReactionEmoji): Promise<void> {
    const conn = this.conns.get(socketId);
    if (!conn) return;
    const event = {
      roomId: this.id,
      userId: conn.userId,
      seat: conn.seat,
      emoji,
      at: Math.round(this.deps.timers.now()),
    };
    for (const other of this.conns.values()) other.socket.emit('reaction', event);
  }

  /** A socket disconnected. In the lobby the seat is held ("away"); in a match grace starts. */
  async socketGone(socketId: string): Promise<void> {
    const conn = this.conns.get(socketId);
    if (!conn) return;
    this.detach(conn);
    if (conn.seat !== null) {
      const slot = this.seats[conn.seat];
      if (slot && slot.sockets.size === 0) this.seatDisconnected(slot);
    }
    await this.settle(true);
  }

  // ---------------------------------------------------------------- game actions

  async action(
    socketId: string,
    payload: { clientActionId: string; baseVersion: number; action: unknown },
  ): Promise<GameActionAck> {
    const conn = this.conns.get(socketId);
    if (!conn) return { ok: false, reason: 'NOT_IN_ROOM' };
    if (conn.seat === null) return { ok: false, reason: 'NOT_SEATED' };
    const engine = this.match?.engine;
    if (this.status !== 'IN_PROGRESS' || !engine) return { ok: false, reason: 'NOT_IN_PROGRESS' };
    const result = engine.submit(conn.seat, payload.action, {
      baseVersion: this.toEngineVersion(payload.baseVersion),
      clientActionId: payload.clientActionId,
    });
    if (!result.ok) {
      const reason = ReasonCodeSchema.safeParse(result.reason);
      return { ok: false, reason: reason.success ? reason.data : 'ILLEGAL' };
    }
    if (!result.duplicate) await this.settle(true);
    return { ok: true, version: this.version };
  }

  // ---------------------------------------------------------------- reads

  summary(userId: string): ResolveRoomResponse {
    return {
      roomId: this.id,
      code: this.code,
      gameId: this.game.id,
      mode: this.mode,
      phase: this.closed ? 'CLOSED' : this.status,
      seatCount: this.seatCount,
      seatsTaken: this.seats.filter((s) => s.userId !== null).length,
      youAreSeated: this.seats.some((s) => s.userId === userId),
    };
  }

  /** Flushes unsaved log rows (+ snapshot) or lobby state, then releases ownership (SIGTERM). */
  async drain(): Promise<void> {
    await this.run(async () => {
      if (this.closed) return;
      const match = this.match;
      if (match?.engine && this.status === 'IN_PROGRESS') await this.flushLog(match, true);
      else if (this.lobbyDirty) await this.writeLobbyNow();
      const expiry = this.status === 'FINISHED' ? EXPIRY_SEC.FINISHED : EXPIRY_SEC.LOBBY;
      await this.persist('release', () => this.deps.store.touch(this.id, expiry, true));
    });
    await this.persistChain;
  }

  /** Waits for queued inputs and writes (tests and drain). */
  async idle(): Promise<void> {
    await this.chain;
    await this.persistChain;
  }

  /** Closes the room in memory and tells everyone; the DB learns it through `expires_at`. */
  close(reason: CloseReason): void {
    if (this.closed) return;
    for (const conn of this.conns.values()) {
      conn.socket.emit('room:closed', { roomId: this.id, reason });
      conn.socket.data.rooms.delete(this.id);
    }
    this.conns.clear();
    this.dispose();
    this.deps.onGone(this.id, this.code, true);
  }

  // ---------------------------------------------------------------- match lifecycle

  private newMatch(id: string): ActiveMatch {
    return {
      id,
      engine: null,
      pending: [],
      unsaved: [],
      sinceSnapshot: 0,
      versions: [],
      result: null,
    };
  }

  private matchDeps(match: ActiveMatch): MatchDeps {
    const timers = this.deps.timers;
    return {
      clock: () => timers.now(),
      scheduler: {
        schedule: (at, fire) => {
          const handle = timers.after(at - timers.now(), fire);
          return () => handle.cancel();
        },
      },
      enqueue: (task) =>
        void this.run(async () => {
          if (this.match !== match || this.closed) return;
          task();
          await this.settle(false);
        }),
      epoch: this.deps.epoch,
      onStep: (record) => {
        if (this.match === match) match.pending.push(record);
      },
      onError: (error) => this.deps.log.error({ err: error, roomId: this.id }, 'engine error'),
    };
  }

  private async beginMatch(): Promise<void> {
    const seats: SeatInfo[] = this.seats.map((s) => ({
      seat: s.seat,
      team: s.team,
      occupant: { kind: 'human', userId: s.userId ?? '' },
    }));
    const seedBytes = randomBytes(16);
    const initNow = this.deps.timers.now();
    this.match?.engine?.dispose();
    const match = this.newMatch(randomUUID());
    this.match = match;
    const engine = this.game.create(
      {
        config: this.options,
        mode: this.mode,
        seats,
        seed: seedFromBytes(seedBytes),
        initNow,
        connectedSeats: this.seats.filter((s) => s.sockets.size > 0).map((s) => s.seat),
      },
      this.matchDeps(match),
    );
    match.engine = engine;
    this.status = 'IN_PROGRESS';
    this.rematch = null;
    this.finishedCloseAt = null;
    this.finishedClose.cancel();
    this.lobbyClose.cancel();
    this.onlyHostSince = null;
    for (const slot of this.seats) {
      slot.ready = false;
      if (slot.sockets.size === 0) this.seatDisconnected(slot);
    }

    if (this.lobbyDirty) void this.writeLobbyNow('IN_PROGRESS');
    const start = this.persist('start', () =>
      this.deps.store.startMatch(this.id, {
        id: match.id,
        gameId: this.game.id,
        mode: this.mode,
        seedHex: seedBytes.toString('hex'),
        config: { options: this.options, initNow, seats },
        logicVersion: this.game.logicVersion,
        stateVersion: this.game.stateVersion,
        snapshot: engine.snapshot(),
        snapshotVersion: engine.version,
      }),
    );
    await this.awaitWrite(start);
    await this.settle(true);
  }

  private async finishMatch(match: ActiveMatch, result: MatchResult): Promise<void> {
    const engine = match.engine;
    if (!engine) return;
    match.result = { placements: result.placements.map((p) => ({ ...p })) };
    this.status = 'FINISHED';
    this.writeBehind.cancel();
    const log = match.unsaved.splice(0);
    const snapshot = { value: engine.snapshot(), version: engine.version };
    const placements = match.result;
    const participants = this.participants(result);
    await this.awaitWrite(
      this.persist('end', () =>
        this.deps.store.endMatch(this.id, match.id, log, snapshot, placements, participants),
      ),
    );
    this.enterFinished();
  }

  private participants(result: MatchResult | null): ParticipantRow[] {
    const draw = result !== null && isDraw(result);
    return this.seats.map((slot) => {
      const placement = result?.placements.find((p) => p.seat === slot.seat);
      const outcome: ParticipantRow['outcome'] =
        result === null ? 'abandoned' : draw ? 'draw' : placement?.place === 1 ? 'win' : 'loss';
      const score = placement?.score;
      return {
        seat: slot.seat,
        user_id: slot.userId,
        team: slot.team,
        outcome,
        score: typeof score === 'number' && Number.isInteger(score) ? score : null,
      };
    });
  }

  private enterFinished(): void {
    this.status = 'FINISHED';
    this.rematch = new Set();
    this.abandonSlot.cancel();
    this.lobbyClose.cancel();
    for (const slot of this.seats) {
      slot.ready = false;
      slot.graceUntil = null;
      slot.grace.cancel();
    }
    this.armFinishedClose();
  }

  private armFinishedClose(): void {
    this.finishedCloseAt = this.deps.timers.now() + FINISHED_CLOSE_MS;
    this.finishedClose.at(this.finishedCloseAt, () => void this.run(() => this.close('FINISHED')));
  }

  /** No human connected for 5 min: abandoned in memory, no W/L, nothing written (§5.2, OQ C5). */
  private abandon(): void {
    if (this.status !== 'IN_PROGRESS' || this.closed) return;
    const match = this.match;
    if (match) {
      match.result = { placements: [], abandoned: true };
      match.engine?.dispose();
    }
    this.close('ABANDONED');
  }

  // ---------------------------------------------------------------- settle: persist, then publish

  /**
   * After every input: log the engine's new entries, write decision boundaries before publishing
   * (≤ 2 s), write intra-turn entries behind, finish the match when it has a result, then publish.
   */
  private async settle(force: boolean, except?: string): Promise<void> {
    const match = this.match;
    let events = NO_EVENTS;
    let changed = force;
    if (match && match.pending.length > 0) {
      changed = true;
      const records = match.pending.splice(0);
      events = match.engine?.takeEvents() ?? NO_EVENTS;
      let boundary = false;
      for (const record of records) {
        match.unsaved.push(toLogRow(record.entry));
        if (record.decisionBoundary) boundary = true;
      }
      match.sinceSnapshot += records.length;
      const result = match.engine?.result ?? null;
      if (result && match.result === null) {
        await this.finishMatch(match, result);
      } else if (boundary || match.sinceSnapshot >= SNAPSHOT_EVERY) {
        await this.awaitWrite(this.flushLog(match, true));
      } else {
        this.writeBehind.at(
          this.deps.timers.now() + WRITE_BEHIND_MS,
          () => void this.run(() => void this.flushLog(match, false)),
        );
      }
    }
    if (changed) this.publish(events, except);
  }

  private flushLog(match: ActiveMatch, withSnapshot: boolean): Promise<boolean> {
    this.writeBehind.cancel();
    const log = match.unsaved.splice(0);
    const engine = match.engine;
    const snapshot =
      withSnapshot && engine ? { value: engine.snapshot(), version: engine.version } : null;
    if (snapshot) match.sinceSnapshot = 0;
    if (log.length === 0 && snapshot === null) return Promise.resolve(true);
    return this.persist('log', () => this.deps.store.appendLog(this.id, match.id, log, snapshot));
  }

  private scheduleLobbyWrite(): void {
    this.lobbyDirty = true;
    if (this.lobbyWrite.armed) return;
    const at = Math.max(this.deps.timers.now(), this.lastLobbyWriteAt + LOBBY_WRITE_DEBOUNCE_MS);
    this.lobbyWrite.at(at, () => void this.run(() => void this.writeLobbyNow()));
  }

  private writeLobbyNow(status?: RoomPhase): Promise<boolean> {
    this.lobbyWrite.cancel();
    this.lobbyDirty = false;
    this.lastLobbyWriteAt = this.deps.timers.now();
    const state = {
      status: status ?? this.status,
      hostUserId: this.hostUserId,
      options: this.options,
      kicked: [...this.kicked],
      seats: this.seats.map((s) => ({ seat: s.seat, userId: s.userId, team: s.team })),
    };
    return this.persist('lobby', () => this.deps.store.writeLobby(this.id, state));
  }

  /** Ordered, retried writes. A fence miss moves this room's clients to the owning process. */
  private persist(label: string, write: () => Promise<unknown>): Promise<boolean> {
    const attempt = async (): Promise<boolean> => {
      if (this.fenced) return false;
      for (let n = 1; ; n++) {
        try {
          await write();
          return true;
        } catch (error) {
          if (error instanceof FencedError) {
            this.fenceOut();
            return false;
          }
          if (n >= WRITE_ATTEMPTS) {
            this.deps.log.error({ err: error, roomId: this.id, label }, 'room write failed');
            return false;
          }
          await retryDelay(250 * n);
        }
      }
    };
    const next = this.persistChain.then(attempt);
    this.persistChain = next;
    return next;
  }

  /** Publish after commit, but never hold a publish back more than 2 s (§4.1). */
  private async awaitWrite(write: Promise<boolean>): Promise<void> {
    let release: () => void = () => {};
    const timeout = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = this.deps.timers.after(PUBLISH_AFTER_MS, () => release());
    await Promise.race([write, timeout]);
    handle.cancel();
  }

  private fenceOut(): void {
    if (this.fenced) return;
    this.fenced = true;
    this.deps.log.warn({ roomId: this.id }, 'fenced out: another process owns this room');
    const sockets = [...this.conns.values()].map((conn) => conn.socket);
    this.conns.clear();
    this.dispose();
    this.deps.onGone(this.id, this.code, false);
    for (const socket of sockets) {
      socket.data.rooms.delete(this.id);
      socket.emit('server:moving', { reason: 'FENCED' });
      socket.disconnect(true);
    }
  }

  private dispose(): void {
    this.closed = true;
    this.match?.engine?.dispose();
    for (const slot of [
      this.lobbyClose,
      this.finishedClose,
      this.abandonSlot,
      this.hostAway,
      this.lobbyWrite,
      this.writeBehind,
      this.spectatorSlot,
    ]) {
      slot.cancel();
    }
    for (const seat of this.seats) seat.grace.cancel();
  }

  // ---------------------------------------------------------------- seats & connections

  private seatOf(socketId: string): SeatSlot | null {
    const conn = this.conns.get(socketId);
    return conn && conn.seat !== null ? (this.seats[conn.seat] ?? null) : null;
  }

  private hostCheck(socketId: string): LobbyAck | null {
    const conn = this.conns.get(socketId);
    if (!conn) return lobbyFail('NOT_IN_ROOM');
    if (conn.userId !== this.hostUserId) return lobbyFail('NOT_HOST');
    return null;
  }

  private spectatorCount(): number {
    let count = 0;
    for (const conn of this.conns.values()) if (conn.seat === null) count++;
    return count;
  }

  private detach(conn: Conn): void {
    this.conns.delete(conn.socket.id);
    conn.socket.data.rooms.delete(this.id);
    if (conn.seat !== null) this.seats[conn.seat]?.sockets.delete(conn.socket.id);
  }

  private freeSeat(slot: SeatSlot): void {
    slot.userId = null;
    slot.name = '';
    slot.avatarSeed = '';
    slot.ready = false;
    slot.loaded = false;
    slot.sockets.clear();
    slot.reconnecting = false;
    slot.disconnectedAt = null;
    slot.graceUntil = null;
    slot.grace.cancel();
  }

  private seatConnected(slot: SeatSlot): void {
    slot.disconnectedAt = null;
    slot.reconnecting = false;
    slot.graceUntil = null;
    slot.grace.cancel();
    const engine = this.match?.engine;
    if (this.status === 'IN_PROGRESS' && engine && !engine.result) {
      engine.setConnected(slot.seat, true);
    }
    this.maybeTransferHost();
    this.checkAbandon();
  }

  private seatDisconnected(slot: SeatSlot): void {
    const now = this.deps.timers.now();
    slot.disconnectedAt = now;
    const engine = this.match?.engine;
    if (this.status === 'IN_PROGRESS' && engine && !engine.result) {
      engine.setConnected(slot.seat, false);
      if (!slot.reconnecting) {
        // Phase 1 hands the seat to a bot when grace ends; until then turn timers auto-move it.
        slot.graceUntil = now + GRACE_MS;
        slot.grace.at(
          slot.graceUntil,
          () =>
            void this.run(() => {
              slot.graceUntil = null;
              this.publish(NO_EVENTS);
            }),
        );
      }
    } else if (slot.userId !== null && slot.userId === this.hostUserId) {
      this.hostAway.at(now + HOST_AWAY_MS, () => void this.run(() => this.maybeTransferHost()));
    }
    this.checkAbandon();
  }

  private checkAbandon(): void {
    const nobody = this.seats.every((s) => s.sockets.size === 0);
    if (this.status === 'IN_PROGRESS' && nobody) {
      if (!this.abandonSlot.armed) {
        this.abandonSlot.at(
          this.deps.timers.now() + ABANDON_MS,
          () => void this.run(() => this.abandon()),
        );
      }
    } else {
      this.abandonSlot.cancel();
    }
  }

  /** Lobby rule (OQ C15): hosting passes after > 5 min away while another human is connected. */
  private maybeTransferHost(): void {
    if (this.status === 'IN_PROGRESS' || this.closed) return;
    const host = this.seats.find((s) => s.userId === this.hostUserId);
    if (host && host.sockets.size > 0) return;
    const now = this.deps.timers.now();
    if (host?.disconnectedAt != null && now - host.disconnectedAt < HOST_AWAY_MS) return;
    const next = this.seats.find(
      (s) => s.userId !== null && s.userId !== this.hostUserId && s.sockets.size > 0,
    );
    if (!next?.userId) return;
    this.hostUserId = next.userId;
    this.scheduleLobbyWrite();
    this.publish(NO_EVENTS);
  }

  /** Explicit leave: the host role passes to the next seated (preferably connected) human. */
  private passHost(preferConnected: boolean): void {
    const candidates = this.seats.filter((s) => s.userId !== null && s.userId !== this.hostUserId);
    const next =
      (preferConnected ? candidates.find((s) => s.sockets.size > 0) : undefined) ?? candidates[0];
    if (!next?.userId) return;
    this.hostUserId = next.userId;
    this.scheduleLobbyWrite();
  }

  /** Lobby activity: re-arms the 30-min idle close and the 10-min host-only close. */
  private touchLobby(): void {
    this.lastActivity = this.deps.timers.now();
    this.armLobbyClose();
  }

  private armLobbyClose(): void {
    if (this.status !== 'LOBBY' || this.closed) {
      this.lobbyClose.cancel();
      return;
    }
    const now = this.deps.timers.now();
    const humans = this.seats.filter((s) => s.userId !== null);
    const onlyHost = humans.length === 1 && humans[0]?.userId === this.hostUserId;
    if (onlyHost) this.onlyHostSince ??= now;
    else this.onlyHostSince = null;
    let at = this.lastActivity + LOBBY_IDLE_MS;
    if (this.onlyHostSince !== null) at = Math.min(at, this.onlyHostSince + HOST_ONLY_MS);
    this.lobbyClose.at(at, () => void this.run(() => this.close('IDLE')));
  }

  // ---------------------------------------------------------------- versions & snapshots

  private toEngineVersion(base: number): number {
    const versions = this.match?.versions ?? [];
    for (let i = versions.length - 1; i >= 0; i--) {
      const entry = versions[i];
      if (entry && entry[0] <= base) return entry[1];
    }
    return 0;
  }

  private publish(events: EventBatch, except?: string): void {
    if (this.closed) return;
    this.version++;
    const engine = this.match?.engine;
    if (this.match && engine) {
      this.match.versions.push([this.version, engine.version]);
      if (this.match.versions.length > VERSION_MAP_CAP) this.match.versions.shift();
    }
    const cache = new Map<string, RoomSnapshot>();
    let spectators = false;
    for (const [id, conn] of this.conns) {
      if (conn.seat === null) {
        spectators = true;
        continue;
      }
      if (id === except) continue;
      conn.socket.emit('room:state', this.snapshotFor(conn.seat, events, cache));
    }
    if (spectators) {
      if (events !== NO_EVENTS) this.spectatorBatches.push(events);
      if (this.spectatorBatches.length > MAX_SPECTATOR_BATCHES) this.spectatorBatches.shift();
      const now = this.deps.timers.now();
      if (now - this.lastSpectatorAt >= SPECTATOR_INTERVAL_MS) this.flushSpectators(except);
      else if (!this.spectatorSlot.armed) {
        this.spectatorSlot.at(
          this.lastSpectatorAt + SPECTATOR_INTERVAL_MS,
          () => void this.run(() => this.flushSpectators()),
        );
      }
    }
  }

  /** Spectators get at most one snapshot per second (§4.5). */
  private flushSpectators(except?: string): void {
    if (this.closed) return;
    this.lastSpectatorAt = this.deps.timers.now();
    const batches = this.spectatorBatches.splice(0);
    const events: EventBatch = (viewer) => batches.flatMap((batch) => batch(viewer));
    let snapshot: RoomSnapshot | null = null;
    for (const [id, conn] of this.conns) {
      if (conn.seat !== null || id === except) continue;
      snapshot ??= this.snapshotFor(null, events, new Map());
      conn.socket.emit('room:state', snapshot);
    }
  }

  private ackFor(conn: Conn): RoomSnapshot {
    return this.snapshotFor(conn.seat, NO_EVENTS, new Map());
  }

  private snapshotFor(
    seat: Seat | null,
    events: EventBatch,
    cache: Map<string, RoomSnapshot>,
  ): RoomSnapshot {
    const key = seat === null ? 'spectator' : `seat:${seat}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const viewer: Viewer = seat === null ? { kind: 'spectator' } : { kind: 'seat', seat };
    const match = this.status === 'LOBBY' ? null : this.match;
    const engine = match?.engine ?? null;
    let view: unknown = null;
    let shown: unknown[] = [];
    let meta: MatchMeta | null = null;
    if (engine) {
      const output = engine.outputFor(viewer, events);
      view = output.view;
      shown = output.events.slice(-MAX_EVENTS);
      const deadlineAt = output.meta.awaiting.deadlineAt;
      meta = {
        version: output.meta.version,
        awaiting: {
          seats: [...output.meta.awaiting.seats],
          deadlineAt: deadlineAt === null ? null : Math.max(0, Math.round(deadlineAt)),
        },
        paused: output.meta.paused,
        finished: output.meta.finished,
      };
    }
    const snapshot: RoomSnapshot = {
      roomId: this.id,
      code: this.code,
      gameId: this.game.id,
      mode: this.mode,
      version: this.version,
      phase: this.status,
      seatCount: this.seatCount,
      options: this.options,
      seats: this.seatStates(),
      spectators: this.spectatorCount(),
      yourSeat: seat,
      matchId: match?.id ?? null,
      deadlines: this.deadlines(meta),
      rematch: this.status === 'FINISHED' && this.rematch ? { accepted: [...this.rematch] } : null,
      view,
      events: shown,
      meta,
      result: match?.result ?? null,
    };
    cache.set(key, snapshot);
    return snapshot;
  }

  private seatStates(): SeatState[] {
    return this.seats.map((slot) => ({
      seat: slot.seat,
      team: slot.team,
      occupant:
        slot.userId === null
          ? null
          : {
              kind: 'human',
              userId: slot.userId,
              name: slot.name || 'Player',
              avatarSeed: slot.avatarSeed || slot.userId,
              platform: slot.platform,
              connection: this.connectionOf(slot),
            },
      isHost: slot.userId !== null && slot.userId === this.hostUserId,
      ready: slot.ready,
      loaded: slot.loaded,
    }));
  }

  private connectionOf(slot: SeatSlot): ConnectionState {
    if (slot.sockets.size > 0) {
      const allAway = [...slot.sockets].every((id) => this.conns.get(id)?.away === true);
      return allAway ? 'away' : 'connected';
    }
    if (slot.reconnecting) return 'reconnecting';
    return this.status === 'IN_PROGRESS' ? 'disconnected' : 'away';
  }

  private deadlines(meta: MatchMeta | null): Deadline[] {
    const out: Deadline[] = [];
    if (this.status === 'IN_PROGRESS' && meta && !meta.paused && !meta.finished) {
      if (meta.awaiting.deadlineAt !== null && meta.awaiting.seats.length > 0) {
        out.push({ kind: 'turn', seats: meta.awaiting.seats, at: meta.awaiting.deadlineAt });
      }
    }
    for (const slot of this.seats) {
      if (slot.graceUntil !== null) {
        out.push({ kind: 'grace', seats: [slot.seat], at: Math.round(slot.graceUntil) });
      }
    }
    if (this.status === 'FINISHED' && this.finishedCloseAt !== null) {
      out.push({ kind: 'rematch', seats: [], at: Math.round(this.finishedCloseAt) });
    }
    return out;
  }
}

function role(conn: Conn): 'player' | 'spectator' {
  return conn.seat === null ? 'spectator' : 'player';
}
