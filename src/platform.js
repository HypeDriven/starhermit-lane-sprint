// Lane Sprint — platform: launch-token capture + refresh, profile, cloud saves,
// token-aware REST, retries, clock sync. Tokens live in memory only; they are
// never written to storage.
'use strict';

let _launchToken = null;
let _userId = null;     // JWT `sub`
let _gameSlug = null;   // JWT `game_scope`; never hard-coded
let _clockOffsetMs = 0;
let _hosted = false;
let _refreshTimer = 0;

const REFRESH_INTERVAL_MS = 45 * 60 * 1000; // token lifetime is 60 min
const REFRESH_RETRY_MS = 60 * 1000;

export function isHosted() { return _hosted; }
export function getUserId() { return _userId; }
export function getGameSlug() { return _gameSlug; }
export function setLaunchToken(t) { _launchToken = t || null; _hosted = !!t; }
export function getLaunchToken() { return _launchToken; }

function headers() {
	const h = { 'Accept': 'application/json' };
	if (_launchToken) h['Authorization'] = `Bearer ${_launchToken}`;
	return h;
}

/** Base64url-decodes a JWT payload segment (no signature verification). */
function decodeJwtPayload(token) {
	const parts = String(token).split('.');
	if (parts.length < 2) return null;
	try {
		const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const json = decodeURIComponent(Array.prototype.map.call(atob(b64), (c) => {
			return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
		}).join(''));
		return JSON.parse(json);
	} catch (_) { return null; }
}

/**
 * Reads the launch token the host shell hands to the game: fragment
 * `#game_token=<jwt>` (optional `&session_id=`), read once and stripped from
 * the URL. Query params are kept as a local-dev fallback only. Absent a host
 * we stay in local guest mode, which must remain fully playable.
 */
export function readLaunchContext() {
	let token = null;
	try {
		if (window.location.hash.indexOf('game_token=') !== -1) {
			const frag = new URLSearchParams(window.location.hash.slice(1));
			token = frag.get('game_token');
			const clean = window.location.pathname + window.location.search;
			history.replaceState(null, '', clean);
		}
		if (!token) {
			const params = new URLSearchParams(window.location.search);
			token = params.get('launch_token') || params.get('token') || params.get('launch');
		}
	} catch (_) {}
	if (token) {
		setLaunchToken(token);
		const claims = decodeJwtPayload(token);
		if (claims && typeof claims === 'object') {
			if (typeof claims.sub === 'string' && claims.sub) _userId = claims.sub;
			if (typeof claims.game_scope === 'string' && claims.game_scope) _gameSlug = claims.game_scope;
		}
	}
	return { hosted: _hosted, userId: _userId, gameSlug: _gameSlug };
}

