// Lane Sprint — graphics quality model: presets, per-category overrides, GPU
// detection and a cost summary. Pure (no three.js, no DOM) so the settings
// panel, the renderer and the unit tests agree on what a setting means.
'use strict';

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
	shadows: ['off', 'low', 'medium', 'high'],
	ao: ['off', 'on', 'high'],
	bloom: ['off', 'on'],
	grade: ['off', 'on'],
	antialias: ['off', 'fxaa', 'smaa', 'msaa'],
	reflections: ['off', 'on'],
	detail: ['plain', 'detailed'],
	particles: ['low', 'high'],
	background: ['static', 'animated'],
};

// Each preset is a row of tiers, a device-pixel-ratio cap and a render scale.
const TABLE = {
	low: { cap: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', detail: 'plain', particles: 'low', background: 'static' },
	balanced: { cap: 1.5, scale: 1, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
	high: { cap: 2, scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
	ultra: { cap: 2, scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

/** Best preset for this GPU, from the unmasked renderer string; touch devices cap at Balanced. */
export function detectPreset(gpu, mobile) {
	const g = String(gpu || '').toLowerCase();
	let p = 'balanced';
	if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
	else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?!.*graphics)|apple m\d/.test(g)) p = 'high';
	if (mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced')) p = 'balanced';
	return p;
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

/** Keep only known keys/values so a hand-edited save cannot break the renderer. */
export function sanitize(raw) {
	const s = raw && typeof raw === 'object' ? raw : {};
	const out = { preset: PRESETS.includes(s.preset) ? s.preset : 'auto' };
	const scale = Number(s.render_scale);
	out.render_scale = Number.isFinite(scale) ? clamp(Math.round(scale * 100) / 100, 0.5, 2) : 1;
	out.adaptive = s.adaptive !== false;
	out.show_fps = !!s.show_fps;
	for (const [cat, tiers] of Object.entries(CATEGORIES)) {
		if (tiers.includes(s[cat])) out[cat] = s[cat];
	}
	return out;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: tier }.
 */
export function resolve(saved, detected) {
	const s = saved || {};
	const auto = !PRESETS.includes(s.preset);
	const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
	const row = TABLE[preset];
	const out = {
		preset, auto,
		cap: row.cap,
		scale: row.scale * clamp(Number(s.render_scale) || 1, 0.5, 2),
	};
	for (const [cat, tiers] of Object.entries(CATEGORIES)) {
		out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
	}
	out.adaptive = s.adaptive !== false;
	out.showFps = !!s.show_fps;
	// The composer runs only when something needs it; otherwise the canvas MSAA is used.
	out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
	return out;
}

/** Choosing a preset clears every per-category override; scale/adaptive/fps are kept. */
export function applyPreset(saved, preset) {
	const s = sanitize(saved);
	const out = { preset: PRESETS.includes(preset) ? preset : 'auto', render_scale: s.render_scale, adaptive: s.adaptive, show_fps: s.show_fps };
	return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
	return TABLE[preset] ? TABLE[preset][cat] : undefined;
}

const EN = {
	gfxSumNoShadows: 'no shadows',
	gfxSumShadows: '{n}² shadows',
	gfxSumAo: 'ambient occlusion',
	gfxSumAoHigh: 'full ambient occlusion',
	gfxSumBloom: 'bloom',
	gfxSumNoAa: 'no anti-aliasing',
};
function en(key, params) {
	let s = EN[key] || key;
	if (params) for (const k of Object.keys(params)) s = s.split('{' + k + '}').join(String(params[k]));
	return s;
}

/** Cost summary; `t` is an optional translator with the i18n.t signature. */
export function describe(r, pixels, t) {
	const tr = typeof t === 'function' ? t : en;
	const parts = [
		r.shadows === 'off' ? tr('gfxSumNoShadows') : tr('gfxSumShadows', { n: SHADOW_MAP[r.shadows] }),
		r.ao === 'off' ? null : r.ao === 'high' ? tr('gfxSumAoHigh') : tr('gfxSumAo'),
		r.bloom === 'on' ? tr('gfxSumBloom') : null,
		r.antialias === 'off' ? tr('gfxSumNoAa') : r.antialias.toUpperCase(),
		pixels ? `${pixels[0]}×${pixels[1]} px` : null,
	];
	return parts.filter(Boolean).join(' · ');
}
