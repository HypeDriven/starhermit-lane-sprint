// Lane Sprint — pure deterministic rules: state, legality, scoring, seeded random stream.
// The simulation runs at a fixed step so replays and daily seeds resolve identically.
'use strict';

const SCHEMA_VERSION = 2;

export const LANE_COUNT = 3;
export const DT = 1 / 60;              // fixed simulation step (seconds)
export const LANE_WIDTH = 2.4;         // metres between lane centres
export const CAR_LENGTH = 4.2;         // metres, used for collision extents
export const CAR_HALF = CAR_LENGTH / 2;

const CRUISE_SPEED = 34;               // m/s target without boost
const BOOST_SPEED = 58;                // m/s target while boosting
const ACCEL = 16;                      // m/s^2 toward the current target
const BOOST_DURATION = 2.2;            // seconds of boost per activation
const BOOST_COOLDOWN = 6.0;            // seconds between manual boosts
const PAD_RADIUS = 2.6;                // metres of overlap needed to collect a pad

export const TUNING = { CRUISE_SPEED, BOOST_SPEED, BOOST_DURATION, BOOST_COOLDOWN };

// Seeded PRNG stream (mulberry32). Rules, decoration and audio use separate streams.
export function createRng(seed) {
	let s = seed >>> 0;
	return () => {
		s |= 0; s = (s + 0x6D2B79F5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function hashSeed(str) {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
	return h >>> 0;
}

/**
 * Build the deterministic layout for a stage. Every row leaves at least one
 * lane open, and row speeds never decrease with distance, so the gap between
 * consecutive rows can only grow: two rows can never merge into a wall.
 */
export function buildLayout(stage) {
	const rng = createRng(stage.seed);
	const traffic = [];
	const pads = [];
	const firstRow = 140;
	const spacing = stage.rowSpacing;
	const maxJitter = spacing * 0.15;
	let rowSpeed = stage.trafficSpeedMin;
	let row = 0;
	for (let z = firstRow; z < stage.length + 60; z += spacing, row++) {
		rowSpeed = Math.min(stage.trafficSpeedMax,
			rowSpeed + rng() * (stage.trafficSpeedMax - stage.trafficSpeedMin) * 0.35);
		const blocked = rng() < stage.doubleBlockChance ? 2 : 1;
		const lanes = [0, 1, 2];
		// Fisher–Yates with the seeded stream keeps row contents reproducible.
		for (let i = lanes.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			const t = lanes[i]; lanes[i] = lanes[j]; lanes[j] = t;
		}
		const jitter = (rng() - 0.5) * 2 * maxJitter;
		for (let i = 0; i < blocked; i++) {
			traffic.push({
				row,
				lane: lanes[i],
				z: z + jitter + i * 3.5,
				speed: rowSpeed,
				passed: false,
				hue: rng(),
			});
		}
		if (rng() < stage.padChance) {
			pads.push({ lane: lanes[lanes.length - 1], z: z + jitter + spacing * 0.5, taken: false });
		}
	}
	return { traffic, pads };
}

export function createInitialState(stage) {
	const layout = buildLayout(stage);
	return {
		schemaVersion: SCHEMA_VERSION,
		seed: stage.seed >>> 0,
		stageIndex: stage.index,
		tick: 0,
		elapsed: 0,          // seconds of simulated time
		lane: 1,             // 0..LANE_COUNT-1 (middle lane at start)
		position: 0,         // metres travelled
		speed: 18,           // m/s
		boostActive: false,
		boostTimer: 0,
		boostReadyAt: 0,     // simulated seconds at which a manual boost is legal
		crashed: false,
		finished: false,
		stageLength: stage.length,
		parTime: stage.parTime,
		checkpointCount: stage.checkpoints,
		checkpointIndex: 0,
		cleanPasses: 0,
		padsCollected: 0,
		invalidActions: 0,
		laneChanges: 0,
		traffic: layout.traffic,
		pads: layout.pads,
		events: [],          // transient event names drained by the presentation layer
	};
}

export function isLegalAction(state, actionId) {
	if (!state || typeof state !== 'object') return false;
	if (state.finished || state.crashed) return false;
	switch (actionId) {
		case 'lane_left': return state.lane > 0;
		case 'lane_right': return state.lane < LANE_COUNT - 1;
		case 'boost': return !state.boostActive && state.elapsed >= state.boostReadyAt;
		default: return false;
	}
}

/** Apply a player command. Returns true when the command was accepted. */
export function applyAction(state, actionId) {
	if (!isLegalAction(state, actionId)) {
		if (state && !state.finished && !state.crashed) state.invalidActions += 1;
		return false;
	}
	switch (actionId) {
		case 'lane_left': state.lane -= 1; state.laneChanges += 1; state.events.push('lane'); break;
		case 'lane_right': state.lane += 1; state.laneChanges += 1; state.events.push('lane'); break;
		case 'boost':
			state.boostActive = true;
			state.boostTimer = BOOST_DURATION;
			state.boostReadyAt = state.elapsed + BOOST_DURATION + BOOST_COOLDOWN;
			state.events.push('boost');
			break;
	}
	return true;
}

/**
 * Advance the simulation by exactly one fixed step. Mutates `state` in place so
 * the loop performs no per-frame allocation; only this module writes to it.
 */
export function step(state) {
	if (state.finished || state.crashed) return state;
	state.tick += 1;
	state.elapsed += DT;

	if (state.boostActive) {
		state.boostTimer -= DT;
		if (state.boostTimer <= 0) { state.boostActive = false; state.boostTimer = 0; }
	}

	const target = state.boostActive ? BOOST_SPEED : CRUISE_SPEED;
	if (state.speed < target) state.speed = Math.min(target, state.speed + ACCEL * DT);
	else state.speed = Math.max(target, state.speed - ACCEL * DT);

	state.position += state.speed * DT;

	const traffic = state.traffic;
	for (let i = 0; i < traffic.length; i++) {
		const car = traffic[i];
		car.z += car.speed * DT;
		if (car.z < state.position - 60) continue; // already far behind
		if (car.lane === state.lane && Math.abs(car.z - state.position) < CAR_LENGTH * 0.86) {
			state.crashed = true;
			state.events.push('crash');
			return state;
		}
		if (!car.passed && state.position > car.z + CAR_HALF) {
			car.passed = true;
			state.cleanPasses += 1;
		}
	}

	const pads = state.pads;
	for (let i = 0; i < pads.length; i++) {
		const pad = pads[i];
		if (pad.taken) continue;
		if (pad.lane === state.lane && Math.abs(pad.z - state.position) < PAD_RADIUS) {
			pad.taken = true;
			state.padsCollected += 1;
			state.boostActive = true;
			state.boostTimer = Math.max(state.boostTimer, BOOST_DURATION);
			state.events.push('boost');
		}
	}

	const nextCheckpoint = Math.floor((state.position / state.stageLength) * state.checkpointCount);
	if (nextCheckpoint > state.checkpointIndex && nextCheckpoint <= state.checkpointCount) {
		state.checkpointIndex = nextCheckpoint;
	}

	if (state.position >= state.stageLength) {
		state.position = state.stageLength;
		state.finished = true;
		state.events.push('finish');
	}
	return state;
}

/** Integer score breakdown. Presentation formats these; rules only produce integers. */
export function scoreBreakdown(state) {
	const distance = Math.round(Math.min(state.position, state.stageLength));
	const passes = state.cleanPasses * 25;
	const pads = state.padsCollected * 40;
	const timeBonus = state.finished
		? Math.max(0, Math.round((state.parTime - state.elapsed) * 60))
		: 0;
	const finishBonus = state.finished ? 500 : 0;
	const total = distance + passes + pads + timeBonus + finishBonus;
	return { distance, passes, pads, timeBonus, finishBonus, total };
}

export function progressPct(state) {
	if (!state || !state.stageLength) return 0;
	return Math.max(0, Math.min(100, (state.position / state.stageLength) * 100));
}

export function stateHash(state) {
	if (!state || typeof state !== 'object') return 0;
	let h = (state.schemaVersion >>> 0);
	const add = v => { h = (Math.imul(h ^ (v >>> 0), 16777619)) >>> 0; };
	add(state.seed); add(state.tick); add(state.lane);
	add(Math.round(state.position * 100)); add(Math.round(state.speed * 100));
	add(state.cleanPasses); add(state.padsCollected);
	add((state.boostActive ? 1 : 0) | (state.crashed ? 2 : 0) | (state.finished ? 4 : 0));
	return h >>> 0;
}

export function isTerminal(state) {
	return !!(state && (state.finished || state.crashed));
}

export function terminalReason(state) {
	if (!state) return '';
	if (state.finished) return 'finished';
	if (state.crashed) return 'crashed';
	return '';
}
