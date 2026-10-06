import { z } from 'zod';
import {
  ReactionEmojiSchema,
  RoomIdSchema,
  SeatSchema,
  UserIdSchema,
  WallTimeMsSchema,
} from '../primitives';
import { RoomSnapshotSchema } from './room-state';

/* Server → client events (ARCHITECTURE §4.4). None of them carries an ack. */

/** Always a full per-viewer snapshot. Spectators get at most one per second. */
export const RoomStateEventSchema = RoomSnapshotSchema;

export const ReactionEventSchema = z.object({
  roomId: RoomIdSchema,
  userId: UserIdSchema,
  /** The sender's seat, or `null` for a spectator. */
  seat: SeatSchema.nullable(),
  emoji: ReactionEmojiSchema,
  at: WallTimeMsSchema,
});

export const ROOM_CLOSE_REASONS = [
  /** 30 min idle in the lobby, or 10 min with only the host. */
  'IDLE',
  /** 10 min after the last rematch prompt. */
  'FINISHED',
  /** The host opened a new lobby (one open lobby per host). */
  'REPLACED',
  /** The match was abandoned (no human connected for 5 min, or a server update). */
  'ABANDONED',
  'SERVER',
] as const;

/** The client forgets the room on `room:closed`. */
export const RoomClosedEventSchema = z.object({
  roomId: RoomIdSchema,
  reason: z.enum(ROOM_CLOSE_REASONS),
});

export const RoomKickedEventSchema = z.object({
  roomId: RoomIdSchema,
  /** Also barred from spectating (OPEN_QUESTIONS C3). */
  fromSpectating: z.boolean(),
});

/**
 * A deploy drain or a fenced-out instance: the client reconnects after a random 0.5–3 s and
 * rejoins with `lastStateVersion`.
 */
export const ServerMovingEventSchema = z.object({
  reason: z.enum(['DEPLOY', 'FENCED']),
});

export const SERVER_ERROR_CODES = [
  /** A payload failed its schema. */
  'INVALID_PAYLOAD',
  /** An event arrived before a successful `hello`. */
  'HELLO_REQUIRED',
  'UNKNOWN_EVENT',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;
export const ServerErrorCodeSchema = z.enum(SERVER_ERROR_CODES);

/** Errors for events that have no ack (or where the ack callback was missing). */
export const ServerErrorEventSchema = z.object({
  code: ServerErrorCodeSchema,
  /** The client event that caused it, when known. */
  event: z.string().max(32).optional(),
});
