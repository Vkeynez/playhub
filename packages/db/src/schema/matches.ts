import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { games } from './catalog';
import { timestamptz } from './columns';
import { botLevel, matchActionKind, matchOutcome } from './enums';
import { rooms } from './rooms';
import { users } from './users';

/**
 * One row per match (a rematch is a new match in the same room).
 *
 * - `seed`, `config` (frozen inputs: initNow, quiz payloads), `logic_version` and
 *   `state_version` are fixed at start; restore = `snapshot` + replay of the logged tail.
 * - `snapshot` is overwritten only when `snapshot_version < $new`.
 * - `ended_at` doubles as the idempotency guard for match end
 *   (`UPDATE … WHERE ended_at IS NULL RETURNING id`, ARCHITECTURE §5.2).
 */
export const matches = pgTable(
  'matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id),
    mode: text('mode').notNull(),
    /** 128-bit match seed, hex. Revealed only to replay viewers after the match ends. */
    seed: text('seed').notNull(),
    config: jsonb('config').notNull().default({}),
    logicVersion: integer('logic_version').notNull(),
    stateVersion: integer('state_version').notNull(),
    snapshot: jsonb('snapshot'),
    /** Engine version of `snapshot` (`epoch × 2³² + n`); 0 = no snapshot yet. */
    snapshotVersion: bigint('snapshot_version', { mode: 'number' }).notNull().default(0),
    result: jsonb('result'),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    endedAt: timestamptz('ended_at'),
  },
  (t) => [
    index('matches_room_idx').on(t.roomId, t.startedAt),
    index('matches_unfinished_idx')
      .on(t.roomId)
      .where(sql`${t.endedAt} IS NULL`),
  ],
);

/**
 * The per-match action journal (ARCHITECTURE §3.3, §5.2): `{seq, kind, seat?, payload, now,
 * clientActionId?}`. Appended with `ON CONFLICT DO NOTHING`; pruned after 30 days. Carrom logs
 * only authoritative results, never trajectories.
 */
export const matchActions = pgTable(
  'match_actions',
  {
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: matchActionKind('kind').notNull(),
    seat: smallint('seat'),
    payload: jsonb('payload').notNull(),
    /** Game time (ms) the entry was applied at; replays feed it back as `ctx.now`. */
    gameNow: bigint('game_now', { mode: 'number' }).notNull(),
    serverTs: timestamptz('server_ts').notNull().defaultNow(),
    clientActionId: text('client_action_id'),
  },
  (t) => [
    primaryKey({ name: 'match_actions_pk', columns: [t.matchId, t.seq] }),
    /** Idempotency survives restarts: a retried action maps back to its original seq. */
    unique('match_actions_client_action_uq').on(t.matchId, t.seat, t.clientActionId),
    index('match_actions_server_ts_idx').on(t.serverTs),
  ],
);

/** Written once per match at its idempotent end; multiplayer stats are recomputed from here. */
export const matchParticipants = pgTable(
  'match_participants',
  {
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    seat: smallint('seat').notNull(),
    /** `null` for a bot seat. */
    userId: uuid('user_id').references(() => users.id),
    botLevel: botLevel('bot_level'),
    team: smallint('team'),
    outcome: matchOutcome('outcome'),
    score: integer('score'),
    stats: jsonb('stats'),
  },
  (t) => [
    primaryKey({ name: 'match_participants_pk', columns: [t.matchId, t.seat] }),
    index('match_participants_user_idx')
      .on(t.userId, t.matchId)
      .where(sql`${t.userId} IS NOT NULL`),
  ],
);

/** Per user, per game, per mode (`default` for single-mode games). */
export const userGameStats = pgTable(
  'user_game_stats',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    gameId: text('game_id').notNull(),
    mode: text('mode').notNull().default('default'),
    played: integer('played').notNull().default(0),
    won: integer('won').notNull().default(0),
    lost: integer('lost').notNull().default(0),
    drawn: integer('drawn').notNull().default(0),
    streak: integer('streak').notNull().default(0),
    best: jsonb('best'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'user_game_stats_pk', columns: [t.userId, t.gameId, t.mode] })],
);
