import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` diffs the schema against the snapshots in ./drizzle; it needs no database.
// Migrations are applied at boot by `runMigrations` (src/migrate.ts), never by drizzle-kit.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
