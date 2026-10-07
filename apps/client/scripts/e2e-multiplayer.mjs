// End-to-end "Join with code" test: two (then three) real browser contexts against a LOCAL server.
//   a) Tic-Tac-Toe: create → join with code (Home sheet) → ready → start → play → same result → rematch.
//   b) Hand Cricket (1 wicket, 1 over): create → join → toss → both innings → result; the guest never
//      receives or shows the host's secret pick before the reveal.
//   c) The guest joins Cricket through the /join/<CODE> link.
//   d) A third context opening a full room's link sees "Room full" + Watch, and watching is live.
//   e) Reloading the guest mid-match rejoins the same seat and the match plays to the end (Tic-Tac-Toe,
//      and Cricket with the host's pick already locked).
// Also: an unknown code shows "No room", and a human opponent is never labelled "Bot".
// No unexpected console errors in any context.
//
// Needs the local stack (never the deployed services):
//   (apps/server)  ../../scripts/isolated.sh node scripts/dev-local.mjs          # API on :10000
//   (repo root)    EXPO_PUBLIC_API_URL=http://localhost:10000 EXPO_PUBLIC_WEB_URL=http://localhost:8090 \
//                    scripts/isolated.sh corepack pnpm --filter @gp/client build
//   (apps/client)  ../../scripts/isolated.sh node scripts/serve-dist.mjs dist 8090
//   (apps/client)  ../../scripts/isolated.sh node scripts/e2e-multiplayer.mjs [--headed] [--only=ttt|cricket]
//   (or from the repo root: scripts/isolated.sh corepack pnpm --filter @gp/client e2e:multiplayer)
// Playwright is borrowed from spikes/render-stress (installed Chrome, no browser download).
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const { chromium } = createRequire(path.resolve(root, '../../spikes/render-stress/package.json'))(
  'playwright',
);
const BASE = process.env.E2E_BASE ?? 'http://localhost:8090';
const API = process.env.E2E_API ?? 'http://localhost:10000';
const shots = path.join(root, '.smoke');
mkdirSync(shots, { recursive: true });
const headed = process.argv.includes('--headed');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? null;

const log = (msg) => process.stdout.write(`${msg}\n`);
const failures = [];
function check(ok, what) {
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
}

const health = await globalThis.fetch(`${API}/health`).then(
  (r) => r.ok,
  () => false,
);
if (!health) {
  log(`no API at ${API}/health; start apps/server scripts/dev-local.mjs first`);
  process.exit(2);
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !headed,
  args: ['--use-mock-keychain', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

/** Socket.IO frames: `42[event, payload]` (event) and `43<id>[ack]` (ack). */
function parseFrame(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^4([23])(\d*)(\[.*)$/s.exec(raw);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[3]);
    return m[1] === '2' ? { event: arr[0], payload: arr[1] } : { event: 'ack', payload: arr[0] };
  } catch {
    return null;
  }
}

// Console noise that is expected in these flows (a reload drops the socket mid-flight).
const EXPECTED = [/WebSocket is closed before the connection is established/];

async function player(name, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const p = {
    name,
    ctx,
    page,
    errors: [],
    /** URL suffixes whose 404 is part of the test. */
    expected404: [],
    /** Every snapshot this page received (room:state events and room:join acks), in order. */
    snapshots: [],
    id: (testId) => page.locator(`[data-testid="${testId}"]`),
    last: () => p.snapshots.at(-1) ?? null,
    // Let entering animations settle so the screenshot shows the resting UI.
    shot: (file) =>
      sleep(900).then(() => page.screenshot({ path: path.join(shots, `mp-${file}.png`) })),
  };
  page.on('pageerror', (e) => p.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // The browser itself logs the 404 of a lookup we provoke on purpose (an unknown room code).
    const url = m.location()?.url ?? '';
    if (p.expected404.some((u) => url.endsWith(u)) && /status of 404/.test(text)) return;
    if (!EXPECTED.some((re) => re.test(text)))
      p.errors.push(`console: ${text.slice(0, 300)} ${url}`);
  });
  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      const f = parseFrame(payload);
      if (!f) return;
      if (f.event === 'room:state') p.snapshots.push(f.payload);
      else if (f.event === 'ack' && f.payload?.ok && f.payload.snapshot)
        p.snapshots.push(f.payload.snapshot);
    });
  });
  return p;
}

