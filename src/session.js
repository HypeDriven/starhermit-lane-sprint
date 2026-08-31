// Lane Sprint — session: commands, snapshot, prediction policy, reconnect, replay.
'use strict';

import { createInitialState, applyAction } from './rules.js';

export function startSession(seed) {
	return { state: createInitialState(seed), commandCount: 0 };
}

export function sendCommand(session, actionId) {
	const next = applyAction(session.state, actionId);
	if (!next) return session;
	session.commandCount += 1;
	session.state = next;
	return session;
}
