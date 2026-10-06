// Test helpers (`@gp/db/testing`): a throwaway real Postgres 17 per test file, no Docker.
// Never imported by production code.

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { runMigrations } from './migrate';
import { MIGRATIONS_FOLDER } from './paths';
import { createPool, db } from './pool';
import { seedCatalog } from './seed';

export { MIGRATIONS_FOLDER } from './paths';

export interface TestDb {
  /** Connection URL of the cluster's default database. */
  url: string;
  /** Creates another empty database in the same cluster and returns its URL. */
  createDatabase(name: string): Promise<string>;
  /** Stops Postgres and deletes its data directory. */
  stop(): Promise<void>;
}

export interface StartTestDbOptions {
  /** Apply the migrations from `packages/db/drizzle` before returning. Default `false`. */
  migrate?: boolean;
  /** Also seed the catalog (implies `migrate`). Default `false`. */
  seed?: boolean;
}

const USER = 'postgres';
const PASSWORD = 'postgres';
const START_ATTEMPTS = 3;

function urlFor(port: number, database: string): string {
  return `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${database}`;
}

/** Asks the OS for a free TCP port on loopback. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error('Could not allocate a port'))));
    });
  });
}

async function startCluster(baseDir: string, attempt: number, logs: string[]) {
  const port = await freePort();
  const instance = new EmbeddedPostgres({
    databaseDir: path.join(baseDir, `data-${attempt}`),
    port,
    user: USER,
    password: PASSWORD,
    authMethod: 'password',
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--no-sync'],
    postgresFlags: Object.entries({
      // Durability is irrelevant for a throwaway test cluster; speed is not.
      fsync: 'off',
      synchronous_commit: 'off',
      full_page_writes: 'off',
      listen_addresses: '127.0.0.1',
      unix_socket_directories: baseDir,
    }).flatMap(([name, value]) => ['-c', `${name}=${value}`]),
    onLog: (message) => logs.push(message),
    onError: (error) => logs.push(error instanceof Error ? error.message : String(error)),
  });
  try {
    await instance.initialise();
    await instance.start();
    return { instance, port };
  } catch (error) {
    await instance.stop().catch(() => {});
    throw error;
  }
}

/**
 * Starts a fresh Postgres 17 (embedded-postgres) on a random free port, in a temp directory that
 * is deleted on `stop()`. Use one per test file and share it across that file's tests.
 */
export async function startTestDb(options: StartTestDbOptions = {}): Promise<TestDb> {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'gp-pg-'));
  const logs: string[] = [];

  let started: Awaited<ReturnType<typeof startCluster>> | null = null;
  let lastError: unknown = null;
  // The free port can be taken between probing and binding; retry on a new one.
  for (let attempt = 1; attempt <= START_ATTEMPTS && !started; attempt++) {
    try {
      started = await startCluster(baseDir, attempt, logs);
    } catch (error) {
      lastError = error;
    }
  }
  if (!started) {
    await rm(baseDir, { recursive: true, force: true });
    throw new Error(`embedded-postgres failed to start:\n${logs.slice(-20).join('')}`, {
      cause: lastError,
    });
  }

  const { instance, port } = started;
  const url = urlFor(port, 'postgres');
  const testDb: TestDb = {
    url,
    async createDatabase(name) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
      } finally {
        await client.end();
      }
      return urlFor(port, name);
    },
    async stop() {
      await instance.stop();
      await rm(baseDir, { recursive: true, force: true });
    },
  };

  try {
    if (options.migrate || options.seed) {
      await runMigrations({ directUrl: url, migrationsFolder: MIGRATIONS_FOLDER });
    }
    if (options.seed) await withDb(url, (database) => seedCatalog(database));
  } catch (error) {
    await testDb.stop();
    throw error;
  }
  return testDb;
}

/** Runs `fn` with a short-lived Drizzle instance over its own pool. */
export async function withDb<T>(
  url: string,
  fn: (database: ReturnType<typeof db>) => Promise<T>,
): Promise<T> {
  const pool = createPool(url, { applicationName: 'gp-test' });
  try {
    return await fn(db(pool));
  } finally {
    await pool.end();
  }
}

export interface ResetDbOptions {
  /** Re-seed the catalog after truncating. Default `true`. */
  seed?: boolean;
}

/**
 * Empties every table in the `public` schema (the migration journal lives in the `drizzle`
 * schema and is kept), restores the epoch row, and re-seeds the catalog. Leaves the database as
 * if it had just been migrated and seeded.
 */
export async function resetDb(url: string, options: ResetDbOptions = {}): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    if (rows.length > 0) {
      const tables = rows
        .map((row) => `public.${client.escapeIdentifier(row.tablename)}`)
        .join(', ');
      await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
    }
    await client.query(
      `INSERT INTO server_state (id, epoch) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`,
    );
  } finally {
    await client.end();
  }
  if (options.seed ?? true) await withDb(url, (database) => seedCatalog(database));
}
