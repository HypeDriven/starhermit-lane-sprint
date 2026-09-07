// Lane Sprint — session: commands, fixed-step accumulator, replay envelope, snapshots.
'use strict';

import { createInitialState, applyAction, step, stateHash, isTerminal, terminalReason, DT } from './rules.js';
import { CONTENT_VERSION } from './content.js';

const MAX_CATCHUP_STEPS = 12; // caps work after a long tab stall

export function startSession(stage) {
	const state = createInitialState(stage);
	return {
		stage,
		state,
		accumulator: 0,
		commandCount: 0,
		replay: {
			schemaVersion: state.schemaVersion,
			contentVersion: CONTENT_VERSION,
			stageId: stage.id,
			seed: stage.seed,
			initialHash: stateHash(state),
			startedAt: Date.now(),
			commands: [],
			hashes: [],
		},
	};
}

/**
 * Queue a player command. Commands are applied at the next simulation step so
 * every input lands on a deterministic tick regardless of frame rate.
 */
export function sendCommand(session, actionId) {
	const accepted = applyAction(session.state, actionId);
	if (accepted) {
		session.commandCount += 1;
		session.replay.commands.push({ tick: session.state.tick, actionId });
	}
	return accepted;
}

/** Advance by wall-clock seconds using the fixed step. Returns steps taken. */
export function advance(session, deltaSeconds) {
	if (isTerminal(session.state)) return 0;
	session.accumulator += Math.max(0, deltaSeconds);
	let steps = 0;
	while (session.accumulator >= DT && steps < MAX_CATCHUP_STEPS) {
		session.accumulator -= DT;
		step(session.state);
		steps += 1;
		if (session.state.tick % 60 === 0) session.replay.hashes.push(stateHash(session.state));
		if (isTerminal(session.state)) { session.accumulator = 0; break; }
	}
	if (session.accumulator > DT * MAX_CATCHUP_STEPS) session.accumulator = 0;
	return steps;
}

/** Interpolation alpha for rendering between fixed steps. */
export function alpha(session) { return Math.max(0, Math.min(1, session.accumulator / DT)); }

export function drainEvents(session) {
	const events = session.state.events;
	if (!events.length) return [];
	const out = events.slice();
	events.length = 0;
	return out;
}

export function snapshot(session) {
	return {
		stageId: session.stage.id,
		tick: session.state.tick,
		hash: stateHash(session.state),
		terminal: isTerminal(session.state),
		reason: terminalReason(session.state),
	};
}

/** Deterministic replay verification: re-runs recorded commands from the seed. */
export function verifyReplay(session) {
	const state = createInitialState(session.stage);
	const commands = session.replay.commands.slice();
	let ci = 0;
	const guard = session.state.tick + 10;
	while (state.tick < session.state.tick && state.tick < guard) {
		while (ci < commands.length && commands[ci].tick === state.tick) {
			applyAction(state, commands[ci].actionId); ci += 1;
		}
		step(state);
	}
	// Commands can change the live state before another simulation step runs.
	while (ci < commands.length && commands[ci].tick === state.tick) {
		applyAction(state, commands[ci].actionId); ci += 1;
	}
	return { hash: stateHash(state), matches: stateHash(state) === stateHash(session.state) };
}
