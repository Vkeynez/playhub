import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './columns';
import { users } from './users';

/*
 * Solo progress and the social timeline (ARCHITECTURE §8, BUILD_BRIEF §8.2). `game_id` here is
 * plain text: these rows are written by `/sync/push`, which validates the game itself.
 */

/** The canonical save per user and game. Whole-blob client writes are impossible (§8.2). */
export const saveSlots = pgTable(
  'save_slots',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    gameId: text('game_id').notNull(),
    data: jsonb('data').notNull(),
    /** HLC per LWW field path: `{ [fieldPath]: { wallMs, counter, deviceId } }`. */
    hlc: jsonb('hlc').notNull().default({}),
    /** The game's `saveVersion` the data is encoded with. */
    version: integer('version').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'save_slots_pk', columns: [t.userId, t.gameId] })],
);

/**
 * Idempotency for `/sync/push`: `INSERT … ON CONFLICT DO NOTHING RETURNING id`, and merge rules
 * apply only to the returned ids. Pruned 7 days after `applied_at`.
 */
export const progressEvents = pgTable(
  'progress_events',
  {
    /** Client UUIDv7. */
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    gameId: text('game_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    /** `{ wallMs, counter }` as stamped by the client (server-clamped). */
    hlc: jsonb('hlc').notNull(),
    deviceId: text('device_id').notNull(),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    appliedAt: timestamptz('applied_at'),
  },
  (t) => [
    index('progress_events_user_game_idx').on(t.userId, t.gameId),
    index('progress_events_applied_idx').on(t.appliedAt),
  ],
);

/**
 * Counters and coins (`counter` / `ledger` merge rules), keyed permanently by event id so
 * idempotency survives pruning `progress_events`. Never pruned (ARCHITECTURE §8.2, D-021).
 */
export const progressLedger = pgTable(
  'progress_ledger',
  {
    eventId: uuid('event_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    gameId: text('game_id').notNull(),
    key: text('key').notNull(),
    delta: bigint('delta', { mode: 'number' }).notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('progress_ledger_balance_idx').on(t.userId, t.gameId, t.key)],
);

/** The profile timeline, capped at 500 rows per user by lazy maintenance. */
export const activity = pgTable(
  'activity',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** e.g. `match_played`, `level_cleared`, `kolam_saved`. */
    type: text('type').notNull(),
    gameId: text('game_id'),
    /** Match id, level id… */
    refId: text('ref_id'),
    data: jsonb('data'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('activity_user_created_idx').on(t.userId, t.createdAt.desc())],
);

/** "Play again?" comes from here (BUILD_BRIEF §6.9). One row per direction. */
export const recentPlayers = pgTable(
  'recent_players',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    otherUserId: uuid('other_user_id')
      .notNull()
      .references(() => users.id),
    lastPlayedAt: timestamptz('last_played_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'recent_players_pk', columns: [t.userId, t.otherUserId] }),
    index('recent_players_user_recent_idx').on(t.userId, t.lastPlayedAt.desc()),
    check('recent_players_not_self', sql`${t.userId} <> ${t.otherUserId}`),
  ],
);
