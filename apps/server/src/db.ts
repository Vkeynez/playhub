// Thin SQL helpers over the pg pool. Hot-path statements are hand-written SQL so each fenced write
// is one statement (ARCHITECTURE §5.6). Callers type the rows they select.

import type { createPool } from '@gp/db';

export type Pool = ReturnType<typeof createPool>;

/** A pool or a checked-out client: anything that runs a parameterised statement. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Rows typed by the caller, who writes the SELECT list they describe. */
export async function rows<R>(db: Queryable, text: string, values: unknown[] = []): Promise<R[]> {
  const result = await db.query(text, values);
  return result.rows as R[];
}

export async function one<R>(
  db: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<R | null> {
  const [row] = await rows<R>(db, text, values);
  return row ?? null;
}

/** Runs `fn` in a transaction on one pooled client (short: Neon counts idle-in-transaction). */
export async function transaction<T>(pool: Pool, fn: (client: Queryable) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
