// Lane Sprint — semantic HTML interface: responsive DOM shell, focus, localization,
// settings, overlays and the accessibility mirror of the Three.js playfield.
'use strict';

import { LANE_COUNT } from './rules.js';
import * as i18n from './i18n.js';

let els = {};
let onAction = () => {};
let lastAnnouncement = '';

const SCREENS = ['title', 'help', 'settings', 'paused', 'results'];

function $(id) { return document.getElementById(id); }

function button(label, action, className) {
	const b = document.createElement('button');
	b.type = 'button';
	b.textContent = label;
	b.className = className || 'btn';
	b.setAttribute('data-action', action);
	return b;
}

export function init(handler, state) {
	onAction = typeof handler === 'function' ? handler : () => {};
	els = {
		canvas: $('game-canvas'),
		hudScore: $('hud-score'),
		hudStage: $('hud-stage'),
		hudSpeed: $('hud-speed'),
		hudBoost: $('hud-boost'),
		hudProgressBar: $('hud-progress-bar'),
		hudProgressLabel: $('hud-progress-label'),
		lanes: $('hud-lanes'),
		live: $('live-region'),
		overlay: $('overlay'),
		title: $('title-screen'),
		results: $('results-screen'),
		help: $('help-screen'),
		settings: $('settings-screen'),
		paused: $('pause-screen'),
		touch: $('touch-controls'),
		pauseBtn: $('btn-pause'),
	};

	document.body.addEventListener('click', e => {
		const el = e.target.closest('[data-action]');
		if (!el || el.disabled) return;
		e.preventDefault();
		onAction(el.getAttribute('data-action'), el.getAttribute('data-value'));
	});

	buildLaneMirror();
	renderStatic(state);
	return els;
}

function buildLaneMirror() {
	if (!els.lanes) return;
	els.lanes.innerHTML = '';
	for (let i = 0; i < LANE_COUNT; i++) {
		const cell = document.createElement('li');
		cell.className = 'lane-cell';
		cell.id = `lane-cell-${i}`;
		els.lanes.appendChild(cell);
	}
}

/** Re-render every localized label. Called on boot and on locale change. */
export function renderStatic(state) {
	const s = state || {};
	document.title = i18n.t('title');

	if (els.title) {
		els.title.innerHTML = '';
		const h = document.createElement('h1'); h.textContent = i18n.t('title');
		const p = document.createElement('p'); p.className = 'tagline'; p.textContent = i18n.t('tagline');
		const nav = document.createElement('div'); nav.className = 'menu';
		nav.appendChild(button(i18n.t('play', { n: s.nextStage || 1 }), 'play', 'btn btn-primary'));
		nav.appendChild(button(i18n.t('daily'), 'daily'));
		nav.appendChild(button(i18n.t('practice'), 'practice'));
		nav.appendChild(button(i18n.t('help'), 'open-help'));
		nav.appendChild(button(i18n.t('settings'), 'open-settings'));
		els.title.append(h, p, nav);
	}

	if (els.help) {
		els.help.innerHTML = '';
		const h = document.createElement('h2'); h.textContent = i18n.t('help');
		const body = document.createElement('p'); body.textContent = i18n.t('helpBody');
		const h3 = document.createElement('h3'); h3.textContent = i18n.t('helpControls');
		const kb = document.createElement('p'); kb.textContent = i18n.t('helpKeyboard');
		const touch = document.createElement('p'); touch.textContent = i18n.t('helpTouch');
		const nav = document.createElement('div'); nav.className = 'menu';
		nav.appendChild(button(i18n.t('back'), 'close-overlay', 'btn btn-primary'));
		els.help.append(h, body, h3, kb, touch, nav);
	}

	if (els.settings) renderSettings(s);

	if (els.paused) {
		els.paused.innerHTML = '';
		const h = document.createElement('h2'); h.textContent = i18n.t('paused');
		const nav = document.createElement('div'); nav.className = 'menu';
		nav.appendChild(button(i18n.t('resume'), 'resume', 'btn btn-primary'));
		nav.appendChild(button(i18n.t('restart'), 'restart'));
		nav.appendChild(button(i18n.t('help'), 'open-help'));
		nav.appendChild(button(i18n.t('settings'), 'open-settings'));
		nav.appendChild(button(i18n.t('quit'), 'quit'));
		els.paused.append(h, nav);
	}

	if (els.touch) {
		els.touch.innerHTML = '';
		els.touch.appendChild(button('◀ ' + i18n.t('left'), 'lane_left', 'btn btn-touch'));
		els.touch.appendChild(button(i18n.t('boost'), 'boost', 'btn btn-touch btn-boost'));
		els.touch.appendChild(button(i18n.t('right') + ' ▶', 'lane_right', 'btn btn-touch'));
	}

	if (els.pauseBtn) {
		els.pauseBtn.textContent = i18n.t('pause');
		els.pauseBtn.setAttribute('aria-label', i18n.t('pause'));
	}
	if (els.hudProgressLabel) els.hudProgressLabel.textContent = i18n.t('progress');
}

