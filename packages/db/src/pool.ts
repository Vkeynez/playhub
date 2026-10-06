import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema> & { $client: pg.Pool };
/** A database or an open transaction: helpers that take this can run inside `db.transaction`. */
export type DbExecutor = PgDatabase<NodePgQueryResultHKT, Schema>;

export interface PoolOptions {
  /**
   * Called for errors on idle clients (Neon drops idle connections when it suspends).
   * Defaults to `console.error`. The handler is mandatory: an unhandled pool `'error'` crashes
   * Node (CLAUDE.md gotcha, ARCHITECTURE §5.3 rule 6).
   */
  onError?: (error: Error) => void;
  /** Shows up in `pg_stat_activity`. */
  applicationName?: string;
}

/** The pool settings from ARCHITECTURE §5.3 rule 6. */
export const POOL_MAX = 5;
export const POOL_IDLE_TIMEOUT_MS = 5_000;

/**
 * The app's connection pool over the pooled `DATABASE_URL`: at most 5 connections, idle ones
 * closed after 5 s, and no minimum, so an idle server holds no connections and Neon can sleep.
 * Creating a pool opens no connection.
 */
export function createPool(url: string, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    application_name: options.applicationName ?? 'gp-server',
  });
  const onError =
    options.onError ?? ((error: Error) => console.error('[db] idle client error', error));
  pool.on('error', (error) => onError(error));
  return pool;
}

/** Wraps a pool in Drizzle with the schema attached. */
export function db(pool: pg.Pool): Db {
  return drizzle({ client: pool, schema });
}
