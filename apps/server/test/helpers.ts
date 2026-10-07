import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createPool } from '@gp/db';
import {
  parseServerEvent,
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type ClientEventInput,
  type RoomSnapshot,
  type ServerToClientEvents,
} from '@gp/protocol';
import { io, type Socket } from 'socket.io-client';
import type { Pool } from '../src/app';
import { TokenService } from '../src/auth/tokens';
import { parseEnv, type Env } from '../src/env';
import type { TimerHandle, Timers } from '../src/timers';

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

/** Signs access tokens with the test env's JWT_SECRET. */
export const testTokens = new TokenService({
  jwtSecret: rawEnv().JWT_SECRET,
  refreshSecret: rawEnv().REFRESH_SECRET,
  rotateSecret: rawEnv().K_ROTATE,
});

export async function accessTokenFor(userId: string = randomUUID()): Promise<string> {
  return (await testTokens.signAccess(userId)).token;
}

/**
 * Connects over WebSocket only and resolves once connected (rejects on connect_error). Without a
 * `token`, signs one for a random user; `null` connects without one.
 */
export async function connect(
  port: number,
  headers: Record<string, string> = {},
  token?: string | null,
): Promise<TestSocket> {
  const auth = token === null ? {} : { token: token ?? (await accessTokenFor()) };
  const socket: TestSocket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: headers,
    auth,
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

/** Counts pool checkouts (every query and every transaction takes one): proof of "no DB access". */
export function countCheckouts(pool: Pool): () => number {
  let count = 0;
  pool.on('acquire', () => count++);
  return () => count;
}

/** A manual clock for room timers: `advance()` fires due timers in order, settling between them. */
export class ManualTimers implements Timers {
  private current: number;
  private seq = 0;
  private pending: { at: number; seq: number; fn: () => void; cancelled: boolean }[] = [];

  /** Waits for room queues and writes after each fired timer (set once the app exists). */
  onSettle: () => Promise<void> = () => Promise.resolve();

  constructor(start = Date.now()) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  after(ms: number, fn: () => void): TimerHandle {
    const timer = { at: this.current + Math.max(0, ms), seq: this.seq++, fn, cancelled: false };
    this.pending.push(timer);
    return { cancel: () => void (timer.cancelled = true) };
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      this.pending = this.pending.filter((timer) => !timer.cancelled);
      const due = this.pending
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.pending.splice(this.pending.indexOf(due), 1);
      this.current = Math.max(this.current, due.at);
      due.fn();
      await this.onSettle();
    }
    this.current = target;
  }
}

/** room:state payloads that failed the protocol schema (tests assert this stays empty). */
export const invalidStates: string[] = [];

/** A socket with its room:state history and a `waitFor` on it. */
export class Player {
  readonly states: RoomSnapshot[] = [];
  private waiters: { test: (s: RoomSnapshot) => boolean; resolve: (s: RoomSnapshot) => void }[] =
    [];

  constructor(
    readonly socket: TestSocket,
    readonly userId: string,
  ) {
    socket.on('room:state', (state) => this.push(state));
  }

  push(state: RoomSnapshot): void {
    const parsed = parseServerEvent('room:state', state);
    if (!parsed.ok) invalidStates.push(parsed.error.message);
    this.states.push(state);
    for (const waiter of [...this.waiters]) {
      if (waiter.test(state)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(state);
      }
    }
  }

  get last(): RoomSnapshot {
    const state = this.states.at(-1);
    if (!state) throw new Error('no room:state yet');
    return state;
  }

  /** The latest state if it matches, else the next one that does. */
  waitFor(test: (s: RoomSnapshot) => boolean, timeoutMs = 5_000): Promise<RoomSnapshot> {
    const latest = this.states.at(-1);
    if (latest && test(latest)) return Promise.resolve(latest);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs);
      this.waiters.push({
        test,
        resolve: (state) => {
          clearTimeout(timer);
          resolve(state);
        },
      });
    });
  }
}
