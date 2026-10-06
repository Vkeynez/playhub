import { MIGRATIONS_FOLDER } from '@gp/db';
import { startTestDb, type TestDb } from '@gp/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootServer, type RunningServer } from '../src/boot';
import { connect, hello, sink, testEnv } from './helpers';

let testDb: TestDb;
const running: RunningServer[] = [];

async function boot(): Promise<RunningServer> {
  const server = await bootServer({
    env: testEnv({ DATABASE_URL: testDb.url, DATABASE_URL_DIRECT: testDb.url }),
    migrationsFolder: MIGRATIONS_FOLDER,
    host: '127.0.0.1',
    port: 0,
    logStream: sink(),
  });
  running.push(server);
  return server;
}

beforeAll(async () => {
  // A fresh, unmigrated database: boot must migrate it.
  testDb = await startTestDb();
});

afterAll(async () => {
  for (const server of running) await server.shutdown('test-teardown');
  await testDb?.stop();
});

describe('boot', () => {
  it('migrates, then takes a higher epoch on every boot', async () => {
    const first = await boot();
    const { rows } = await first.pool.query<{ n: number }>(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(2);
    expect(first.epoch).toBeGreaterThanOrEqual(1);

    const second = await boot();
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(second.bootId).not.toBe(first.bootId);

    const health = await fetch(`http://127.0.0.1:${second.port}/health`);
    expect(await health.json()).toMatchObject({ ok: true, epoch: second.epoch });
  });

  it('fails when the database is unreachable', async () => {
    await expect(
      bootServer({
        env: testEnv(),
        migrationsFolder: MIGRATIONS_FOLDER,
        host: '127.0.0.1',
        port: 0,
        logStream: sink(),
      }),
    ).rejects.toThrow();
  });
});

describe('shutdown (the SIGTERM path)', () => {
  it('emits server:moving to every socket, disconnects them and closes the app and pool', async () => {
    const server = await boot();
    const socket = await connect(server.port);
    expect(await socket.emitWithAck('hello', hello())).toMatchObject({ ok: true });

    const moving = new Promise((resolve) => socket.once('server:moving', resolve));
    const disconnected = new Promise((resolve) => socket.once('disconnect', resolve));
    await server.shutdown('SIGTERM');

    expect(await moving).toEqual({ reason: 'DEPLOY' });
    await disconnected;
    expect(server.app.server.listening).toBe(false);
    expect(server.pool.ended).toBe(true);
    // Idempotent: a second signal waits for the same drain.
    await expect(server.shutdown('SIGINT')).resolves.toBeUndefined();
    socket.close();
  });
});
