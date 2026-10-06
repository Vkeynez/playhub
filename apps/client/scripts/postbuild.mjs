// Runs after `expo export -p web`: makes sure the files Render serves as real files are in dist/
// (Expo copies public/ already; this is the safety net and the check), and writes 404.html.
//   node scripts/postbuild.mjs
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const { CANVASKIT_VERSION } = parseGenerated();
const required = [
  'robots.txt',
  '.well-known/assetlinks.json',
  `canvaskit/${CANVASKIT_VERSION}/canvaskit.wasm`,
];

for (const file of required) {
  const target = path.join(dist, file);
  if (existsSync(target)) continue;
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(path.join(root, 'public', file), target);
}
// SPA: Render rewrites /* to /index.html; 404.html is the same shell for hosts that use it.
copyFileSync(path.join(dist, 'index.html'), path.join(dist, '404.html'));

const missing = [...required, 'index.html'].filter((f) => !existsSync(path.join(dist, f)));
if (missing.length > 0) {
  process.stderr.write(`postbuild: missing in dist/: ${missing.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`postbuild: dist/ ok (canvaskit ${CANVASKIT_VERSION})\n`);

function parseGenerated() {
  const src = readFileSync(path.join(root, 'src/generated/canvaskit.ts'), 'utf8');
  const match = /CANVASKIT_VERSION = '([^']+)'/.exec(src);
  if (!match) throw new Error('src/generated/canvaskit.ts has no CANVASKIT_VERSION');
  return { CANVASKIT_VERSION: match[1] };
}
