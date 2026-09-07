/**
 * Lane Sprint — headless checks for rules, content, scoring, i18n and the server.
 * Run: npm run test:unit
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

serverMod.webSocketServer.close();
await new Promise((resolve) => serverMod.httpServer.close(resolve));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
