// Plays a full Hand Cricket match vs the easy bot (1 wicket, 1 over) against the exported web build
// (apps/client/dist, built first with `pnpm --filter @gp/client build`) in headless Chrome, clicking
// the buttons (or pressing keys with --keys) until the result sheet, then checks Rematch and that no
// console errors were logged. Playwright is borrowed from spikes/render-stress like the client smoke.
//   scripts/isolated.sh node packages/games/cricket/src/ui/e2e/play-web.mjs \
//     [--width=390] [--height=844] [--reduce] [--keys] [--shots=<dir>]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const repo = path.resolve(import.meta.dirname, '../../../../../..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const W = Number(arg('width', 390));
const H = Number(arg('height', 844));
const reduce = process.argv.includes('--reduce');
const useKeys = process.argv.includes('--keys');
const client = path.join(repo, 'apps/client');
const { chromium } = createRequire(path.join(repo, 'spikes/render-stress/package.json'))(
  'playwright',
);
const shots = path.resolve(
  arg('shots', path.join(client, '.smoke', `cricket-${W}${reduce ? '-rm' : ''}`)),
);
mkdirSync(shots, { recursive: true });
const PORT = 8793 + (W % 7);
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(
  process.execPath,
  [path.join(client, 'scripts/serve-dist.mjs'), 'dist', String(PORT)],
  {
    cwd: client,
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('serving') && r()));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-mock-keychain', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const log = (msg) => process.stdout.write(`${msg}\n`);
let ok = false;
try {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    reducedMotion: reduce ? 'reduce' : 'no-preference',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on(
    'console',
    (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 300)}`),
  );
  const id = (x) => page.locator(`[data-testid="${x}"]`);
  await page.goto(`${BASE}/play/cricket`);
  await id('start').waitFor({ timeout: 20_000 });
  if (await id('level-easy').count()) await id('level-easy').click();
  await id('opt-wickets-1').click();
  await id('opt-overs-1').click();
  await id('start').click();
  await id('cricket-screen').waitFor({ timeout: 20_000 });
  log('screen loaded');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '01-start.png') });
  const t0 = Date.now();
  let picks = 0;
  let shotN = 2;
  const seen = new Set();
  while (Date.now() - t0 < 150_000) {
    if (await id('result-sheet').count()) break;
    const status =
      (await id('cr-status')
        .textContent()
        .catch(() => '')) ?? '';
    for (const c of ['cr-call-odd', 'cr-choose-bat']) {
      if (await id(c).count()) {
        log(`click ${c}`);
        if (useKeys) await page.keyboard.press(c === 'cr-call-odd' ? 'o' : 'b');
        else await id(c).click();
      }
    }
    const v = 1 + ((picks * 5) % 6);
    const btn = id(`cr-pick-${v}`);
    if ((await btn.count()) && (await btn.isEnabled().catch(() => false))) {
      if (useKeys) await page.keyboard.press(String(v));
      else await btn.click();
      picks++;
      await page.waitForTimeout(500);
      const fb =
        (await id('cr-feedback')
          .textContent()
          .catch(() => null)) ?? '';
      if (shotN < 12 && fb && !seen.has(fb)) {
        seen.add(fb);
        await page.screenshot({
          path: path.join(
            shots,
            `${String(shotN++).padStart(2, '0')}-${fb.replace(/\W/g, '')}.png`,
          ),
        });
      }
    }
    if ((await id('cr-splash').count()) && !seen.has('splash' + status)) {
      seen.add('splash' + status);
      await page.screenshot({
        path: path.join(shots, `${String(shotN++).padStart(2, '0')}-splash.png`),
      });
    }
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '90-done.png') });
  const result = await id('cr-result')
    .textContent()
    .catch(() => null);
  const sheet = await id('result-sheet').count();
  log(`picks=${picks} result="${result}" sheet=${sheet} in ${Date.now() - t0}ms`);
  ok = sheet > 0 && Boolean(result);
  if (ok && (await id('rematch').count())) {
    await id('rematch').click();
    await id('cr-scoreboard').waitFor({ timeout: 10_000 });
    log('rematch ok');
  }
} catch (e) {
  log(`FAIL ${String(e).slice(0, 500)}`);
} finally {
  await browser.close();
  server.kill();
}
for (const e of errors) log(`  ${e}`);
log(ok && errors.length === 0 ? 'PASS' : `FAIL (errors ${errors.length})`);
process.exit(ok && errors.length === 0 ? 0 : 1);
