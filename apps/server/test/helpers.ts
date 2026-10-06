import { createServer } from 'node:net';
import { createPool } from '@gp/db';
import {
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type ClientEventInput,
  type ServerToClientEvents,
} from '@gp/protocol';
import { io, type Socket } from 'socket.io-client';
import type { Pool } from '../src/app';
import { parseEnv, type Env } from '../src/env';

export const ADMIN_TOKEN = 'admin-token-for-tests-0123456789abcdef';
export const ALLOWED_ORIGIN = 'https://web.example.test';

/** Secrets and URLs for a valid env. Values are long enough for the 32-character rule. */
export function rawEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none',
    DATABASE_URL_DIRECT: 'postgres://u:p@127.0.0.1:1/none',
    JWT_SECRET: 'jwt-secret-for-tests-0123456789abcdef',
    REFRESH_SECRET: 'refresh-secret-for-tests-0123456789ab',
    K_ROTATE: 'k-rotate-for-tests-0123456789abcdefgh',
    ADMIN_TOKEN,
    CORS_ORIGINS: `${ALLOWED_ORIGIN}, http://localhost:8081`,
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

export function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  const result = parseEnv(rawEnv(overrides));
  if (!result.ok) throw new Error(`test env invalid: ${JSON.stringify(result)}`);
  return result.env;
}

/** Discards log lines (or collects them, when `lines` is given). */
export function sink(lines?: string[]) {
  return { write: (line: string) => void lines?.push(line) };
}

/** A pool whose `query` and `connect` throw and count every attempt: proof of "no DB access". */
export function throwingPool(): { pool: Pool; calls: () => number } {
  const pool = createPool('postgres://u:p@127.0.0.1:1/none', { onError: () => {} });
  let calls = 0;
  const boom = (): never => {
    calls++;
    throw new Error('this code path must not touch Postgres');
  };
  pool.query = boom;
  pool.connect = boom;
  return { pool, calls: () => calls };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

export type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Connects over WebSocket only and resolves once connected (rejects on connect_error). */
export function connect(port: number, headers: Record<string, string> = {}): Promise<TestSocket> {
  const socket: TestSocket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: headers,
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

export function hello(protocolVersion = PROTOCOL_VERSION): ClientEventInput<'hello'> {
  return {
    protocolVersion,
    appVersion: '0.1.0',
    platform: 'web',
    deviceId: 'device-test-1',
    locale: 'en',
  };
}
