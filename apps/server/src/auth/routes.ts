// /auth/guest, /auth/refresh and /me (ARCHITECTURE §7). Bearer transport; every body is parsed with
// its @gp/protocol schema. Each endpoint is one or two statements.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  GuestAuthRequestSchema,
  LocaleSchema,
  RefreshRequestSchema,
  type ApiErrorCode,
  type AuthSession,
  type Me,
} from '@gp/protocol';
import { one, type Pool } from '../db';
import type { ProfileCache } from '../profiles';
import type { Limiters } from '../rate-limit';
import { bearerToken, type TokenService } from './tokens';

/** Re-presenting a rotated refresh token returns the same successor within this window (OQ B7). */
export const ROTATION_GRACE_SEC = { google: 60, guest: 24 * 60 * 60 } as const;

interface UserRow {
  id: string;
  kind: 'guest' | 'google';
  display_name: string;
  avatar_seed: string;
  locale: string;
  mute_invites: boolean;
  email: string | null;
  deleted_at: Date | null;
  merged_into_user_id: string | null;
}

export interface AuthContext {
  pool: Pool;
  tokens: TokenService;
  limiters: Limiters;
  profiles: ProfileCache;
}

function fail(reply: FastifyReply, status: number, error: ApiErrorCode) {
  return reply.code(status).send({ error });
}

function toMe(row: UserRow): Me {
  return {
    userId: row.id,
    kind: row.kind,
    name: row.display_name,
    avatarSeed: row.avatar_seed,
    locale: LocaleSchema.catch('en').parse(row.locale),
    muteInvites: row.mute_invites,
    email: row.kind === 'google' ? row.email : null,
  };
}

const usable = (row: UserRow) => row.deleted_at === null && row.merged_into_user_id === null;

/** The user id of the request's valid access token, or null (stateless; no DB). */
export async function authenticate(
  tokens: TokenService,
  request: FastifyRequest,
): Promise<string | null> {
  const token = bearerToken(request.headers.authorization);
  return token === null ? null : tokens.verifyAccess(token);
}

const USER_COLUMNS = `u.id, u.kind, u.display_name, u.avatar_seed, u.locale, u.mute_invites,
  u.deleted_at, u.merged_into_user_id,
  (SELECT email FROM auth_identities a WHERE a.user_id = u.id ORDER BY a.created_at LIMIT 1) AS email`;

