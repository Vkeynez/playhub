import type { RoomSnapshot } from '@gp/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { TimerApi } from '../src/room/clock';
import { RemoteRoom } from '../src/room/RemoteRoom';
import type { RemoteRoomOptions, SocketHandler, SocketLike } from '../src/room/RemoteRoom';

const ROOM_ID = '7b0f3c2e-8a51-4c1e-9d6b-2f4a1e0c9b11';
const MATCH_ID = '2c9e1f4a-6b3d-4e8f-a1c2-9d0b7e6f5a43';
const USER_A = '0f1e2d3c-4b5a-4968-8776-655443322110';
const USER_B = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

type Ack = (response: unknown) => void;
type ServerHandler = (payload: unknown, ack: Ack) => void;

class FakeSocket implements SocketLike {
  connected = false;
  connects = 0;
  readonly emitted: { event: string; payload: unknown }[] = [];
  readonly server: Record<string, ServerHandler> = {};
  private readonly handlers = new Map<string, Set<SocketHandler>>();

  connect(): void {
    this.connects += 1;
    this.connected = true;
    this.fire('connect', undefined);
  }
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.fire('disconnect', 'io client disconnect');
  }
  /** The server or the network cut the socket. */
  drop(reason = 'transport close'): void {
    this.connected = false;
    this.fire('disconnect', reason);
  }
  on(event: string, fn: SocketHandler): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn);
    this.handlers.set(event, set);
  }
  off(event: string, fn: SocketHandler): void {
    this.handlers.get(event)?.delete(fn);
  }
  emit(event: string, payload: unknown, ack?: Ack): void {
    this.emitted.push({ event, payload });
    const handler = this.server[event];
    if (handler && ack) handler(payload, ack);
  }
  fire(event: string, payload: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(payload);
  }
  sent(event: string): unknown[] {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }
}

function manualTimers() {
  let now = 0;
  let id = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: TimerApi = {
    setTimeout(fn, ms) {
      id += 1;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      queue.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of queue) if (!next || entry[1].at < next[1].at) next = entry;
      if (!next || next[1].at > target) break;
      queue.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = target;
  };
  return { timers, advance, now: () => now };
}

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

function snapshot(patch: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    roomId: ROOM_ID,
    code: 'K7P2QX',
    gameId: 'dev-tictactoe',
    mode: 'classic',
    version: 10,
    phase: 'IN_PROGRESS',
    seatCount: 2,
    options: {},
    seats: [
      {
        seat: 0,
        team: null,
        occupant: {
          kind: 'human',
          userId: USER_A,
          name: 'Asha',
          avatarSeed: 'a1',
          platform: 'web',
          connection: 'connected',
        },
        isHost: true,
        ready: true,
        loaded: true,
      },
      {
        seat: 1,
        team: null,
        occupant: {
          kind: 'human',
          userId: USER_B,
          name: 'Ravi',
          avatarSeed: 'b2',
          platform: 'android',
          connection: 'connected',
        },
        isHost: false,
        ready: true,
        loaded: true,
      },
    ],
    spectators: 0,
    yourSeat: 0,
    matchId: MATCH_ID,
    deadlines: [{ kind: 'turn', seats: [0], at: 50_000 }],
    rematch: null,
    view: { board: [null, null, null, null, null, null, null, null, null], turn: 0, you: 0 },
    events: [{ type: 'placed', cell: 4 }],
    ...patch,
  };
}

interface Harness {
  socket: FakeSocket;
  room: RemoteRoom;
  time: ReturnType<typeof manualTimers>;
  joins: unknown[];
  /** Pending game:action acks, oldest first. */
  actionAcks: Ack[];
  setJoinSnapshot(s: RoomSnapshot): void;
}

function harness(opts: Partial<RemoteRoomOptions> = {}, serverOffset = 5_000): Harness {
  const socket = new FakeSocket();
  const time = manualTimers();
  const joins: unknown[] = [];
  const actionAcks: Ack[] = [];
  let joinSnapshot = snapshot();
  let ids = 0;
  socket.server.hello = (_p, ack) =>
    ack({ ok: true, serverTime: 1, protocol: { min: 1, max: 1 }, bootId: 'boot-1', epoch: 0 });
  socket.server['clock:ping'] = (p, ack) => {
    const { t0 } = p as { t0: number };
    ack({ t0, ts: Math.round(t0 + serverOffset) });
  };
  socket.server['room:join'] = (p, ack) => {
    joins.push(p);
    ack({ ok: true, roomId: ROOM_ID, role: 'player', snapshot: joinSnapshot });
  };
  socket.server['game:action'] = (_p, ack) => actionAcks.push(ack);
  const room = new RemoteRoom({
    socket,
    roomId: ROOM_ID,
    hello: () => ({
      protocolVersion: 1,
      appVersion: '0.1.0',
      platform: 'web',
      deviceId: 'd-test',
      locale: 'en',
    }),
    newActionId: () => `action-${String(++ids).padStart(4, '0')}`,
    timers: time.timers,
    now: () => 1_000 + time.now(),
    wallNow: () => 0,
    random: () => 0.5,
    ...opts,
  });
  return {
    socket,
    room,
    time,
    joins,
    actionAcks,
    setJoinSnapshot: (s) => {
      joinSnapshot = s;
    },
  };
}

