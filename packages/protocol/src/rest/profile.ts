import { z } from 'zod';
import {
  AvatarSeedSchema,
  BotLevelSchema,
  DisplayNameSchema,
  GameIdSchema,
  LocaleSchema,
  MatchIdSchema,
  ModeIdSchema,
  PublicUserSchema,
  RoomIdSchema,
  SeatSchema,
  TeamSchema,
  UserIdSchema,
  VersionSchema,
  WallTimeMsSchema,
} from '../primitives';
import { MeSchema } from './auth';

/* Profile, match history, invites and account deletion (BUILD_BRIEF §8.2, §6.9). */

/** Keep in sync with the `match_outcome` enum in `packages/db`. */
export const MATCH_OUTCOMES = ['win', 'loss', 'draw', 'abandoned'] as const;
export const MatchOutcomeSchema = z.enum(MATCH_OUTCOMES);
export type MatchOutcome = z.infer<typeof MatchOutcomeSchema>;

export const UserGameStatsSchema = z.object({
  gameId: GameIdSchema,
  /** `default` for games with a single mode. */
  mode: ModeIdSchema,
  played: z.int().min(0),
  won: z.int().min(0),
  lost: z.int().min(0),
  drawn: z.int().min(0),
  streak: z.int(),
  /** Game-specific bests (high score, best time…). */
  best: z.unknown(),
});
export type UserGameStats = z.infer<typeof UserGameStatsSchema>;

export const ActivityItemSchema = z.object({
  /** e.g. `match_played`, `level_cleared`, `kolam_saved`. */
  type: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  gameId: GameIdSchema.nullable(),
  refId: z.string().max(64).nullable(),
  data: z.unknown(),
  at: WallTimeMsSchema,
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const RecentPlayerSchema = PublicUserSchema.extend({
  lastPlayedAt: WallTimeMsSchema,
});
export type RecentPlayer = z.infer<typeof RecentPlayerSchema>;

export const MatchSummarySchema = z.object({
  matchId: MatchIdSchema,
  gameId: GameIdSchema,
  mode: ModeIdSchema,
  startedAt: WallTimeMsSchema,
  endedAt: WallTimeMsSchema.nullable(),
  outcome: MatchOutcomeSchema.nullable(),
  score: z.int().nullable(),
});
export type MatchSummary = z.infer<typeof MatchSummarySchema>;

// GET /profile (stats and activity are visible only to the user in v1, OPEN_QUESTIONS B8)
export const ProfileResponseSchema = z.object({
  me: MeSchema,
  stats: z.array(UserGameStatsSchema).max(256),
  activity: z.array(ActivityItemSchema).max(500),
  recentPlayers: z.array(RecentPlayerSchema).max(100),
  recentMatches: z.array(MatchSummarySchema).max(100),
});
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;

// PATCH /profile → Me
export const UpdateProfileRequestSchema = z.object({
  name: DisplayNameSchema.optional(),
  avatarSeed: AvatarSeedSchema.optional(),
  locale: LocaleSchema.optional(),
  muteInvites: z.boolean().optional(),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;
export const UpdateProfileResponseSchema = MeSchema;

// GET /matches/:id
export const MatchParamsSchema = z.object({ id: MatchIdSchema });

export const ParticipantPlayerSchema = z.discriminatedUnion('kind', [
  PublicUserSchema.extend({ kind: z.literal('human') }),
  z.object({ kind: z.literal('bot'), level: BotLevelSchema }),
  /** A tombstoned account; the UI shows "Deleted player". */
  z.object({ kind: z.literal('deleted') }),
]);

export const MatchParticipantSchema = z.object({
  seat: SeatSchema,
  team: TeamSchema.nullable(),
  player: ParticipantPlayerSchema,
  outcome: MatchOutcomeSchema.nullable(),
  score: z.int().nullable(),
});
export type MatchParticipant = z.infer<typeof MatchParticipantSchema>;

export const MATCH_ACTION_KINDS = ['action', 'timeout', 'tick', 'effect', 'clock'] as const;

/** One action-log entry, as replays need it (ARCHITECTURE §3.3). */
export const ReplayEntrySchema = z.object({
  seq: z.int().min(0),
  kind: z.enum(MATCH_ACTION_KINDS),
  seat: SeatSchema.nullable(),
  payload: z.unknown(),
  /** Game time (ms) the entry was applied at. */
  now: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/**
 * Present only after the match ended, when its `logicVersion` matches the running one
 * (OPEN_QUESTIONS E3) and within the 30-day action-log window.
 */
export const ReplaySchema = z.object({
  seed: z.string().regex(/^[0-9a-f]{32}$/),
  config: z.unknown(),
  entries: z.array(ReplayEntrySchema).max(20_000),
});

export const MatchDetailResponseSchema = z.object({
  matchId: MatchIdSchema,
  roomId: RoomIdSchema,
  gameId: GameIdSchema,
  mode: ModeIdSchema,
  logicVersion: z.int().min(0),
  startedAt: WallTimeMsSchema,
  endedAt: WallTimeMsSchema.nullable(),
  /** The game's `MatchResult`; `null` while running or when abandoned. */
  result: z.unknown(),
  finalVersion: VersionSchema.nullable(),
  participants: z.array(MatchParticipantSchema).max(8),
  replay: ReplaySchema.nullable(),
});
export type MatchDetailResponse = z.infer<typeof MatchDetailResponseSchema>;

// POST /invites ("Play again?" to a recent player)
export const InviteRequestSchema = z.object({
  toUserId: UserIdSchema,
  roomId: RoomIdSchema,
});
export type InviteRequest = z.infer<typeof InviteRequestSchema>;

/**
 * `sent: false` when the recipient muted invites or has no push token; the response doesn't say
 * which. Rate limits (1 per opponent per 10 min, 10 per hour) answer 429 `rate_limited`.
 */
export const InviteResponseSchema = z.object({ sent: z.boolean() });
export type InviteResponse = z.infer<typeof InviteResponseSchema>;

// DELETE /me (tombstones the account; OPEN_QUESTIONS B4) → OkResponse
export { OkResponseSchema as DeleteMeResponseSchema } from './errors';

// GET /me → Me
export { MeSchema as MeResponseSchema } from './auth';
