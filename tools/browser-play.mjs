// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes: at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3). On the desktop Enter on the
// focused Play stage 1 starts the run, the arrow keys and Space change lanes
// and boost, Escape pauses; on the phones Enter starts it, a tap on the left
// half of the road changes lane, the tray's Boost is tapped and the HUD's
// Pause button; every view then lets the run end (a crash or the finish) and
// shows the results. Screenshots of each step go to --shots. Fails on console
// errors or warnings or the runtime's error screen.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
// Serves GAME_DIR on loopback (never tests/, tools/ or dot-names), the engine
// itself from wiki.starhermit.com as the loader pins it. playwright-core is
// resolved from GAME_DIR's node_modules or any sibling game's.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  // The platform's clock (platform.serverTime / serverNow), as the game host answers it.
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;

const desktop = [
  ['shot', 'title'], ['key', 'Enter'], ['wait', 1500], ['shot', 'play'], ['key', 'ArrowLeft'], ['wait', 600], ['key', 'Space'], ['wait', 900],
  ['shot', 'boost'], ['key', 'Escape'], ['wait', 800], ['shot', 'paused'], ['key', 'Escape'], ['wait', 30000], ['shot', 'results'],
];
const phone = (pause) => [
  ['shot', 'title'], ['key', 'Enter'], ['wait', 1500], ['tap', { x: 0.25, y: 0.55 }], ['wait', 600], ['tap', { x: 0.5, y: 0.95 }], ['wait', 900],
  ['shot', 'boost'], ['tap', pause], ['wait', 800], ['shot', 'paused'], ['key', 'Escape'], ['wait', 30000], ['shot', 'results'],
];
const views = [
  { name: 'desktop', viewport: { width: 1366, height: 768 }, steps: desktop },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, steps: phone({ x: 0.88, y: 0.04 }) },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, steps: phone({ x: 0.94, y: 0.07 }) },
];
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  // The first key press can be lost while the runtime starts up.
  await page.waitForTimeout(4000);
  const W = v.viewport.width, H = v.viewport.height;
  const at = (p) => ({ x: W * p.x, y: H * p.y, id: 0 });
  for (const [op, a, b] of v.steps) {
    if (op === 'key') { await page.keyboard.down(a); await page.waitForTimeout(120); await page.keyboard.up(a); }
    if (op === 'down') await page.keyboard.down(a);
    if (op === 'up') await page.keyboard.up(a);
    if (op === 'wait') await page.waitForTimeout(a);
    if (op === 'touch') {
      // Fingers held on the pedals for `b` ms, then lifted (CDP touches: several at once).
      const points = a.map((p, i) => ({ ...at(p), id: i + 1 }));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
      await page.waitForTimeout(b);
      if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-holding-${a.length}.png`) }); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    if (op === 'tap') {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(a)] });
      await page.waitForTimeout(120);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    if (op === 'shot' && shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${a}.png`) }); }
  }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