async function waitUntil(fn, what, timeout = 20_000, every = 150) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(every);
  }
  check(false, `timed out: ${what}`);
  return false;
}

async function createRoom(host, tile, options = []) {
  await host.page.goto(`${BASE}/?dev=1`);
  await host.id(`tile-${tile}`).click({ timeout: 20_000 });
  await host.id('play-friend').waitFor({ timeout: 20_000 });
  for (const o of options) await host.id(o).click();
  await host.id('play-friend').click();
  await host.id('room-code').waitFor({ timeout: 30_000 });
  const code = (await host.id('room-code').innerText()).replace(/[^A-Z0-9]/gi, '').toUpperCase();
  check(/^[A-Z0-9]{6}$/.test(code), `${tile}: lobby shows a 6-char code (${code})`);
  return code;
}

async function readyAndStart(host, guest, label) {
  for (const p of [host, guest]) {
    await waitUntil(() => p.id('ready').isEnabled(), `${label}: ${p.name} ready enabled`, 30_000);
    await p.id('ready').click();
  }
  await waitUntil(() => host.id('start-match').isEnabled(), `${label}: start enabled`);
  await host.shot(`${label}-lobby-host`);
  await guest.shot(`${label}-lobby-guest`);
  await host.id('start-match').click();
}

// ---- a) + d) + e): Tic-Tac-Toe -----------------------------------------------------------------

