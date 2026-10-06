import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './columns';
import { authProvider, platform, userKind } from './enums';

/**
 * Users are never hard-deleted once referenced: deletion tombstones the row (PII scrubbed,
 * `deleted_at` set) and a guest merged into a Google account keeps its row with
 * `merged_into_user_id` (ARCHITECTURE §7).
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: userKind('kind').notNull().default('guest'),
    /** HMAC of the local identity's `guestKey`; makes `POST /auth/guest` idempotent. */
    guestKeyHash: text('guest_key_hash'),
    displayName: text('display_name').notNull(),
    avatarSeed: text('avatar_seed').notNull(),
    locale: text('locale').notNull().default('en'),
    muteInvites: boolean('mute_invites').notNull().default(false),
    mergedIntoUserId: uuid('merged_into_user_id').references((): AnyPgColumn => users.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** Written at most daily, piggybacked on a write that happens anyway (§5.3 rule 3). */
    lastSeenAt: timestamptz('last_seen_at'),
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [
    uniqueIndex('users_guest_key_hash_uq')
      .on(t.guestKeyHash)
      .where(sql`${t.guestKeyHash} IS NOT NULL`),
    index('users_merged_into_idx')
      .on(t.mergedIntoUserId)
      .where(sql`${t.mergedIntoUserId} IS NOT NULL`),
  ],
);

export const authIdentities = pgTable(
  'auth_identities',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProvider('provider').notNull(),
    providerSub: text('provider_sub').notNull(),
    email: text('email'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'auth_identities_pk', columns: [t.provider, t.providerSub] }),
    index('auth_identities_user_idx').on(t.userId),
  ],
);

/**
 * Opaque refresh tokens, stored as `HMAC(REFRESH_SECRET, token)`. Rotation keeps the family and
 * bumps `generation`; prune revoked or expired rows after 60 days (ARCHITECTURE §7).
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique('refresh_tokens_token_hash_uq'),
    familyId: uuid('family_id').notNull(),
    generation: integer('generation').notNull().default(0),
    /** Untrusted device label. */
    deviceId: text('device_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    rotatedAt: timestamptz('rotated_at'),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => [
    index('refresh_tokens_family_idx').on(t.familyId),
    index('refresh_tokens_user_idx').on(t.userId),
  ],
);

/** One row per install. A push token belongs to one user; the upsert reassigns it. */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: platform('platform').notNull(),
    appVersion: text('app_version'),
    pushToken: text('push_token').unique('devices_push_token_uq'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastSeenAt: timestamptz('last_seen_at'),
  },
  (t) => [index('devices_user_idx').on(t.userId)],
);
