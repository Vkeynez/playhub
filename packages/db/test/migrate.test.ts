import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_LOCK_KEY, MIGRATIONS_FOLDER, MigrationError, runMigrations } from '../src';
import { startTestDb, type TestDb } from '../src/testing';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
});

afterAll(async () => {
  await testDb?.stop();
});

async function query<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

const journalEntries = async (url: string) =>
  (await query<{ n: string }>(url, 'SELECT count(*) AS n FROM drizzle.__drizzle_migrations'))[0]?.n;

describe('runMigrations', () => {
  it('applies every migration to an empty database', async () => {
    const url = await testDb.createDatabase('fresh');
    await runMigrations({ directUrl: url, migrationsFolder: MIGRATIONS_FOLDER });

    const tables = (
      await query<{ tablename: string }>(
        url,
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      )
    ).map((row) => row.tablename);
    expect(tables.sort()).toEqual(
      [
        'activity',
        'app_releases',
        'auth_identities',
        'devices',
        'games',
        'match_actions',
        'match_participants',
        'matches',
        'progress_events',
        'progress_ledger',
        'quiz_question_text',
        'quiz_questions',
        'quiz_reports',
        'quiz_seen',
        'recent_players',
        'refresh_tokens',
        'room_seats',
        'rooms',
        'save_slots',
        'server_state',
        'user_game_stats',
        'users',
      ].sort(),
    );

    // The custom migration inserts the single fencing-epoch row.
    expect(await query(url, 'SELECT id, epoch FROM server_state')).toEqual([{ id: 1, epoch: '0' }]);
    expect(await journalEntries(url)).toBe('2');
  });

  it('is a no-op the second time', async () => {
    const url = await testDb.createDatabase('twice');
    await runMigrations({ directUrl: url, migrationsFolder: MIGRATIONS_FOLDER });
    await query(url, 'UPDATE server_state SET epoch = 7');

    await runMigrations({ directUrl: url, migrationsFolder: MIGRATIONS_FOLDER });

    expect(await journalEntries(url)).toBe('2');
    expect(await query(url, 'SELECT epoch FROM server_state')).toEqual([{ epoch: '7' }]);
  });

  it('serializes concurrent runs with the advisory lock', async () => {
    const url = await testDb.createDatabase('concurrent');
    const runs = Array.from({ length: 3 }, () =>
      runMigrations({ directUrl: url, migrationsFolder: MIGRATIONS_FOLDER }),
    );
    await expect(Promise.all(runs)).resolves.toBeDefined();
    expect(await journalEntries(url)).toBe('2');
  });

  it('releases the lock when it finishes, so a later session can take it', async () => {
    const url = await testDb.createDatabase('lock_released');
    await runMigrations({ directUrl: url, migrationsFolder: MIGRATIONS_FOLDER });
    const [row] = await query<{ locked: boolean }>(
      url,
      `SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) AS locked`,
    );
    expect(row?.locked).toBe(true);
  });

  it('throws a MigrationError when it cannot migrate', async () => {
    const unreachable = testDb.url.replace(/\/postgres$/, '/does_not_exist');
    await expect(
      runMigrations({ directUrl: unreachable, migrationsFolder: MIGRATIONS_FOLDER }),
    ).rejects.toThrow(MigrationError);
    const url = await testDb.createDatabase('bad_folder');
    await expect(
      runMigrations({ directUrl: url, migrationsFolder: '/nonexistent/migrations' }),
    ).rejects.toThrow(/Database migration failed/);
  });
});
