// Lane Sprint — local persistence: settings and progression, versioned and validated.
// Launch/access tokens are never written here (see platform.js).
'use strict';

const KEY = 'lane-sprint/v1';
const SAVE_VERSION = 1;

const DEFAULTS = {
	version: SAVE_VERSION,
	locale: null,
	reducedMotion: false,
	highContrast: false,
	sound: true,
	highestStage: 1,
	bestScores: {},   // stageId -> integer score
	dailyBest: {},    // dayKey -> integer score
};

let cache = null;

function storage() {
	try {
		const s = window.localStorage;
		s.setItem(KEY + '/probe', '1'); s.removeItem(KEY + '/probe');
		return s;
	} catch (_) { return null; }
}

function sanitize(raw) {
	const out = Object.assign({}, DEFAULTS, { bestScores: {}, dailyBest: {} });
	if (!raw || typeof raw !== 'object') return out;
	if (typeof raw.locale === 'string') out.locale = raw.locale;
	out.reducedMotion = !!raw.reducedMotion;
	out.highContrast = !!raw.highContrast;
	out.sound = raw.sound !== false;
	const stage = Number(raw.highestStage);
	out.highestStage = Number.isFinite(stage) ? Math.max(1, Math.min(999, Math.floor(stage))) : 1;
	for (const map of ['bestScores', 'dailyBest']) {
		const src = raw[map];
		if (src && typeof src === 'object') {
			for (const k of Object.keys(src)) {
				const v = Number(src[k]);
				if (Number.isFinite(v) && v >= 0) out[map][String(k)] = Math.floor(v);
			}
		}
	}
	return out;
}

export function load() {
	if (cache) return cache;
	const s = storage();
	let raw = null;
	if (s) { try { raw = JSON.parse(s.getItem(KEY) || 'null'); } catch (_) { raw = null; } }
	cache = sanitize(raw);
	return cache;
}

export function save(patch) {
	const data = Object.assign(load(), patch || {});
	data.version = SAVE_VERSION;
	cache = data;
	const s = storage();
	if (s) { try { s.setItem(KEY, JSON.stringify(data)); } catch (_) {} }
	return data;
}

/** Records a score; returns true when it beat the stored best. */
export function recordScore(stageId, score, isDaily) {
	const data = load();
	const map = isDaily ? data.dailyBest : data.bestScores;
	const prev = map[stageId] || 0;
	if (score <= prev) return false;
	map[stageId] = Math.floor(score);
	save({});
	return true;
}

export function bestScore(stageId, isDaily) {
	const data = load();
	return (isDaily ? data.dailyBest : data.bestScores)[stageId] || 0;
}

export function unlockStage(index) {
	const data = load();
	if (index > data.highestStage) save({ highestStage: index });
	return load().highestStage;
}

export function resetForTests() { cache = null; }
