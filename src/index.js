// Lane Sprint — bootstrap: host handshake, capability detection, lifecycle,
// input, and the fixed-step game loop that drives rules → render → ui → audio.
'use strict';

import { LANE_COUNT, TUNING, scoreBreakdown, progressPct, isTerminal, terminalReason } from './rules.js';
import * as session from './session.js';
import * as render from './render.js';
import * as ui from './ui.js';
import * as audio from './audio.js';
import * as store from './store.js';
import * as platform from './platform.js';
import * as i18n from './i18n.js';
import { getStage, getDailyStage, getStageCount } from './content.js';

// boot → title → preparing → active ↔ paused → results
const PHASE = { TITLE: 'title', PLAY: 'play', PAUSED: 'paused', RESULTS: 'results', OVERLAY: 'overlay' };

let started = false;
let phase = PHASE.TITLE;
let overlayReturn = PHASE.TITLE;
let current = null;      // active session
let currentStage = null;
let isDaily = false;
let lastFrame = 0;
let rafId = 0;
let settings = null;
let lastHudTick = -1;

function settingsView() {
	return {
		nextStage: Math.min(getStageCount(), settings.highestStage),
		reducedMotion: settings.reducedMotion,
		highContrast: settings.highContrast,
		sound: settings.sound,
	};
}

function prefersReducedMotion() {
	try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
}

function stageLabel(stage) {
	return stage.dayKey ? i18n.t('dailyStage', { d: stage.dayKey }) : i18n.t('stage', { n: stage.index });
}

function boostView(state) {
	if (state.boostActive) return { label: i18n.t('boostActive'), state: 'active' };
	const remain = state.boostReadyAt - state.elapsed;
	if (remain > 0) return { label: i18n.t('boostCooldown', { s: Math.ceil(remain) }), state: 'cooldown' };
	return { label: i18n.t('boostReady'), state: 'ready' };
}

/** Lanes with traffic inside the reaction window, for the HUD mirror. */
function hazardLanes(state) {
	const out = [];
	for (const car of state.traffic) {
		const gap = car.z - state.position;
		if (gap > 0 && gap < 55 && !out.includes(car.lane)) out.push(car.lane);
	}
	return out;
}

function startStage(stage, daily) {
	currentStage = stage;
	isDaily = !!daily;
	current = session.startSession(stage);
	render.setTheme(stage.theme);
	ui.setHudVisible(true);
	phase = PHASE.PLAY;
	ui.showScreen('play');
	ui.setPauseLabel(false);
	ui.setOverlayBanner('');
	ui.announce(`${stageLabel(stage)} — ${i18n.t('go')}`);
	lastHudTick = -1;
	updateHud(true);
}

function endStage() {
	const state = current.state;
	const breakdown = scoreBreakdown(state);
	const key = currentStage.dayKey || currentStage.id;
	const newBest = store.recordScore(key, breakdown.total, isDaily);
	if (state.finished && !isDaily) store.unlockStage(Math.min(getStageCount(), currentStage.index + 1));
	settings = store.load();
	phase = PHASE.RESULTS;
	ui.showResults({
		finished: state.finished,
		breakdown,
		elapsed: state.elapsed,
		best: store.bestScore(key, isDaily),
		newBest,
		hasNextStage: !isDaily && currentStage.index < getStageCount(),
	});
	ui.announce(state.finished
		? i18n.t('announceFinish', { s: state.elapsed.toFixed(1) })
		: i18n.t('announceCrash', { m: Math.round(state.position) }));
}

function updateHud(force) {
	if (!current) return;
	const state = current.state;
	if (!force && state.tick === lastHudTick) return;
	lastHudTick = state.tick;
	const boost = boostView(state);
	ui.setHud({
		score: scoreBreakdown(state).total,
		stageLabel: stageLabel(currentStage),
		speed: state.speed,
		boostLabel: boost.label,
		boostState: boost.state,
		progress: progressPct(state),
		lane: state.lane,
		hazardLanes: hazardLanes(state),
	});
}

function handleEvents() {
	for (const name of session.drainEvents(current)) {
		audio.playEvent(name);
		if (name === 'crash') render.markCrash();
	}
}

function frame(now) {
	rafId = requestAnimationFrame(frame);
	const dt = lastFrame ? Math.min(0.25, (now - lastFrame) / 1000) : 0;
	lastFrame = now;

	if (phase === PHASE.PLAY && current) {
		session.advance(current, dt);
		handleEvents();
		updateHud(false);
		if (isTerminal(current.state)) { render.render(current.state, 0, dt); endStage(); return; }
	}
	if (current) render.render(current.state, phase === PHASE.PLAY ? session.alpha(current) : 0, dt);
}

