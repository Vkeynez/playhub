// Debug helper: open one URL on the strict-CSP server, print console/errors/__spike after N ms.
//   ../../scripts/isolated.sh node scripts/debug-web.mjs "/?ck=self" 8000 [--gpu=default] [--dist=dist] [--click=Tamil] [--shot=name]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [urlPath = '/', waitMs = '8000', ...rest] = process.argv.slice(2);
const gpu = rest.find((a) => a.startsWith('--gpu='))?.split('=')[1] ?? 'swiftshader';
const dist = rest.find((a) => a.startsWith('--dist='))?.split('=')[1] ?? 'dist';
const click = rest.find((a) => a.startsWith('--click='))?.split('=')[1];
const shot = rest.find((a) => a.startsWith('--shot='))?.split('=')[1] ?? 'debug';
const server = spawn(
  process.execPath,
  [path.join(root, 'scripts/serve.mjs'), path.resolve(root, dist), '8799'],
  {
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('serving') && r()));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
});
try {
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
  });
  await ctx.addInitScript(
    `window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push({d:e.violatedDirective,b:e.blockedURI,s:e.sample,f:e.sourceFile,l:e.lineNumber}));`,
  );
  const page = await ctx.newPage();
  page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text().slice(0, 600)));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 600)));
  page.on('requestfailed', (r) => console.log('[requestfailed]', r.url(), r.failure()?.errorText));
  await page.goto(`http://127.0.0.1:8799${urlPath}`);
  if (click) {
    await page.getByText(click, { exact: true }).click({ timeout: 30000 });
  }
  await page.waitForTimeout(Number(waitMs));
  console.log('__spike keys', await page.evaluate(() => Object.keys(window.__spike ?? {})));
  console.log('__csp', JSON.stringify(await page.evaluate(() => window.__csp)));
  console.log('body text', (await page.evaluate(() => document.body.innerText)).slice(0, 800));
  await page.screenshot({ path: path.join(root, 'results', `${shot}.png`) });
} finally {
  await browser.close();
  server.kill();
}
