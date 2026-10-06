// The Fastify app (ARCHITECTURE §5.1 `http`), built without listening so tests can inject requests.
// M2 routes: /health (memory only), /health/deep and /ops/* (ADMIN_TOKEN).

import { createHash, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { createPool } from '@gp/db';
import { PROTOCOL_VERSION, type ApiErrorCode, type HealthResponse } from '@gp/protocol';
import type { Env } from './env';
import { startProcessMetrics } from './metrics';
import { attachRealtime, type Realtime } from './realtime';

export type Pool = ReturnType<typeof createPool>;

declare module 'fastify' {
  interface FastifyInstance {
    realtime: Realtime;
  }
}

/** pino redaction (ARCHITECTURE §5.7), at the top level and one level down (e.g. `req.headers`). */
export const REDACT_PATHS = [
  'authorization',
  'cookie',
  'token',
  'idToken',
  'email',
  'refreshToken',
  '*.authorization',
  '*.cookie',
  '*.token',
  '*.idToken',
  '*.email',
  '*.refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/** /health's body: the protocol DTO plus process-local diagnostics. */
export type HealthBody = HealthResponse & { epoch: number; sockets: number; eldP99Ms: number };

export interface BuildAppOptions {
  env: Env;
  pool: Pool;
  /** This process's fencing epoch (§5.6), from `bumpServerEpoch` at boot. */
  epoch: number;
  bootId: string;
  /** Log destination; defaults to stdout. Tests pass a sink. */
  logStream?: { write(line: string): void };
}

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_HEADERS = 'authorization, content-type, x-request-id';

const BenchQuerySchema = z.object({
  shots: z.coerce.number().int().min(1).max(1_000).default(200),
});

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

function sendError(reply: FastifyReply, status: number, error: ApiErrorCode): FastifyReply {
  return reply.code(status).send({ error });
}

function errorCodeFor(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal';
  return 'bad_request';
}

export function buildApp({
  env,
  pool,
  epoch,
  bootId,
  logStream,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      ...(logStream ? { stream: logStream } : {}),
    },
    // Render's exact hop count, never `true` (§5.7). 0 = trust no proxy. This is what proxy-addr
    // compiles a numeric trustProxy to (Fastify's types don't accept the number form).
    trustProxy:
      env.TRUST_PROXY_HOPS > 0
        ? (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS
        : false,
    bodyLimit: 256 * 1024,
  });

  const metrics = startProcessMetrics();
  app.addHook('onClose', (_instance, done) => {
    metrics.stop();
    done();
  });

  app.decorate(
    'realtime',
    attachRealtime(app, {
      corsOrigins: env.CORS_ORIGINS,
      credentials: env.AUTH_TRANSPORT === 'cookie',
      bootId,
      epoch,
      minProtocolVersion: env.MIN_PROTOCOL_VERSION,
    }),
  );

  // --- CORS (§5.7): only CORS_ORIGINS. Requests without an Origin (native app, curl) pass. --------
  const allowedOrigins = new Set(env.CORS_ORIGINS);
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin === undefined) return;
    reply.header('vary', 'Origin');
    const allowed = allowedOrigins.has(origin);
    if (allowed) {
      reply.header('access-control-allow-origin', origin);
      if (env.AUTH_TRANSPORT === 'cookie') reply.header('access-control-allow-credentials', 'true');
    }
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
      if (!allowed) return sendError(reply, 403, 'forbidden');
      reply.header('access-control-allow-methods', CORS_METHODS);
      reply.header('access-control-allow-headers', CORS_HEADERS);
      reply.header('access-control-max-age', '600');
      return reply.code(204).send();
    }
  });
  // A route for every OPTIONS path, so preflights for any path reach the hook above.
  app.options('/*', async (_request, reply) => reply.code(204).send());

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'not_found'));
  app.setErrorHandler((error: unknown, request, reply) => {
    const raw =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
    const status = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    return sendError(reply, status, errorCodeFor(status));
  });

  // --- /health: process memory only. NEVER touches Postgres (§5.3 rule 1; tested). -------------
  let firstHealthyAt: number | null = null;
  app.get('/health', { logLevel: 'warn' }, async () => {
    if (firstHealthyAt === null) {
      firstHealthyAt = Date.now();
      app.log.info({ firstHealthyAt, bootId }, 'first /health served');
    }
    const body: HealthBody = {
      ok: true,
      bootId,
      buildSha: env.BUILD_SHA,
      protocolVersion: PROTOCOL_VERSION,
      uptime: Math.round(process.uptime()),
      rooms: 0,
      elu: metrics.elu(),
      epoch,
      sockets: app.realtime.socketCount(),
      eldP99Ms: metrics.eldP99Ms(),
    };
    return body;
  });

  // --- Admin-only routes (ADMIN_TOKEN bearer) ----------------------------------------------------
  const adminDigest = sha256(env.ADMIN_TOKEN);
  const isAdmin = (request: FastifyRequest): boolean => {
    const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
    return match?.[1] !== undefined && timingSafeEqual(sha256(match[1]), adminDigest);
  };

  let benchRunning = false;
  void app.register(async (admin) => {
    admin.addHook('onRequest', async (request, reply) => {
      if (!isAdmin(request)) return sendError(reply, 401, 'unauthorized');
    });

    // Manual use only: wakes Neon.
    admin.get('/health/deep', async (request, reply) => {
      const started = performance.now();
      try {
        await pool.query('select 1');
        return { ok: true, db: 'up', latencyMs: Math.round(performance.now() - started) };
      } catch (error) {
        request.log.warn({ err: error }, '/health/deep: select 1 failed');
        return reply
          .code(503)
          .send({ ok: false, db: 'down', latencyMs: Math.round(performance.now() - started) });
      }
    });

    // Measures Render's proxy hop count for TRUST_PROXY_HOPS (§5.7).
    admin.get('/ops/headers', async (request) => ({
      xForwardedFor: request.headers['x-forwarded-for'] ?? null,
      remoteAddress: request.socket.remoteAddress ?? null,
      ip: request.ip,
      ips: request.ips ?? [],
      trustProxyHops: env.TRUST_PROXY_HOPS,
    }));

    // Spike (d) on the real instance (§5.4). No DB; planck loads only here.
    admin.post('/ops/bench/carrom', async (request, reply) => {
      const query = BenchQuerySchema.safeParse(request.query);
      if (!query.success) return sendError(reply, 400, 'bad_request');
      if (benchRunning) return sendError(reply, 409, 'conflict');
      benchRunning = true;
      try {
        const { runCarromBench } = await import('./ops/carrom-bench');
        const { shots } = query.data;
        return await runCarromBench({ shots, warmupShots: Math.min(20, shots), seed: 1 });
      } finally {
        benchRunning = false;
      }
    });
  });

  return app;
}
