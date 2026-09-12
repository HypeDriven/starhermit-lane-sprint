// Lane Sprint — persistence: settings and progression, versioned and validated.
// localStorage is the offline cache; when a launch token is present the same
// doc is mirrored to the platform cloud slot (debounced, remote wins on boot).
// Launch/access tokens are never written here (see platform.js).
'use strict';

import * as platform from './platform.js';

const KEY = 'lane-sprint/v1';
const SAVE_VERSION = 1;
const CLOUD_DEBOUNCE_MS = 2000;

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
let syncState = 'offline';   // 'offline' | 'synced' | 'saving' | 'error'
let pushTimer = 0;
let pushInFlight = null;
const syncListeners = new Set();

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

/** Current cloud-mirror status, for the HUD badge. */
export function getSyncState() { return syncState; }

export function onSyncChange(fn) {
	syncListeners.add(fn);
	return () => syncListeners.delete(fn);
}

function setSyncState(state) {
	if (state === syncState) return;
	syncState = state;
	for (const fn of syncListeners) { try { fn(state); } catch (_) {} }
}

export function load() {
	if (cache) return cache;
	const s = storage();
	let raw = null;
	if (s) { try { raw = JSON.parse(s.getItem(KEY) || 'null'); } catch (_) { raw = null; } }
	cache = sanitize(raw);
	return cache;
}

function writeLocal(data) {
	cache = data;
	const s = storage();
	if (s) { try { s.setItem(KEY, JSON.stringify(data)); } catch (_) {} }
}

export function save(patch) {
	const data = Object.assign(load(), patch || {});
	data.version = SAVE_VERSION;
	writeLocal(data);
	scheduleCloudPush();
	return data;
}

/**
 * Boots from the cloud mirror when hosted: a remote save wins over the local
 * cache; a 404 (or any failure) keeps the local document. Returns true when
 * the local cache was replaced by the remote document.
 */
export async function syncFromCloud() {
	if (!platform.isHosted()) return false;
	try {
		const remote = await platform.fetchCloudSave();
		if (!remote || typeof remote !== 'object') { setSyncState('synced'); return false; }
		const merged = sanitize(remote);
		writeLocal(merged);
		setSyncState('synced');
		return true;
	} catch (_) {
		setSyncState('error');
		return false;
	}
}

function scheduleCloudPush() {
	if (!platform.isHosted()) { setSyncState('offline'); return; }
	setSyncState('saving');
	clearTimeout(pushTimer);
	pushTimer = setTimeout(() => { flushCloudPush().catch(() => {}); }, CLOUD_DEBOUNCE_MS);
}

/** Pushes the current document now; used by the debounce timer and pagehide. */
export async function flushCloudPush() {
	if (!platform.isHosted()) return false;
	clearTimeout(pushTimer);
	pushTimer = 0;
	if (pushInFlight) return pushInFlight;
	pushInFlight = (async () => {
		try {
			await platform.putCloudSave(load());
			setSyncState('synced');
			return true;
		} catch (_) {
			setSyncState('error');
			return false;
		} finally {
			pushInFlight = null;
		}
	})();
	return pushInFlight;
}

// Flush pending saves when the page is hidden or torn down.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
	window.addEventListener('pagehide', () => { flushCloudPush().catch(() => {}); });
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) flushCloudPush().catch(() => {});
	});
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
