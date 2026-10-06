import { games } from './schema';
import type { DbExecutor } from './pool';

type GameRow = typeof games.$inferInsert;

/**
 * The v1 catalog (BUILD_BRIEF §3) plus the two dev-only reference games (OPEN_QUESTIONS I5).
 * Real games start as `coming_soon`; `dev` games are visible only to `DEV_USER_IDS`.
 */
export const CATALOG_SEED: readonly GameRow[] = [
  { id: 'cricket', shelf: 'friends', status: 'coming_soon', sort: 10 },
  { id: 'ludo', shelf: 'friends', status: 'coming_soon', sort: 20 },
  { id: 'carrom', shelf: 'friends', status: 'coming_soon', sort: 30 },
  { id: 'quiz', shelf: 'friends', status: 'coming_soon', sort: 40 },
  { id: 'runner', shelf: 'adventure', status: 'coming_soon', sort: 50 },
  { id: 'lantern-quest', shelf: 'adventure', status: 'coming_soon', sort: 60 },
  { id: 'kolam', shelf: 'relax', status: 'coming_soon', sort: 70 },
  { id: 'koi-pond', shelf: 'relax', status: 'coming_soon', sort: 80 },
  { id: 'color-sort', shelf: 'relax', status: 'coming_soon', sort: 90 },
  { id: 'zen-garden', shelf: 'relax', status: 'coming_soon', sort: 100 },
  { id: 'dev-tictactoe', shelf: 'friends', status: 'dev', sort: 900 },
  { id: 'dev-secret-pick', shelf: 'friends', status: 'dev', sort: 910 },
];

/**
 * Inserts any catalog rows that are missing. Existing rows are left alone: once a game exists,
 * its status, featured flag and config belong to ops (`/ops/reload`), so re-running the seed
 * never undoes a launch or a kill-switch. Returns the ids it inserted.
 */
export async function seedCatalog(database: DbExecutor): Promise<string[]> {
  const inserted = await database
    .insert(games)
    .values([...CATALOG_SEED])
    .onConflictDoNothing({ target: games.id })
    .returning({ id: games.id });
  return inserted.map((row) => row.id);
}
