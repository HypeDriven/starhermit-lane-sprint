/**
 * Lane Sprint — headless checks for rules, content, scoring, the session, i18n and the progress save.
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

await test('every key the engine client shows is authored in all nine locales (no silent English fallback)', () => {
	const { readdirSync, readFileSync } = fsMod;
	const used = new Set(['syncSynced', 'syncSaving', 'syncError', 'syncOffline']); // shown through a lookup table
	for (const f of readdirSync(join(ROOT, 'native'))) {
		if (!f.endsWith('.ts')) continue;
		const code = readFileSync(join(ROOT, 'native', f), 'utf8');
		for (const m of code.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1]);
	}
	assert.ok(used.size > 50, 'only ' + used.size + ' keys found');
	const en = i18n.AUTHORED['en-US'];
	assert.deepEqual([...used].filter((k) => !(k in en)), [], 'keys used but not defined');
	assert.deepEqual(Object.keys(en).filter((k) => !used.has(k)), [], 'keys defined but never shown');
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


// --- the progress save (src/progress.js) ---
const progress = await import(src('progress.js'));

await test('progress: normalize cleans any document, the old store document included', () => {
	assert.deepEqual(progress.normalize(null), { highestStage: 1, bestScores: {}, dailyBest: {} });
	const old = { version: 1, reducedMotion: true, highContrast: false, sound: true, graphics: { preset: 'auto' }, highestStage: '7', bestScores: { 'stage-1': 512.7, bad: -3, x: 'no' }, dailyBest: { '2026-10-01': 900 } };
	assert.deepEqual(progress.normalize(old), { highestStage: 7, bestScores: { 'stage-1': 512 }, dailyBest: { '2026-10-01': 900 } });
});

await test('progress: the browser build\'s cloud slot text is read (and junk is not)', () => {
	const text = JSON.stringify({ version: 1, sound: false, highestStage: 4, bestScores: { 'stage-3': 1200 }, dailyBest: {} });
	assert.deepEqual(progress.readForeign(text), { highestStage: 4, bestScores: { 'stage-3': 1200 }, dailyBest: {} });
	assert.equal(progress.readForeign('not json'), null);
	assert.equal(progress.readForeign(''), null);
	assert.equal(progress.readForeign(null), null);
});

await test('progress: merge keeps the furthest stage and the best score per stage and per day', () => {
	const a = { highestStage: 4, bestScores: { 'stage-1': 450 }, dailyBest: { d1: 100 } };
	const b = { highestStage: 6, bestScores: { 'stage-1': 100, 'stage-5': 800 }, dailyBest: { d1: 300, d2: 5 } };
	assert.deepEqual(progress.merge(a, b), { highestStage: 6, bestScores: { 'stage-1': 450, 'stage-5': 800 }, dailyBest: { d1: 300, d2: 5 } });
	assert.deepEqual(progress.merge(b, a), progress.merge(a, b));
	assert.deepEqual(progress.merge(null, a), progress.normalize(a));
});

await test('progress: records, bests, unlocks and the next stage', () => {
	const d = progress.normalize(null);
	assert.equal(progress.recordScore(d, 'stage-1', 300, false), true);
	assert.equal(progress.recordScore(d, 'stage-1', 200, false), false);
	assert.equal(progress.bestScore(d, 'stage-1', false), 300);
	assert.equal(progress.recordScore(d, 'daily-x', 50, true), true);
	assert.equal(progress.bestScore(d, 'daily-x', true), 50);
	assert.equal(progress.bestScore(d, 'daily-x', false), 0);
	assert.equal(progress.unlockStage(d, 3), 3);
	assert.equal(progress.unlockStage(d, 2), 3);
	assert.equal(progress.nextStage(d), 3);
	d.highestStage = 45;
	assert.equal(progress.nextStage(d), content.getStageCount());
	assert.equal(progress.hasProgress(progress.normalize(null)), false);
});

await test('the generated play script still matches the bot\'s run (tools/gen-plays.mjs)', async () => {
	const { readFileSync } = fsMod;
	const { plan } = await import(join(ROOT, 'tools', 'gen-plays.mjs'));
	const r = plan(content.getStage(1));
	assert.ok(r.state.finished);
	const text = readFileSync(join(ROOT, 'tests', 'native', 'stage-1-finish.play'), 'utf8');
	assert.ok(text.includes(`expect ${rules.scoreBreakdown(r.state).total}`), 'stale play script: run node tools/gen-plays.mjs');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
