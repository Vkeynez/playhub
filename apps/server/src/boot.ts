// Boot and shutdown (ARCHITECTURE §5.5, §5.6). `main.ts` wires these to the process; tests call
// them directly.

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { bumpServerEpoch, createPool, db, runMigrations, seedCatalog } from '@gp/db';
import { buildApp, type Pool } from './app';
import type { Env } from './env';

/** SIGTERM drain budget for room writes; Render kills the process 30 s after SIGTERM. */
const DRAIN_TIMEOUT_MS = 5_000;

export interface LogSink {
  write(line: string): void;
}

/** pino-compatible JSON lines for the steps before Fastify's logger exists. */
export function bootLogger(sink: LogSink = process.stdout) {
  const write = (level: number, msg: string, fields: Record<string, unknown> = {}) =>
    sink.write(
      `${JSON.stringify({ level, time: Date.now(), pid: process.pid, ...fields, msg })}\n`,
    );
  return {
    info: (msg: string, fields?: Record<string, unknown>) => write(30, msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => write(40, msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => write(50, msg, fields),
  };
}

export const errorFields = (error: unknown): Record<string, unknown> =>
  error instanceof Error
    ? { err: { type: error.name, message: error.message, stack: error.stack } }
    : { err: String(error) };

export interface BootOptions {
  env: Env;
  migrationsFolder: string;
  /** Logged at boot (ARCHITECTURE §5.5 step 1). */
  disabledFeatures?: string[];
  /** Defaults to `0.0.0.0` and `env.PORT`; tests use `127.0.0.1` and port 0. */
  host?: string;
  port?: number;
  logStream?: LogSink;
}

export interface RunningServer {
  app: FastifyInstance;
  pool: Pool;
  epoch: number;
  bootId: string;
  port: number;
  /** Drain sockets with `server:moving`, then close the app and the pool. Idempotent. */
  shutdown(signal: string): Promise<void>;
}

/** Migrate → pool → fence → app → listen. Any failure rejects; the caller exits 1. */
export async function bootServer(options: BootOptions): Promise<RunningServer> {
  const { env } = options;
  const log = bootLogger(options.logStream);
  const bootId = randomUUID();
  const started = performance.now();

  if (options.disabledFeatures?.length) {
    log.info('optional features disabled', { disabled: options.disabledFeatures });
  }

  await runMigrations({
    directUrl: env.DATABASE_URL_DIRECT,
    migrationsFolder: options.migrationsFolder,
  });
  const migratedMs = Math.round(performance.now() - started);

  let app: FastifyInstance | null = null;
  const pool = createPool(env.DATABASE_URL, {
    onError: (error) =>
      app
        ? app.log.warn({ err: error }, 'idle pg client error')
        : log.warn('idle pg client error', errorFields(error)),
  });

  try {
    const epoch = await bumpServerEpoch(db(pool));
    // Rooms reference `games`; insert any missing catalog rows (existing rows are left to ops).
    await seedCatalog(db(pool));
    const built = buildApp({ env, pool, epoch, bootId, logStream: options.logStream });
    app = built;
    await built.listen({ host: options.host ?? '0.0.0.0', port: options.port ?? env.PORT });
    const address = built.server.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : (options.port ?? env.PORT);

    built.log.info(
      {
        bootId,
        epoch,
        buildSha: env.BUILD_SHA,
        port,
        migratedMs,
        bootMs: Math.round(performance.now() - started),
        authTransport: env.AUTH_TRANSPORT,
        trustProxyHops: env.TRUST_PROXY_HOPS,
        corsOrigins: env.CORS_ORIGINS.length,
        protocol: built.realtime.protocol,
      },
      'server booted',
    );

    let closing: Promise<void> | null = null;
    const shutdown = (signal: string): Promise<void> => {
      closing ??= (async () => {
        built.log.info({ signal, sockets: built.realtime.socketCount() }, 'shutting down');
        // Snapshot and release every room before telling clients to move (§5.6).
        await Promise.race([
          built.rooms.drain(),
          new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS).unref()),
        ]);
        built.realtime.drain('DEPLOY');
        await built.close();
        await pool.end();
        built.log.info({ signal }, 'shutdown complete');
      })();
      return closing;
    };

    return { app: built, pool, epoch, bootId, port, shutdown };
  } catch (error) {
    await app?.close().catch(() => {});
    await pool.end().catch(() => {});
    throw error;
  }
}
