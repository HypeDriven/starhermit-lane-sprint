/**
 * Lane Sprint — end-to-end browser playthrough (dev only, not shipped).
 *
 * Drives the real shipped server and the real visible UI on desktop and mobile:
 *   title → help → settings (locale + accessibility toggles) → play → lane and
 *   boost input → pause/resume → restart → crash or finish → results → quit.
 * Fails loudly on any console error, page error or failed request.
 *
 * Run: npm run test:e2e
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { launchToken, noContentUrls, stubStarHermit } from './starhermit-e2e.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const serverMod = await import(join(ROOT, 'server.js'));

const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions|Failed to load resource: net::ERR_ABORTED/i;

const step = async (name, fn) => { await fn(); console.log(`ok - ${name}`); };

async function runPass(browser, label, contextOptions, baseUrl) {
	const context = await browser.newContext(contextOptions);
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	const page = await context.newPage();
	const errors = [];
	// Standalone (no launch token) must not touch any own-server route.
	const ownServer = [];
	const onRequest = (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && /^\/(api|ws)(\/|$)/.test(u.pathname)) ownServer.push(r.method() + ' ' + u.pathname); };
	page.on('request', onRequest);
	page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
	page.on('console', (m) => {
		if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) {
			errors.push(`console ${m.type()}: ${m.text()}`);
		}
	});
	page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });
	page.on('requestfailed', (r) => {
		// A 204 from the stubbed StarHermit API surfaces as ERR_ABORTED in Chromium; it is not a failure.
		if (noContentUrls.has(r.url())) return;
		errors.push(`requestfailed: ${r.url()} (${r.failure()?.errorText})`);
	});

	const shot = (stage) => page.screenshot({ path: `/tmp/lane-sprint-e2e-${stage}-${label}.png` });
	const phase = () => page.evaluate(() => window.__laneSprint.getPhase());
	const state = () => page.evaluate(() => {
		const s = window.__laneSprint.getState();
		return s && { lane: s.lane, position: s.position, speed: s.speed, boostActive: s.boostActive, tick: s.tick, crashed: s.crashed, finished: s.finished };
	});

	await step(`${label}: boot reaches the title screen`, async () => {
		await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
		await page.waitForFunction(() => window.__laneSprint && window.__laneSprint.getPhase() === 'title', null, { timeout: 15000 });
		await page.waitForSelector('#title-screen h1', { state: 'visible' });
		await page.waitForSelector('[data-action="play"]', { state: 'visible' });
		await shot('title');
	});

	await step(`${label}: no UI text is clipped on the title screen`, async () => {
		const clipped = await page.evaluate(() => {
			const out = [];
			for (const el of document.querySelectorAll('#title-screen *, #hud *')) {
				if (!el.offsetParent && el.tagName !== 'BODY') continue;
				if (el.classList.contains('sr-only')) continue; // intentionally clipped
				if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) out.push(`${el.tagName}#${el.id || ''}.${el.className}`);
			}
			return out;
		});
		if (clipped.length) throw new Error(`clipped elements: ${clipped.join(', ')}`);
	});

	await step(`${label}: help screen opens and closes`, async () => {
		await page.click('[data-action="open-help"]');
		await page.waitForSelector('#help-screen', { state: 'visible' });
		await shot('help');
		await page.click('#help-screen [data-action="close-overlay"]');
		await page.waitForSelector('#title-screen', { state: 'visible' });
	});

	await step(`${label}: settings toggles and locale switch apply`, async () => {
		await page.click('[data-action="open-settings"]');
		await page.waitForSelector('#settings-screen', { state: 'visible' });
		await page.click('#toggle-high-contrast');
		if (!(await page.evaluate(() => document.body.classList.contains('high-contrast')))) {
			throw new Error('high contrast toggle did not apply');
		}
		await page.click('#toggle-high-contrast');
		await page.selectOption('#select-locale', 'fr-FR');
		await page.waitForFunction(() => document.documentElement.lang === 'fr-FR');
		const playLabel = await page.textContent('[data-action="play"]');
		if (!/tape/i.test(playLabel)) throw new Error(`locale did not localize the menu: ${playLabel}`);
		await shot('settings-fr');
		await page.selectOption('#select-locale', 'en-US');
		await page.waitForFunction(() => document.documentElement.lang === 'en-US');
		await page.click('#settings-screen [data-action="close-overlay"]');
		await page.waitForSelector('#title-screen', { state: 'visible' });
	});

	await step(`${label}: settings survive a reload`, async () => {
		await page.click('[data-action="open-settings"]');
		await page.click('#toggle-sound');
		const before = await page.getAttribute('#toggle-sound', 'aria-pressed');
		await page.reload({ waitUntil: 'load' });
		await page.waitForFunction(() => window.__laneSprint && window.__laneSprint.getPhase() === 'title');
		await page.click('[data-action="open-settings"]');
		const after = await page.getAttribute('#toggle-sound', 'aria-pressed');
		if (before !== after) throw new Error(`sound setting not persisted: ${before} -> ${after}`);
		await page.click('#toggle-sound'); // restore default
		await page.click('#settings-screen [data-action="close-overlay"]');
	});

	await step(`${label}: graphics settings switch presets, override, persist and apply live`, async () => {
		const gfxPreset = () => page.evaluate(() => [document.body.dataset.gfxPreset, document.getElementById('game-canvas').dataset.gfxPreset]);
		await page.click('[data-action="open-settings"]');
		await page.waitForSelector('#gfx-section', { state: 'visible' });
		const autoLabel = await page.textContent('#gfx-preset option[value="auto"]');
		if (!/Auto \(detected: /.test(autoLabel)) throw new Error(`auto option label: ${autoLabel}`);
		await page.selectOption('#gfx-preset', 'low');
		await page.waitForFunction(() => document.body.dataset.gfxPreset === 'low');
		if ((await gfxPreset()).join() !== 'low,low') throw new Error('low preset not applied to canvas');
		if (!/no shadows/.test(await page.textContent('#gfx-summary'))) throw new Error('summary did not follow Low');
		await page.selectOption('#gfx-preset', 'high');
		await page.waitForFunction(() => document.body.dataset.gfxPreset === 'high');
		const summary = await page.textContent('#gfx-summary');
		if (!/2048² shadows/.test(summary) || !/SMAA/.test(summary)) throw new Error(`summary did not follow High: ${summary}`);
		await page.selectOption('#gfx-bloom', 'off');
		await page.waitForFunction(() => !/bloom/.test(document.getElementById('gfx-summary').textContent));
		// Keyboard: the render scale slider steps with the arrow keys.
		await page.focus('#gfx-scale');
		await page.keyboard.press('ArrowRight');
		await page.waitForFunction(() => document.getElementById('gfx-scale-value').textContent === '110%');
		await page.click('#gfx-show-fps');
		await page.waitForSelector('#fps-meter', { state: 'visible' });
		if (await page.getAttribute('#gfx-show-fps', 'aria-pressed') !== 'true') throw new Error('fps toggle not pressed');
		await shot('settings-graphics');
		await page.reload({ waitUntil: 'load' });
		await page.waitForFunction(() => window.__laneSprint && window.__laneSprint.getPhase() === 'title');
		if ((await gfxPreset()).join() !== 'high,high') throw new Error('preset did not survive reload');
		await page.click('[data-action="open-settings"]');
		if (await page.inputValue('#gfx-preset') !== 'high') throw new Error('preset select not restored');
		if (await page.inputValue('#gfx-bloom') !== 'off') throw new Error('bloom override not restored');
		if (await page.inputValue('#gfx-scale') !== '110') throw new Error('render scale not restored');
		// Ultra renders a live run without console noise.
		await page.selectOption('#gfx-preset', 'ultra');
		await page.waitForFunction(() => document.body.dataset.gfxPreset === 'ultra');
		if (await page.inputValue('#gfx-bloom') !== 'preset') throw new Error('choosing a preset did not clear overrides');
		await page.click('#settings-screen [data-action="close-overlay"]');
		await page.click('[data-action="practice"]');
		await page.waitForFunction(() => window.__laneSprint.getState().position > 10, null, { timeout: 20000 });
		await shot('play-ultra');
		await page.click('#btn-pause');
		await page.waitForSelector('#pause-screen', { state: 'visible' });
		await page.click('#pause-screen [data-action="open-settings"]');
		await page.waitForSelector('#gfx-section', { state: 'visible' });
		await page.selectOption('#gfx-preset', 'auto');
		await page.click('#gfx-show-fps');
		await page.focus('#gfx-scale');
		await page.keyboard.press('ArrowLeft');
		await page.waitForFunction(() => document.getElementById('gfx-scale-value').textContent === '100%');
		await page.waitForSelector('#fps-meter', { state: 'hidden' });
		await page.click('#settings-screen [data-action="close-overlay"]');
		await page.click('#pause-screen [data-action="quit"]');
		await page.waitForSelector('#title-screen', { state: 'visible' });
	});

	await step(`${label}: starting practice advances the simulation`, async () => {
		await page.click('[data-action="practice"]');
		await page.waitForFunction(() => window.__laneSprint.getPhase() === 'play');
		await page.waitForFunction(() => window.__laneSprint.getState().position > 20, null, { timeout: 10000 });
		const s = await state();
		if (!(s.speed > 0)) throw new Error('car is not moving');
		const score = await page.textContent('#hud-score');
		if (!(Number(score) > 0)) throw new Error(`HUD score did not update: ${score}`);
		await shot('play');
	});

	await step(`${label}: lane controls move the car and update the mirror`, async () => {
		const before = (await state()).lane;
		if (contextOptions.hasTouch) await page.tap('[data-action="lane_left"]');
		else await page.keyboard.press('ArrowLeft');
		await page.waitForTimeout(120);
		const after = (await state()).lane;
		if (after !== before - 1) throw new Error(`lane did not change left: ${before} -> ${after}`);
		const marked = await page.getAttribute(`#lane-cell-${after}`, 'data-player');
		if (marked !== 'true') throw new Error('lane mirror did not follow the car');
		const live = await page.textContent('#live-region');
		if (!live.trim()) throw new Error('no live-region announcement for the lane change');
		if (contextOptions.hasTouch) await page.tap('[data-action="lane_right"]');
		else await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(120);
		if ((await state()).lane !== before) throw new Error('lane did not change back right');
	});

	await step(`${label}: boost activates and then reports a cooldown`, async () => {
		if (contextOptions.hasTouch) await page.tap('[data-action="boost"]');
		else await page.keyboard.press('Space');
		await page.waitForTimeout(150);
		if (!(await state()).boostActive) throw new Error('boost did not activate');
		const badge = await page.getAttribute('#hud-boost', 'data-state');
		if (badge !== 'active') throw new Error(`boost badge state was ${badge}`);
		await page.waitForFunction(() => {
			const s = window.__laneSprint.getState();
			return !s || !s.boostActive || s.crashed || s.finished;
		}, null, { timeout: 10000 });
	});

	await step(`${label}: pause freezes the simulation and resume restores it`, async () => {
		const running = await phase();
		if (running !== 'play') { console.log(`  note: run already ended (${running}); restarting for the pause check`);
			await page.click('[data-action="restart"]');
			await page.waitForFunction(() => window.__laneSprint.getPhase() === 'play');
		}
		await page.click('#btn-pause');
		await page.waitForSelector('#pause-screen', { state: 'visible' });
		const t1 = (await state()).tick;
		await page.waitForTimeout(400);
		const t2 = (await state()).tick;
		if (t1 !== t2) throw new Error(`simulation kept running while paused: ${t1} -> ${t2}`);
		await shot('paused');
		await page.click('[data-action="resume"]');
		await page.waitForFunction(() => window.__laneSprint.getPhase() === 'play');
		await page.waitForFunction((t) => window.__laneSprint.getState().tick > t, t2, { timeout: 5000 });
	});

	await step(`${label}: restart resets the run to tick zero`, async () => {
		await page.keyboard.press('KeyR');
		await page.waitForFunction(() => {
			const s = window.__laneSprint.getState();
			return window.__laneSprint.getPhase() === 'play' && s && s.position < 30;
		}, null, { timeout: 5000 });
	});

	await step(`${label}: the run reaches a terminal state and shows results`, async () => {
		// Drive with the game's own action API so the run ends promptly and
		// deterministically; the DOM path is already covered above.
		await page.evaluate(async () => {
			const api = window.__laneSprint;
			const deadline = Date.now() + 60000;
			while (api.getPhase() === 'play' && Date.now() < deadline) {
				const s = api.getState();
				const clearance = (lane) => {
					let best = Infinity;
					for (const c of s.traffic) {
						if (c.lane !== lane) continue;
						const gap = c.z - s.position;
						if (gap < -4.2 || gap >= best) continue;
						best = gap;
					}
					return best;
				};
				if (clearance(s.lane) < 55) {
					let target = s.lane, bestGap = clearance(s.lane);
					for (let lane = 0; lane < 3; lane++) {
						const gap = clearance(lane);
						if (gap > bestGap) { bestGap = gap; target = lane; }
					}
					if (target !== s.lane) {
						const next = target < s.lane ? s.lane - 1 : s.lane + 1;
						if (clearance(next) > 10.5) api.action(target < s.lane ? 'lane_left' : 'lane_right');
					}
				}
				await new Promise(r => setTimeout(r, 16));
			}
		});
		await page.waitForSelector('#results-screen', { state: 'visible', timeout: 5000 });
		const reason = await page.evaluate(() => window.__laneSprint.terminalReason());
		const total = await page.textContent('.breakdown tr:last-child td');
		if (!(Number(total) >= 0)) throw new Error(`missing score total: ${total}`);
		console.log(`  run ended: ${reason}, total ${total}`);
		await shot('results');
	});

	await step(`${label}: replay of the finished run reproduces its state hash`, async () => {
		const result = await page.evaluate(() => window.__laneSprint.verifyReplay());
		if (!result || !result.matches) throw new Error('replay diverged from live state');
	});

	await step(`${label}: quit returns to the title screen`, async () => {
		await page.click('[data-action="quit"]');
		await page.waitForSelector('#title-screen', { state: 'visible' });
		if ((await phase()) !== 'title') throw new Error('phase did not return to title');
	});

	await step(`${label}: canvas resizes with the viewport`, async () => {
		await page.setViewportSize({ width: contextOptions.viewport.width, height: contextOptions.viewport.height - 120 });
		await page.waitForTimeout(200);
		const ok = await page.evaluate(() => {
			const c = document.getElementById('game-canvas');
			return c.width > 0 && c.height > 0 && Math.abs(c.clientHeight - window.innerHeight) < 2;
		});
		if (!ok) throw new Error('canvas did not track the viewport');
	});

	await step(`${label}: StarHermit — standalone makes no /api or /ws calls; launch token shows nickname, invite toast`, async () => {
		await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
		await page.waitForFunction(() => window.__laneSprint && window.__laneSprint.getPhase() === 'title', null, { timeout: 15000 });
		if (await page.locator('[data-action="invite"], [data-action="sign-in"]').count()) throw new Error('account buttons shown standalone');
		if (ownServer.length) throw new Error('standalone requested ' + ownServer.join(', '));
		page.off('request', onRequest);
		const calls = await stubStarHermit(page);
		await page.goto(baseUrl + 'index.html#game_token=' + launchToken(), { waitUntil: 'load', timeout: 30000 });
		await page.waitForFunction(() => /Al/.test(document.querySelector('#title-screen .player-line')?.textContent || ''), null, { timeout: 15000 });
		if (page.url().includes('game_token')) throw new Error('token left in URL');
		await page.click('[data-action="invite"]');
		await page.waitForSelector('#sh-toast:not([hidden])');
		const box = await page.locator('#sh-toast').boundingBox();
		if (box.x < 0 || box.x + box.width > page.viewportSize().width + 1) throw new Error('toast cut off');
		if (!calls.some((c) => c.includes('/cloud-saves/game%3Agid-1'))) throw new Error('no cloud-save load: ' + calls.join(', '));
		await shot('signed-in');
		// Let the debounced cloud save land on the stub before the context closes.
		await page.waitForTimeout(2600);
		await page.waitForLoadState('networkidle');
	});

	await context.close();
	if (errors.length) throw new Error(`${label} pass had page errors:\n${errors.join('\n')}`);
	await step(`${label}: no console/page/request errors`, async () => {});
}

const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
	args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

let failed = false;
try {
	const port = await serverMod.start(0);
	const baseUrl = `http://127.0.0.1:${port}/`;
	console.log(`serving ${ROOT} at ${baseUrl}`);

	await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, baseUrl);
	await runPass(browser, 'mobile', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, baseUrl);

	console.log('\nE2E PASS — full playthrough works on desktop + mobile with no page errors');
} catch (err) {
	failed = true;
	console.error(`\nE2E FAIL — ${err.message}`);
} finally {
	await browser.close();
	serverMod.webSocketServer.close();
	await new Promise((resolve) => serverMod.httpServer.close(resolve));
}
if (failed) process.exit(1);
