// Lane Sprint — pure deterministic rules: state, legality, scoring, seeded random stream.
'use strict';

const SCHEMA_VERSION = 1;

export const LANE_COUNT = 3;

export function createInitialState(seed) {
	return {
		schemaVersion: SCHEMA_VERSION,
		seed: seed >>> 0,
		tick: 0,
		lane: 1,          // 0..LANE_COUNT-1 (middle lane at start)
		position: 0,      // distance travelled in meters
		speed: 0,         // m/s
		boostActive: false,
		boostReadyAt: 0,
		crashed: false,
		finished: false,
		stageLength: 0,   // meters to finish line (set by content)
		checkpointIndex: -1,
		score: { cleanPasses: 0, timeBonus: 0 },
	};
}

// Seeded PRNG stream (mulberry32).
export function createRng(seed) {
	let s = seed >>> 0;
	return () => {
		s |= 0; s = (s + 0x6D2B79F5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function isLegalAction(state, actionId) {
	if (!state || typeof state !== 'object') return false;
	switch (actionId) {
		case 'lane_left':
			return !state.finished && !state.crashed && state.lane > 0;
		case 'lane_right':
			return !state.finished && !state.crashed && state.lane < LANE_COUNT - 1;
		case 'boost':
			if (state.boostActive) return false;
			if (!state.finished && !state.crashed) {
				const t = nowSeconds(state);
				if (t >= state.boostReadyAt) return true;
			}
			return false;
		default:
			return false;
	}
}

function nowSeconds(state) {
	return state.tick * 0.1; // fixed 10 Hz simulation step, seconds per tick
}

export function applyAction(state, actionId) {
	if (!isLegalAction(state, actionId)) return null;
	const s = Object.assign({}, state);
	s.tick += 1;
	switch (actionId) {
		case 'lane_left': s.lane -= 1; break;
		case 'lane_right': s.lane += 1; break;
		case 'boost': s.boostActive = true; break;
	}
	return s;
}

export function stateHash(state) {
	if (!state || typeof state !== 'object') return '';
	let h = (state.schemaVersion >>> 0);
	const add = v => { h ^= v >>> 0; };
	add(state.seed); add(state.tick); add(state.lane);
	add(Math.round(state.position)); add(Math.round(state.speed * 10));
	if (state.boostActive) add(1 << 24);
	if (state.crashed) add(1 << 25);
	if (state.finished) add(1 << 26);
	return h >>> 0;
}

export function isTerminal(state) {
	return !!(state && state.finished || state && state.crashed);
}

export function terminalReason(state) {
	if (!state) return '';
	if (state.finished) return 'finished';
	if (state.crashed) return 'crashed';
	return '';
}
