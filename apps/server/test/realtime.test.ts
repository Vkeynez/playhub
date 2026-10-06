import { PROTOCOL_VERSION, type ServerEventPayload } from '@gp/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { HelloAckWithBoot } from '../src/realtime';
import {
  ALLOWED_ORIGIN,
  connect,
  hello,
  sink,
  testEnv,
  throwingPool,
  type TestSocket,
} from './helpers';

// Socket handlers never touch Postgres (ARCHITECTURE §5.3 rule 3): the app gets a pool that throws.
const db = throwingPool();
let app: FastifyInstance;
let port: number;
const sockets: TestSocket[] = [];

async function open(headers?: Record<string, string>): Promise<TestSocket> {
  const socket = await connect(port, headers);
  sockets.push(socket);
  return socket;
}

beforeAll(async () => {
  app = buildApp({
    env: testEnv(),
    pool: db.pool,
    epoch: 42,
    bootId: 'boot-rt',
    logStream: sink(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await app?.close();
  await db.pool.end();
  expect(db.calls()).toBe(0);
});

describe('hello', () => {
  it('acks a current client with the protocol range, server time, bootId and epoch', async () => {
    const socket = await open();
    const before = Date.now();
    const ack = (await socket.emitWithAck('hello', hello())) as HelloAckWithBoot;
    expect(ack).toMatchObject({
      ok: true,
      protocol: { min: 1, max: PROTOCOL_VERSION },
      bootId: 'boot-rt',
      epoch: 42,
    });
    expect(ack.serverTime).toBeGreaterThanOrEqual(before);
  });

  it('rejects an old client with CLIENT_TOO_OLD and a newer one with SERVER_TOO_OLD', async () => {
    const socket = await open();
    expect(await socket.emitWithAck('hello', hello(0))).toMatchObject({
      ok: false,
      reason: 'CLIENT_TOO_OLD',
    });
    expect(await socket.emitWithAck('hello', hello(PROTOCOL_VERSION + 1))).toMatchObject({
      ok: false,
      reason: 'SERVER_TOO_OLD',
    });
  });

  it('honours MIN_PROTOCOL_VERSION', async () => {
    const strict = buildApp({
      env: testEnv({ MIN_PROTOCOL_VERSION: String(PROTOCOL_VERSION + 1) }),
      pool: db.pool,
      epoch: 1,
      bootId: 'b',
      logStream: sink(),
    });
    await strict.listen({ host: '127.0.0.1', port: 0 });
    const address = strict.server.address();
    const socket = await connect(typeof address === 'object' && address ? address.port : 0);
    expect(await socket.emitWithAck('hello', hello())).toMatchObject({
      ok: false,
      reason: 'CLIENT_TOO_OLD',
    });
    socket.close();
    await strict.close();
  });

  it('answers an invalid payload with an INVALID_PAYLOAD error event', async () => {
    const socket = await open();
    const error = new Promise<ServerEventPayload<'error'>>((resolve) =>
      socket.once('error', resolve),
    );
    socket.emit('hello', { ...hello(), platform: 'ios' } as never, () => {});
    expect(await error).toEqual({ code: 'INVALID_PAYLOAD', event: 'hello' });
  });
});

describe('clock:ping', () => {
  it('echoes t0 with the server time', async () => {
    const socket = await open();
    const before = Date.now();
    const pong = await socket.emitWithAck('clock:ping', { t0: 1234.5 });
    expect(pong.t0).toBe(1234.5);
    expect(pong.ts).toBeGreaterThanOrEqual(before);
    expect(pong.ts).toBeLessThanOrEqual(Date.now());
  });
});

describe('connections', () => {
  it('counts sockets on /health', async () => {
    await open();
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = response.json<{ sockets: number }>();
    expect(body.sockets).toBeGreaterThanOrEqual(1);
    expect(body.sockets).toBe(app.realtime.socketCount());
  });

  it('accepts allowed and same-host origins and refuses others on the WebSocket upgrade', async () => {
    await expect(open({ origin: ALLOWED_ORIGIN })).resolves.toBeDefined();
    await expect(open({ origin: `http://127.0.0.1:${port}` })).resolves.toBeDefined();
    await expect(open({ origin: 'https://evil.example' })).rejects.toThrow();
  });

  it('answers events this build does not handle yet', async () => {
    const socket = await open();
    const error = new Promise<ServerEventPayload<'error'>>((resolve) =>
      socket.once('error', resolve),
    );
    socket.emit('presence', { state: 'active' } as never);
    expect((await error).code).toMatch(/^(HELLO_REQUIRED|UNKNOWN_EVENT)$/);
  });
});
