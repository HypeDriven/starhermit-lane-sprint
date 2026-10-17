// Lane Sprint — graphics quality model: presets, per-category overrides,
// hardware-level detection, per-preset budgets and a cost summary. Pure (no three.js, no DOM) so the settings
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

// StarHermit hardware level (0–20, src/gpu-level.js → window.StarHermitGpu) at which Auto starts choosing
// each preset. 0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX 5090; phones, tablets and ≤ 4 GB machines
// are capped at level 9 (Balanced); software renderers are level 0 (Low).
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

/*
 * Per-preset asset and effect budgets, each tuned to hold 60 FPS on the weakest GPU Auto gives the preset
 * (Low: level 0 phones / Intel UHD; Balanced: level 4 Iris Xe; High: level 10 GTX 1070; Ultra: level 17
 * RTX 4080; measured with tests/gfx-bench.mjs). Gameplay is identical on every preset.
 *   material  car bodies and scenery: 'lambert' (Low) | 'standard' (Balanced) | 'physical' (clearcoated
 *             bodies with Reflections on; High/Ultra)
 *   road      asphalt texture width in px (height 2×); ground: verge texture size (Scenery detail on)
 *   segments  geometry LOD: multiplies wheel/hub, sky dome, tree and pole segments and rounded-body bevels
 *   trees     roadside tree density (fraction of the full planting)
 *   clouds    sky cloud noise octaves (Sky animated / Scenery detail on)
 *   sparks    multiplies boost exhaust points and speed lines, then scaled by the hardware level within
 *             the preset (≤ 2×)
 *   hudBlur   backdrop blur behind menus and overlays (re-composited every frame over the live 3D view);
 *             off below High, where the overlay uses a more opaque backing
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
	low: { material: 'lambert', road: 128, ground: 128, segments: 0.5, trees: 0.5, clouds: 2, sparks: 0.5, hudBlur: false, bloomRes: 0.5, aoRes: 0.5 },
	balanced: { material: 'standard', road: 256, ground: 256, segments: 0.75, trees: 0.75, clouds: 3, sparks: 0.75, hudBlur: false, bloomRes: 0.5, aoRes: 0.5 },
	high: { material: 'physical', road: 256, ground: 256, segments: 1, trees: 1, clouds: 4, sparks: 1, hudBlur: true, bloomRes: 0.5, aoRes: 0.5 },
	ultra: { material: 'physical', road: 512, ground: 512, segments: 1.5, trees: 1, clouds: 5, sparks: 1.5, hudBlur: true, bloomRes: 1, aoRes: 1 },
};

const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system = {}) {
	const G = gpuApi();
	if (!G) return LEVELS.balanced;
	return G.detectLevel({ webgl: true, webgl2: true, ...system, gpu: String(gpu || '') });
}

/** Auto preset for a hardware level: Low 0, Balanced 4, High 10, Ultra 17. */
export function presetForLevel(level) {
	const G = gpuApi();
	if (G) return G.presetForLevel(level, LEVELS);
	return PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU; phones and tablets are capped at Balanced by the hardware level. */
export function detectPreset(gpu, system = {}) {
	return presetForLevel(detectLevel(gpu, system));
}

/** A preset's concrete budget for a hardware level (sparks scale within the preset, ≤ 2×). */
export function budget(preset, level) {
	const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
	const G = gpuApi(), floor = LEVELS[preset] ?? 0;
	const k = G ? Math.min(2, G.scaleBudget(1, Number.isFinite(level) ? level : floor, floor)) : 1;
	b.sparks = Math.round(b.sparks * k * 100) / 100;
	return b;
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
export function resolve(saved, detected, level) {
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
	out.level = Number.isFinite(level) ? level : LEVELS[preset];
	out.budget = budget(preset, out.level);
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
