// Spike (a) web: load the export from the local strict-CSP server in headless Chrome and collect
// CanvasKit init, frame stats, the planck bench, CSP violations and screenshots.
//
//   ../../scripts/isolated.sh node scripts/web-measure.mjs [--gpu=swiftshader|default] [--dpr=2] [--label=sdk57]
//
// storage.googleapis.com is blocked on this network, so Playwright's bundled Chromium can't be
// downloaded; this uses the installed Google Chrome (channel 'chrome') with Playwright's throwaway
// profile and --use-mock-keychain (no sign-in, no sync, no keychain). Headless numbers are indicative.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opt = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const gpu = opt.gpu ?? 'swiftshader';
const dpr = Number(opt.dpr ?? 2);
const label = opt.label ?? 'sdk57';
const dist = path.resolve(root, opt.dist ?? 'dist');
const outDir = path.join(root, 'results');
mkdirSync(outDir, { recursive: true });

function startServer(port, extra = []) {
  const child = spawn(
    process.execPath,
    [path.join(root, 'scripts/serve.mjs'), dist, String(port), ...extra],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  return new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      if (String(d).includes('serving')) resolve(child);
    });
  });
}

const INIT = `
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample, source: e.sourceFile, line: e.lineNumber });
  });
`;

async function newPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: dpr,
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => {
    const t = m.text();
    if (!t.startsWith('SPIKE ')) consoleLines.push(`${m.type()}: ${t}`.slice(0, 400));
  });
  page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`.slice(0, 400)));
  return { context, page, consoleLines };
}

async function waitFor(page, key, timeoutMs) {
  await page.waitForFunction(
    (k) =>
      window.__spike &&
      (window.__spike[k] !== undefined ||
        window.__spike['skia-load-error'] !== undefined ||
        window.__spike['render-error'] !== undefined),
    key,
    { timeout: timeoutMs, polling: 250 },
  );
  return page.evaluate(() => ({ spike: window.__spike, csp: window.__csp }));
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
});
const out = {
  label,
  browser: `chrome ${browser.version()}`,
  gpu,
  dpr,
  viewport: '412x915',
  runs: {},
};
const base = 'http://127.0.0.1:8787';
const server = await startServer(8787);
const serverNoBlob = await startServer(8788, ['--no-blob']);

try {
  // 1. Cold load + full auto run (Tamil, stress sweep, planck bench), self-hosted wasm.
  {
    const { context, page, consoleLines } = await newPage(browser);
    await page.goto(`${base}/?ck=self`);
    const shots = {};
    await page.waitForSelector('[data-testid="tamil"]', { timeout: 60000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(outDir, `web-${label}-tamil.png`) });
    shots.tamil = true;
    await page.waitForSelector('[data-testid="stress-2000"]', { timeout: 120000 });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: path.join(outDir, `web-${label}-stress-2000.png`) });
    const r = await waitFor(page, 'done', 240000);
    out.runs.coldAuto = { ...r, console: consoleLines };

    // 2. Warm reload in the same context (HTTP cache, V8 wasm code cache), loader only.
    await page.goto(`${base}/?ck=self&auto=0`);
    const warm = await waitFor(page, 'skia-load', 30000);
    out.runs.warmSelf = { skiaLoad: warm.spike['skia-load'], csp: warm.csp };

    // 3. Compile-only timing of the same bytes (3 runs).
    out.runs.compileOnly = await page.evaluate(async () => {
      const bytes = await (await fetch('/canvaskit/0.41.0/canvaskit.wasm')).arrayBuffer();
      const times = [];
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        await WebAssembly.compile(bytes);
        times.push(performance.now() - t);
      }
      return { bytes: bytes.byteLength, compileMs: times };
    });
    await context.close();
  }

  // 4. Loader variants, each in a fresh context (cold cache).
  for (const mode of ['cdn', 'cdn-badsri', 'cdn-timeout']) {
    const { context, page, consoleLines } = await newPage(browser);
    await page.goto(`${base}/?ck=${mode}&auto=0`);
    try {
      const r = await waitFor(page, 'skia-load', 60000);
      out.runs[mode] = {
        skiaLoad: r.spike['skia-load'],
        error: r.spike['skia-load-error'],
        csp: r.csp,
        console: consoleLines,
      };
    } catch (e) {
      out.runs[mode] = { timeout: String(e).slice(0, 200), console: consoleLines };
    }
    await context.close();
  }

  // 5. CDN loader against a CSP without blob: in connect-src.
  {
    const { context, page, consoleLines } = await newPage(browser);
    await page.goto(`http://127.0.0.1:8788/?ck=cdn&auto=0`);
    try {
      const r = await waitFor(page, 'skia-load', 60000);
      out.runs.cdnNoBlobCsp = {
        skiaLoad: r.spike['skia-load'],
        error: r.spike['skia-load-error'],
        csp: r.csp,
        console: consoleLines,
      };
    } catch (e) {
      out.runs.cdnNoBlobCsp = { timeout: String(e).slice(0, 200), console: consoleLines };
    }
    await context.close();
  }

  out.serverCspReports = {
    main: await (await fetch(`${base}/csp-report`)).json(),
    noBlob: await (await fetch('http://127.0.0.1:8788/csp-report')).json(),
  };
} finally {
  await browser.close();
  server.kill();
  serverNoBlob.kill();
}

const file = path.join(outDir, `web-${label}-${gpu}-dpr${dpr}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`wrote ${path.relative(root, file)}`);
const s = out.runs.coldAuto?.spike ?? {};
console.log(
  JSON.stringify(
    { skiaLoad: s['skia-load'], errors: [s['skia-load-error'], s['render-error']].filter(Boolean) },
    null,
    2,
  ),
);
for (const k of Object.keys(s).filter((k) => k.startsWith('stress-'))) {
  const v = s[k];
  console.log(
    k,
    `fps ${v.meanFps.toFixed(1)} p50 ${v.p50} p95 ${v.p95} p99 ${v.p99} >20 ${v.pctOver20.toFixed(1)}% >33 ${v.pctOver33.toFixed(1)}% work ${v.workMeanMs.toFixed(2)}`,
  );
}
console.log(
  'bench',
  JSON.stringify(
    s.bench?.results?.map((r) => ({
      b: r.allBullets,
      ms: r.msPerShot.mean,
      steps: r.stepsPerShot.mean,
    })),
  ),
);
console.log('tamil', JSON.stringify(s.tamil));
console.log('csp violations (page)', JSON.stringify(out.runs.coldAuto?.csp));