export function registerAuthRoutes(app: FastifyInstance, ctx: AuthContext): void {
  const { pool, tokens, limiters, profiles } = ctx;

  async function session(row: UserRow, refreshToken: string): Promise<AuthSession> {
    profiles.set(row.id, { name: row.display_name, avatarSeed: row.avatar_seed });
    const access = await tokens.signAccess(row.id);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      user: toMe(row),
    };
  }

  // POST /auth/guest: idempotent on the guest key; every call starts a new refresh family.
  app.post('/auth/guest', async (request, reply) => {
    const body = GuestAuthRequestSchema.safeParse(request.body);
    if (!body.success) return fail(reply, 400, 'bad_request');
    const { guestKey, name, avatarSeed, locale, deviceId } = body.data;
    if (!limiters.guestPerIp.take(request.ip)) return fail(reply, 429, 'rate_limited');
    const keyHash = tokens.hashGuestKey(guestKey);
    if (!limiters.guestPerKey.take(keyHash)) return fail(reply, 429, 'rate_limited');

    const refresh = tokens.newRefreshToken();
    const row = await one<UserRow & { issued: number }>(
      pool,
      `WITH ins AS (
         INSERT INTO users (kind, guest_key_hash, display_name, avatar_seed, locale, last_seen_at)
         VALUES ('guest', $1, $2, $3, $4, now())
         ON CONFLICT (guest_key_hash) WHERE guest_key_hash IS NOT NULL
         DO UPDATE SET last_seen_at = CASE
           WHEN users.last_seen_at IS NULL OR users.last_seen_at < now() - interval '1 day'
           THEN now() ELSE users.last_seen_at END
         RETURNING *
       ), t AS (
         INSERT INTO refresh_tokens (user_id, token_hash, family_id, generation, device_id, expires_at)
         SELECT id, $5, gen_random_uuid(), 0, $6, now() + interval '60 days' FROM ins
          WHERE kind = 'guest' AND deleted_at IS NULL AND merged_into_user_id IS NULL
         RETURNING id
       )
       SELECT ins.id, ins.kind, ins.display_name, ins.avatar_seed, ins.locale, ins.mute_invites,
              ins.deleted_at, ins.merged_into_user_id, NULL::text AS email,
              (SELECT count(*)::int FROM t) AS issued
         FROM ins`,
      [keyHash, name, avatarSeed, locale ?? 'en', tokens.hashRefresh(refresh), deviceId ?? null],
    );
    if (!row || row.issued === 0 || !usable(row)) return fail(reply, 401, 'unauthorized');
    return session(row, refresh);
  });

  // POST /auth/refresh: idempotent rotation (OQ B7).
  app.post('/auth/refresh', async (request, reply) => {
    const body = RefreshRequestSchema.safeParse(request.body ?? {});
    if (!body.success || body.data.refreshToken === undefined) {
      return fail(reply, body.success ? 401 : 400, body.success ? 'unauthorized' : 'bad_request');
    }
    if (!limiters.refreshPerIp.take(request.ip)) return fail(reply, 429, 'rate_limited');
    const presented = body.data.refreshToken;
    const hash = tokens.hashRefresh(presented);
    const successor = tokens.successorOf(presented);
    const successorHash = tokens.hashRefresh(successor);

    const rotated = await one<UserRow>(
      pool,
      `WITH old AS (
         UPDATE refresh_tokens SET rotated_at = now()
          WHERE token_hash = $1 AND rotated_at IS NULL AND revoked_at IS NULL AND expires_at > now()
         RETURNING user_id, family_id, generation, device_id
       ), ins AS (
         INSERT INTO refresh_tokens (user_id, token_hash, family_id, generation, device_id, expires_at)
         SELECT user_id, $2, family_id, generation + 1, device_id, now() + interval '60 days' FROM old
         ON CONFLICT (token_hash) DO NOTHING
         RETURNING user_id
       )
       SELECT ${USER_COLUMNS} FROM old JOIN users u ON u.id = old.user_id`,
      [hash, successorHash],
    );
    if (rotated) {
      return usable(rotated) ? session(rotated, successor) : fail(reply, 401, 'unauthorized');
    }

    // Already rotated (or unknown, revoked, expired).
    const seen = await one<
      UserRow & { family_id: string; since_rotation: number | null; successor_ok: boolean }
    >(
      pool,
      `SELECT ${USER_COLUMNS}, t.family_id,
              extract(epoch FROM now() - t.rotated_at)::float8 AS since_rotation,
              (s.id IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > now()) AS successor_ok
         FROM refresh_tokens t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN refresh_tokens s ON s.token_hash = $2
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
      [hash, successorHash],
    );
    if (!seen || seen.since_rotation === null || !usable(seen)) {
      return fail(reply, 401, 'unauthorized');
    }
    if (seen.since_rotation <= ROTATION_GRACE_SEC[seen.kind] && seen.successor_ok) {
      return session(seen, successor);
    }
    // Reuse after the window: revoke the family for Google accounts only; a guest family is never
    // revoked, because it is the guest's only credential.
    if (seen.kind === 'google') {
      await pool.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
        [seen.family_id],
      );
    }
    return fail(reply, 401, 'unauthorized');
  });

  app.get('/me', async (request, reply) => {
    const userId = await authenticate(tokens, request);
    if (userId === null) return fail(reply, 401, 'unauthorized');
    const row = await one<UserRow>(pool, `SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [
      userId,
    ]);
    if (!row || !usable(row)) return fail(reply, 401, 'unauthorized');
    profiles.set(row.id, { name: row.display_name, avatarSeed: row.avatar_seed });
    return toMe(row);
  });
}