function renderSettings(s) {
	els.settings.innerHTML = '';
	const h = document.createElement('h2'); h.textContent = i18n.t('settings');
	els.settings.appendChild(h);

	const localeWrap = document.createElement('p');
	const localeLabel = document.createElement('label');
	localeLabel.setAttribute('for', 'select-locale');
	localeLabel.textContent = i18n.t('locale') + ' ';
	const select = document.createElement('select');
	select.id = 'select-locale';
	for (const l of i18n.availableLocales()) {
		const opt = document.createElement('option');
		opt.value = l.id; opt.textContent = l.label;
		if (l.id === i18n.getLocale()) opt.selected = true;
		select.appendChild(opt);
	}
	select.addEventListener('change', () => onAction('set-locale', select.value));
	localeWrap.append(localeLabel, select);
	els.settings.appendChild(localeWrap);

	const toggles = [
		['toggle-reduced-motion', 'reducedMotion', !!s.reducedMotion],
		['toggle-high-contrast', 'highContrast', !!s.highContrast],
		['toggle-sound', 'sound', s.sound !== false],
	];
	for (const [action, key, value] of toggles) {
		const b = button(`${i18n.t(key)}: ${value ? i18n.t('on') : i18n.t('off')}`, action);
		b.id = action;
		b.setAttribute('aria-pressed', String(value));
		els.settings.appendChild(b);
	}

	const nav = document.createElement('div'); nav.className = 'menu';
	nav.appendChild(button(i18n.t('back'), 'close-overlay', 'btn btn-primary'));
	els.settings.appendChild(nav);
}

export function refreshSettings(s) { if (els.settings) renderSettings(s); }

/**
 * Shows exactly one overlay screen (or none for 'play'). Overlays own focus so
 * keyboard users land on the primary action.
 */
export function showScreen(id) {
	const overlayVisible = SCREENS.includes(id);
	for (const name of SCREENS) {
		const el = els[name];
		if (!el) continue;
		const active = name === id;
		el.hidden = !active;
	}
	if (els.overlay) els.overlay.hidden = !overlayVisible;
	if (els.touch) els.touch.hidden = overlayVisible;
	if (els.pauseBtn) els.pauseBtn.hidden = overlayVisible;
	if (overlayVisible && els[id]) {
		const first = els[id].querySelector('button, select');
		if (first) first.focus();
	} else if (els.canvas) {
		els.canvas.focus();
	}
}

/** The HUD only describes a live run, so it is hidden outside play. */
export function setHudVisible(visible) {
	const hud = $('hud');
	if (hud) hud.hidden = !visible;
}

export function setPauseLabel(paused) {
	if (!els.pauseBtn) return;
	const label = paused ? i18n.t('resume') : i18n.t('pause');
	els.pauseBtn.textContent = label;
	els.pauseBtn.setAttribute('aria-label', label);
}

