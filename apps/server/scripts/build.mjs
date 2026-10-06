// Bundles the server into dist/ (ARCHITECTURE §5.4, §10.1): one ESM entry, dist/main.js, with the
// workspace packages and npm deps inlined, source maps and no minification. Code-splitting keeps
// lazily imported modules (planck, via /ops/bench/carrom) in their own chunk, so they are neither
// parsed nor evaluated at boot. Also copies packages/db/drizzle/** to dist/migrations/.
//
//   node scripts/build.mjs

import { cp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const migrations = path.resolve(root, '../../packages/db/drizzle');

await rm(dist, { recursive: true, force: true });

await build({
  entryPoints: { main: path.join(root, 'src/main.ts') },
  outdir: dist,
  bundle: true,
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  // Optional native add-ons that are never installed: pg's `pg.native` getter and ws's
  // bufferutil/utf-8-validate (both required lazily or inside try/catch).
  external: ['pg-native', 'bufferutil', 'utf-8-validate'],
  // Bundled CJS deps (pg, fastify, socket.io) call require() for Node built-ins; ESM has none.
  banner: {
    js: "import { createRequire as __gpCreateRequire } from 'node:module';\nconst require = __gpCreateRequire(import.meta.url);",
  },
});

await cp(migrations, path.join(dist, 'migrations'), { recursive: true });

async function sizeOf(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && !entry.name.endsWith('.map')) {
      total += (await stat(path.join(entry.parentPath, entry.name))).size;
    }
  }
  return total;
}
const mainKb = (await stat(path.join(dist, 'main.js'))).size / 1024;
const totalKb = (await sizeOf(dist)) / 1024;
process.stdout.write(
  `server bundle: dist/main.js ${mainKb.toFixed(0)} KiB, dist/ without maps ${totalKb.toFixed(0)} KiB\n`,
);