describe('RemoteRoom', () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    h.room.start();
    await flush();
  });

  it('runs hello, five clock pings and room:join, then applies the snapshot', () => {
    expect(h.socket.emitted.map((e) => e.event)).toEqual([
      'hello',
      'clock:ping',
      'clock:ping',
      'clock:ping',
      'clock:ping',
      'clock:ping',
      'room:join',
    ]);
    expect(h.joins).toEqual([{ roomId: ROOM_ID }]);
    expect(h.room.getInfo().status).toBe('live');
    expect(h.room.getInfo().role).toBe('player');
    expect(h.room.seat).toBe(0);
    const state = h.room.getState();
    expect(state.version).toBe(10);
    expect(state.events).toEqual([{ type: 'placed', cell: 4 }]);
    expect(state.meta).toEqual({
      version: 10,
      awaiting: { seats: [0], deadlineAt: 50_000 },
      paused: false,
      finished: false,
    });
    expect(state.result).toBeNull();
  });

  it('estimates server time from the median clock offset', () => {
    expect(h.room.clockOffset).toBe(5_000);
    expect(h.room.serverNow()).toBe(1_000 + 5_000);
  });

  it('orders room:state by version: older ignored, same re-applied without events', () => {
    const listener: number[] = [];
    h.room.subscribe((s) => listener.push(s.version));
    h.socket.fire('room:state', snapshot({ version: 12, events: [{ type: 'placed', cell: 0 }] }));
    h.socket.fire('room:state', snapshot({ version: 11 }));
    expect(h.room.getState().version).toBe(12);
    h.socket.fire('room:state', snapshot({ version: 12, events: [{ type: 'placed', cell: 0 }] }));
    expect(listener).toEqual([12, 12]);
    expect(h.room.getState().events).toEqual([]);
  });

  it('ignores invalid payloads and other rooms', () => {
    h.socket.fire('room:state', { roomId: ROOM_ID, version: 'nope' });
    h.socket.fire('room:state', snapshot({ roomId: USER_B, version: 99 }));
    expect(h.room.getState().version).toBe(10);
  });

  it('ignores an older version even from another match', () => {
    h.socket.fire('room:state', snapshot({ version: 3, matchId: USER_B, events: [] }));
    expect(h.room.getState().version).toBe(10);
  });

  it('submits with clientActionId + baseVersion and resolves on the ack', async () => {
    const result = h.room.submit({ type: 'place', cell: 2 });
    expect(h.socket.sent('game:action')).toEqual([
      {
        roomId: ROOM_ID,
        clientActionId: 'action-0001',
        baseVersion: 10,
        action: { type: 'place', cell: 2 },
      },
    ]);
    h.actionAcks.shift()?.({ ok: true, version: 11 });
    await expect(result).resolves.toEqual({ ok: true, version: 11 });

    const rejected = h.room.submit({ type: 'place', cell: 2 });
    h.actionAcks.shift()?.({ ok: false, reason: 'CELL_TAKEN' });
    await expect(rejected).resolves.toEqual({ ok: false, reason: 'CELL_TAKEN' });
  });

  it('reconnects after a dropped transport and rejoins with lastStateVersion', async () => {
    h.socket.fire('room:state', snapshot({ version: 14 }));
    h.socket.drop('transport close');
    expect(h.room.getInfo().status).toBe('reconnecting');
    expect(h.socket.connects).toBe(1);
    h.time.advance(3_000);
    await flush();
    expect(h.socket.connects).toBe(2);
    expect(h.joins.at(-1)).toEqual({ roomId: ROOM_ID, lastStateVersion: 14 });
    expect(h.room.getInfo().status).toBe('live');
  });

  it('reconnects on server:moving within 0.5–3 s', async () => {
    h.socket.fire('server:moving', { reason: 'DEPLOY' });
    expect(h.socket.connected).toBe(false);
    expect(h.room.getInfo().status).toBe('reconnecting');
    h.time.advance(400);
    expect(h.socket.connects).toBe(1);
    h.time.advance(2_600);
    await flush();
    expect(h.socket.connects).toBe(2);
    expect(h.room.getInfo().status).toBe('live');
  });

  it('resends an in-flight action with the same clientActionId after a rejoin', async () => {
    const result = h.room.submit({ type: 'place', cell: 5 });
    h.actionAcks.length = 0; // the ack is lost with the socket
    h.socket.drop();
    h.time.advance(3_000);
    await flush();
    const sends = h.socket.sent('game:action') as { clientActionId: string }[];
    expect(sends.map((s) => s.clientActionId)).toEqual(['action-0001', 'action-0001']);
    h.actionAcks.shift()?.({ ok: true, version: 11 });
    await expect(result).resolves.toEqual({ ok: true, version: 11 });
  });

  it('sends an action queued offline when the rejoin snapshot is unchanged', async () => {
    h.socket.drop();
    const result = h.room.submit({ type: 'place', cell: 1 });
    expect(h.socket.sent('game:action')).toHaveLength(0);
    h.time.advance(3_000);
    await flush();
    expect(h.socket.sent('game:action')).toHaveLength(1);
    h.actionAcks.shift()?.({ ok: true, version: 11 });
    await expect(result).resolves.toEqual({ ok: true, version: 11 });
  });

  it('drops an action queued offline when the rejoin snapshot jumped', async () => {
    h.socket.drop();
    const result = h.room.submit({ type: 'place', cell: 1 });
    h.setJoinSnapshot(snapshot({ version: 13 }));
    h.time.advance(3_000);
    await flush();
    await expect(result).resolves.toEqual({ ok: false, reason: 'STALE' });
    expect(h.socket.sent('game:action')).toHaveLength(0);
  });

  it('drops everything in flight on an epoch jump', async () => {
    const result = h.room.submit({ type: 'place', cell: 1 });
    h.socket.fire('room:state', snapshot({ version: 2 ** 32 + 10 }));
    await expect(result).resolves.toEqual({ ok: false, reason: 'STALE' });
  });

  it('uses the snapshot meta and result when the server sends them', () => {
    h.socket.fire(
      'room:state',
      snapshot({
        version: 11,
        phase: 'FINISHED',
        deadlines: [],
        meta: {
          version: 7,
          awaiting: { seats: [], deadlineAt: null },
          paused: false,
          finished: true,
        },
        result: {
          placements: [
            { seat: 0, place: 2, score: null },
            { seat: 1, place: 1, score: null },
          ],
        },
      }),
    );
    const state = h.room.getState();
    expect(state.meta).toEqual({
      version: 7,
      awaiting: { seats: [], deadlineAt: null },
      paused: false,
      finished: true,
    });
    expect(state.result?.placements[1]?.place).toBe(1);
  });

  it('derives meta from the turn deadline when the snapshot has none', () => {
    h.socket.fire(
      'room:state',
      snapshot({ version: 12, meta: null, deadlines: [{ kind: 'turn', seats: [1], at: 61_000 }] }),
    );
    expect(h.room.getState().meta.awaiting).toEqual({ seats: [1], deadlineAt: 61_000 });
  });
});