/** HUD + accessibility mirror of the playfield. */
export function setHud(view) {
	if (els.hudScore) els.hudScore.textContent = String(view.score);
	if (els.hudStage) els.hudStage.textContent = view.stageLabel;
	if (els.hudSpeed) els.hudSpeed.textContent = `${Math.round(view.speed * 3.6)} km/h`;
	if (els.hudBoost) {
		els.hudBoost.textContent = view.boostLabel;
		els.hudBoost.dataset.state = view.boostState;
	}
	if (els.hudProgressBar) {
		els.hudProgressBar.style.width = view.progress.toFixed(1) + '%';
		const parent = els.hudProgressBar.parentElement;
		if (parent) parent.setAttribute('aria-valuenow', String(Math.round(view.progress)));
	}
	if (els.lanes) {
		for (let i = 0; i < LANE_COUNT; i++) {
			const cell = document.getElementById(`lane-cell-${i}`);
			if (!cell) continue;
			const occupied = view.hazardLanes.includes(i);
			const isPlayer = i === view.lane;
			cell.dataset.player = isPlayer ? 'true' : 'false';
			cell.dataset.hazard = occupied ? 'true' : 'false';
			cell.textContent = `${i + 1}${isPlayer ? ' ▲' : ''}${occupied ? ' ✕' : ''}`;
			cell.setAttribute('aria-label',
				`${i18n.t('announceLane', { n: i + 1, total: LANE_COUNT })}${occupied ? ' — ' + i18n.t('hazardAhead', { n: i + 1 }) : ''}`);
		}
	}
}

/** Polite live region; repeated text is skipped so screen readers stay usable. */
export function announce(text) {
	if (!els.live || !text || text === lastAnnouncement) return;
	lastAnnouncement = text;
	els.live.textContent = text;
}

export function showResults(view) {
	if (!els.results) return;
	els.results.innerHTML = '';
	const h = document.createElement('h2');
	h.textContent = view.finished ? i18n.t('finished') : i18n.t('crashed');
	els.results.appendChild(h);

	const table = document.createElement('table');
	table.className = 'breakdown';
	const rows = [
		[i18n.t('breakdownDistance'), view.breakdown.distance],
		[i18n.t('breakdownPasses'), view.breakdown.passes],
		[i18n.t('breakdownPads'), view.breakdown.pads],
		[i18n.t('breakdownTime'), view.breakdown.timeBonus],
		[i18n.t('breakdownFinish'), view.breakdown.finishBonus],
		[i18n.t('breakdownTotal'), view.breakdown.total],
	];
	const body = document.createElement('tbody');
	for (const [label, value] of rows) {
		const tr = document.createElement('tr');
		const th = document.createElement('th'); th.scope = 'row'; th.textContent = label;
		const td = document.createElement('td'); td.textContent = String(value);
		tr.append(th, td); body.appendChild(tr);
	}
	table.appendChild(body);
	els.results.appendChild(table);

	const meta = document.createElement('p');
	meta.textContent = `${i18n.t('elapsed')}: ${view.elapsed.toFixed(1)}s · ${i18n.t('best')}: ${view.best}`;
	els.results.appendChild(meta);

	if (view.newBest) {
		const nb = document.createElement('p');
		nb.className = 'new-best';
		nb.textContent = i18n.t('newBest');
		els.results.appendChild(nb);
	}

	const nav = document.createElement('div'); nav.className = 'menu';
	if (view.finished && view.hasNextStage) nav.appendChild(button(i18n.t('nextStage'), 'next-stage', 'btn btn-primary'));
	nav.appendChild(button(i18n.t('retry'), 'restart', view.finished && view.hasNextStage ? 'btn' : 'btn btn-primary'));
	nav.appendChild(button(i18n.t('quit'), 'quit'));
	els.results.appendChild(nav);

	showScreen('results');
}

export function setOverlayBanner(text) {
	const el = $('banner');
	if (!el) return;
	el.textContent = text || '';
	el.hidden = !text;
}
