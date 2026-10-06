// Headless smoke test of the exported web build (dist/), served with SPA fallback:
//   1. Home renders the 3 shelves and the 10 catalog tiles; dev tiles only with ?dev=1.
//   2. "Join with code" opens the coming-soon sheet.
//   3. A full dev-tictactoe match vs the bot completes and the result sheet offers a rematch.
//   4. dev-secret-pick (a Skia game) loads CanvasKit from /canvaskit/<ver>/ and plays a round.
// Playwright is borrowed from spikes/render-stress (installed Chrome, no browser download).
//   node scripts/smoke-web.mjs [--shots=<dir>]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const requireFromSpike = createRequire(
  path.resolve(root, '../../spikes/render-stress/package.json'),
);
const { chromium } = requireFromSpike('playwright');
const shots = path.resolve(
  process.argv.find((a) => a.startsWith('--shots='))?.slice(8) ?? path.join(root, '.smoke'),
);
mkdirSync(shots, { recursive: true });
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

const log = (msg) => process.stdout.write(`${msg}\n`);
const failures = [];
function check(ok, what) {
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

const server = spawn(
  process.execPath,
  [path.join(root, 'scripts/serve-dist.mjs'), 'dist', String(PORT)],
  {
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);
await new Promise((resolve) =>
  server.stdout.on('data', (d) => String(d).includes('serving') && resolve()),
);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-mock-keychain', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on(
    'console',
    (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 300)}`),
  );
  const byTestId = (id) => page.locator(`[data-testid="${id}"]`);

  // 1. Home
  await page.goto(`${BASE}/`);
  await page.getByText('Play with Friends').first().waitFor({ timeout: 20_000 });
  for (const shelf of ['Adventure', 'Relax']) {
    const shown = await page
      .getByText(shelf, { exact: true })
      .waitFor({ timeout: 5_000 })
      .then(
        () => true,
        () => false,
      );
    check(shown, `shelf ${shelf}`);
  }
  const tiles = await page.locator('[data-testid^="tile-"]').count();
  check(tiles === 10, `10 catalog tiles without ?dev=1 (got ${tiles})`);
  check((await page.getByText('Coming soon').count()) === 9, '9 tiles say Coming soon');
  await page.screenshot({ path: path.join(shots, 'home-phone.png'), fullPage: true });

  // 2. Join sheet
  await byTestId('join').click();
  await byTestId('join-sheet').waitFor({ timeout: 5_000 });
  const joinShown = await page
    .getByText('Multiplayer is coming soon')
    .waitFor({ timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
  check(joinShown, 'join sheet');
  await page.keyboard.press('Escape');
  await byTestId('join-sheet').waitFor({ state: 'detached', timeout: 5_000 });

  // 3. Tic-tac-toe vs bot
  await page.goto(`${BASE}/?dev=1`);
  await byTestId('tile-dev-tictactoe').waitFor({ timeout: 20_000 });
  check((await page.locator('[data-testid^="tile-"]').count()) === 12, 'dev tiles with ?dev=1');
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.screenshot({ path: path.join(shots, 'home-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await byTestId('tile-dev-tictactoe').click();
  await byTestId('start').waitFor({ timeout: 20_000 });
  await byTestId('level-easy').click();
  await page.screenshot({ path: path.join(shots, 'ttt-setup.png') });
  await byTestId('start').click();
  await byTestId('cell-0').waitFor({ timeout: 20_000 });
  const deadline = Date.now() + 90_000;
  let moves = 0;
  while (Date.now() < deadline) {
    if (await byTestId('result-sheet').isVisible()) break;
    const status = await byTestId('ttt-status').textContent();
    if (status === 'Your turn') {
      const empty = page.locator('[data-testid^="cell-"][aria-label$="empty"]');
      if ((await empty.count()) > 0) {
        await empty.first().click();
        moves += 1;
      }
    }
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: path.join(shots, 'ttt-result.png') });
  check(
    await byTestId('result-sheet').isVisible(),
    `tic-tac-toe match finished (${moves} human moves)`,
  );
  await byTestId('rematch').click();
  await byTestId('result-sheet').waitFor({ state: 'detached', timeout: 5_000 });
  const filled = await page.locator('[data-testid^="cell-"]:not([aria-label$="empty"])').count();
  check(filled <= 1, `rematch resets the board (${filled} marks)`);

  // 4. Secret Pick (Skia)
  await page.goto(`${BASE}/play/dev-secret-pick`);
  await byTestId('start').waitFor({ timeout: 20_000 });
  await byTestId('start').click();
  await byTestId('pick-2').waitFor({ timeout: 30_000 });
  const wasm = await page.evaluate(() =>
    globalThis.performance
      .getEntriesByType('resource')
      .some((e) => /\/canvaskit\/[^/]+\/canvaskit\.wasm$/.test(e.name)),
  );
  check(wasm, 'CanvasKit wasm loaded from the self-hosted path');
  await byTestId('pick-2').click();
  await page.waitForFunction(
    () =>
      /You take the round|Bot takes the round|Tie round/.test(globalThis.document.body.innerText),
    null,
    { timeout: 20_000 },
  );
  check((await page.locator('canvas').count()) > 0, 'Skia canvas rendered');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, 'secret-pick-reveal.png') });

  // 5. Cricket: logic + options load; the UI arrives from the cricket workstream.
  await page.goto(`${BASE}/play/cricket`);
  await byTestId('start').waitFor({ timeout: 20_000 });
  check((await byTestId('opt-wickets-2').count()) === 1, 'cricket wickets/overs options');
  await byTestId('opt-overs-5').click();
  await byTestId('start').click();
  const notReady = await page
    .getByText('Cricket is still being built')
    .waitFor({ timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
  log(`info cricket UI: ${notReady ? 'not built yet (placeholder shown)' : 'loaded'}`);
  await page.screenshot({ path: path.join(shots, 'cricket.png') });

  // Deep link to an unknown route falls back to the SPA shell.
  const res = await page.goto(`${BASE}/join/ABCDEF`);
  check(res?.status() === 200, 'SPA fallback for /join/ABCDEF');
} catch (e) {
  failures.push(String(e));
  log(`FAIL ${String(e).slice(0, 400)}`);
} finally {
  await browser.close();
  server.kill();
}
for (const e of errors) log(`  ${e}`);
check(errors.length === 0, `no page errors (${errors.length})`);
log(
  failures.length === 0
    ? `smoke passed; screenshots in ${shots}`
    : `smoke FAILED: ${failures.length}`,
);
process.exit(failures.length === 0 ? 0 : 1);
