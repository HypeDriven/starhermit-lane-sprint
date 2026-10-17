/**
 * Lane Sprint — headless checks for rules, content, scoring, i18n and the server.
 * Run: npm run test:unit
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as fsMod from 'node:fs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const src = (f) => join(ROOT, 'src', f);

const rules = await import(src('rules.js'));
const content = await import(src('content.js'));
const session = await import(src('session.js'));
const i18n = await import(src('i18n.js'));

let passed = 0;
const failures = [];
async function test(name, fn) {
	try { await fn(); passed++; console.log(`ok - ${name}`); }
	catch (err) { failures.push(`${name}: ${err.message}`); console.log(`not ok - ${name}\n    ${err.message}`); }
}

await test('rng is deterministic for a seed', () => {
	const a = rules.createRng(1234), b = rules.createRng(1234);
	for (let i = 0; i < 50; i++) assert.equal(a(), b());
});

await test('every stage validates: rows never block all lanes', () => {
	const results = content.validateAllStages();
	assert.equal(results.length, content.getStageCount());
	const bad = results.filter(r => !r.ok);
	assert.deepEqual(bad, [], `invalid stages: ${JSON.stringify(bad)}`);
});

await test('daily stage is stable within a UTC day and differs across days', () => {
	const d1 = content.getDailyStage(Date.UTC(2026, 8, 7, 1));
	const d2 = content.getDailyStage(Date.UTC(2026, 8, 7, 23));
	const d3 = content.getDailyStage(Date.UTC(2026, 8, 8, 1));
	assert.equal(d1.seed, d2.seed);
	assert.notEqual(d1.seed, d3.seed);
});

await test('the next 40 daily stages are all completable', () => {
	const start = Date.UTC(2026, 0, 1);
	const failed = [];
	for (let d = 0; d < 40; d++) {
		const stage = content.getDailyStage(start + d * 86400000);
		const solution = content.solveStage(stage);
		if (!solution.finished) failed.push(`${stage.dayKey}: ${solution.reason} at ${solution.position}m`);
	}
	assert.deepEqual(failed, []);
});

await test('legality respects lane bounds, boost cooldown and terminal state', () => {
	const state = rules.createInitialState(content.getStage(1));
	assert.equal(rules.isLegalAction(state, 'lane_left'), true);
	state.lane = 0;
	assert.equal(rules.isLegalAction(state, 'lane_left'), false);
	assert.equal(rules.isLegalAction(state, 'lane_right'), true);
	assert.equal(rules.isLegalAction(state, 'boost'), true);
	rules.applyAction(state, 'boost');
	assert.equal(rules.isLegalAction(state, 'boost'), false, 'boost must not stack');
	state.crashed = true;
	assert.equal(rules.isLegalAction(state, 'lane_right'), false);
	assert.equal(rules.isLegalAction(state, 'boost'), false);
	assert.equal(rules.terminalReason(state), 'crashed');
});

await test('illegal actions are rejected and counted, never applied', () => {
	const state = rules.createInitialState(content.getStage(1));
	state.lane = 0;
	assert.equal(rules.applyAction(state, 'lane_left'), false);
	assert.equal(state.lane, 0);
	assert.equal(state.invalidActions, 1);
});

await test('a passive run in the start lane eventually terminates', () => {
	const state = rules.createInitialState(content.getStage(1));
	let guard = 0;
	while (!rules.isTerminal(state) && guard++ < 20000) rules.step(state);
	assert.ok(rules.isTerminal(state), 'run never terminated');
	assert.ok(state.elapsed < 200, `run took too long: ${state.elapsed}s`);
});

await test('a perfect-lane policy can finish stage 1 without boosting', () => {
	// Greedy dodge proves the layout is completable through legal actions only.
	const stage = content.getStage(1);
	const state = rules.createInitialState(stage);
	let guard = 0;
	while (!rules.isTerminal(state) && guard++ < 40000) {
		const danger = (lane) => state.traffic.some(c => c.lane === lane && c.z > state.position - 6 && c.z - state.position < 40);
		if (danger(state.lane)) {
			for (const next of [state.lane - 1, state.lane + 1]) {
				if (next < 0 || next >= rules.LANE_COUNT || danger(next)) continue;
				rules.applyAction(state, next < state.lane ? 'lane_left' : 'lane_right');
				break;
			}
		}
		rules.step(state);
	}
	assert.equal(rules.terminalReason(state), 'finished', `ended as ${rules.terminalReason(state)} at ${Math.round(state.position)}m`);
});

await test('score breakdown components sum to the total', () => {
	const state = rules.createInitialState(content.getStage(1));
	state.position = state.stageLength;
	state.finished = true;
	state.elapsed = 10;
	state.cleanPasses = 3;
	state.padsCollected = 2;
	const b = rules.scoreBreakdown(state);
	assert.equal(b.passes, 75);
	assert.equal(b.pads, 80);
	assert.equal(b.distance + b.passes + b.pads + b.timeBonus + b.finishBonus, b.total);
	assert.ok(Number.isInteger(b.total));
});

await test('an unfinished run earns no time or finish bonus', () => {
	const state = rules.createInitialState(content.getStage(1));
	state.position = 100; state.crashed = true; state.elapsed = 3;
	const b = rules.scoreBreakdown(state);
	assert.equal(b.timeBonus, 0);
	assert.equal(b.finishBonus, 0);
});

await test('identical command streams produce identical state hashes', () => {
	const run = () => {
		const s = session.startSession(content.getStage(3));
		for (let i = 0; i < 600; i++) {
			if (i === 100) session.sendCommand(s, 'lane_left');
			if (i === 200) session.sendCommand(s, 'boost');
			if (i === 300) session.sendCommand(s, 'lane_right');
			session.advance(s, 1 / 60);
		}
		return session.snapshot(s).hash;
	};
	assert.equal(run(), run());
});

await test('replay verification reproduces the live state', () => {
	const s = session.startSession(content.getStage(2));
	for (let i = 0; i < 400; i++) {
		if (i % 97 === 0) session.sendCommand(s, i % 2 ? 'lane_left' : 'lane_right');
		session.advance(s, 1 / 60);
	}
	const result = session.verifyReplay(s);
	assert.equal(result.matches, true, 'replay hash diverged');
});

await test('replay includes inputs on the current tick before advancing', () => {
	const s = session.startSession(content.getStage(1));
	session.sendCommand(s, 'lane_left');
	assert.equal(session.verifyReplay(s).matches, true);
	session.advance(s, 1 / 60);
	session.sendCommand(s, 'lane_right');
	assert.equal(session.verifyReplay(s).matches, true);
});

await test('advance is frame-rate independent for the same elapsed time', () => {
	const fine = session.startSession(content.getStage(4));
	for (let i = 0; i < 300; i++) session.advance(fine, 1 / 60);
	const coarse = session.startSession(content.getStage(4));
	for (let i = 0; i < 150; i++) session.advance(coarse, 2 / 60);
	assert.equal(session.snapshot(fine).tick, session.snapshot(coarse).tick);
});

await test('every locale defines every string key', () => {
	const missing = i18n.missingKeys();
	assert.deepEqual(missing, {}, `missing translations: ${JSON.stringify(missing)}`);
	assert.equal(i18n.availableLocales().length, 9);
});

await test('every key used in the code is authored in all nine locales (no silent English fallback)', () => {
	const { readdirSync, readFileSync } = fsMod;
	const used = new Set();
	for (const f of readdirSync(join(ROOT, 'src'))) {
		if (!f.endsWith('.js') || f === 'i18n.js') continue;
		const code = readFileSync(join(ROOT, 'src', f), 'utf8');
		for (const m of code.matchAll(/i18n\.t\(\s*'([^']+)'/g)) used.add(m[1]);
		for (const m of code.matchAll(/(?:label|aria)\([^,]+,\s*'([^']+)'\)/g)) used.add(m[1]);
	}
	assert.ok(used.size > 40, 'only ' + used.size + ' keys found');
	const en = i18n.AUTHORED['en-US'];
	const missingEn = [...used].filter((k) => !k.endsWith('_') && !(k in en)); // 'gfxTier_' + tier etc. are prefixes
	assert.deepEqual(missingEn, [], 'keys used but not defined');
	// en-GB intentionally inherits US spellings; the game name is not translated.
	for (const id of ['es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
		const missing = Object.keys(en).filter((k) => k !== 'title' && !(k in i18n.AUTHORED[id]));
		assert.deepEqual(missing, [], id + ' falls back to English for these keys');
	}
});

await test('locale negotiation maps browser tags to shipped locales', () => {
	assert.equal(i18n.negotiateLocale(null, ['pt-BR']), 'pt-BR');
	assert.equal(i18n.negotiateLocale(null, ['es-MX']), 'es-419');
	assert.equal(i18n.negotiateLocale(null, ['es-ES']), 'es-ES');
	assert.equal(i18n.negotiateLocale(null, ['fr-CA']), 'fr-CA');
	assert.equal(i18n.negotiateLocale(null, ['en-GB']), 'en-GB');
	assert.equal(i18n.negotiateLocale(null, ['xx-YY']), 'en-US');
	assert.equal(i18n.negotiateLocale('de-DE', ['en-US']), 'de-DE');
});

await test('interpolation substitutes parameters in each locale', () => {
	for (const l of i18n.availableLocales()) {
		i18n.setLocale(l.id);
		const s = i18n.t('stage', { n: 7 });
		assert.ok(s.includes('7'), `${l.id} lost the {n} parameter: ${s}`);
		assert.ok(!s.includes('{'), `${l.id} left an unsubstituted placeholder: ${s}`);
	}
	i18n.setLocale('en-US');
});


// --- graphics quality model ---
// src/gpu-level.js is a classic script in the page; imported here it sets globalThis.StarHermitGpu.
await import(src('gpu-level.js'));
const gfx = await import(src('gfx.js'));

await test('gfx: hardware level picks the Auto preset (StarHermit gpu-level.js)', () => {
	assert.equal(gfx.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
	assert.equal(gfx.detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
	assert.equal(gfx.detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'low');
	assert.equal(gfx.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'low');
	assert.equal(gfx.detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)'), 'balanced');
	assert.equal(gfx.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
	assert.equal(gfx.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)'), 'ultra');
	assert.equal(gfx.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)'), 'ultra');
	assert.equal(gfx.detectLevel('NVIDIA GeForce RTX 5090'), 20);
	assert.equal(gfx.detectLevel('SwiftShader'), 0);
	for (const [p, lv] of Object.entries(gfx.LEVELS)) assert.equal(gfx.presetForLevel(lv), p);
	assert.equal(gfx.presetForLevel(9), 'balanced');
	assert.equal(gfx.presetForLevel(16), 'high');
	assert.ok(['low', 'balanced'].includes(gfx.detectPreset('Adreno (TM) 740', { mobile: true })), 'mobile Adreno 740 is Balanced at most');
	assert.equal(gfx.detectPreset('NVIDIA GeForce RTX 5090', { mobile: true }), 'balanced', 'phones/tablets cap at Balanced');
	assert.equal(gfx.detectPreset('SwiftShader', { mobile: true }), 'low');
});

await test('gfx: per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
	const keys = ['material', 'road', 'ground', 'segments', 'trees', 'clouds', 'sparks', 'hudBlur', 'bloomRes', 'aoRes'];
	for (const p of gfx.PRESETS) for (const k of keys) assert.ok(k in gfx.BUDGETS[p], `${p}.${k}`);
	for (let i = 1; i < gfx.PRESETS.length; i++) {
		const a = gfx.BUDGETS[gfx.PRESETS[i - 1]], b = gfx.BUDGETS[gfx.PRESETS[i]];
		for (const k of ['road', 'ground', 'segments', 'trees', 'clouds', 'sparks', 'bloomRes', 'aoRes']) assert.ok(b[k] >= a[k], `${gfx.PRESETS[i]}.${k}`);
	}
	assert.deepEqual(gfx.PRESETS.map((p) => gfx.BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
	assert.deepEqual(gfx.PRESETS.map((p) => gfx.BUDGETS[p].hudBlur), [false, false, true, true]);
	assert.deepEqual(gfx.budget('high', 10), gfx.BUDGETS.high, 'floor level = table');
	assert.ok(gfx.budget('high', 14).sparks > gfx.BUDGETS.high.sparks, 'sparks grow above the floor');
	assert.ok(gfx.budget('ultra', 20).sparks <= gfx.BUDGETS.ultra.sparks * 2, 'at most 2x');
	assert.ok(gfx.budget('ultra', 2).sparks < gfx.BUDGETS.ultra.sparks, 'fewer below the floor');
	assert.deepEqual(gfx.resolve({ preset: 'low' }, 'low', 0).budget, gfx.BUDGETS.low);
	assert.equal(gfx.resolve({}, 'ultra', 20).level, 20);
});

await test('gfx: resolve applies preset, overrides and clamps scale', () => {
	const auto = gfx.resolve({}, 'low');
	assert.equal(auto.preset, 'low'); assert.equal(auto.auto, true);
	assert.equal(auto.shadows, 'off'); assert.equal(auto.post, false);
	const high = gfx.resolve({ preset: 'high' }, 'low');
	assert.equal(high.preset, 'high'); assert.equal(high.auto, false);
	assert.equal(high.shadows, gfx.presetTier('high', 'shadows'));
	assert.equal(high.post, true);
	const over = gfx.resolve({ preset: 'high', bloom: 'off', shadows: 'bogus', detail: 'plain' }, 'low');
	assert.equal(over.bloom, 'off'); assert.equal(over.shadows, 'medium'); assert.equal(over.detail, 'plain');
	assert.equal(gfx.resolve({ preset: 'balanced', render_scale: 9 }).scale, 2);
	assert.equal(gfx.resolve({ preset: 'balanced', render_scale: 0.1 }).scale, 0.5);
	assert.equal(gfx.resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
	assert.equal(gfx.resolve({ adaptive: false }).adaptive, false);
	assert.equal(gfx.resolve({}).adaptive, true);
	assert.equal(gfx.resolve({}).showFps, false);
});

await test('gfx: choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
	const next = gfx.applyPreset({ preset: 'high', bloom: 'off', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'low');
	assert.deepEqual(next, { preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
	assert.equal(gfx.applyPreset({}, 'nonsense').preset, 'auto');
});

await test('gfx: sanitize drops unknown keys/values and describe summarises cost', () => {
	const s = gfx.sanitize({ preset: 'mega', shadows: 'high', ao: 'x', evil: 1, render_scale: '3' });
	assert.deepEqual(s, { preset: 'auto', render_scale: 2, adaptive: true, show_fps: false, shadows: 'high' });
	const text = gfx.describe(gfx.resolve({ preset: 'high' }), [1280, 800]);
	assert.match(text, /2048² shadows/); assert.match(text, /SMAA/); assert.match(text, /1280×800 px/);
	assert.match(gfx.describe(gfx.resolve({ preset: 'low' })), /no shadows/);
});

// --- server ---
const serverMod = await import(join(ROOT, 'server.js'));
const port = await serverMod.start(0);
const base = `http://127.0.0.1:${port}`;

await test('server serves index.html with the right content type', async () => {
	const res = await fetch(`${base}/`);
	assert.equal(res.status, 200);
	assert.match(res.headers.get('content-type'), /text\/html/);
	assert.match(await res.text(), /<canvas id="game-canvas"/);
});

await test('server serves modules and css with correct types', async () => {
	const js = await fetch(`${base}/src/index.js`);
	assert.equal(js.status, 200);
	assert.match(js.headers.get('content-type'), /javascript/);
	const css = await fetch(`${base}/css/style.css`);
	assert.equal(css.status, 200);
	assert.match(css.headers.get('content-type'), /text\/css/);
});

await test('/api/v1/time returns a usable epoch', async () => {
	const res = await fetch(`${base}/api/v1/time`);
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.ok(Math.abs(body.now - Date.now()) < 5000);
});

await test('unknown api routes return a structured error', async () => {
	const res = await fetch(`${base}/api/v1/nope`);
	assert.equal(res.status, 404);
	assert.equal((await res.json()).error, 'unknown endpoint');
});

await test('missing files 404 and traversal is rejected', async () => {
	assert.equal((await fetch(`${base}/does-not-exist.js`)).status, 404);
	assert.equal((await fetch(`${base}/.git/config`)).status, 403);
	assert.equal((await fetch(`${base}/%2egit/config`)).status, 403);
	const escaped = await fetch(`${base}/../../etc/passwd`);
	assert.ok(escaped.status === 403 || escaped.status === 404, `traversal returned ${escaped.status}`);
	const encoded = await fetch(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
	assert.ok(encoded.status === 403 || encoded.status === 404, `encoded traversal returned ${encoded.status}`);
});

await test('non-GET methods are rejected', async () => {
	const res = await fetch(`${base}/`, { method: 'POST' });
	assert.equal(res.status, 405);
});

// ---- StarHermit platform adapter over the shared SDK ----
{
	const { readFileSync } = await import('node:fs');
	const platform = await import(src('platform.js'));
	const store = await import(src('store.js'));
	const sdkModule = { exports: {} };
	new Function('module', 'exports', readFileSync(join(ROOT, 'starhermit-sdk.js'), 'utf8'))(sdkModule, sdkModule.exports);
	const SDK = sdkModule.exports;
	const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
	const jwt = 'h.' + b64u({ sub: 'user-123456789', game_scope: 'gid-1', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';
	const calls = [];
	const saves = {};
	const etags = {};
	let version = 0;
	const kv = {};
	const fetchStub = async (url, init = {}) => {
		const method = init.method || 'GET';
		const body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ method, url, body, auth: init.headers && init.headers.Authorization });
		const r = (st, b) => new Response(b, { status: st });
		if (url.includes('/cloud-saves/')) {
			// Conditional writes like the platform: a stale If-Match (or If-None-Match: *
			// on a filled slot) is refused with 412; a success returns the new ETag.
			const rest = decodeURIComponent(url.split('/cloud-saves/')[1]);
			const key = rest.replace(/\/info$/, '');
			if (rest.endsWith('/info')) return r(200, JSON.stringify(saves[key] ? { exists: true, etag: etags[key] } : { exists: false }));
			if (method === 'PUT') {
				const h = init.headers || {};
				if ((h['If-Match'] && h['If-Match'] !== etags[key]) || (h['If-None-Match'] === '*' && saves[key])) return r(412, JSON.stringify({ etag: etags[key] }));
				saves[key] = Buffer.from(body.dataBase64, 'base64');
				etags[key] = '"v' + (++version) + '"';
				return r(200, JSON.stringify({ etag: etags[key] }));
			}
			return saves[key] ? r(200, saves[key]) : r(404, '');
		}
		if (url.endsWith('/profile')) return r(200, JSON.stringify({ username: 'pk', nickname: 'Al' }));
		if (/\/settings$/.test(url)) { if (method === 'PATCH') Object.assign(kv, body.settings); return r(200, JSON.stringify({ settings: kv })); }
		if (url.endsWith('/controls')) return r(200, JSON.stringify({ actions: [{ action: 'boost', codes: ['KeyB'] }] }));
		return r(404, '');
	};
	const makeWin = (hash, hostname = 'localhost') => {
		const win = { location: { hash, search: '', pathname: '/', hostname, origin: 'https://' + hostname, href: '' }, history: { replaceState: (a, b, u) => { win.replaced = u; } } };
		return win;
	};

	await test('platform: launch token read + stripped, nickname, cloud save game:<slug>, settings KV, bindings, invite', async () => {
		const win = makeWin('#game_token=' + jwt);
		const sh = SDK.create({ window: win, fetch: fetchStub });
		platform.useSdk(sh);
		const ctx = platform.readLaunchContext();
		assert.deepEqual(ctx, { hosted: true, userId: 'user-123456789', gameSlug: 'gid-1' });
		assert.equal(win.replaced, '/');
		assert.equal((await platform.fetchProfile()).nickname, 'Al');
		assert.ok(await platform.putCloudSave({ version: 1, highestStage: 7 }));
		const put = calls.find((c) => c.method === 'PUT');
		assert.equal(put.url, '/api/v1/me/cloud-saves/' + encodeURIComponent('game:gid-1'));
		assert.deepEqual(await platform.fetchCloudSave(), { version: 1, highestStage: 7 });
		platform.patchSettings({ sound: false });
		await new Promise((r) => setTimeout(r, 10));
		const patch = calls.find((c) => c.method === 'PATCH');
		assert.equal(patch.url, '/api/v1/games/gid-1/settings');
		assert.deepEqual(patch.body, { settings: { sound: false } });
		kv['ui.language'] = { choice: 'de-DE' };
		assert.deepEqual(await platform.getSettings(), { sound: false }, 'shared ui.* keys are not adopted as game settings');
		assert.deepEqual(await platform.loadBindings({ boost: ['Space'], restart: ['KeyR'] }), { boost: ['KeyB'], restart: ['KeyR'] });
		assert.ok(platform.inviteLink().endsWith('/game-invite/user-123456789/gid-1'));
		assert.ok(calls.every((c) => c.auth === 'Bearer ' + sh.token));
		sh.signOut();
	});

	await test('platform: standalone makes no network calls', async () => {
		let fetched = 0;
		const sh = SDK.create({ window: makeWin(''), fetch: async () => { fetched++; throw new Error('offline'); } });
		platform.useSdk(sh);
		assert.equal(platform.readLaunchContext().hosted, false);
		assert.equal(platform.canSignIn(), false);
		assert.equal(await platform.fetchProfile(), null);
		assert.equal(await platform.fetchCloudSave(), null);
		assert.equal(await platform.putCloudSave({ a: 1 }), false);
		platform.patchSettings({ a: 1 });
		assert.deepEqual(await platform.getSettings(), {});
		assert.deepEqual(await platform.loadBindings({ restart: ['KeyR'] }), { restart: ['KeyR'] });
		assert.equal(platform.inviteLink(), null);
		const realFetch = globalThis.fetch;
		globalThis.fetch = async () => { fetched++; throw new Error('offline'); };
		try { assert.equal((await platform.syncTime()).ok, false); } finally { globalThis.fetch = realFetch; }
		assert.equal(fetched, 0);
	});

	await test('platform: hosted domain without a token offers sign-in', () => {
		platform.useSdk(SDK.create({ window: makeWin('', '0b9d6f2e-3c4a-4e5b-9a7c-1d2e3f405162.starhermit.com'), fetch: async () => { throw new Error('x'); } }));
		platform.readLaunchContext();
		assert.equal(platform.canSignIn(), true);
	});

	await test('store: mergeSaves keeps the furthest stage and best scores from both sides, local settings', () => {
		const m = store.mergeSaves(
			{ highestStage: 9, sound: false, bestScores: { 'stage-1': 500, 'stage-2': 10 }, dailyBest: { '2026-10-01': 7 } },
			{ highestStage: 3, sound: true, bestScores: { 'stage-1': 900 }, dailyBest: { '2026-10-02': 4 } });
		assert.equal(m.highestStage, 9);
		assert.equal(m.sound, true);
		assert.deepEqual(m.bestScores, { 'stage-1': 900, 'stage-2': 10 });
		assert.deepEqual(m.dailyBest, { '2026-10-01': 7, '2026-10-02': 4 });
	});

	await test('store: a cloud write that lost to another device reloads, merges and saves again', async () => {
		for (const k of Object.keys(saves)) delete saves[k];
		const other = SDK.create({ window: makeWin('#game_token=' + jwt), fetch: fetchStub });
		other.init();
		const sh = SDK.create({ window: makeWin('#game_token=' + jwt), fetch: fetchStub });
		platform.useSdk(sh);
		platform.readLaunchContext();
		store.resetForTests();
		store.save({ highestStage: 4, bestScores: { 'stage-1': 300 } });
		await store.syncFromCloud();                  // empty slot: pushes this device's progress
		await store.flushCloudPush();
		await other.loadJSON();                       // the other device loads, plays further and saves
		assert.ok(await other.writeSave(JSON.stringify({ version: 1, highestStage: 6, bestScores: { 'stage-1': 100, 'stage-5': 800 }, dailyBest: {} })));
		store.save({ bestScores: { 'stage-1': 450 } }); // this device's write is now stale
		assert.equal(await store.flushCloudPush(), false);
		for (let i = 0; i < 50 && (sh.saveConflicted() || store.getSyncState() !== 'synced'); i++) await new Promise((res) => setTimeout(res, 5));
		const doc = JSON.parse(await sh.loadSave());
		assert.equal(doc.highestStage, 6);
		assert.deepEqual(doc.bestScores, { 'stage-1': 450, 'stage-5': 800 });
		assert.equal(store.load().highestStage, 6);
		sh.signOut(); other.signOut();
	});
}

serverMod.webSocketServer.close();
await new Promise((resolve) => serverMod.httpServer.close(resolve));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
