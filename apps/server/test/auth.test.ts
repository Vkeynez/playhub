import { createPool } from '@gp/db';
import { startTestDb, type TestDb } from '@gp/db/testing';
import { AuthSessionSchema, MeSchema, type AuthSession } from '@gp/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type Pool } from '../src/app';
import { connect, hello, sink, testEnv } from './helpers';

let testDb: TestDb;
let pool: Pool;
let app: FastifyInstance;
let port: number;

const KEY_A = 'guest-key-aaaaaaaaaaaaaaaaaaaaaaaa';

async function guest(guestKey: string, name = 'Asha'): Promise<AuthSession> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/guest',
    payload: { guestKey, name, avatarSeed: `seed-${name}` },
  });
  expect(response.statusCode).toBe(200);
  return AuthSessionSchema.parse(response.json());
}

async function refresh(refreshToken: string) {
  return app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
}

beforeAll(async () => {
  testDb = await startTestDb({ seed: true });
  pool = createPool(testDb.url, { onError: () => {} });
  const env = testEnv({ DATABASE_URL: testDb.url, DATABASE_URL_DIRECT: testDb.url });
  app = buildApp({
    env,
    pool,
    epoch: 1,
    bootId: 'auth',
    logStream: sink(),
    rateLimits: { guestPerKey: [3, 60_000] },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await testDb?.stop();
});

describe('POST /auth/guest', () => {
  it('creates the user once per guest key and returns a session', async () => {
    const first = await guest(KEY_A);
    const again = await guest(KEY_A, 'Renamed');
    expect(again.user.userId).toBe(first.user.userId);
    expect(again.user.name).toBe('Asha');
    expect(first.user).toMatchObject({ kind: 'guest', email: null, locale: 'en' });
    expect(again.refreshToken).not.toBe(first.refreshToken);
    expect(first.accessTokenExpiresAt).toBeGreaterThan(Date.now() + 14 * 60_000);
    const other = await guest('guest-key-bbbbbbbbbbbbbbbbbbbbbbbb', 'Bala');
    expect(other.user.userId).not.toBe(first.user.userId);
  });

  it('rejects bad bodies and rate-limits a guest key', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      payload: { guestKey: 'short', name: 'x', avatarSeed: 'y' },
    });
    expect(bad.statusCode).toBe(400);
    const key = 'guest-key-limited-cccccccccccccccc';
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/guest',
        payload: { guestKey: key, name: 'Limit', avatarSeed: 's' },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe('GET /me', () => {
  it('returns the signed-in user and 401 without a valid token', async () => {
    const session = await guest('guest-key-me-dddddddddddddddddddd', 'Meena');
    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(MeSchema.parse(me.json())).toEqual(session.user);
    expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    const forged = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${session.accessToken}x` },
    });
    expect(forged.statusCode).toBe(401);
  });
});

describe('POST /auth/refresh (idempotent rotation)', () => {
  it('rotates, and re-presenting the old token returns the same successor', async () => {
    const session = await guest('guest-key-rot-eeeeeeeeeeeeeeeeeee', 'Ravi');
    const t0 = session.refreshToken ?? '';
    const first = await refresh(t0);
    expect(first.statusCode).toBe(200);
    const t1 = AuthSessionSchema.parse(first.json()).refreshToken;
    expect(t1).toBeDefined();
    expect(t1).not.toBe(t0);
    const retry = await refresh(t0);
    expect(retry.statusCode).toBe(200);
    expect(AuthSessionSchema.parse(retry.json()).refreshToken).toBe(t1);
    const second = await refresh(t1 ?? '');
    expect(second.statusCode).toBe(200);
    expect(AuthSessionSchema.parse(second.json()).refreshToken).not.toBe(t1);
    expect((await refresh('unknown-token')).statusCode).toBe(401);
  });

  it('never revokes a guest family; rejects only the stale token after 24 h', async () => {
    const session = await guest('guest-key-stale-fffffffffffffffff', 'Sita');
    const t0 = session.refreshToken ?? '';
    const t1 = AuthSessionSchema.parse((await refresh(t0)).json()).refreshToken ?? '';
    await pool.query(
      `UPDATE refresh_tokens SET rotated_at = now() - interval '25 hours' WHERE rotated_at IS NOT NULL
         AND user_id = $1`,
      [session.user.userId],
    );
    expect((await refresh(t0)).statusCode).toBe(401);
    expect((await refresh(t1)).statusCode).toBe(200);
  });

  it('revokes a Google family when a rotated token is reused after 60 s', async () => {
    const session = await guest('guest-key-google-ggggggggggggggggg', 'Gita');
    const t0 = session.refreshToken ?? '';
    await pool.query(`UPDATE users SET kind = 'google' WHERE id = $1`, [session.user.userId]);
    const t1 = AuthSessionSchema.parse((await refresh(t0)).json()).refreshToken ?? '';
    expect(AuthSessionSchema.parse((await refresh(t0)).json()).refreshToken).toBe(t1);
    await pool.query(
      `UPDATE refresh_tokens SET rotated_at = now() - interval '2 minutes'
        WHERE rotated_at IS NOT NULL AND user_id = $1`,
      [session.user.userId],
    );
    expect((await refresh(t0)).statusCode).toBe(401);
    expect((await refresh(t1)).statusCode).toBe(401);
    // The guest key of an account that became a Google account no longer signs in as a guest.
    const viaKey = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      payload: { guestKey: 'guest-key-google-ggggggggggggggggg', name: 'Gita', avatarSeed: 's' },
    });
    expect(viaKey.statusCode).toBe(401);
  });
});

describe('socket handshake', () => {
  it('accepts a session access token and refuses a missing one', async () => {
    const session = await guest('guest-key-sock-hhhhhhhhhhhhhhhhhh', 'Sock');
    const socket = await connect(port, {}, session.accessToken);
    expect(await socket.emitWithAck('hello', hello())).toMatchObject({ ok: true });
    socket.close();
    await expect(connect(port, {}, null)).rejects.toThrow('UNAUTHORIZED');
  });
});