const cellLabels = (p) =>
  p.page
    .locator('[data-testid^="cell-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));

async function playTtt(players, label, { stopAfter = Infinity } = {}) {
  let moves = 0;
  const end = Date.now() + 90_000;
  while (Date.now() < end && moves < stopAfter) {
    if (
      (await players[0].id('result-sheet').count()) ||
      (await players[1].id('result-sheet').count())
    )
      break;
    for (const p of players) {
      if (
        (await p
          .id('ttt-status')
          .textContent()
          .catch(() => '')) !== 'Your turn'
      )
        continue;
      const empty = p.page.locator('[data-testid^="cell-"][aria-label$="empty"]');
      if ((await empty.count()) === 0) continue;
      await empty.first().click();
      moves += 1;
      await sleep(250);
    }
    await sleep(150);
  }
  return moves;
}

async function tttFlow() {
  const host = await player('host', { width: 390, height: 844 });
  const guest = await player('guest', { width: 1280, height: 800 });
  const code = await createRoom(host, 'dev-tictactoe');
  await host.shot('ttt-lobby-code');

  // Guest: Home → Join with code → type the code.
  await guest.page.goto(`${BASE}/`);
  await guest.id('join').click({ timeout: 20_000 });
  // A code nobody created first: a clear "no room" error, no navigation.
  const reversed = [...code].reverse().join('');
  const bogus = reversed !== code ? reversed : code.slice(1) + code[0];
  guest.expected404.push(`/rooms/${bogus}`);
  await guest.id('code-input').fill(bogus);
  await guest.id('join-submit').click();
  const notFound = await guest
    .id('join-error')
    .innerText({ timeout: 20_000 })
    .catch(() => '');
  check(/No room has that code/.test(notFound), `join: unknown code ${bogus} → "${notFound}"`);
  await guest.id('code-input').fill(code);
  await guest.id('join-submit').click();
  await guest.id('room-code').waitFor({ timeout: 30_000 });
  const guestCode = (await guest.id('room-code').innerText()).replace(/[^A-Z0-9]/gi, '');
  check(guestCode.toUpperCase() === code, `ttt: guest lands in the same lobby (${guestCode})`);
  await waitUntil(
    async () => host.last()?.seats.every((s) => s.occupant !== null),
    'ttt: host sees the guest seated',
  );

  await readyAndStart(host, guest, 'ttt');
  await host.id('cell-0').waitFor({ timeout: 20_000 });
  await guest.id('cell-0').waitFor({ timeout: 20_000 });
  check(true, 'ttt: match started for both');

  const moves = await playTtt([host, guest], 'ttt');
  await waitUntil(
    async () => (await host.id('result-sheet').count()) && (await guest.id('result-sheet').count()),
    'ttt: both see the result sheet',
  );
  await host.shot('ttt-result-host');
  await guest.shot('ttt-result-guest');
  const [hb, gb] = [await cellLabels(host), await cellLabels(guest)];
  check(JSON.stringify(hb) === JSON.stringify(gb), `ttt: same final board (${moves} moves)`);
  const [hr, gr] = [host.last()?.result, guest.last()?.result];
  check(
    hr && JSON.stringify(hr) === JSON.stringify(gr),
    `ttt: same result placements ${JSON.stringify(hr?.placements)}`,
  );
  const hText = await host.id('result-sheet').innerText();
  const gText = await guest.id('result-sheet').innerText();
  log(`info host sheet: ${hText.split('\n')[0]} | guest sheet: ${gText.split('\n')[0]}`);
  const youWin = (t) => /^You win/i.test(t);
  check(
    youWin(hText) !== youWin(gText) || /draw/i.test(hText + gText),
    'ttt: outcomes complement (one "You win", or a draw for both)',
  );

  // Rematch: both accept → a new board for both.
  const matchId = host.last()?.matchId;
  await host.id('rematch').click();
  await guest.id('rematch').click();
  for (const p of [host, guest]) {
    await p.id('result-sheet').waitFor({ state: 'detached', timeout: 15_000 });
  }
  await waitUntil(
    async () => (await cellLabels(host)).every((l) => l.endsWith('empty')),
    'ttt: host board empty after rematch',
  );
  check(
    (await cellLabels(guest)).every((l) => l.endsWith('empty')),
    'ttt: guest board empty after rematch',
  );
  check(host.last()?.matchId !== matchId, 'ttt: rematch is a new match');
  await host.shot('ttt-rematch-host');

  // d) A third context opens the full room's link: Room full + Watch → live match.
  const watcher = await player('watcher', { width: 800, height: 900 });
  await watcher.page.goto(`${BASE}/join/${code}`);
  const full = await watcher.page
    .getByText(/Room full/)
    .waitFor({ timeout: 20_000 })
    .then(
      () => true,
      () => false,
    );
  check(full, 'watch: full room link shows "Room full"');
  await watcher.shot('watch-room-full');
  await watcher.id('watch-live').click();
  await watcher.id('cell-0').waitFor({ timeout: 20_000 });
  check(watcher.last()?.yourSeat === null, 'watch: joined as a spectator');

  // Two moves, then the watcher must show the same board. A mark already on the board must not
  // re-mount (and replay its pop-in) when the next move arrives.
  await playTtt([host, guest], 'ttt2', { stopAfter: 1 });
  await waitUntil(
    async () => (await cellLabels(watcher)).some((l) => !l.endsWith('empty')),
    'watch: first move reaches the watcher',
  );
  const tagged = await watcher.page.evaluate(() => {
    const cell = [...globalThis.document.querySelectorAll('[data-testid^="cell-"]')].find(
      (c) => !(c.getAttribute('aria-label') ?? '').endsWith('empty'),
    );
    const mark = cell?.firstElementChild;
    if (mark) mark.setAttribute('data-probe', '1');
    return Boolean(mark);
  });
  await playTtt([host, guest], 'ttt2', { stopAfter: 1 });
  await waitUntil(
    async () =>
      JSON.stringify(await cellLabels(watcher)) === JSON.stringify(await cellLabels(host)),
    'watch: watcher sees the live board',
  );
  check(
    (await cellLabels(watcher)).filter((l) => !l.endsWith('empty')).length >= 2,
    'watch: watcher saw the moves',
  );
  check(
    tagged && (await watcher.page.locator('[data-probe="1"]').count()) === 1,
    'watch: earlier marks stay mounted when a move arrives',
  );
  await watcher.shot('watch-live');

  // e) Reload the guest mid-match: same seat, match continues to the end.
  const seat = guest.last()?.yourSeat;
  const before = await cellLabels(host);
  await guest.page.reload();
  await guest.id('cell-0').waitFor({ timeout: 30_000 });
  await waitUntil(
    async () => JSON.stringify(await cellLabels(guest)) === JSON.stringify(before),
    'reload: guest sees the same board after reload',
  );
  check(guest.last()?.yourSeat === seat, `reload: guest rejoined the same seat (${seat})`);
  await guest.shot('reload-rejoined');
  await playTtt([host, guest], 'ttt3');
  const done = await waitUntil(
    async () =>
      (await host.id('result-sheet').count()) &&
      (await guest.id('result-sheet').count()) &&
      (await watcher.id('result-sheet').count()),
    'reload: match after reload finished for host, guest and watcher',
  );
  if (done) check(true, 'reload: match after reload played to the end');
  check(
    JSON.stringify(await cellLabels(watcher)) === JSON.stringify(await cellLabels(guest)),
    'watch: watcher final board matches',
  );
  await watcher.shot('watch-result');
  return [host, guest, watcher];
}

// ---- b) + c): Hand Cricket ---------------------------------------------------------------------

const PENDING = new Set(['call', 'toss', 'ball']);

/** The guest must never receive the host's own pick while picks are still secret. */
function leakedPicks(guest, hostSeat) {
  const leaks = [];
  for (const s of guest.snapshots) {
    const v = s.view;
    if (!v || !Array.isArray(v.picks)) continue;
    if (PENDING.has(v.phase) && typeof v.picks[hostSeat] === 'number') {
      leaks.push(`v${s.version} ${v.phase} picks=${JSON.stringify(v.picks)}`);
    }
    for (const e of s.events ?? []) {
      if (e?.type === 'picked' && e.seat === hostSeat && e.value !== null) {
        leaks.push(`v${s.version} picked event ${JSON.stringify(e)}`);
      }
    }
  }
  return leaks;
}

const handLabels = (p) =>
  p.page
    .locator('[data-testid="cr-hand-home"],[data-testid="cr-hand-away"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));

async function cricketFlow() {
  const host = await player('host', { width: 390, height: 844 });
  const guest = await player('guest', { width: 1280, height: 800 });
  const code = await createRoom(host, 'cricket', ['opt-wickets-1', 'opt-overs-1']);

  // c) The guest opens the WhatsApp link directly.
  await guest.page.goto(`${BASE}/join/${code}`);
  await guest.id('room-code').waitFor({ timeout: 30_000 });
  check(
    (await guest.id('room-code').innerText()).replace(/[^A-Z0-9]/gi, '').toUpperCase() === code,
    'link: /join/<CODE> lands in the lobby',
  );
  await guest.shot('cricket-lobby-guest');
  await readyAndStart(host, guest, 'cricket');
  await host.id('cricket-screen').waitFor({ timeout: 30_000 });
  await guest.id('cricket-screen').waitFor({ timeout: 30_000 });
  check(true, 'cricket: match started for both');
  const hostSeat = host.last()?.yourSeat;
  // A human opponent is shown by name, never as "Bot".
  const noBot = async (when) => {
    for (const p of [host, guest]) {
      const text = await p.id('cricket-screen').innerText();
      check(
        !/\bBot\b/.test(text),
        `cricket: ${p.name} sees the opponent's name, not "Bot" (${when})`,
      );
    }
  };
  await sleep(500);
  await noBot('start');
  const opts = host.last()?.options;
  check(
    opts?.wickets === 1 && opts?.overs === 1,
    `cricket: options 1 wicket / 1 over (${JSON.stringify(opts)})`,
  );

  const enabledPick = async (p) => {
    for (let v = 1; v <= 6; v++) {
      const b = p.id(`cr-pick-${v}`);
      if ((await b.count()) && (await b.isEnabled().catch(() => false))) return true;
    }
    return false;
  };
  const clickChoices = async (p) => {
    for (const c of ['cr-call-odd', 'cr-choose-bat']) {
      const b = p.id(c);
      if ((await b.count()) && (await b.isEnabled().catch(() => false))) {
        await b.click().catch(() => {});
      }
    }
  };

  let balls = 0;
  let reloaded = false;
  let domChecks = 0;
  let shotN = 0;
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    if ((await host.id('result-sheet').count()) && (await guest.id('result-sheet').count())) break;
    await clickChoices(host);
    await clickChoices(guest);
    if (balls >= 2 && !reloaded && (await enabledPick(guest))) {
      // Mid-innings reload with the host's pick already locked: same seat, still secret.
      reloaded = true;
      const seat = guest.last()?.yourSeat;
      await waitUntil(() => enabledPick(host), 'cricket reload: host can pick');
      await host.id(`cr-pick-${1 + (balls % 6)}`).click();
      await sleep(400);
      await guest.page.reload();
      await guest.id('cricket-screen').waitFor({ timeout: 30_000 });
      await waitUntil(() => enabledPick(guest), 'cricket reload: guest can pick after rejoin');
      check(guest.last()?.yourSeat === seat, `cricket reload: guest rejoined seat ${seat}`);
      await guest.shot('cricket-reload-rejoined');
      await guest.id('cr-pick-4').click();
      balls += 1;
      continue;
    }
    if ((await enabledPick(host)) && (await enabledPick(guest))) {
      // Host picks first; while the guest's pick is pending, the guest must learn nothing.
      const handsBefore = await handLabels(guest);
      const hv = 1 + (balls % 6);
      await host.id(`cr-pick-${hv}`).click();
      await sleep(700);
      const handsAfter = await handLabels(guest);
      const leakText = await guest.page.evaluate(() => globalThis.document.body.innerText);
      if (JSON.stringify(handsBefore) !== JSON.stringify(handsAfter)) {
        check(false, `hidden: guest DOM changed hands before its pick ${handsAfter.join(',')}`);
      }
      if (shotN < 2) await guest.shot(`cricket-pending-${shotN++}`);
      domChecks += leakText.length > 0 ? 1 : 0;
      if (await enabledPick(guest)) await guest.id('cr-pick-4').click();
      balls += 1;
    }
    await sleep(200);
  }
  check(balls > 2 && reloaded, `cricket: played ${balls} throws (toss + balls), reload included`);
  await waitUntil(
    async () => (await host.id('result-sheet').count()) && (await guest.id('result-sheet').count()),
    'cricket: both see the result',
    30_000,
  );
  await noBot('result');
  await host.shot('cricket-result-host');
  await guest.shot('cricket-result-guest');
  const ho = host.last()?.view?.outcome;
  const go = guest.last()?.view?.outcome;
  check(
    ho && JSON.stringify(ho) === JSON.stringify(go),
    `cricket: same outcome for both ${JSON.stringify(ho)}`,
  );
  check(
    JSON.stringify(host.last()?.result) === JSON.stringify(guest.last()?.result),
    'cricket: same placements',
  );
  const leaks = leakedPicks(guest, hostSeat);
  check(
    leaks.length === 0 && domChecks > 0,
    `hidden: guest never received the host's pick early (${guest.snapshots.length} snapshots, ${domChecks} DOM checks)${leaks.length ? `: ${leaks.slice(0, 3).join(' | ')}` : ''}`,
  );
  const reverse = leakedPicks(host, 1 - hostSeat);
  check(reverse.length === 0, "hidden: host never received the guest's pick early");
  return [host, guest];
}

const all = [];
try {
  if (!only || only === 'ttt') all.push(...(await tttFlow()));
  if (!only || only === 'cricket') all.push(...(await cricketFlow()));
} catch (e) {
  check(false, String(e?.stack ?? e).slice(0, 800));
  for (const p of all) await p.shot(`fail-${p.name}`).catch(() => {});
} finally {
  for (const p of all) {
    for (const e of p.errors) log(`  [${p.name}] ${e}`);
    check(p.errors.length === 0, `${p.name}: no unexpected console errors (${p.errors.length})`);
  }
  await browser.close();
}
log(
  failures.length === 0 ? `e2e passed; screenshots in ${shots}` : `e2e FAILED: ${failures.length}`,
);
process.exit(failures.length === 0 ? 0 : 1);
