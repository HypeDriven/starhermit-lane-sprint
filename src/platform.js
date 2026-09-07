// Lane Sprint — platform: token-aware REST/WebSocket adapter, retries, clock sync.
// Tokens live in memory only; they are never written to storage.
'use strict';

let _launchToken = null;
let _clockOffsetMs = 0;
let _hosted = false;

export function isHosted() { return _hosted; }
export function setLaunchToken(t) { _launchToken = t || null; _hosted = !!t; }
export function getLaunchToken() { return _launchToken; }

function headers() {
	const h = { 'Accept': 'application/json' };
	if (_launchToken) h['Authorization'] = `Bearer ${_launchToken}`;
	return h;
}

/**
 * Reads the launch token the host shell hands to the game. Absent a host we
 * stay in local guest mode, which must remain fully playable.
 */
export function readLaunchContext() {
	try {
		const params = new URLSearchParams(window.location.search);
		const token = params.get('launch_token') || params.get('token');
		if (token) setLaunchToken(token);
	} catch (_) {}
	return { hosted: _hosted };
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
