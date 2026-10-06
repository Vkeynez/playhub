import { sql } from 'drizzle-orm';
import type { DbExecutor } from './pool';
import { serverState } from './schema';

/**
 * Boot step 3 (ARCHITECTURE §5.5): takes the next fencing epoch, which becomes `myEpoch`.
 * An upsert, so it also works on a database whose epoch row was never inserted.
 */
export async function bumpServerEpoch(database: DbExecutor): Promise<number> {
  const [row] = await database
    .insert(serverState)
    .values({ id: 1, epoch: 1 })
    .onConflictDoUpdate({
      target: serverState.id,
      set: { epoch: sql`${serverState.epoch} + 1`, updatedAt: sql`now()` },
    })
    .returning({ epoch: serverState.epoch });
  if (!row) throw new Error('bumpServerEpoch: no row returned');
  return row.epoch;
}
