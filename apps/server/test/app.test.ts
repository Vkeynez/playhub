import { createPool } from '@gp/db';
import { startTestDb, type TestDb } from '@gp/db/testing';
import { HealthResponseSchema } from '@gp/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type Pool } from '../src/app';
import { ADMIN_TOKEN, ALLOWED_ORIGIN, sink, testEnv, throwingPool } from './helpers';

const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

let testDb: TestDb;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb({ migrate: true });
  pool = createPool(testDb.url, { onError: () => {} });
  const env = testEnv({ DATABASE_URL: testDb.url, DATABASE_URL_DIRECT: testDb.url });
  app = buildApp({ env, pool, epoch: 7, bootId: 'boot-test', logStream: sink() });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await testDb?.stop();
});

describe('/health', () => {
  // ARCHITECTURE §5.3 rule 1 / brief §10.2 rule 2: /health must never touch Postgres.
  it('answers 100 times while every pool query and connect throws', async () => {
    const { pool: broken, calls } = throwingPool();
    const isolated = buildApp({
      env: testEnv(),
      pool: broken,
      epoch: 3,
      bootId: 'boot-no-db',
      logStream: sink(),
    });
    try {
      for (let i = 0; i < 100; i++) {
        const response = await isolated.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toMatch(/^application\/json/);
        const body = response.json<Record<string, unknown>>();
        expect(body.ok).toBe(true);
        expect(HealthResponseSchema.safeParse(body).success).toBe(true);
      }
      expect(calls()).toBe(0);
    } finally {
      await isolated.close();
      await broken.end();
    }
  });

  it('reports boot identity and process metrics', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      ok: true,
      bootId: 'boot-test',
      buildSha: 'dev',
      protocolVersion: 1,
      epoch: 7,
      sockets: 0,
      rooms: 0,
    });
    expect(typeof body.elu).toBe('number');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('admin routes', () => {
  const routes = [
    { method: 'GET', url: '/health/deep' },
    { method: 'GET', url: '/ops/headers' },
    { method: 'POST', url: '/ops/bench/carrom?shots=1' },
  ] as const;

  it.each(routes)('$method $url rejects a missing or wrong admin token', async (route) => {
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: ADMIN_TOKEN }]) {
      const response = await app.inject({ ...route, headers });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('/health/deep runs select 1 against Postgres', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deep', headers: admin });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, db: 'up' });
  });

  it('/health/deep answers 503 when the database is unreachable', async () => {
    const { pool: broken } = throwingPool();
    const isolated = buildApp({
      env: testEnv(),
      pool: broken,
      epoch: 1,
      bootId: 'b',
      logStream: sink(),
    });
    const response = await isolated.inject({ method: 'GET', url: '/health/deep', headers: admin });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, db: 'down' });
    await isolated.close();
    await broken.end();
  });

  it('/ops/headers echoes the forwarding chain, honouring TRUST_PROXY_HOPS', async () => {
    const xff = '203.0.113.9, 198.51.100.7';
    const direct = await app.inject({
      method: 'GET',
      url: '/ops/headers',
      headers: { ...admin, 'x-forwarded-for': xff },
    });
    expect(direct.json()).toMatchObject({ xForwardedFor: xff, ip: '127.0.0.1', trustProxyHops: 0 });

    const proxied = buildApp({
      env: testEnv({ TRUST_PROXY_HOPS: '1' }),
      pool,
      epoch: 1,
      bootId: 'b',
      logStream: sink(),
    });
    const response = await proxied.inject({
      method: 'GET',
      url: '/ops/headers',
      headers: { ...admin, 'x-forwarded-for': xff },
    });
    // One trusted hop: the right-most XFF entry is the client, never the client-controlled left one.
    expect(response.json()).toMatchObject({ ip: '198.51.100.7', remoteAddress: '127.0.0.1' });
    await proxied.close();
  });

  it('/ops/bench/carrom runs planck shots and validates shots', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ops/bench/carrom?shots=3',
      headers: admin,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, number>>();
    expect(body.shots).toBe(3);
    expect(body.stepsPerShotMean).toBeGreaterThan(0);
    for (const key of ['msPerShotP50', 'msPerShotP95', 'totalMs']) {
      expect(body[key]).toBeGreaterThan(0);
    }
    const bad = await app.inject({
      method: 'POST',
      url: '/ops/bench/carrom?shots=0',
      headers: admin,
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('CORS', () => {
  it('answers preflights only for CORS_ORIGINS', async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/health/deep',
        headers: { origin, 'access-control-request-method': 'GET' },
      });
    const ok = await preflight(ALLOWED_ORIGIN);
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(ok.headers['access-control-allow-headers']).toContain('authorization');

    const denied = await preflight('https://evil.example');
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets Access-Control-Allow-Origin only for allowed origins', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    const other = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('errors and logging', () => {
  it('unknown routes answer the protocol error shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it('redacts credentials and emails from logs', async () => {
    const lines: string[] = [];
    const logged = buildApp({
      env: testEnv({ LOG_LEVEL: 'info' }),
      pool,
      epoch: 1,
      bootId: 'b',
      logStream: sink(lines),
    });
    logged.log.info(
      {
        authorization: 'Bearer secret-a',
        cookie: 'sid=secret-b',
        user: { token: 'secret-c', idToken: 'secret-d', email: 'someone@example.com' },
        refreshToken: 'secret-e',
      },
      'redaction check',
    );
    await logged.close();
    const output = lines.join('');
    expect(output).toContain('redaction check');
    for (const secret of ['secret-a', 'secret-b', 'secret-c', 'secret-d', 'secret-e', 'someone@']) {
      expect(output).not.toContain(secret);
    }
  });
});
