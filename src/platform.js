// Lane Sprint — platform: a thin adapter over the shared StarHermit SDK
// (starhermit-sdk.js, window.StarHermit), plus round-trip-corrected clock
// sync. The SDK reads the launch token (#game_token= or the #access_token=
// sign-in return), strips it from the URL, renews it, and makes every
// platform call here: profile/avatar, the cloud-save slot game:<slug>, the
// per-player settings KV, key bindings and the invite link. Tokens live in
// memory only; without one nothing here touches the network. Signed in, the
// only own-server route is the GET /api/v1/time clock sync.
'use strict';

let _sh = null;
let _clockOffsetMs = 0;

function sdk() {
	if (!_sh && typeof window !== 'undefined' && window.StarHermit) _sh = window.StarHermit;
	return _sh;
}

/** Tests inject an SDK instance built with StarHermit.create(). */
export function useSdk(instance) { _sh = instance || null; }

export function isHosted() { const s = sdk(); return !!(s && s.signedIn); }
export function getUserId() { return isHosted() ? String(sdk().userId) : null; }
export function getGameSlug() { const s = sdk(); return s ? s.slug : null; }
export function getLaunchToken() { return isHosted() ? sdk().token : null; }
export function canSignIn() { const s = sdk(); return !!(s && s.canSignIn()); }
export function signIn() { const s = sdk(); return !!(s && s.signIn()); }
/** fn(signedIn) — e.g. a refused renewal signs the player out. */
export function onAuth(fn) { const s = sdk(); return s ? s.on('auth', (a) => fn(!!a.signedIn)) : () => {}; }

/** Reads the launch context once (StarHermit.init). Absent a host we stay in local guest mode. */
export function readLaunchContext() {
	const s = sdk();
	if (s) s.init();
	return { hosted: isHosted(), userId: getUserId(), gameSlug: getGameSlug() };
}

/** Token renewal is scheduled by the SDK itself; kept for the boot sequence. */
export function startTokenRefresh() {}

function headers() {
	const h = { 'Accept': 'application/json' };
	const t = getLaunchToken();
	if (t) h['Authorization'] = `Bearer ${t}`;
	return h;
}

/** Signed in only: round-trip-adjusted host clock sync. Standalone uses the local clock. */
export async function syncTime() {
	if (!isHosted()) return { ok: false, offsetMs: 0, error: 'standalone' };
	const t0 = Date.now();
	try {
		const res = await fetch('/api/v1/time', { headers: headers(), cache: 'no-store' });
		if (!res.ok) throw new Error(`http ${res.status}`);
		const body = await res.json();
		const serverMs = Number(body.serverTime ?? body.now ?? body.epochMs);
		if (!Number.isFinite(serverMs)) throw new Error('bad time payload');
		const rtt = Date.now() - t0;
		_clockOffsetMs = serverMs + rtt / 2 - Date.now();
		return { ok: true, offsetMs: _clockOffsetMs, rtt };
	} catch (err) {
		_clockOffsetMs = 0;
		return { ok: false, offsetMs: 0, error: String(err && err.message || err) };
	}
}

export function now() { return Date.now() + _clockOffsetMs; }

/** Display name for the signed-in player; NEVER a username, never /api/v1/me. */
export function fallbackName() {
	return 'Player ' + String(getUserId() || '000000').slice(0, 6);
}

export async function fetchProfile() {
	if (!isHosted()) return null;
	const p = await sdk().profile();
	return { id: getUserId(), nickname: p ? p.displayName : fallbackName() };
}

/** Object URL of the account avatar, or null. */
export function fetchAvatar() { return isHosted() ? sdk().avatarUrl() : Promise.resolve(null); }

/** Fetches the cloud save doc (parsed JSON) or null when there is none/no host. */
export async function fetchCloudSave() {
	if (!isHosted()) return null;
	return sdk().loadJSON();
}

/** Stores the save doc in the game's single cloud slot (keepalive for pagehide). */
export async function putCloudSave(doc, keepalive) {
	if (!isHosted()) return false;
	const ok = await sdk().writeSave(JSON.stringify(doc), { keepalive: !!keepalive });
	if (!ok) throw new Error('cloud save failed');
	return true;
}

/** Per-player settings KV. */
export function getSettings() { return isHosted() ? sdk().getSettings() : Promise.resolve({}); }
export function patchSettings(obj) { if (isHosted()) sdk().patchSettings(obj); }

/** Resolve key bindings: defaults is { action: [code, …] }. */
export function loadBindings(defaults) {
	return isHosted() ? sdk().loadBindings(defaults) : Promise.resolve(JSON.parse(JSON.stringify(defaults)));
}

/** Share link that friends the recipient and invites them to play. */
export function inviteLink() { return isHosted() ? sdk().inviteLink() : null; }
