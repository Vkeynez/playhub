import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { games } from './catalog';
import { timestamptz } from './columns';
import { botLevel, roomStatus } from './enums';
import { users } from './users';

/**
 * Rooms (ARCHITECTURE §4.2, §5.2, §5.6).
 *
 * - A room is closed iff `status = 'CLOSED' OR expires_at < now()`. Idle closes are decided in
 *   memory; every persisted transition bumps `expires_at`, and lazy maintenance reconciles.
 * - Every persistence write is fenced on `owner_epoch` and stamps `last_write_at`; `released_at`
 *   is set by a graceful drain. `owner_epoch` is never NULL.
 * - `code` is unique among open rooms only (a partial unique index). The 24 h no-reuse rule for
 *   closed codes is checked by the server when it generates a code (a partial index predicate
 *   can't use `now()`).
 */
export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id),
    mode: text('mode').notNull(),
    hostUserId: uuid('host_user_id')
      .notNull()
      .references(() => users.id),
    seatCount: smallint('seat_count').notNull(),
    options: jsonb('options').notNull().default({}),
    status: roomStatus('status').notNull().default('LOBBY'),
    ownerEpoch: bigint('owner_epoch', { mode: 'number' }).notNull(),
    releasedAt: timestamptz('released_at'),
    lastWriteAt: timestamptz('last_write_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    kickedUserIds: uuid('kicked_user_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    startedAt: timestamptz('started_at'),
    closedAt: timestamptz('closed_at'),
  },
  (t) => [
    uniqueIndex('rooms_open_code_uq')
      .on(t.code)
      .where(sql`${t.status} <> 'CLOSED'`),
    /** Code lookups that include closed rooms (the 24 h reuse check). */
    index('rooms_code_idx').on(t.code),
    /** Expiry reconciliation and the boot sweep only look at open rooms. */
    index('rooms_open_expires_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} <> 'CLOSED'`),
    /** One open lobby per host: creating a room closes the host's previous lobby. */
    index('rooms_host_status_idx').on(t.hostUserId, t.status),
    check('rooms_seat_count_range', sql`${t.seatCount} BETWEEN 1 AND 8`),
    check('rooms_code_format', sql`${t.code} ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$'`),
  ],
);

/**
 * One row per seat. A leave or kick clears `user_id` (or deletes the row), so the partial unique
 * index guarantees a user holds at most one seat per room (BUILD_BRIEF §6.3). `bot_level` marks a
 * bot-filled seat; it may sit alongside `user_id` if a bot takeover is ever persisted.
 */
export const roomSeats = pgTable(
  'room_seats',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    seat: smallint('seat').notNull(),
    userId: uuid('user_id').references(() => users.id),
    botLevel: botLevel('bot_level'),
    team: smallint('team'),
    joinedAt: timestamptz('joined_at').notNull().defaultNow(),
    leftAt: timestamptz('left_at'),
  },
  (t) => [
    primaryKey({ name: 'room_seats_pk', columns: [t.roomId, t.seat] }),
    uniqueIndex('room_seats_room_user_uq')
      .on(t.roomId, t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
    index('room_seats_user_idx')
      .on(t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
    check('room_seats_seat_range', sql`${t.seat} BETWEEN 0 AND 7`),
  ],
);
