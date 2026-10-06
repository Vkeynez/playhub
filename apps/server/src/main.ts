// Process entry (ARCHITECTURE §5.5): env → migrate → pool → fence → app → listen, and the SIGTERM
// drain (§5.6). Bundled to dist/main.js; Render starts it with `node --max-old-space-size=384`.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS_FOLDER } from '@gp/db';
import { bootLogger, bootServer, errorFields } from './boot';
import { formatEnvError, parseEnv } from './env';

/** Render sends SIGKILL 30 s after SIGTERM; finish well inside that. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** The bundle ships migrations in dist/migrations; `tsx src/main.ts` uses packages/db/drizzle. */
function resolveMigrationsFolder(): string {
  const bundled = fileURLToPath(new URL('./migrations', import.meta.url));
  return existsSync(path.join(bundled, 'meta', '_journal.json')) ? bundled : MIGRATIONS_FOLDER;
}

async function main(): Promise<void> {
  const log = bootLogger();
  const parsed = parseEnv(process.env);
  if (!parsed.ok) {
    process.stderr.write(`${formatEnvError(parsed)}\n`);
    process.exit(1);
  }

  const migrationsFolder = resolveMigrationsFolder();
  let server: Awaited<ReturnType<typeof bootServer>>;
  try {
    server = await bootServer({
      env: parsed.env,
      migrationsFolder,
      disabledFeatures: parsed.disabledFeatures,
    });
  } catch (error) {
    log.error('boot failed', { migrationsFolder, ...errorFields(error) });
    process.exit(1);
  }

  const onSignal = (signal: NodeJS.Signals) => {
    setTimeout(() => {
      log.error('shutdown timed out; exiting', { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    server.shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        log.error('shutdown failed', errorFields(error));
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}

void main();