function setPaused(paused) {
	if (paused && phase === PHASE.PLAY) {
		phase = PHASE.PAUSED;
		ui.showScreen('paused');
		ui.setPauseLabel(true);
		audio.setFocused(false);
	} else if (!paused && phase === PHASE.PAUSED) {
		phase = PHASE.PLAY;
		current.accumulator = 0;
		ui.showScreen('play');
		ui.setPauseLabel(false);
		audio.setFocused(true);
	}
}

function openOverlay(id) {
	if (phase === PHASE.PLAY) setPaused(true);
	else overlayReturn = phase;
	ui.showScreen(id);
	if (phase !== PHASE.PAUSED) phase = PHASE.OVERLAY;
}

function closeOverlay() {
	if (phase === PHASE.OVERLAY) {
		phase = overlayReturn === PHASE.RESULTS ? PHASE.RESULTS : PHASE.TITLE;
		ui.showScreen(phase === PHASE.RESULTS ? 'results' : 'title');
	} else if (phase === PHASE.PAUSED) {
		ui.showScreen('paused');
	} else {
		phase = PHASE.TITLE;
		ui.showScreen('title');
	}
}

function goTitle() {
	phase = PHASE.TITLE;
	overlayReturn = PHASE.TITLE;
	settings = store.load();
	// Attract scene: a real, static stage rendered behind the menu so the
	// title screen is never a blank canvas. It is never advanced.
	const attractStage = getStage(Math.min(getStageCount(), settings.highestStage));
	currentStage = attractStage;
	isDaily = false;
	current = session.startSession(attractStage);
	render.setTheme(attractStage.theme);
	ui.setHudVisible(false);
	ui.renderStatic(settingsView());
	ui.showScreen('title');
	ui.announce(i18n.t('title'));
}

function applySettings() {
	store.save({
		locale: settings.locale,
		reducedMotion: settings.reducedMotion,
		highContrast: settings.highContrast,
		sound: settings.sound,
	});
	render.setAccessibility({ reducedMotion: settings.reducedMotion, highContrast: settings.highContrast });
	audio.setEnabled(settings.sound);
	document.body.classList.toggle('reduced-motion', !!settings.reducedMotion);
	document.body.classList.toggle('high-contrast', !!settings.highContrast);
	ui.refreshSettings(settingsView());
}

// Menu-level actions get a UI click; gameplay actions have their own cues.
const GAMEPLAY_ACTIONS = new Set(['lane_left', 'lane_right', 'boost']);

function handleAction(action, value) {
	audio.resumeAudio();
	if (!GAMEPLAY_ACTIONS.has(action)) audio.playEvent('ui');
	switch (action) {
		case 'play': startStage(getStage(Math.min(getStageCount(), settings.highestStage)), false); return;
		case 'practice': startStage(getStage(1), false); return;
		case 'daily': startStage(getDailyStage(platform.now()), true); return;
		case 'open-help': openOverlay('help'); return;
		case 'open-settings': openOverlay('settings'); return;
		case 'close-overlay': closeOverlay(); return;
		case 'resume': setPaused(false); return;
		case 'toggle-pause': setPaused(phase === PHASE.PLAY); return;
		case 'restart': if (currentStage) startStage(currentStage, isDaily); return;
		case 'next-stage':
			if (currentStage && currentStage.index < getStageCount()) startStage(getStage(currentStage.index + 1), false);
			return;
		case 'quit': goTitle(); return;
		case 'set-locale':
			settings.locale = i18n.setLocale(value);
			applySettings();
			ui.renderStatic(settingsView());
			ui.showScreen(phase === PHASE.PAUSED ? 'paused' : 'settings');
			return;
		case 'toggle-reduced-motion': settings.reducedMotion = !settings.reducedMotion; applySettings(); return;
		case 'toggle-high-contrast': settings.highContrast = !settings.highContrast; applySettings(); return;
		case 'toggle-sound': settings.sound = !settings.sound; applySettings(); return;
		case 'lane_left': case 'lane_right': case 'boost':
			if (phase === PHASE.PLAY && current) {
				session.sendCommand(current, action);
				handleEvents();
				updateHud(true);
				if (action !== 'boost') ui.announce(i18n.t('announceLane', { n: current.state.lane + 1, total: LANE_COUNT }));
			}
			return;
		default: return;
	}
}

