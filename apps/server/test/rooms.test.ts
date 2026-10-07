// Rooms end to end: REST create → socket join by code → lobby → matches → persistence, against a
// real Postgres, with room timers on a manual clock (sockets and pg use real time).

import { randomUUID } from 'node:crypto';
import { createPool } from '@gp/db';
import { startTestDb, type TestDb } from '@gp/db/testing';
import {
  AuthSessionSchema,
  CreateRoomResponseSchema,
  ResolveRoomResponseSchema,
  type RoomJoinAck,
  type RoomSnapshot,
} from '@gp/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type Pool } from '../src/app';
import {
  connect,
  countCheckouts,
  hello,
  invalidStates,
  ManualTimers,
  Player,
  sink,
  testEnv,
  type TestSocket,
} from './helpers';

interface Server {
  app: FastifyInstance;
  port: number;
  timers: ManualTimers;
}

let testDb: TestDb;
let pool: Pool;
/** Server log lines; the suite fails if any error-level line was logged. */
const logLines: string[] = [];
let checkouts: () => number;
let server: Server;
const sockets: TestSocket[] = [];
const servers: Server[] = [];

async function startServer(epoch: number): Promise<Server> {
  const timers = new ManualTimers();
  const app = buildApp({
    env: testEnv({ DATABASE_URL: testDb.url, DATABASE_URL_DIRECT: testDb.url, LOG_LEVEL: 'warn' }),
    pool,
    epoch,
    bootId: `rooms-${epoch}`,
    logStream: sink(logLines),
    timers,
  });
  timers.onSettle = () => app.rooms.idle();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const started = { app, port: typeof address === 'object' && address ? address.port : 0, timers };
  servers.push(started);
  return started;
}

beforeAll(async () => {
  testDb = await startTestDb({ seed: true });
  pool = createPool(testDb.url, { onError: () => {} });
  checkouts = countCheckouts(pool);
  server = await startServer(1);
});

afterAll(async () => {
  expect(logLines.filter((line) => line.includes('"level":50'))).toEqual([]);
  expect(invalidStates).toEqual([]);
  for (const socket of sockets) socket.close();
  for (const running of servers) await running.app.close();
  await pool?.end();
  await testDb?.stop();
});

let guestCount = 0;

async function guest(name: string, on: Server = server) {
  guestCount++;
  const response = await on.app.inject({
    method: 'POST',
    url: '/auth/guest',
    payload: {
      guestKey: `room-test-guest-key-${guestCount}-${randomUUID()}`,
      name,
      avatarSeed: `seed-${name}`,
    },
  });
  expect(response.statusCode).toBe(200);
  const session = AuthSessionSchema.parse(response.json());
  return { token: session.accessToken, userId: session.user.userId };
}

async function player(user: { token: string; userId: string }, on: Server = server) {
  const socket = await connect(on.port, {}, user.token);
  sockets.push(socket);
  await socket.emitWithAck('hello', hello());
  return new Player(socket, user.userId);
}