describe('RemoteRoom handshake failures', () => {
  it('stops on CLIENT_TOO_OLD without joining', async () => {
    const h = harness();
    h.socket.server.hello = (_p, ack) =>
      ack({ ok: false, serverTime: 1, protocol: { min: 2, max: 2 }, reason: 'CLIENT_TOO_OLD' });
    h.room.start();
    await flush();
    expect(h.room.getInfo()).toMatchObject({ status: 'blocked', failure: 'CLIENT_TOO_OLD' });
    expect(h.joins).toEqual([]);
    h.time.advance(60_000);
    expect(h.socket.connects).toBe(1);
  });

  it('retries by itself on SERVER_TOO_OLD', async () => {
    const h = harness();
    let first = true;
    h.socket.server.hello = (_p, ack) => {
      if (first) {
        first = false;
        ack({ ok: false, serverTime: 1, protocol: { min: 0, max: 0 }, reason: 'SERVER_TOO_OLD' });
      } else {
        ack({ ok: true, serverTime: 1, protocol: { min: 1, max: 1 }, bootId: 'b2', epoch: 1 });
      }
    };
    h.room.start();
    await flush();
    expect(h.room.getInfo().failure).toBe('SERVER_TOO_OLD');
    h.time.advance(20_000);
    await flush();
    expect(h.room.getInfo().status).toBe('live');
  });

  it('fails for good on ROOM_FULL', async () => {
    const h = harness();
    h.socket.server['room:join'] = (_p, ack) => ack({ ok: false, error: 'ROOM_FULL' });
    h.room.start();
    await flush();
    expect(h.room.getInfo()).toMatchObject({ status: 'failed', failure: 'ROOM_FULL' });
    await expect(h.room.submit({})).resolves.toEqual({ ok: false, reason: 'NOT_IN_ROOM' });
  });

  it('refreshes the token once on an auth connect_error', async () => {
    let refreshes = 0;
    const h = harness({
      refreshAuth: () => {
        refreshes += 1;
        return Promise.resolve();
      },
    });
    h.socket.connect = () => {
      h.socket.connects += 1;
      if (h.socket.connects === 1) h.socket.fire('connect_error', new Error('AUTH_EXPIRED'));
      else {
        h.socket.connected = true;
        h.socket.fire('connect', undefined);
      }
    };
    h.room.start();
    await flush();
    expect(refreshes).toBe(1);
    h.time.advance(0);
    await flush();
    expect(h.room.getInfo().status).toBe('live');
  });
});
