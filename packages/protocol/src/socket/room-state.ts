import { z } from 'zod';
import {
  BotLevelSchema,
  GameIdSchema,
  MatchIdSchema,
  ModeIdSchema,
  PlatformSchema,
  PublicUserSchema,
  RoomIdSchema,
  RoomPhaseSchema,
  SeatCountSchema,
  SeatSchema,
  TeamSchema,
  UserIdSchema,
  VersionSchema,
  WallTimeMsSchema,
} from '../primitives';
import { RoomCodeSchema } from '../room-code';

/**
 * How a seat's human is connected, for the seat card's connection dot.
 * - `connected`: at least one live socket.
 * - `away`: the app is backgrounded or the tab hidden (`presence`), or a lobby disconnect.
 * - `reconnecting`: during a deploy overlap (ARCHITECTURE §5.6): no grace countdown yet.
 * - `disconnected`: no socket; a grace window may be running.
 */
export const CONNECTION_STATES = ['connected', 'away', 'reconnecting', 'disconnected'] as const;
export const ConnectionStateSchema = z.enum(CONNECTION_STATES);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const HumanOccupantSchema = PublicUserSchema.extend({
  kind: z.literal('human'),
  platform: PlatformSchema,
  connection: ConnectionStateSchema,
});

export const BotOccupantSchema = z.object({
  kind: z.literal('bot'),
  level: BotLevelSchema,
  /** Set when a bot is playing for a disconnected human ("Bot playing for <name>"). */
  playingFor: UserIdSchema.nullable(),
});

export const SeatOccupantSchema = z.discriminatedUnion('kind', [
  HumanOccupantSchema,
  BotOccupantSchema,
]);
export type SeatOccupant = z.infer<typeof SeatOccupantSchema>;

export const SeatStateSchema = z.object({
  seat: SeatSchema,
  team: TeamSchema.nullable(),
  /** `null` = an empty seat. */
  occupant: SeatOccupantSchema.nullable(),
  isHost: z.boolean(),
  ready: z.boolean(),
  /** The game chunk (and CanvasKit on web) has loaded; `room:start` waits for it. */
  loaded: z.boolean(),
});
export type SeatState = z.infer<typeof SeatStateSchema>;

/** Every deadline the UI counts down, in server wall time (ARCHITECTURE §4.3). */
export const DEADLINE_KINDS = ['turn', 'grace', 'rematch', 'lobby_close'] as const;
export const DeadlineSchema = z.object({
  kind: z.enum(DEADLINE_KINDS),
  /** The seats the deadline applies to; empty for room-wide deadlines. */
  seats: z.array(SeatSchema).max(8),
  at: WallTimeMsSchema,
});
export type Deadline = z.infer<typeof DeadlineSchema>;

export const RematchStateSchema = z.object({
  /** Seats whose humans have asked for, or accepted, a rematch. */
  accepted: z.array(SeatSchema).max(8),
});

/**
 * The engine's metadata for the current match (P0 addition): which seats it is waiting on, the
 * turn deadline in server wall time, whether the game clock is frozen (no human connected), and
 * whether the match is over. `version` is the engine's own version; the client still sends the
 * snapshot's top-level `version` as `game:action.baseVersion`.
 */
export const MatchMetaSchema = z.object({
  version: VersionSchema,
  awaiting: z.object({
    seats: z.array(SeatSchema).max(8),
    deadlineAt: WallTimeMsSchema.nullable(),
  }),
  paused: z.boolean(),
  finished: z.boolean(),
});
export type MatchMeta = z.infer<typeof MatchMetaSchema>;

/** A finished match's placements (place 1 wins; every seat in place 1 is a draw). P0 addition. */
export const MatchPlacementsSchema = z.object({
  placements: z
    .array(
      z.object({
        seat: SeatSchema,
        place: z.int().min(1).max(8),
        score: z.number().nullable(),
      }),
    )
    .max(8),
  /** The match was abandoned (no human connected for 5 min): no W/L. */
  abandoned: z.boolean().optional(),
});
export type MatchPlacements = z.infer<typeof MatchPlacementsSchema>;

/**
 * The full per-viewer snapshot (`room:state`, and the `room:join` ack).
 * `view` and `events` come from the game's `viewFor` / `eventFor` and are opaque here.
 */
export const RoomSnapshotSchema = z.object({
  roomId: RoomIdSchema,
  code: RoomCodeSchema,
  gameId: GameIdSchema,
  mode: ModeIdSchema,
  version: VersionSchema,
  phase: RoomPhaseSchema,
  seatCount: SeatCountSchema,
  /** Lobby options as last set by the host; validated by the game's `configSchema`. */
  options: z.unknown(),
  seats: z.array(SeatStateSchema).max(8),
  /** How many people are watching. */
  spectators: z.int().min(0).max(1000),
  /** The viewer's own seat, or `null` for a spectator. */
  yourSeat: SeatSchema.nullable(),
  matchId: MatchIdSchema.nullable(),
  deadlines: z.array(DeadlineSchema).max(16),
  rematch: RematchStateSchema.nullable(),
  /** `viewFor(state, viewer)`; `null` in the lobby. */
  view: z.unknown(),
  /** `eventFor(event, viewer)` for the events of this step, already redacted. */
  events: z.array(z.unknown()).max(256),
  /** P0 addition: the engine's metadata; `null` when there is no match yet. */
  meta: MatchMetaSchema.nullable().optional(),
  /** P0 addition: the match result once it is over, else `null`. */
  result: MatchPlacementsSchema.nullable().optional(),
});
export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;