async function createRoom(
  user: { token: string },
  body: Record<string, unknown>,
  on: Server = server,
) {
  const response = await on.app.inject({
    method: 'POST',
    url: '/rooms',
    headers: { authorization: `Bearer ${user.token}` },
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(200);
  return CreateRoomResponseSchema.parse(response.json());
}

async function join(p: Player, payload: Parameters<TestSocket['emitWithAck']>[1]) {
  const ack = (await p.socket.emitWithAck('room:join', payload as never)) as RoomJoinAck;
  if (ack.ok) p.push(ack.snapshot);
  return ack;
}

async function readyUp(...players: Player[]) {
  for (const p of players) {
    const ack = await p.socket.emitWithAck('room:ready', {
      roomId: p.last.roomId,
      ready: true,
      loaded: true,
    });
    expect(ack).toEqual({ ok: true });
  }
}

let actionCount = 0;
function act(p: Player, action: unknown, baseVersion = p.last.version) {
  actionCount++;
  return p.socket.emitWithAck('game:action', {
    roomId: p.last.roomId,
    clientActionId: `action-${actionCount}-${randomUUID().slice(0, 8)}`,
    baseVersion,
    action,
  });
}

interface TttView {
  board: (number | null)[];
  turn: number;
  winner: number | null;
}
const ttt = (state: RoomSnapshot) => state.view as TttView;

/** Two seated, ready players in a started dev-tictactoe match. */
async function startTicTacToe(on: Server = server) {
  const hostUser = await guest('Asha', on);
  const guestUser = await guest('Bala', on);
  const room = await createRoom(hostUser, { gameId: 'dev-tictactoe', mode: 'classic' }, on);
  const host = await player(hostUser, on);
  const other = await player(guestUser, on);
  expect(await join(host, { code: room.code })).toMatchObject({ ok: true, role: 'player' });
  expect(await join(other, { code: room.code.toLowerCase() })).toMatchObject({ ok: true });
  await readyUp(host, other);
  expect(await host.socket.emitWithAck('room:start', { roomId: room.roomId })).toEqual({
    ok: true,
  });
  await host.waitFor((s) => s.phase === 'IN_PROGRESS');
  await other.waitFor((s) => s.phase === 'IN_PROGRESS');
  return { room, host, other, hostUser, guestUser };
}

/** Places `cell` for `p` and waits until both players see it. */
async function place(p: Player, cell: number, watchers: Player[]) {
  const ack = await act(p, { type: 'place', cell });
  expect(ack).toMatchObject({ ok: true });
  for (const w of watchers) await w.waitFor((s) => s.view !== null && ttt(s).board[cell] !== null);
  return ack;
}

describe('create → join by code → play', () => {
  it('plays a full dev-tictactoe match, persists it, and rematches in the same room', async () => {
    const { room, host, other } = await startTicTacToe();
    expect(room.joinUrl).toBe(`https://web.example.test/join/${room.code}`);
    expect(host.last.yourSeat).toBe(0);
    expect(other.last.yourSeat).toBe(1);
    expect(host.last.seats.map((s) => s.isHost)).toEqual([true, false]);
    expect(host.last.meta).toMatchObject({ awaiting: { seats: [0] }, paused: false });
    expect(host.last.deadlines.find((d) => d.kind === 'turn')?.seats).toEqual([0]);

    // Not your turn, and a STALE action (acting on a version older than the current decision).
    expect(await act(other, { type: 'place', cell: 4 })).toEqual({
      ok: false,
      reason: 'NOT_YOUR_TURN',
    });
    const startVersion = other.last.version;
    await place(host, 0, [host, other]);
    expect(await act(other, { type: 'place', cell: 3 }, startVersion)).toEqual({
      ok: false,
      reason: 'STALE',
    });
    await place(other, 3, [host, other]);

    // A retried clientActionId is acknowledged once.
    const retryId = `retry-${randomUUID().slice(0, 8)}`;
    const payload = {
      roomId: room.roomId,
      clientActionId: retryId,
      baseVersion: host.last.version,
      action: { type: 'place', cell: 1 },
    };
    const first = await host.socket.emitWithAck('game:action', payload);
    const again = await host.socket.emitWithAck('game:action', payload);
    expect(first).toMatchObject({ ok: true });
    expect(again).toMatchObject({ ok: true });
    await other.waitFor((s) => ttt(s).board[1] === 0);

    await place(other, 4, [host, other]);
    await place(host, 2, [host, other]);
    for (const p of [host, other]) {
      const done = await p.waitFor((s) => s.phase === 'FINISHED');
      expect(ttt(done).winner).toBe(0);
      expect(done.result?.placements.find((x) => x.place === 1)?.seat).toBe(0);
      expect(done.deadlines.some((d) => d.kind === 'rematch')).toBe(true);
    }

    await server.app.rooms.idle();
    const matchId = host.last.matchId;
    const { rows: matches } = await pool.query<{ ended: boolean; result: unknown; n: number }>(
      `SELECT ended_at IS NOT NULL AS ended, result,
              (SELECT count(*)::int FROM match_actions a WHERE a.match_id = m.id) AS n
         FROM matches m WHERE id = $1`,
      [matchId],
    );
    expect(matches[0]).toMatchObject({ ended: true, n: 5 });
    const { rows: parts } = await pool.query<{ seat: number; outcome: string }>(
      'SELECT seat, outcome FROM match_participants WHERE match_id = $1 ORDER BY seat',
      [matchId],
    );
    expect(parts).toEqual([
      { seat: 0, outcome: 'win' },
      { seat: 1, outcome: 'loss' },
    ]);
    const { rows: stats } = await pool.query<{ won: number; lost: number; played: number }>(
      `SELECT played, won, lost FROM user_game_stats WHERE user_id = $1 AND game_id = 'dev-tictactoe'`,
      [host.userId],
    );
    expect(stats[0]).toEqual({ played: 1, won: 1, lost: 0 });
    const { rows: recent } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM recent_players WHERE user_id = ANY($1::uuid[])',
      [[host.userId, other.userId]],
    );
    expect(recent[0]?.n).toBe(2);

    // Rematch: every seated human accepts → a new match in the same room and seats.
    expect(
      await host.socket.emitWithAck('room:rematch', { roomId: room.roomId, accept: true }),
    ).toEqual({ ok: true });
    await other.waitFor((s) => (s.rematch?.accepted ?? []).includes(0));
    expect(
      await other.socket.emitWithAck('room:rematch', { roomId: room.roomId, accept: true }),
    ).toEqual({ ok: true });
    const rematch = await host.waitFor((s) => s.phase === 'IN_PROGRESS' && s.matchId !== matchId);
    expect(rematch.code).toBe(room.code);
    expect(ttt(rematch).board.every((c) => c === null)).toBe(true);
    expect(rematch.version).toBeGreaterThan(host.states[0]?.version ?? 0);

    // The join screen's summary.
    const summary = await server.app.inject({
      method: 'GET',
      url: `/rooms/${room.code}`,
      headers: { authorization: `Bearer ${(await guest('Viewer')).token}` },
    });
    expect(ResolveRoomResponseSchema.parse(summary.json())).toMatchObject({
      code: room.code,
      gameId: 'dev-tictactoe',
      phase: 'IN_PROGRESS',
      seatCount: 2,
      seatsTaken: 2,
      youAreSeated: false,
    });
  });

  it('validates room creation and answers unknown codes', async () => {
    const user = await guest('Check');
    const auth = { authorization: `Bearer ${user.token}` };
    const post = (payload: unknown) =>
      server.app.inject({
        method: 'POST',
        url: '/rooms',
        headers: auth,
        payload: payload as object,
      });
    expect((await post({ gameId: 'cricket', mode: 'hand-cricket', seatCount: 3 })).statusCode).toBe(
      400,
    );
    expect(
      (await post({ gameId: 'cricket', mode: 'hand-cricket', options: { overs: 7 } })).statusCode,
    ).toBe(400);
    expect((await post({ gameId: 'ludo', mode: 'classic' })).statusCode).toBe(404);
    expect(
      (await server.app.inject({ method: 'POST', url: '/rooms', payload: {} })).statusCode,
    ).toBe(401);
    const missing = await server.app.inject({
      method: 'GET',
      url: '/rooms/ZZZZZZ',
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);

    // One open lobby per host: a new room closes the previous lobby (its code answers 410).
    const firstRoom = await createRoom(user, { gameId: 'dev-tictactoe', mode: 'classic' });
    const watcher = await player(user);
    await join(watcher, { code: firstRoom.code });
    const replaced = new Promise((resolve) => watcher.socket.once('room:closed', resolve));
    await createRoom(user, { gameId: 'cricket', mode: 'hand-cricket', options: { overs: 1 } });
    expect(await replaced).toEqual({ roomId: firstRoom.roomId, reason: 'REPLACED' });
    const gone = await server.app.inject({
      method: 'GET',
      url: `/rooms/${firstRoom.code}`,
      headers: auth,
    });
    expect(gone.statusCode).toBe(410);
  });
});

describe('Hand Cricket', () => {
  it('plays a scripted match to the end; no one sees the other pick before the reveal', async () => {
    const aUser = await guest('Arun');
    const bUser = await guest('Bhavna');
    const room = await createRoom(aUser, {
      gameId: 'cricket',
      mode: 'hand-cricket',
      options: { wickets: 1, overs: 1 },
    });
    const a = await player(aUser);
    const b = await player(bUser);
    await join(a, { code: room.code });
    await join(b, { code: room.code });
    await readyUp(a, b);
    await a.socket.emitWithAck('room:start', { roomId: room.roomId });
    await a.waitFor((s) => s.phase === 'IN_PROGRESS');
    await b.waitFor((s) => s.phase === 'IN_PROGRESS');

    const players = [a, b];
    const hiddenPhases = new Set(['toss', 'toss-locked', 'ball', 'ball-locked']);
    let ballPick = 0;
    for (let step = 0; step < 400; step++) {
      const state = a.last;
      if (state.phase === 'FINISHED') break;
      const view = state.view as { phase: string; awaiting: number[]; toss: { winner: number } };
      if (view.awaiting.length === 0) {
        await server.timers.advance(500);
        await server.app.rooms.idle();
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      for (const seat of view.awaiting) {
        const p = players[seat];
        if (!p) throw new Error(`no player for seat ${seat}`);
        const action =
          view.phase === 'call'
            ? { type: 'call', call: 'odd' }
            : view.phase === 'choose'
              ? { type: 'choose', decision: 'bat' }
              : { type: 'pick', value: (ballPick++ % 6) + 1 };
        const ack = await act(p, action);
        expect(ack).toMatchObject({ ok: true });
      }
      const version = state.version;
      await Promise.all(players.map((p) => p.waitFor((s) => s.version > version)));
    }

    for (const p of players) {
      const done = await p.waitFor((s) => s.phase === 'FINISHED');
      expect((done.view as { phase: string }).phase).toBe('done');
      expect(done.result?.placements).toHaveLength(2);
    }
    // Redaction: across every state either player received, the opponent's pick was never a
    // number while picks were still hidden, and opponents' `picked` events carried no value.
    let checked = 0;
    for (const [seat, p] of players.entries()) {
      const other = 1 - seat;
      for (const state of p.states) {
        const view = state.view as { phase: string; picks: unknown[] } | null;
        if (view && hiddenPhases.has(view.phase)) {
          expect(typeof view.picks[other]).not.toBe('number');
          checked++;
        }
        for (const event of state.events as { type: string; seat?: number; value?: unknown }[]) {
          if (event.type === 'picked' && event.seat === other) expect(event.value).toBeNull();
        }
      }
    }
    expect(checked).toBeGreaterThan(4);
    await server.app.rooms.idle();
    const { rows } = await pool.query<{ ended: boolean }>(
      'SELECT ended_at IS NOT NULL AS ended FROM matches WHERE id = $1',
      [a.last.matchId],
    );
    expect(rows[0]?.ended).toBe(true);
  });
});

describe('seats', () => {
  it('settles the last-seat race atomically and offers spectating', async () => {
    const hostUser = await guest('Host');
    const room = await createRoom(hostUser, { gameId: 'dev-tictactoe', mode: 'classic' });
    const host = await player(hostUser);
    await join(host, { code: room.code });
    const b = await player(await guest('Racer B'));
    const c = await player(await guest('Racer C'));
    const [ackB, ackC] = await Promise.all([
      join(b, { code: room.code }),
      join(c, { code: room.code }),
    ]);
    const outcomes = [ackB, ackC].map((ack) => (ack.ok ? ack.role : ack.error)).sort();
    expect(outcomes).toEqual(['ROOM_FULL', 'player']);
    const loser = ackB.ok ? c : b;
    const spectate = await join(loser, { code: room.code, asSpectator: true });
    expect(spectate).toMatchObject({ ok: true, role: 'spectator' });
    if (spectate.ok) {
      expect(spectate.snapshot.yourSeat).toBeNull();
      expect(spectate.snapshot.spectators).toBe(1);
    }
    const third = await player(await guest('Late'));
    expect(await join(third, { code: room.code })).toEqual({ ok: false, error: 'ROOM_FULL' });
    expect(await join(third, { code: room.code, asSpectator: true })).toMatchObject({
      ok: true,
      role: 'spectator',
    });
    // Joining is idempotent: the host rejoins its own seat from a second socket.
    const again = await player({ token: hostUser.token, userId: hostUser.userId });
    expect(await join(again, { code: room.code })).toMatchObject({
      ok: true,
      role: 'player',
      snapshot: { yourSeat: 0 },
    });
  });

  it('keeps a seat through a disconnect and resumes from a snapshot on reconnect', async () => {
    const { room, host, other, guestUser } = await startTicTacToe();
    await place(host, 4, [host, other]);
    const lastSeen = other.last.version;
    other.socket.close();
    const away = await host.waitFor(
      (s) =>
        s.seats[1]?.occupant?.kind === 'human' && s.seats[1].occupant.connection === 'disconnected',
    );
    expect(away.deadlines.some((d) => d.kind === 'grace' && d.seats[0] === 1)).toBe(true);

    const back = await player(guestUser);
    const ack = await join(back, { roomId: room.roomId, lastStateVersion: lastSeen });
    expect(ack).toMatchObject({ ok: true, role: 'player', snapshot: { yourSeat: 1 } });
    expect(ttt(back.last).board[4]).toBe(0);
    await host.waitFor(
      (s) =>
        s.seats[1]?.occupant?.kind === 'human' && s.seats[1].occupant.connection === 'connected',
    );
    await place(back, 0, [host, back]);
    expect(ttt(host.last).board[0]).toBe(1);
  });
});

describe('Neon can sleep', () => {
  it('an idle lobby with connected clients makes zero DB queries for 30 fake minutes', async () => {
    // Its own process, so other tests' matches (whose turn timers do write) stay frozen.
    const idle = await startServer(5);
    const hostUser = await guest('Idle Host', idle);
    const room = await createRoom(hostUser, { gameId: 'dev-tictactoe', mode: 'classic' }, idle);
    const host = await player(hostUser, idle);
    const other = await player(await guest('Idle Guest', idle), idle);
    await join(host, { code: room.code });
    await join(other, { code: room.code });
    // Let the debounced lobby-seat write (a transition) land first.
    await idle.timers.advance(3_000);
    await idle.app.rooms.idle();
    const closed = new Promise((resolve) => host.socket.once('room:closed', resolve));
    const before = checkouts();
    for (let minute = 0; minute < 30; minute++) {
      await idle.timers.advance(60_000);
      await host.socket.emitWithAck('clock:ping', { t0: minute });
      for (let i = 0; i < 3; i++) {
        const health = await idle.app.inject({ method: 'GET', url: '/health' });
        expect(health.json<{ ok: boolean }>().ok).toBe(true);
      }
    }
    await idle.app.rooms.idle();
    expect(checkouts() - before).toBe(0);
    // The 30-min idle close was decided in memory.
    expect(await closed).toEqual({ roomId: room.roomId, reason: 'IDLE' });
  });
});

describe('restart', () => {
  it('resumes a match on a new server process from the snapshot and logged tail', async () => {
    const { room, host, other, hostUser, guestUser } = await startTicTacToe();
    await place(host, 0, [host, other]);
    await place(other, 4, [host, other]);
    await server.app.rooms.idle();

    // A second process (higher epoch) on the same database; the clients reconnect to it.
    const next = await startServer(2);
    const host2 = await player(hostUser, next);
    const other2 = await player(guestUser, next);
    const ack = await join(host2, { roomId: room.roomId, lastStateVersion: host.last.version });
    expect(ack).toMatchObject({ ok: true, role: 'player', snapshot: { phase: 'IN_PROGRESS' } });
    expect(ttt(host2.last).board.slice(0, 5)).toEqual([0, null, null, null, 1]);
    expect(host2.last.version).toBeGreaterThan(2 ** 33);
    expect(await join(other2, { roomId: room.roomId })).toMatchObject({ ok: true });

    // The old process is fenced out at its next write.
    const moving = new Promise((resolve) => host.socket.once('server:moving', resolve));
    // Its ack never comes: the socket is moved before the (fenced) write could publish.
    act(host, { type: 'place', cell: 1 }).catch(() => {});
    expect(await moving).toEqual({ reason: 'FENCED' });

    await place(host2, 1, [host2, other2]);
    await place(other2, 3, [host2, other2]);
    await place(host2, 2, [host2, other2]);
    const done = await other2.waitFor((s) => s.phase === 'FINISHED');
    expect(ttt(done).winner).toBe(0);
    await next.app.rooms.idle();
    const { rows } = await pool.query<{ ended: boolean; owner: string }>(
      `SELECT m.ended_at IS NOT NULL AS ended, r.owner_epoch AS owner
         FROM matches m JOIN rooms r ON r.id = m.room_id WHERE m.id = $1`,
      [done.matchId],
    );
    expect(rows[0]).toEqual({ ended: true, owner: '2' });
  });
});
