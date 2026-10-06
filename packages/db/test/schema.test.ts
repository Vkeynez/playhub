import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bumpServerEpoch,
  CATALOG_SEED,
  createPool,
  db,
  POOL_IDLE_TIMEOUT_MS,
  POOL_MAX,
  schema,
  seedCatalog,
  type Db,
} from '../src';
import { resetDb, startTestDb, type TestDb } from '../src/testing';

const { devices, games, matchActions, matches, roomSeats, rooms, users } = schema;

let testDb: TestDb;
let pool: ReturnType<typeof createPool>;
let database: Db;

beforeAll(async () => {
  testDb = await startTestDb({ seed: true });
  pool = createPool(testDb.url, { onError: () => {} });
  database = db(pool);
});

afterAll(async () => {
  await pool?.end();
  await testDb?.stop();
});

beforeEach(async () => {
  await resetDb(testDb.url);
});

/** Postgres error code of a rejected query (drizzle wraps the driver error in `cause`). */
async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    throw error;
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

async function createUser(name = 'Swift Mango 42') {
  const [user] = await database
    .insert(users)
    .values({ displayName: name, avatarSeed: 'seed' })
    .returning();
  if (!user) throw new Error('no user');
  return user;
}

async function createRoom(code: string, hostUserId: string) {
  const [room] = await database
    .insert(rooms)
    .values({
      code,
      gameId: 'dev-tictactoe',
      mode: 'classic',
      hostUserId,
      seatCount: 2,
      ownerEpoch: 1,
      expiresAt: sql`now() + interval '30 minutes'`,
    })
    .returning();
  if (!room) throw new Error('no room');
  return room;
}

