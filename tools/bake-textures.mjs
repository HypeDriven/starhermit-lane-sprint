// Bakes the browser build's procedural asphalt and verge textures (src/render.js
// before the engine port: buildSizedTextures with noiseFill) into
// assets/textures/road.png and ground.png, by running that canvas code
// unchanged in Chrome (~/games/tools/gpu-chrome.mjs). Their tens of thousands
// of speckles paint far too slowly on the engine's canvas at start-up, so the
// engine client loads these images instead (native/render.ts). They are
// near-white detail maps that multiply the theme's road and ground colours,
// baked at Ultra's 512 px (the runtime holds textures to the graphics level's
// size). Run once; commit the PNGs.
//   node tools/bake-textures.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function findPlaywright() {
  const roots = [root, resolve(root, '..'), ...readdirSync(resolve(root, '..')).map((d) => resolve(root, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

// The old src/render.js painters, verbatim (LANE_COUNT 3), returning data URLs.
const painters = String.raw`
const LANE_COUNT = 3;
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function noiseFill(ctx, w, h, base, spread, count, size, seed) {
  const rnd = seeded(seed);
  ctx.fillStyle = 'rgb(' + base + ',' + base + ',' + base + ')';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    const v = Math.round(base + (rnd() - 0.5) * spread);
    ctx.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.55)';
    const s = 1 + rnd() * size;
    ctx.fillRect(rnd() * w, rnd() * h, s, s);
  }
}
function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  return c.toDataURL('image/png');
}
function road(size) {
  return canvasTexture(size, size * 2, (ctx, pw, ph) => {
    const w = 256, h = 512;
    ctx.scale(pw / w, ph / h);
    noiseFill(ctx, w, h, 236, 60, 9000, 2, 7);
    const lanePx = w / (LANE_COUNT + 1);
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const cx = lanePx * (lane + 1);
      for (const off of [-0.22, 0.22]) {
        const g = ctx.createLinearGradient(cx + off * lanePx - 10, 0, cx + off * lanePx + 10, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,0.13)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(cx + off * lanePx - 10, 0, 20, h);
      }
    }
  });
}
function ground(size) {
  return canvasTexture(size, size, (ctx, pw, ph) => {
    const w = 256, h = 256;
    ctx.scale(pw / w, ph / h);
    noiseFill(ctx, w, h, 225, 90, 14000, 3, 3);
    const rnd = seeded(5);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = 'rgba(' + (rnd() < 0.5 ? '0,0,0' : '255,255,255') + ',0.06)';
      ctx.beginPath(); ctx.arc(rnd() * w, rnd() * h, 8 + rnd() * 26, 0, Math.PI * 2); ctx.fill();
    }
  });
}
`;

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, close } = await launchChrome(chromium);
const page = await browser.newPage();
await page.setContent('<!doctype html><title>bake</title>');
const out = await page.evaluate(`(() => { ${painters}; return { road: road(512), ground: ground(512) }; })()`);
await close();
const dir = join(root, 'assets', 'textures');
mkdirSync(dir, { recursive: true });
for (const [name, url] of Object.entries(out)) {
  writeFileSync(join(dir, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
  console.log(`wrote assets/textures/${name}.png`);
}
process.exit(0);
