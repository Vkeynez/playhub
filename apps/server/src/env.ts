// Environment parsing (ARCHITECTURE §5.5 step 1). Required secrets fail the boot with a message that
// names the keys (never their values); optional ones treat a blank value as unset, because Render
// Blueprints create `sync: false` keys with an empty value.

import { z } from 'zod';

/** Keys that must be present and non-blank. */
export const REQUIRED_KEYS = [
  'DATABASE_URL',
  'DATABASE_URL_DIRECT',
  'JWT_SECRET',
  'REFRESH_SECRET',
  'K_ROTATE',
  'ADMIN_TOKEN',
  'CORS_ORIGINS',
] as const;

/** Secrets must be long enough to resist guessing (Render generates 256-bit base64 values). */
const MIN_SECRET_LENGTH = 32;

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());

const commaList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const postgresUrl = z
  .string()
  .trim()
  .regex(/^postgres(?:ql)?:\/\/\S+$/, 'must be a postgres:// or postgresql:// URL');

const secret = z
  .string()
  .trim()
  .min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters`);

/** `https://host[:port]` with no path; a trailing slash is tolerated and removed. */
function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin === trimmed ? url.origin : null;
  } catch {
    return null;
  }
}

const corsOrigins = z
  .string()
  .transform(commaList)
  .superRefine((origins, ctx) => {
    if (origins.length === 0) ctx.addIssue({ code: 'custom', message: 'must list an origin' });
    if (origins.some((origin) => normalizeOrigin(origin) === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a comma-separated list of origins like https://example.com',
      });
    }
  })
  .transform((origins) => origins.map((origin) => normalizeOrigin(origin) ?? origin));

const nonEmptyList = z
  .string()
  .transform(commaList)
  .pipe(z.array(z.string()).min(1, 'must list at least one value'));

const EnvSchema = z.object({
  DATABASE_URL: postgresUrl,
  DATABASE_URL_DIRECT: postgresUrl,
  JWT_SECRET: secret,
  REFRESH_SECRET: secret,
  K_ROTATE: secret,
  ADMIN_TOKEN: secret,
  CORS_ORIGINS: corsOrigins,

  GOOGLE_CLIENT_IDS: optional(nonEmptyList),
  EXPO_ACCESS_TOKEN: optional(z.string().trim()),
  SENTRY_DSN: optional(
    z
      .string()
      .trim()
      .regex(/^https:\/\/\S+$/, 'must be an https URL'),
  ),
  DEV_USER_IDS: optional(nonEmptyList),
  MIN_PROTOCOL_VERSION: optional(z.coerce.number().int().min(0).max(65_535)),

  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65_535).default(10_000)),
  AUTH_TRANSPORT: z.preprocess(blankToUndefined, z.enum(['bearer', 'cookie']).default('bearer')),
  /** Fastify `trustProxy` hop count (ARCHITECTURE §5.7); 0 means "trust no proxy". */
  TRUST_PROXY_HOPS: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(0).max(5).default(0),
  ),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  /** Room creation cap (ARCHITECTURE §4.2): creation only, never activation or restore. */
  MAX_ACTIVE_ROOMS: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1).max(1_000).default(25),
  ),
  /** Base of the share link `<PUBLIC_WEB_URL>/join/<CODE>`; defaults to the first CORS origin. */
  PUBLIC_WEB_URL: optional(
    z
      .string()
      .trim()
      .transform((value) => normalizeOrigin(value))
      .pipe(z.string({ message: 'must be an origin like https://example.com' })),
  ),
  BUILD_SHA: optional(z.string().trim().max(64)),
  RENDER_GIT_COMMIT: optional(z.string().trim().max(64)),
});

type ParsedEnv = z.output<typeof EnvSchema>;

export type Env = Omit<ParsedEnv, 'BUILD_SHA' | 'RENDER_GIT_COMMIT'> & { BUILD_SHA: string };

export type EnvResult =
  | { ok: true; env: Env; disabledFeatures: string[] }
  | { ok: false; missing: string[]; invalid: { key: string; message: string }[] };

/** Features that stay off until their optional key is set. Logged at boot. */
function disabledFeatures(env: Env): string[] {
  const off: string[] = [];
  if (!env.GOOGLE_CLIENT_IDS) off.push('google-sign-in (GOOGLE_CLIENT_IDS unset)');
  if (!env.EXPO_ACCESS_TOKEN) off.push('push (EXPO_ACCESS_TOKEN unset)');
  if (!env.SENTRY_DSN) off.push('sentry (SENTRY_DSN unset)');
  if (!env.DEV_USER_IDS) off.push('dev-games (DEV_USER_IDS unset)');
  return off;
}

export function parseEnv(source: Record<string, string | undefined>): EnvResult {
  const missing = REQUIRED_KEYS.filter((key) => (source[key] ?? '').trim() === '');
  const result = EnvSchema.safeParse(source);
  if (!result.success || missing.length > 0) {
    const invalid = result.success
      ? []
      : result.error.issues
          .map((issue) => ({ key: String(issue.path[0] ?? '(root)'), message: issue.message }))
          .filter(({ key }) => !(missing as string[]).includes(key));
    return { ok: false, missing, invalid };
  }
  const { BUILD_SHA, RENDER_GIT_COMMIT, ...rest } = result.data;
  const env: Env = { ...rest, BUILD_SHA: BUILD_SHA ?? RENDER_GIT_COMMIT ?? 'dev' };
  return { ok: true, env, disabledFeatures: disabledFeatures(env) };
}

/** A one-paragraph error naming every bad key. Messages come from our schema, never the values. */
export function formatEnvError(result: Extract<EnvResult, { ok: false }>): string {
  const lines = ['Invalid server environment:'];
  if (result.missing.length > 0) lines.push(`  missing: ${result.missing.join(', ')}`);
  for (const { key, message } of result.invalid) lines.push(`  ${key}: ${message}`);
  return lines.join('\n');
}
