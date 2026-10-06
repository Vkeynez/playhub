import { fileURLToPath } from 'node:url';

/**
 * The generated migrations in the source tree (`packages/db/drizzle`). For tests and `tsx`
 * runs only: the bundled server copies them into `dist/migrations` and passes that path instead.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));
