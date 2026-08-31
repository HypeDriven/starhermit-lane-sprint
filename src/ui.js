// Lane Sprint — semantic HTML interface: responsive DOM shell, focus, settings, overlays, accessibility mirror.
'use strict';

import { LANE_COUNT } from './rules.js';
import * as audioMod from './audio.js';

let canvas = null;
let hudScoreEl = null;
let hudProgressEl = null;
let overlayEl = null;
let titleScreenEl = null;
let resultsEl = null;
let helpEl = null;
let settingsEl = null;
let pauseBtnEl = null;

export function init() {
	canvas = document.getElementById('game-canvas');
	hudScoreEl = document.getElementById('hud-score');
	hudProgressEl = document.getElementById('hud-progress');
	overlayEl = document.getElementById('overlay');
	titleScreenEl = document.getElementById('title-screen');
	resultsEl = document.getElementById('results-screen');
	helpEl = document.getElementById('help-screen');
	settingsEl = document.getElementById('settings-screen');
	pauseBtnEl = document.getElementById('btn-pause');

	document.querySelectorAll('[data-action]').forEach(el => {
		el.addEventListener('click', onActionClick);
	});
	window.addEventListener('resize', () => {
		const rmod = window.__laneSprintRender; if (rmod && canvas) rmod.resize(canvas.clientWidth, canvas.clientHeight);
	});

	audioMod.onAudioEvent(name => {
		if (name === 'boost') document.body.classList.add('fx-boost');
		else document.body.classList.remove('fx-boost');
	});
}

export function showScreen(id) {
	titleScreenEl.style.display = id === 'title' ? '' : 'none';
	resultsEl.style.display = id === 'results' ? '' : 'none';
	helpEl.style.display = id === 'help' ? '' : 'none';
	settingsEl.style.display = id === 'settings' ? '' : 'none';
	if (overlayEl) overlayEl.style.display = id === 'play' || id === 'paused' ? 'none' : '';
}

export function setHud(score, progressPct) {
	if (!hudScoreEl) return;
	hudScoreEl.textContent = String(Math.round(score));
	if (hudProgressEl) hudProgressEl.style.width = Math.max(0, Math.min(100, progressPct)) + '%';
}

export function setOverlayText(text) { if (overlayEl) overlayEl.textContent = text; }

function onActionClick(e) {
	const el = e.currentTarget; const a = el.getAttribute('data-action');
	if (!a) return;
	window.__laneSprintUiHandleAction(a);
}

export function setPaused(paused) { if (pauseBtnEl) pauseBtnEl.textContent = paused ? 'Resume' : 'Pause'; }
