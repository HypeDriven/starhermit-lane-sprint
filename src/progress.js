// Lane Sprint — the progress document: the furthest unlocked stage and the
// best score per stage and per Daily date. Pure (no storage, no platform) so
// the engine client and the node tests share it. The browser build kept the
// same fields (plus its settings, now the runtime's Options) in localStorage
// 'lane-sprint/v1' and in the cloud slot game:<slug> as plain JSON; readForeign
// reads that slot, merge() is its saveconflict merge (the best of each side).
'use strict';

export const MAX_STAGE = 40;

/** A clean progress document from anything (the old cloud doc included). */
export function normalize(raw) {
	const out = { highestStage: 1, bestScores: {}, dailyBest: {} };
	if (!raw || typeof raw !== 'object') return out;
	const stage = Number(raw.highestStage);
	out.highestStage = Number.isFinite(stage) ? Math.max(1, Math.min(999, Math.floor(stage))) : 1;
	for (const map of ['bestScores', 'dailyBest']) {
		const src = raw[map];
		if (!src || typeof src !== 'object') continue;
		for (const k of Object.keys(src)) {
			const v = Number(src[k]);
			if (Number.isFinite(v) && v >= 0) out[map][String(k)] = Math.floor(v);
		}
	}
	return out;
}

/** Two copies merged: the furthest unlocked stage and the best score per stage and per day. */
export function merge(a, b) {
	const x = normalize(a), y = normalize(b);
	const out = { highestStage: Math.max(x.highestStage, y.highestStage), bestScores: {}, dailyBest: {} };
	for (const map of ['bestScores', 'dailyBest']) {
		for (const k of new Set([...Object.keys(x[map]), ...Object.keys(y[map])])) out[map][k] = Math.max(x[map][k] || 0, y[map][k] || 0);
	}
	return out;
}

/** The browser build's cloud slot text (its whole store document as JSON), or null. */
export function readForeign(text) {
	if (typeof text !== 'string' || !text) return null;
	try {
		const doc = JSON.parse(text);
		return doc && typeof doc === 'object' ? normalize(doc) : null;
	} catch (_) { return null; }
}

export function hasProgress(d) {
	return d.highestStage > 1 || Object.keys(d.bestScores).length > 0 || Object.keys(d.dailyBest).length > 0;
}

/** Records a score in place; true when it beat the stored best. */
export function recordScore(doc, key, score, isDaily) {
	const map = isDaily ? doc.dailyBest : doc.bestScores;
	const prev = map[key] || 0;
	if (score <= prev) return false;
	map[key] = Math.floor(score);
	return true;
}

export function bestScore(doc, key, isDaily) {
	return (isDaily ? doc.dailyBest : doc.bestScores)[key] || 0;
}

/** Unlocks a stage in place; returns the furthest unlocked stage. */
export function unlockStage(doc, index) {
	if (index > doc.highestStage) doc.highestStage = index;
	return doc.highestStage;
}

/** The stage "Play" starts: the furthest unlocked, at most the last. */
export function nextStage(doc) {
	return Math.min(MAX_STAGE, doc.highestStage);
}
