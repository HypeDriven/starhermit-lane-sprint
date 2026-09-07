// Lane Sprint — versioned content: stages, themes, tutorials, validation metadata.
'use strict';

import {
	buildLayout, hashSeed, LANE_COUNT, CAR_LENGTH,
	createInitialState, applyAction, step, isTerminal, terminalReason,
} from './rules.js';

export const CONTENT_VERSION = 2;

export const STAGE_COUNT = 40;

const THEMES = [
	{ id: 'coastal', sky: 0x8fd4ff, road: 0x39404e, fog: 0xa8dcff, accent: 0x2fd6c8 },
	{ id: 'sunset', sky: 0xff9d6e, road: 0x3b3340, fog: 0xffc39a, accent: 0xffd166 },
	{ id: 'night', sky: 0x101c33, road: 0x23283a, fog: 0x1a2a44, accent: 0x7cc6ff },
	{ id: 'snow', sky: 0xdfeeff, road: 0x4a5160, fog: 0xeaf4ff, accent: 0x9ad9ff },
	{ id: 'desert', sky: 0xf6d9a0, road: 0x4d4438, fog: 0xf3ddb4, accent: 0xff8f5a },
];

export function getThemes() { return THEMES.slice(); }
export function getTheme(id) { return THEMES.find(t => t.id === id) || THEMES[0]; }
export function getStageCount() { return STAGE_COUNT; }

/**
 * Stages are data, not code: identifier, seed, goals, par values and theme.
 * Difficulty grows through row spacing and double-blocked rows rather than
 * through raw speed, so the reaction window shrinks fairly.
 */
export function getStage(index) {
	const i = Math.max(1, Math.min(STAGE_COUNT, Math.round(index)));
	const t = (i - 1) / (STAGE_COUNT - 1);
	const length = Math.round(900 + t * 900);
	const rowSpacing = Math.round(78 - t * 34);
	return {
		id: `stage-${i}`,
		index: i,
		seed: hashSeed(`lane-sprint/v${CONTENT_VERSION}/stage-${i}`),
		length,
		rowSpacing,
		doubleBlockChance: 0.1 + t * 0.55,
		padChance: 0.5 - t * 0.2,
		trafficSpeedMin: 12 + t * 6,
		trafficSpeedMax: 20 + t * 8,
		checkpoints: 4,
		parTime: Math.round(length / 30),
		theme: THEMES[(i - 1) % THEMES.length].id,
		contentVersion: CONTENT_VERSION,
	};
}

/** Daily challenge: one shared seed and ruleset per UTC day. */
export function getDailyStage(utcMillis) {
	const d = new Date(utcMillis);
	const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
	const seed = hashSeed(`lane-sprint/v${CONTENT_VERSION}/daily/${key}`);
	const t = (seed % 1000) / 1000;
	return {
		id: `daily-${key}`,
		dayKey: key,
		index: 0,
		seed,
		length: 1400,
		rowSpacing: Math.round(70 - t * 20),
		doubleBlockChance: 0.25 + t * 0.35,
		padChance: 0.4,
		trafficSpeedMin: 14,
		trafficSpeedMax: 26,
		checkpoints: 4,
		parTime: Math.round(1400 / 30),
		theme: THEMES[seed % THEMES.length].id,
		contentVersion: CONTENT_VERSION,
	};
}

/**
 * Offline validator: proves every stage is legal, completable without boosting
 * and bounded in duration. Exposed so tests and tooling can assert content
 * health without booting the renderer.
 */
export function validateStage(stage) {
	const problems = [];
	const { traffic, pads } = buildLayout(stage);
	if (stage.length <= 0) problems.push('non-positive length');
	if (!traffic.length) problems.push('no traffic generated');
	// Assert every generated row leaves at least one lane open.
	const rows = new Map();
	for (const car of traffic) {
		if (!rows.has(car.row)) rows.set(car.row, new Set());
		rows.get(car.row).add(car.lane);
	}
	for (const [key, lanes] of rows) {
		if (lanes.size >= LANE_COUNT) problems.push(`row ${key} blocks every lane`);
	}
	for (const pad of pads) {
		if (pad.lane < 0 || pad.lane >= LANE_COUNT) problems.push('pad outside lane range');
	}
	if (stage.parTime <= 0) problems.push('non-positive par time');
	return { id: stage.id, ok: problems.length === 0, problems, trafficCount: traffic.length, padCount: pads.length };
}

/**
 * Reference solver: a cautious lane-keeping policy that never boosts. If this
 * reaches the finish, the stage is completable through legal actions alone.
 * Used by the offline validator and by tests; never by play.
 */
export function solveStage(stage) {
	const state = createInitialState(stage);
	const LOOKAHEAD = 55;
	const clearance = (lane) => {
		let best = Infinity;
		for (const car of state.traffic) {
			if (car.lane !== lane) continue;
			const gap = car.z - state.position;
			if (gap < -CAR_LENGTH) continue;
			if (gap < best) best = gap;
		}
		return best;
	};
	let guard = 0;
	while (!isTerminal(state) && guard++ < 60000) {
		if (clearance(state.lane) < LOOKAHEAD) {
			// Pick the roomiest lane overall, then step one lane toward it —
			// but only through a neighbour that is safe to occupy right now.
			let target = state.lane;
			let bestGap = clearance(state.lane);
			for (let lane = 0; lane < LANE_COUNT; lane++) {
				const gap = clearance(lane);
				if (gap > bestGap) { bestGap = gap; target = lane; }
			}
			if (target !== state.lane) {
				const next = target < state.lane ? state.lane - 1 : state.lane + 1;
				if (clearance(next) > CAR_LENGTH * 2.5) {
					applyAction(state, target < state.lane ? 'lane_left' : 'lane_right');
				}
			}
		}
		step(state);
	}
	return {
		finished: !!state.finished,
		reason: terminalReason(state) || 'timeout',
		position: Math.round(state.position),
		elapsed: Number(state.elapsed.toFixed(2)),
		laneChanges: state.laneChanges,
	};
}

export function validateAllStages() {
	const results = [];
	for (let i = 1; i <= STAGE_COUNT; i++) {
		const stage = getStage(i);
		const result = validateStage(stage);
		result.solution = solveStage(stage);
		if (!result.solution.finished) {
			result.ok = false;
			result.problems.push(`unreachable goal: ${result.solution.reason} at ${result.solution.position}m`);
		}
		results.push(result);
	}
	return results;
}
