// Lane Sprint — procedural audio: buses, event mapping, focus/background behavior.
// Authored samples in sfx/*.opus are preferred per event; synthesis below is the fallback.
'use strict';

let ctx = null;
let fxBus = null;
let unlocked = false;
const listeners = new Set();

// Runtime event map: every basename in sfx/manifest.json is listed here.
const SFX_BY_EVENT = {
	lane: ['lane-whoosh-soft', 'lane-whoosh-quick', 'lane-whoosh-deep'],
	boost: ['boost-ignition', 'boost-surge', 'boost-roar'],
	crash: ['crash-impact', 'crash-scrape', 'crash-thud'],
	finish: ['finish-fanfare', 'finish-chime', 'finish-applause'],
};
const sampleCache = new Map(); // name -> { state: 'loading'|'ready'|'error', buffer }
const eventCursor = new Map(); // event -> round-robin index

function ensureCtx() {
	if (!ctx) {
		try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
	}
	return ctx;
}

function bus() {
	const c = ensureCtx(); if (!c) return null;
	if (!fxBus) {
		try { fxBus = c.createGain(); fxBus.connect(c.destination); } catch (_) { fxBus = null; }
	}
	return fxBus;
}

export function resumeAudio() {
	const c = ensureCtx();
	if (!c) return;
	unlocked = true;
	if (c.state === 'suspended') c.resume().catch(() => {});
}

function requestSample(name) {
	let entry = sampleCache.get(name);
	if (entry) return entry;
	entry = { state: 'loading', buffer: null };
	sampleCache.set(name, entry);
	const c = ensureCtx();
	if (!c) { entry.state = 'error'; return entry; }
	fetch('sfx/' + encodeURIComponent(name) + '.opus')
		.then(res => { if (!res.ok) throw new Error('http ' + res.status); return res.arrayBuffer(); })
		.then(data => c.decodeAudioData(data))
		.then(buffer => { entry.state = 'ready'; entry.buffer = buffer; })
		.catch(() => { entry.state = 'error'; });
	return entry;
}

function tryPlaySample(name) {
	const names = SFX_BY_EVENT[name];
	if (!names || !unlocked || !bus()) return false;
	const start = (eventCursor.get(name) || 0) % names.length;
	eventCursor.set(name, start + 1);
	for (let i = 0; i < names.length; i++) {
		const entry = requestSample(names[(start + i) % names.length]);
		if (entry.state === 'ready' && entry.buffer) {
			try {
				const src = ctx.createBufferSource();
				src.buffer = entry.buffer;
				src.connect(fxBus);
				src.start();
				return true;
			} catch (_) { return false; }
		}
	}
	return false;
}

function blip(freq, dur, type, gainVal) {
	const c = ensureCtx(); if (!c || !bus()) return;
	try {
		const o = c.createOscillator(), g = c.createGain();
		o.type = type || 'sine'; o.frequency.value = freq;
		g.gain.setValueAtTime(gainVal, c.currentTime);
		g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
		o.connect(g).connect(fxBus);
		o.start(); o.stop(c.currentTime + dur);
	} catch (_) {}
}

export function playEvent(name) {
	if (!tryPlaySample(name)) {
		switch (name) {
			case 'lane': blip(440, 0.12, 'triangle', 0.3); break;
			case 'boost': blip(880, 0.25, 'sawtooth', 0.35); break;
			case 'crash': blip(160, 0.4, 'square', 0.4); break;
			case 'finish': blip(987, 0.5, 'triangle', 0.4); break;
			default: break;
		}
	}
	listeners.forEach(fn => { try { fn(name); } catch (_) {} });
}

export function onAudioEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
