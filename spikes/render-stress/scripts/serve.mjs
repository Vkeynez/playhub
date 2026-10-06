// Tiny static server for the web export with production-style headers (ARCH §6.5): an *enforced*
// strict CSP (no 'unsafe-eval'; 'wasm-unsafe-eval' only), COOP, Permissions-Policy and the cache
// rules. CSP violation reports are POSTed to /csp-report and kept in memory (GET /csp-report).
//   ../../scripts/isolated.sh node scripts/serve.mjs [dir=dist] [port=8787] [--no-blob]
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const root = path.resolve(args[0] ?? 'dist');
const port = Number(args[1] ?? 8787);

// connect-src needs blob: only for the CDN-with-SRI loader (the verified bytes reach the CanvasKit
// glue as a blob: URL). --no-blob shows what breaks without it.
const connect = [
  "'self'",
  'https://cdn.jsdelivr.net',
  ...(flags.has('--no-blob') ? [] : ['blob:']),
];
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  `connect-src ${connect.join(' ')}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  'report-uri /csp-report',
].join('; ');

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
  '.map': 'application/json',
};

const reports = [];

function cacheControl(urlPath) {
  return /^\/(_expo\/static|assets|canvaskit)\//.test(urlPath)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (url.pathname === '/csp-report') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        try {
          reports.push(JSON.parse(body));
        } catch {
          reports.push({ raw: body });
        }
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reports));
    return;
  }

  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const idx = path.join(file, 'index.html');
    file = existsSync(idx) ? idx : path.join(root, 'index.html'); // SPA fallback
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': cacheControl(url.pathname),
    'content-security-policy': CSP,
    'cross-origin-opener-policy': 'same-origin-allow-popups',
    'permissions-policy': 'gamepad=(self), identity-credentials-get=(self)',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}`);
  console.log(`CSP: ${CSP}`);
});
