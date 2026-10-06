import { z } from 'zod';
import { DeviceIdSchema, EventIdSchema, GameIdSchema, WallTimeMsSchema } from '../primitives';

/* Offline-first sync (ARCHITECTURE §8). The merge itself lives in `packages/sync` (Phase 2). */

/**
 * Hybrid logical clock stamp (OPEN_QUESTIONS E1). LWW compares `(wallMs, counter, deviceId)`,
 * where `deviceId` is the event's own. The server clamps `wallMs` to `serverNow + 2 min`.
 */
export const HlcSchema = z.object({
  wallMs: WallTimeMsSchema,
  counter: z.int().min(0).max(0xffff_ffff),
});
export type Hlc = z.infer<typeof HlcSchema>;

/** One outbox entry. `id` is a client UUIDv7 and the idempotency key. */
export const OutboxEventSchema = z.object({
  id: EventIdSchema,
  gameId: GameIdSchema,
  type: z.string().regex(/^[a-z][a-z0-9_.-]{0,47}$/),
  /** Validated by the game's `SoloGameModule.eventSchema`. */
  payload: z.unknown(),
  hlc: HlcSchema,
  deviceId: DeviceIdSchema,
});
export type OutboxEvent = z.infer<typeof OutboxEventSchema>;

export const MAX_SYNC_EVENTS_PER_PUSH = 500;

// POST /sync/push
export const SyncPushRequestSchema = z.object({
  events: z.array(OutboxEventSchema).max(MAX_SYNC_EVENTS_PER_PUSH),
});
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

export const SYNC_REJECTIONS = [
  /** The payload failed the game's event schema. */
  'INVALID_EVENT',
  'UNKNOWN_GAME',
  /** A `ledger` spend would take the balance below zero. */
  'INSUFFICIENT_FUNDS',
  /** The game's save version is newer than this server understands. */
  'UNSUPPORTED_VERSION',
] as const;
export const SyncRejectionSchema = z.enum(SYNC_REJECTIONS);

export const CanonicalSaveSchema = z.object({
  gameId: GameIdSchema,
  saveVersion: z.int().min(0),
  data: z.unknown(),
});
export type CanonicalSave = z.infer<typeof CanonicalSaveSchema>;

/**
 * The client adopts each canonical save, rebases its unacked events on top, and rolls back the
 * rejected ones. Re-sent events that were already applied are acked again, not rejected.
 */
export const SyncPushResponseSchema = z.object({
  canonicalSaves: z.array(CanonicalSaveSchema).max(64),
  ackedIds: z.array(EventIdSchema).max(MAX_SYNC_EVENTS_PER_PUSH),
  rejected: z
    .array(z.object({ id: EventIdSchema, reason: SyncRejectionSchema }))
    .max(MAX_SYNC_EVENTS_PER_PUSH),
});
export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>;
