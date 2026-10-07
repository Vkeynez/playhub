// Local dev runner: a throwaway embedded Postgres 17 (migrated and seeded) plus the server with a
// safe local env (random secrets, CORS for the Expo web dev server). Nothing touches a real account
// or the deployed services. Ctrl-C stops the server, then Postgres, and deletes its data.
//
//   scripts/isolated.sh corepack pnpm --filter @gp/server dev:local
//   (PORT=10001 to change the port; default 10000)

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';

const root = path.resolve(import.meta.dirname, '..');
const secret = () => randomBytes(32).toString('base64url');

const { startTestDb } = await tsImport('@gp/db/testing', import.meta.url);
const db = await startTestDb({ seed: true });
const port = process.env.PORT ?? '10000';

const env = {
  ...process.env,
  DATABASE_URL: db.url,
  DATABASE_URL_DIRECT: db.url,
  JWT_SECRET: secret(),
  REFRESH_SECRET: secret(),
  K_ROTATE: secret(),
  ADMIN_TOKEN: secret(),
  CORS_ORIGINS: 'http://localhost:8090,http://127.0.0.1:8090,http://localhost:8081',
  PUBLIC_WEB_URL: process.env.PUBLIC_WEB_URL ?? 'http://localhost:8090',
  PORT: port,
  TRUST_PROXY_HOPS: '0',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  BUILD_SHA: 'dev-local',
};

process.stdout.write(
  `\n[dev-local] Postgres ${db.url}\n[dev-local] server  http://localhost:${port}  (Ctrl-C to stop)\n\n`,
);

const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src/main.ts')], {
  cwd: root,
  env,
  stdio: 'inherit',
});

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await db.stop().catch(() => {});
  process.exit(code);
}

child.once('exit', (code) => void stop(code ?? 0));
process.once('SIGINT', () => void stop(0));
process.once('SIGTERM', () => void stop(0));
