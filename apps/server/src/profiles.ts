// Public identities for seat cards, cached in memory so socket traffic doesn't read Postgres.
// Filled by the auth routes; a miss (e.g. after a restart) reads one row on room:join, which is a
// state transition anyway.

import { one, type Queryable } from './db';

export interface Profile {
  name: string;
  avatarSeed: string;
}

const CAPACITY = 5_000;

export class ProfileCache {
  private readonly entries = new Map<string, Profile>();

  set(userId: string, profile: Profile): void {
    this.entries.delete(userId);
    this.entries.set(userId, profile);
    if (this.entries.size > CAPACITY) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  peek(userId: string): Profile | null {
    return this.entries.get(userId) ?? null;
  }

  /** The cached profile, or one read from `users` (null for an unknown, deleted or merged user). */
  async get(db: Queryable, userId: string): Promise<Profile | null> {
    const cached = this.entries.get(userId);
    if (cached) return cached;
    const row = await one<{ display_name: string; avatar_seed: string }>(
      db,
      `SELECT display_name, avatar_seed FROM users
        WHERE id = $1 AND deleted_at IS NULL AND merged_into_user_id IS NULL`,
      [userId],
    );
    if (!row) return null;
    const profile = { name: row.display_name, avatarSeed: row.avatar_seed };
    this.set(userId, profile);
    return profile;
  }
}
