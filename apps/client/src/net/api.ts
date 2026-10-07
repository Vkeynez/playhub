// REST client with cold-start handling (ARCHITECTURE §6.7).
//
// Render's free instance sleeps; while it wakes, requests fail with 502/503, Render's HTML spin-up
// page (status 200, text/html), or a network TypeError. All three are WAKING: the wake banner shows,
// GET /health is polled (backoff 1→5 s, up to 120 s) until it answers {ok:true}, then the original
// request is replayed. /health never touches Postgres, so polling it never wakes Neon.
import { ApiErrorSchema, HealthResponseSchema, restRoutes } from '@gp/protocol';
import type { ApiErrorCode, RestResponse, RestRouteName } from '@gp/protocol';
import type { z } from 'zod';

import { API_URL } from './config';
import { wakeStore } from './wake';

export type ClientErrorCode = ApiErrorCode | 'offline' | 'asleep' | 'invalid_response';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

/** The server is (probably) waking up. Internal to apiFetch; callers see ApiError('asleep') at worst. */
export class WakingError extends Error {
  constructor() {
    super('server is waking');
    this.name = 'WakingError';
  }
}

export interface ApiDeps {
  baseUrl: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  isOnline(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const defaultApiDeps: ApiDeps = {
  baseUrl: API_URL,
  fetch: (url, init) => globalThis.fetch(url, init),
  isOnline: () => {
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
    return nav?.onLine ?? true;
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** What "awake" means (§6.7): {ok:true, bootId, protocolVersion}; other fields may evolve. */
const AwakeSchema = HealthResponseSchema.pick({ ok: true, bootId: true, protocolVersion: true });

const WAKE_TIMEOUT_MS = 120_000;
/** A request slower than this shows the wake banner even before it is classified WAKING. */
const SLOW_MS = 2_000;
const MAX_WAKE_RETRIES = 2;

function isJson(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').toLowerCase().includes('json');
}

async function send(deps: ApiDeps, path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await deps.fetch(`${deps.baseUrl}${path}`, init);
  } catch (e) {
    if (e instanceof TypeError && deps.isOnline()) throw new WakingError();
    throw new ApiError(0, 'offline', String(e));
  }
  if (res.status === 502 || res.status === 503 || !isJson(res)) throw new WakingError();
  return res;
}

/** Polls GET /health until it reports {ok:true}. Throws ApiError('asleep') after `timeoutMs`. */
export async function waitForHealth(
  deps: ApiDeps = defaultApiDeps,
  timeoutMs = WAKE_TIMEOUT_MS,
): Promise<void> {
  const until = deps.now() + timeoutMs;
  let delay = 1_000;
  for (;;) {
    try {
      const res = await send(deps, '/health', { headers: { accept: 'application/json' } });
      if (AwakeSchema.safeParse(await res.json()).success) return;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'offline') throw e;
    }
    if (deps.now() + delay > until) throw new ApiError(0, 'asleep');
    await deps.sleep(delay);
    delay = Math.min(5_000, delay + 1_000);
  }
}

type Routes = typeof restRoutes;
export type BodyOf<R extends RestRouteName> = Routes[R] extends { body: infer B extends z.ZodType }
  ? z.input<B>
  : undefined;

export interface ApiRequest<R extends RestRouteName> {
  body?: BodyOf<R>;
  params?: Readonly<Record<string, string>>;
  token?: string | null;
  signal?: AbortSignal;
}

function buildPath(template: string, params: Readonly<Record<string, string>> = {}): string {
  return template.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`missing path param ${key} for ${template}`);
    return encodeURIComponent(value);
  });
}

async function once<R extends RestRouteName>(
  deps: ApiDeps,
  route: R,
  req: ApiRequest<R>,
): Promise<RestResponse<R>> {
  const spec: Routes[RestRouteName] = restRoutes[route];
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if ('body' in spec) {
    body = JSON.stringify(spec.body.parse(req.body));
    headers['content-type'] = 'application/json';
  }
  if (req.token) headers.authorization = `Bearer ${req.token}`;
  const res = await send(deps, buildPath(spec.path, req.params), {
    method: spec.method,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(res.status, 'invalid_response');
  }
  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(json);
    const code: ClientErrorCode = parsed.success
      ? parsed.data.error
      : res.status === 401
        ? 'unauthorized'
        : 'internal';
    throw new ApiError(res.status, code, parsed.success ? parsed.data.message : undefined);
  }
  const parsed = spec.response.safeParse(json);
  if (!parsed.success) throw new ApiError(res.status, 'invalid_response');
  return parsed.data as RestResponse<R>;
}

/**
 * One validated REST call. The body is parsed with the route's protocol schema before sending and
 * the response with its response schema after. WAKING responses wait for /health and replay.
 */
export async function apiFetch<R extends RestRouteName>(
  route: R,
  req: ApiRequest<R> = {},
  deps: ApiDeps = defaultApiDeps,
): Promise<RestResponse<R>> {
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    wakeStore.begin();
  };
  const slow = setTimeout(show, SLOW_MS);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(deps, route, req);
      } catch (e) {
        if (!(e instanceof WakingError) || attempt >= MAX_WAKE_RETRIES) {
          throw e instanceof WakingError ? new ApiError(0, 'asleep') : e;
        }
        show();
        await waitForHealth(deps);
      }
    }
  } finally {
    clearTimeout(slow);
    if (shown) wakeStore.end();
  }
}
