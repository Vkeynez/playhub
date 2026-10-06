import { z } from 'zod';
import {
  AppVersionSchema,
  GameIdSchema,
  GameStatusSchema,
  PlatformSchema,
  RuntimeVersionSchema,
  ShelfSchema,
  WallTimeMsSchema,
} from '../primitives';

/* Memory-served endpoints: /catalog, /app/version (ARCHITECTURE §5.3 rule 4) and /health. */

// GET /catalog
export const CatalogGameSchema = z.object({
  id: GameIdSchema,
  shelf: ShelfSchema,
  /** `dev` entries are returned only to `DEV_USER_IDS`. */
  status: GameStatusSchema,
  featured: z.boolean(),
  sort: z.int(),
  minAppVersion: AppVersionSchema,
  /** Remote per-game config (e.g. price tables); validated by the game. */
  config: z.unknown(),
});
export type CatalogGame = z.infer<typeof CatalogGameSchema>;

export const CatalogResponseSchema = z.object({
  games: z.array(CatalogGameSchema).max(64),
});
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;

// GET /app/version?platform=&appVersion=&runtimeVersion=
export const AppVersionQuerySchema = z.object({
  platform: PlatformSchema,
  appVersion: AppVersionSchema,
  runtimeVersion: RuntimeVersionSchema.optional(),
});
export type AppVersionQuery = z.infer<typeof AppVersionQuerySchema>;

export const AppReleaseSchema = z.object({
  version: AppVersionSchema,
  runtimeVersion: RuntimeVersionSchema,
  /** GitHub Releases, never Render (OPEN_QUESTIONS G3). `null` on web. */
  apkUrl: z.url().nullable(),
  notes: z.string().max(2000).nullable(),
  publishedAt: WallTimeMsSchema,
});
export type AppRelease = z.infer<typeof AppReleaseSchema>;

/**
 * - `ok`: up to date.
 * - `update_available`: a newer release exists.
 * - `runtime_unsupported`: this APK's runtime no longer receives OTA fixes; prompt to install.
 * - `update_required`: below `minSupported`; block with "Update required".
 */
export const APP_VERSION_STATUSES = [
  'ok',
  'update_available',
  'runtime_unsupported',
  'update_required',
] as const;

export const AppVersionResponseSchema = z.object({
  status: z.enum(APP_VERSION_STATUSES),
  latest: AppReleaseSchema.nullable(),
  minSupported: AppVersionSchema.nullable(),
});
export type AppVersionResponse = z.infer<typeof AppVersionResponseSchema>;

// GET /health: process memory only, never Postgres (ARCHITECTURE §5.3 rule 1)
export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  bootId: z.string().min(1).max(64),
  buildSha: z.string().max(64),
  protocolVersion: z.int().min(0),
  uptime: z.number().min(0),
  rooms: z.int().min(0),
  /** Event-loop utilization, 0–1. */
  elu: z.number().min(0).max(1),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
