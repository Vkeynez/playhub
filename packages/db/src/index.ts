// @gp/db: the Drizzle schema, migrations runner, pool and catalog seed (ARCHITECTURE §5, §9).
// Test helpers live in `@gp/db/testing`.

export * as schema from './schema';
export {
  createPool,
  db,
  POOL_IDLE_TIMEOUT_MS,
  POOL_MAX,
  type Db,
  type DbExecutor,
  type PoolOptions,
  type Schema,
} from './pool';
export {
  MIGRATION_LOCK_KEY,
  MigrationError,
  runMigrations,
  type RunMigrationsOptions,
} from './migrate';
export { MIGRATIONS_FOLDER } from './paths';
export { CATALOG_SEED, seedCatalog } from './seed';
export { bumpServerEpoch } from './server-state';