const KEY_ACTIONS = {
	ArrowLeft: 'lane_left', KeyA: 'lane_left',
	ArrowRight: 'lane_right', KeyD: 'lane_right',
	Space: 'boost', KeyW: 'boost', ArrowUp: 'boost',
};

function onKeyDown(e) {
	if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
	const target = e.target;
	if (target && (target.tagName === 'SELECT' || target.tagName === 'INPUT')) return;
	if (e.code === 'Escape' || e.code === 'KeyP') {
		e.preventDefault();
		if (phase === PHASE.OVERLAY) handleAction('close-overlay');
		else if (phase === PHASE.PAUSED) handleAction('resume');
		else if (phase === PHASE.PLAY) setPaused(true);
		return;
	}
	if (e.code === 'KeyR' && (phase === PHASE.PLAY || phase === PHASE.PAUSED || phase === PHASE.RESULTS)) {
		e.preventDefault(); handleAction('restart'); return;
	}
	// Buttons keep their native Enter/Space activation; only gameplay keys are captured.
	const action = KEY_ACTIONS[e.code];
	if (!action) return;
	if (phase !== PHASE.PLAY) return;
	e.preventDefault();
	handleAction(action);
}

function onCanvasPointer(e) {
	if (phase !== PHASE.PLAY) return;
	const rect = e.currentTarget.getBoundingClientRect();
	const x = e.clientX - rect.left;
	handleAction(x < rect.width / 2 ? 'lane_left' : 'lane_right');
}

function fitCanvas() {
	const canvas = document.getElementById('game-canvas');
	if (!canvas) return;
	render.resize(canvas.clientWidth, canvas.clientHeight);
}

function detectCapabilities() {
	try {
		const probe = document.createElement('canvas');
		return !!(probe.getContext('webgl2') || probe.getContext('webgl'));
	} catch (_) { return false; }
}

function showCompatibilityMessage() {
	const el = document.getElementById('title-screen');
	if (!el) return;
	const p = document.createElement('p');
	p.className = 'tagline';
	p.textContent = 'This game needs WebGL. Your progress and settings are safe — enable WebGL and reload.';
	el.appendChild(p);
}

export function boot() {
	if (started) return; started = true;

	platform.readLaunchContext();
	if (platform.isHosted()) {
		platform.startTokenRefresh();
		platform.fetchProfile().then((profile) => {
			if (profile) ui.setPlayerName(profile.nickname);
		}).catch(() => {});
		store.syncFromCloud().then((replaced) => {
			if (!replaced) return;
			settings = store.load();
			if (!settings.locale) settings.locale = i18n.getLocale();
			if (prefersReducedMotion() && !settings.reducedMotion) settings.reducedMotion = true;
			applySettings();
			ui.renderStatic(settingsView());
		}).catch(() => {});
	}
	ui.setSyncStatus(store.getSyncState());
	store.onSyncChange(ui.setSyncStatus);
	settings = store.load();
	i18n.setLocale(i18n.negotiateLocale(settings.locale, navigator.languages || [navigator.language]));
	if (!settings.locale) settings.locale = i18n.getLocale();
	if (prefersReducedMotion() && !store.load().reducedMotion) settings.reducedMotion = true;

	ui.init(handleAction, settingsView());

	const canvas = document.getElementById('game-canvas');
	if (!detectCapabilities()) {
		ui.showScreen('title');
		showCompatibilityMessage();
		return;
	}
	render.init(canvas, { reducedMotion: settings.reducedMotion, highContrast: settings.highContrast });
	applySettings();
	fitCanvas();

	window.addEventListener('resize', fitCanvas);
	window.addEventListener('orientationchange', fitCanvas);
	window.addEventListener('keydown', onKeyDown);
	canvas.addEventListener('pointerdown', onCanvasPointer);
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) { setPaused(true); audio.setFocused(false); }
		else audio.setFocused(true);
	});
	goTitle();
	// Time sync is best-effort; local play never waits on the network.
	platform.syncTime().catch(() => {});
	lastFrame = 0;
	rafId = requestAnimationFrame(frame);

	// Test/debug handles: read-only views of the live simulation.
	window.__laneSprint = {
		getPhase: () => phase,
		getState: () => current && current.state,
		getSnapshot: () => current && session.snapshot(current),
		verifyReplay: () => current && session.verifyReplay(current),
		action: handleAction,
		tuning: TUNING,
		terminalReason: () => current && terminalReason(current.state),
		stop: () => cancelAnimationFrame(rafId),
	};
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
	boot();
}