describe('rooms', () => {
  it('rejects a duplicate code while the first room is open', async () => {
    const host = await createUser();
    await createRoom('ABC234', host.id);
    expect(await pgErrorCode(createRoom('ABC234', host.id))).toBe(UNIQUE_VIOLATION);
  });

  it('allows the code again once the first room is CLOSED', async () => {
    const host = await createUser();
    const first = await createRoom('ABC234', host.id);
    await database
      .update(rooms)
      .set({ status: 'CLOSED', closedAt: sql`now()` })
      .where(eq(rooms.id, first.id));

    const second = await createRoom('ABC234', host.id);
    expect(second.id).not.toBe(first.id);
    // Re-opening the old one would collide with the new open room.
    expect(
      await pgErrorCode(
        database.update(rooms).set({ status: 'LOBBY' }).where(eq(rooms.id, first.id)),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('defaults owner fencing columns and kicked ids', async () => {
    const host = await createUser();
    const room = await createRoom('XYZ789', host.id);
    expect(room.status).toBe('LOBBY');
    expect(room.ownerEpoch).toBe(1);
    expect(room.releasedAt).toBeNull();
    expect(room.lastWriteAt).toBeInstanceOf(Date);
    expect(room.kickedUserIds).toEqual([]);

    const kicked = await createUser('Kicked Kite 1');
    const [updated] = await database
      .update(rooms)
      .set({ kickedUserIds: sql`array_append(${rooms.kickedUserIds}, ${kicked.id}::uuid)` })
      .where(eq(rooms.id, room.id))
      .returning();
    expect(updated?.kickedUserIds).toEqual([kicked.id]);
  });

  it('rejects malformed codes and seat counts', async () => {
    const host = await createUser();
    expect(await pgErrorCode(createRoom('abc234', host.id))).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(createRoom('ABC1O0', host.id))).toBe(CHECK_VIOLATION);
    expect(
      await pgErrorCode(
        database.insert(rooms).values({
          code: 'QWE234',
          gameId: 'dev-tictactoe',
          mode: 'classic',
          hostUserId: host.id,
          seatCount: 9,
          ownerEpoch: 1,
          expiresAt: sql`now()`,
        }),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});

describe('room_seats', () => {
  it("doesn't let a user hold two seats in one room", async () => {
    const host = await createUser();
    const room = await createRoom('SEA234', host.id);
    await database.insert(roomSeats).values({ roomId: room.id, seat: 0, userId: host.id });
    expect(
      await pgErrorCode(
        database.insert(roomSeats).values({ roomId: room.id, seat: 1, userId: host.id }),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('lets one seat hold only one occupant', async () => {
    const host = await createUser();
    const other = await createUser('Calm Kite 7');
    const room = await createRoom('SEB234', host.id);
    await database.insert(roomSeats).values({ roomId: room.id, seat: 0, userId: host.id });
    expect(
      await pgErrorCode(
        database.insert(roomSeats).values({ roomId: room.id, seat: 0, userId: other.id }),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('allows several empty or bot seats, and the same user in different rooms', async () => {
    const host = await createUser();
    const roomA = await createRoom('SEC234', host.id);
    const roomB = await createRoom('SED234', host.id);
    await database.insert(roomSeats).values([
      { roomId: roomA.id, seat: 0, userId: host.id },
      { roomId: roomA.id, seat: 1, userId: null, botLevel: 'easy' },
      { roomId: roomA.id, seat: 2, userId: null },
      { roomId: roomB.id, seat: 0, userId: host.id },
    ]);
    const seats = await database.select().from(roomSeats);
    expect(seats).toHaveLength(4);
  });

  it('frees the user once their seat is cleared (a leave)', async () => {
    const host = await createUser();
    const room = await createRoom('SEE234', host.id);
    await database.insert(roomSeats).values({ roomId: room.id, seat: 0, userId: host.id });
    await database
      .update(roomSeats)
      .set({ userId: null, leftAt: sql`now()` })
      .where(eq(roomSeats.roomId, room.id));
    await database.insert(roomSeats).values({ roomId: room.id, seat: 1, userId: host.id });
  });
});

describe('devices', () => {
  it('keeps push tokens unique across users', async () => {
    const a = await createUser('A');
    const b = await createUser('B');
    await database
      .insert(devices)
      .values({ userId: a.id, platform: 'android', pushToken: 'ExponentPushToken[x]' });
    expect(
      await pgErrorCode(
        database
          .insert(devices)
          .values({ userId: b.id, platform: 'android', pushToken: 'ExponentPushToken[x]' }),
      ),
    ).toBe(UNIQUE_VIOLATION);
    // Devices without a token don't collide.
    await database.insert(devices).values([
      { userId: a.id, platform: 'web' },
      { userId: b.id, platform: 'web' },
    ]);
  });

  it('supports the reassigning upsert from ARCHITECTURE §9', async () => {
    const a = await createUser('A');
    const b = await createUser('B');
    await database
      .insert(devices)
      .values({ userId: a.id, platform: 'android', pushToken: 'tok-1' });
    await database
      .insert(devices)
      .values({ userId: b.id, platform: 'android', pushToken: 'tok-1' })
      .onConflictDoUpdate({ target: devices.pushToken, set: { userId: b.id } });
    const rows = await database.select().from(devices).where(eq(devices.pushToken, 'tok-1'));
    expect(rows.map((row) => row.userId)).toEqual([b.id]);
  });
});

describe('match_actions', () => {
  it('dedupes retried actions by (match, seat, clientActionId) but not timeouts', async () => {
    const host = await createUser();
    const room = await createRoom('MAT234', host.id);
    const [match] = await database
      .insert(matches)
      .values({
        roomId: room.id,
        gameId: 'dev-tictactoe',
        mode: 'classic',
        seed: '0123456789abcdef0123456789abcdef',
        logicVersion: 1,
        stateVersion: 1,
      })
      .returning();
    if (!match) throw new Error('no match');

    await database.insert(matchActions).values([
      {
        matchId: match.id,
        seq: 0,
        kind: 'action',
        seat: 0,
        payload: { cell: 4 },
        gameNow: 0,
        clientActionId: 'act-0001',
      },
      { matchId: match.id, seq: 1, kind: 'timeout', seat: 1, payload: {}, gameNow: 15_000 },
      { matchId: match.id, seq: 2, kind: 'timeout', seat: 1, payload: {}, gameNow: 30_000 },
    ]);
    expect(
      await pgErrorCode(
        database.insert(matchActions).values({
          matchId: match.id,
          seq: 3,
          kind: 'action',
          seat: 0,
          payload: { cell: 4 },
          gameNow: 31_000,
          clientActionId: 'act-0001',
        }),
      ),
    ).toBe(UNIQUE_VIOLATION);
    // ON CONFLICT DO NOTHING makes a replayed append harmless.
    const replayed = await database
      .insert(matchActions)
      .values({
        matchId: match.id,
        seq: 0,
        kind: 'action',
        seat: 0,
        payload: { cell: 4 },
        gameNow: 0,
      })
      .onConflictDoNothing()
      .returning();
    expect(replayed).toEqual([]);
  });
});

describe('catalog seed', () => {
  it('seeds the 10 v1 games as coming_soon plus the 2 dev games', async () => {
    const rows = await database.select().from(games).orderBy(games.sort);
    expect(rows.map((row) => row.id)).toEqual([
      'cricket',
      'ludo',
      'carrom',
      'quiz',
      'runner',
      'lantern-quest',
      'kolam',
      'koi-pond',
      'color-sort',
      'zen-garden',
      'dev-tictactoe',
      'dev-secret-pick',
    ]);
    const shelves = Object.fromEntries(rows.map((row) => [row.id, row.shelf]));
    expect(shelves).toMatchObject({
      cricket: 'friends',
      ludo: 'friends',
      carrom: 'friends',
      quiz: 'friends',
      runner: 'adventure',
      'lantern-quest': 'adventure',
      kolam: 'relax',
      'koi-pond': 'relax',
      'color-sort': 'relax',
      'zen-garden': 'relax',
    });
    expect(rows.filter((row) => row.status === 'coming_soon')).toHaveLength(10);
    expect(rows.filter((row) => row.status === 'dev').map((row) => row.id)).toEqual([
      'dev-tictactoe',
      'dev-secret-pick',
    ]);
  });

  it('is idempotent and never overwrites ops changes', async () => {
    await database
      .update(games)
      .set({ status: 'live', featured: true })
      .where(eq(games.id, 'cricket'));

    expect(await seedCatalog(database)).toEqual([]);
    expect(await seedCatalog(database)).toEqual([]);

    expect(await database.$count(games)).toBe(CATALOG_SEED.length);
    const [cricket] = await database.select().from(games).where(eq(games.id, 'cricket'));
    expect(cricket).toMatchObject({ status: 'live', featured: true });
  });

  it('restores missing rows', async () => {
    await database.delete(games).where(eq(games.id, 'kolam'));
    expect(await seedCatalog(database)).toEqual(['kolam']);
  });
});

describe('server epoch', () => {
  it('increments on every boot, inside a transaction too', async () => {
    expect(await bumpServerEpoch(database)).toBe(1);
    expect(await bumpServerEpoch(database)).toBe(2);
    expect(await database.transaction((tx) => bumpServerEpoch(tx))).toBe(3);
  });

  it('allows only the single row', async () => {
    expect(await pgErrorCode(database.insert(schema.serverState).values({ id: 2, epoch: 0 }))).toBe(
      CHECK_VIOLATION,
    );
  });
});

describe('pool', () => {
  it('uses the ARCHITECTURE §5.3 settings and always handles errors', async () => {
    const fresh = createPool(testDb.url);
    try {
      expect(fresh.options.max).toBe(POOL_MAX);
      expect(POOL_MAX).toBe(5);
      expect(fresh.options.idleTimeoutMillis).toBe(POOL_IDLE_TIMEOUT_MS);
      expect(POOL_IDLE_TIMEOUT_MS).toBe(5_000);
      expect(fresh.options.min ?? 0).toBe(0);
      expect(fresh.listenerCount('error')).toBeGreaterThan(0);
      // Creating a pool opens nothing (Neon can stay asleep).
      expect(fresh.totalCount).toBe(0);
    } finally {
      await fresh.end();
    }
  });

  it('routes idle-client errors to the handler instead of crashing', async () => {
    const seen: Error[] = [];
    const fresh = createPool(testDb.url, { onError: (error) => seen.push(error) });
    try {
      fresh.emit('error', new Error('Connection terminated unexpectedly'));
      expect(seen.map((error) => error.message)).toEqual(['Connection terminated unexpectedly']);
    } finally {
      await fresh.end();
    }
  });
});
