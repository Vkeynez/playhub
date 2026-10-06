// Serves the exported web build like Render does: real files first, then the SPA shell for every
// other path (Render rewrites /* → /index.html). For local checks only.
//   node scripts/serve-dist.mjs [dir=dist] [port=8080]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

if (!existsSync(path.join(root, 'index.html'))) {
  process.stderr.write(`no index.html in ${root}; run the build first\n`);
  process.exit(1);
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  let file = path.join(root, decodeURIComponent(pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
  const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
  });
  // dist/ can vanish for a moment while a rebuild runs: answer 503 instead of crashing.
  createReadStream(file)
    .on('error', () => {
      if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Rebuilding, reload in a moment\n');
    })
    .pipe(res);
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`serving ${root} at http://127.0.0.1:${port}\n`);
});
