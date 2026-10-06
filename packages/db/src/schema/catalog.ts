import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './columns';
import { gameShelf, gameStatus, platform } from './enums';

/**
 * The remote catalog (BUILD_BRIEF §5): a kill-switch and ordering that need no app update.
 * Loaded into memory at boot; never read on a timer (ARCHITECTURE §5.3 rule 4).
 */
export const games = pgTable('games', {
  id: text('id').primaryKey(),
  shelf: gameShelf('shelf').notNull(),
  status: gameStatus('status').notNull().default('coming_soon'),
  featured: boolean('featured').notNull().default(false),
  sort: integer('sort').notNull(),
  minAppVersion: text('min_app_version').notNull().default('0.0.0'),
  config: jsonb('config').notNull().default({}),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** One row per published build; `/app/version` prompts by runtime (ARCHITECTURE §11). */
export const appReleases = pgTable(
  'app_releases',
  {
    platform: platform('platform').notNull(),
    version: text('version').notNull(),
    runtimeVersion: text('runtime_version').notNull(),
    /** GitHub Releases (never Render). `null` for web. */
    apkUrl: text('apk_url'),
    /** The oldest app version still supported once this release ships. */
    minSupported: text('min_supported').notNull(),
    notes: text('notes'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'app_releases_pk', columns: [t.platform, t.version] })],
);

/**
 * A single row (`id = 1`) holding the fencing epoch. Each boot runs
 * `UPDATE server_state SET epoch = epoch + 1 RETURNING epoch` (ARCHITECTURE §5.5); the row is
 * inserted by a migration.
 */
export const serverState = pgTable(
  'server_state',
  {
    id: smallint('id').primaryKey().default(1),
    epoch: bigint('epoch', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [check('server_state_single_row', sql`${t.id} = 1`)],
);
