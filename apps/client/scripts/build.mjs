// PLACEHOLDER web build for the Render static site (render.yaml `playhub-web`). It exists only so the
// Blueprint can deploy before the app does. It is replaced by the Expo web export in P0-M6, which
// must keep emitting the same well-known files (robots.txt, .well-known/assetlinks.json, 404.html).
// No dependencies and no external resources.
//
//   node scripts/build.mjs

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const dist = path.resolve(import.meta.dirname, '..', 'dist');

const TITLE = 'playhub';
const DESCRIPTION = 'Card, board and party games to play with friends. Coming soon.';

const page = ({ heading, body }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${TITLE} — coming soon</title>
    <meta name="description" content="${DESCRIPTION}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${TITLE} — coming soon" />
    <meta property="og:description" content="${DESCRIPTION}" />
    <meta name="theme-color" content="#14213d" />
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        background: #14213d;
        color: #f5f5f5;
        text-align: center;
        padding: 0 16px;
      }
      h1 { font-size: clamp(2rem, 8vw, 3.5rem); margin: 0 0 0.5rem; letter-spacing: -0.02em; }
      p { margin: 0; opacity: 0.8; }
    </style>
  </head>
  <body>
    <main>
      <h1>${heading}</h1>
      <p>${body}</p>
    </main>
  </body>
</html>
`;

const files = {
  'index.html': page({ heading: `${TITLE} — coming soon`, body: DESCRIPTION }),
  '404.html': page({ heading: 'Page not found', body: 'playhub is coming soon.' }),
  // Room links (/join/*) are for people, not search engines (render.yaml also sends X-Robots-Tag).
  'robots.txt': 'User-agent: *\nDisallow: /join/\n',
  // Android App Links. Empty until the EAS release keystore's SHA-256 exists (ARCHITECTURE §11).
  '.well-known/assetlinks.json': '[]\n',
};

await rm(dist, { recursive: true, force: true });
for (const [name, content] of Object.entries(files)) {
  const target = path.join(dist, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
process.stdout.write(`client placeholder: wrote ${Object.keys(files).length} files to dist/\n`);
