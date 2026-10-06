import { z } from 'zod';
import {
  AppVersionSchema,
  ClientActionIdSchema,
  ClockReadingSchema,
  DeviceIdSchema,
  LocaleSchema,
  ModeIdSchema,
  PlatformSchema,
  ReactionEmojiSchema,
  ReasonCodeSchema,
  RoomIdSchema,
  RoomRoleSchema,
  SeatCountSchema,
  UserIdSchema,
  VersionSchema,
  WallTimeMsSchema,
} from '../primitives';
import { RoomCodeInputSchema } from '../room-code';
import { RoomSnapshotSchema } from './room-state';

/* Client → server events (ARCHITECTURE §4.4) and the acks the server sends back. */

// --- hello: the version gate --------------------------------------------------------------

export const HelloSchema = z.object({
  protocolVersion: z.int().min(0).max(65_535),
  appVersion: AppVersionSchema,
  platform: PlatformSchema,
  deviceId: DeviceIdSchema,
  locale: LocaleSchema,
});
export type Hello = z.infer<typeof HelloSchema>;

const ProtocolRangeSchema = z.object({
  min: z.int().min(0),
  max: z.int().min(0),
});

export const HELLO_REJECTIONS = ['CLIENT_TOO_OLD', 'SERVER_TOO_OLD'] as const;

/**
 * `SERVER_TOO_OLD` shows "Server updating…" and retries; `CLIENT_TOO_OLD` tries an OTA update,
 * then links to the APK.
 */
export const HelloAckSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    serverTime: WallTimeMsSchema,
    protocol: ProtocolRangeSchema,
  }),
  z.object({
    ok: z.literal(false),
    serverTime: WallTimeMsSchema,
    protocol: ProtocolRangeSchema,
    reason: z.enum(HELLO_REJECTIONS),
  }),
]);
export type HelloAck = z.infer<typeof HelloAckSchema>;

// --- clock:ping: offset estimation (median of 5) ------------------------------------------

export const ClockPingSchema = z.object({
  /** The client's monotonic clock when the ping was sent (`performance.now()`). */
  t0: ClockReadingSchema,
});
export type ClockPing = z.infer<typeof ClockPingSchema>;

export const ClockPongSchema = z.object({
  t0: ClockReadingSchema,
  /** Server wall time when the ping was handled. */
  ts: WallTimeMsSchema,
});
export type ClockPong = z.infer<typeof ClockPongSchema>;

// --- room:join ----------------------------------------------------------------------------

export const JoinByCodeSchema = z.object({
  code: RoomCodeInputSchema,
  asSpectator: z.boolean().optional(),
});

export const RejoinSchema = z.object({
  roomId: RoomIdSchema,
  /** The last `room:state` version this client rendered; the server always sends a full snapshot. */
  lastStateVersion: VersionSchema.optional(),
  asSpectator: z.boolean().optional(),
});

/** `{code}` (from a link or the code box) or `{roomId, lastStateVersion?}` (a reconnect). */
export const RoomJoinSchema = z.union([RejoinSchema, JoinByCodeSchema]);
export type RoomJoin = z.infer<typeof RoomJoinSchema>;

export const ROOM_JOIN_ERRORS = [
  'NOT_FOUND',
  'CLOSED',
  'ROOM_FULL',
  'KICKED',
  'SERVER_BUSY',
  'MOVING',
] as const;
export const RoomJoinErrorSchema = z.enum(ROOM_JOIN_ERRORS);
export type RoomJoinError = z.infer<typeof RoomJoinErrorSchema>;

/** `ROOM_FULL` comes with the "Room full: watch live?" offer; the client retries with `asSpectator`. */
export const RoomJoinAckSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    roomId: RoomIdSchema,
    role: RoomRoleSchema,
    snapshot: RoomSnapshotSchema,
  }),
  z.object({
    ok: z.literal(false),
    error: RoomJoinErrorSchema,
  }),
]);
export type RoomJoinAck = z.infer<typeof RoomJoinAckSchema>;

// --- lobby commands (host-only where applicable) -------------------------------------------

export const RoomReadySchema = z.object({
  roomId: RoomIdSchema,
  ready: z.boolean(),
  /** The game chunk (and CanvasKit on web) has loaded. Native clients send `true`. */
  loaded: z.boolean(),
});

export const RoomOptionsSchema = z.object({
  roomId: RoomIdSchema,
  /** Only where the mode allows a seat range (Cricket is locked at 2). */
  seatCount: SeatCountSchema.optional(),
  mode: ModeIdSchema.optional(),
  /** Game-specific; validated by the game's `configSchema`. */
  options: z.unknown(),
});

export const RoomKickSchema = z.object({
  roomId: RoomIdSchema,
  userId: UserIdSchema,
  /** Also bars the user from spectating (OPEN_QUESTIONS C3). */
  fromSpectating: z.boolean().optional(),
});

export const RoomStartSchema = z.object({ roomId: RoomIdSchema });

/** Any seated human can request a rematch; it starts when every seated human accepts. */
export const RoomRematchSchema = z.object({
  roomId: RoomIdSchema,
  accept: z.boolean(),
});

export const RoomLeaveSchema = z.object({ roomId: RoomIdSchema });

export const LOBBY_REJECTIONS = [
  'NOT_IN_ROOM',
  'NOT_HOST',
  'NOT_SEATED',
  'WRONG_PHASE',
  'INVALID_OPTIONS',
  'NOT_ALL_READY',
  'UNKNOWN_USER',
  'RATE_LIMITED',
  'MOVING',
] as const;
export const LobbyRejectionSchema = z.enum(LOBBY_REJECTIONS);

/** Ack for every lobby command. The new state itself arrives as `room:state`. */
export const LobbyAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: LobbyRejectionSchema }),
]);
export type LobbyAck = z.infer<typeof LobbyAckSchema>;

// --- game:action --------------------------------------------------------------------------

export const GameActionSchema = z.object({
  roomId: RoomIdSchema,
  clientActionId: ClientActionIdSchema,
  /** The version the client was looking at; older than the seat's current decision → `STALE`. */
  baseVersion: VersionSchema,
  /** Game-specific; validated by the game's `actionSchema`. Inner keys are left untouched here. */
  action: z.unknown(),
});
export type GameAction = z.infer<typeof GameActionSchema>;

/**
 * Rejections the platform itself produces. Engines add `NOT_YOUR_TURN | ILLEGAL | STALE |
 * FINISHED`, and each game may add its own closed set, so the wire type is any reason code.
 */
export const PLATFORM_ACTION_REJECTIONS = [
  'INVALID_ACTION',
  'NOT_IN_ROOM',
  'NOT_SEATED',
  'NOT_IN_PROGRESS',
  'NOT_YOUR_TURN',
  'ILLEGAL',
  'STALE',
  'FINISHED',
  'RATE_LIMITED',
  'MOVING',
] as const;

export const GameActionAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), version: VersionSchema }),
  z.object({ ok: z.literal(false), reason: ReasonCodeSchema }),
]);
export type GameActionAck = z.infer<typeof GameActionAckSchema>;

// --- react / presence ---------------------------------------------------------------------

/** Rate-limited to 1 per 2 s per user (players and spectators alike). No ack. */
export const ReactSchema = z.object({
  roomId: RoomIdSchema,
  emoji: ReactionEmojiSchema,
});

/** Sent on `AppState` / `visibilitychange` while in a room. Never touches the DB. No ack. */
export const PresenceSchema = z.object({
  roomId: RoomIdSchema,
  state: z.enum(['active', 'away']),
});