/** Round-trip-adjusted host clock sync. Falls back to the local clock. */
export async function syncTime() {
	const t0 = Date.now();
	try {
		const res = await fetch('/api/v1/time', { headers: headers(), cache: 'no-store' });
		if (!res.ok) throw new Error(`http ${res.status}`);
		const body = await res.json();
		const serverMs = Number(body.now ?? body.epochMs);
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

/**
 * Re-mints the launch token with the current one (scoped tokens may re-mint)
 * and swaps it in. Retries failures after ~60 s; the schedule repeats every
 * 45 min so a 60 min token never expires mid-session.
 */
async function refreshLaunchToken() {
	if (!_hosted || !_launchToken || !_gameSlug) return;
	try {
		const res = await fetch(`/api/v1/games/${encodeURIComponent(_gameSlug)}/launch-token`, {
			method: 'POST',
			headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
			body: JSON.stringify({ token: _launchToken }),
		});
		if (!res.ok) throw new Error(`http ${res.status}`);
		const body = await res.json();
		if (!body || typeof body.token !== 'string' || !body.token) throw new Error('no token in refresh response');
		setLaunchToken(body.token);
		_refreshTimer = setTimeout(refreshLaunchToken, REFRESH_INTERVAL_MS);
	} catch (_) {
		_refreshTimer = setTimeout(refreshLaunchToken, REFRESH_RETRY_MS);
	}
}

export function startTokenRefresh() {
	if (!_hosted || _refreshTimer) return;
	_refreshTimer = setTimeout(refreshLaunchToken, REFRESH_INTERVAL_MS);
}

/** Display name for the signed-in player; NEVER a username, never /api/v1/me. */
export function fallbackName() {
	return 'Player ' + String(_userId || '00000000').slice(0, 8);
}

export async function fetchProfile() {
	if (!_hosted || !_userId) return null;
	try {
		const res = await fetch(`/api/v1/users/${encodeURIComponent(_userId)}/profile`, { headers: headers(), cache: 'no-store' });
		if (!res.ok) throw new Error(`http ${res.status}`);
		const body = await res.json();
		const nickname = typeof body.nickname === 'string' && body.nickname.trim() ? body.nickname.trim() : fallbackName();
		return { id: body.id || _userId, nickname };
	} catch (_) {
		return { id: _userId, nickname: fallbackName() };
	}
}

/** Fetches the cloud save doc (parsed JSON) or null when there is none/no host. */
export async function fetchCloudSave() {
	if (!_hosted || !_gameSlug || !_launchToken) return null;
	const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(_gameSlug)}`, { headers: headers(), cache: 'no-store' });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`http ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	const dataBytes = unzipFirstEntry(bytes);
	return JSON.parse(new TextDecoder().decode(dataBytes));
}

/** Stores the save doc as a zip+base64 payload in the game's single cloud slot. */
export async function putCloudSave(doc) {
	if (!_hosted || !_gameSlug || !_launchToken) return false;
	const dataBytes = new TextEncoder().encode(JSON.stringify(doc));
	const payload = bytesToBase64(zipStore('save.json', dataBytes));
	const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(_gameSlug)}`, {
		method: 'PUT',
		headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
		body: JSON.stringify({ dataBase64: payload }),
	});
	if (!res.ok) throw new Error(`http ${res.status}`);
	return true;
}

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
function crc32(bytes) {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
	const enc = new TextEncoder();
	const nameB = enc.encode(name);
	const crc = crc32(dataBytes);
	const out = [];
	const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
	const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
	u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
	u32(crc); u32(dataBytes.length); u32(dataBytes.length);
	u16(nameB.length); u16(0);
	const head = new Uint8Array(out);
	const cd = [];
	const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
	const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
	c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
	c32(crc); c32(dataBytes.length); c32(dataBytes.length);
	c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
	const cdHead = new Uint8Array(cd);
	const cdOff = head.length + nameB.length + dataBytes.length;
	const parts = [head, nameB, dataBytes, cdHead, nameB];
	const eocd = [];
	const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
	const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
	e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
	e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
	parts.push(new Uint8Array(eocd));
	const total = parts.reduce((n, p) => n + p.length, 0);
	const buf = new Uint8Array(total);
	let o = 0;
	for (const p of parts) { buf.set(p, o); o += p.length; }
	return buf;
}
function unzipFirstEntry(zipBytes) {
	// Stored single-entry reader: scan local headers for compression 0.
	const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
	let off = 0;
	while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
		const method = dv.getUint16(off + 8, true);
		const size = dv.getUint32(off + 18, true);
		const nameLen = dv.getUint16(off + 26, true);
		const extraLen = dv.getUint16(off + 28, true);
		const dataOff = off + 30 + nameLen + extraLen;
		if (method !== 0) throw new Error('unsupported zip entry');
		return zipBytes.slice(dataOff, dataOff + size);
	}
	throw new Error('bad zip');
}
function bytesToBase64(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(s);
}
function base64ToBytes(b64) {
	const s = atob(b64);
	const b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
	return b;
}

// Exported for save/load plumbing and offline validation of the zip codec.
export const zip = { zipStore, unzipFirstEntry, bytesToBase64, base64ToBytes };
