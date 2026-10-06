import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Session advisory-lock key that serializes migrations across instances ("GPMIG" in ASCII).
 * During a Render deploy the old and new instances overlap, and two new boots can race.
 */
export const MIGRATION_LOCK_KEY = 0x47_50_4d_49_47;

export interface RunMigrationsOptions {
  /**
   * `DATABASE_URL_DIRECT`: bypasses PgBouncer, so a session lock is safe, and a crash releases
   * the lock with the connection (ARCHITECTURE §5.5).
   */
  directUrl: string;
  /** The folder with `meta/_journal.json` (shipped inside `dist/` for the server). */
  migrationsFolder: string;
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

/**
 * Applies pending migrations on a dedicated `pg.Client`:
 * `pg_advisory_lock` → Drizzle `migrate()` (its own transaction) → unlock → `end()`.
 *
 * Any failure throws a `MigrationError` (with the original error as `cause`); the server exits
 * with status 1 so Render keeps the old instance serving. Migrations are expand/contract only.
 */
export async function runMigrations({
  directUrl,
  migrationsFolder,
}: RunMigrationsOptions): Promise<void> {
  const client = new pg.Client({ connectionString: directUrl, application_name: 'gp-migrate' });
  // A dropped connection surfaces as a failed query below; this keeps it from crashing Node first.
  client.on('error', () => {});

  try {
    await client.connect();
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle({ client }), { migrationsFolder });
    } finally {
      // If this fails, end() below still releases the session lock with the connection.
      await client
        .query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY])
        .catch(() => {});
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MigrationError(`Database migration failed: ${detail}`, { cause: error });
  } finally {
    await client.end().catch(() => {});
  }
}
