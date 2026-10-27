// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the boost exhaust and speed lines scaled within the tier by the level
// (frame().levelIndex), as the browser build scaled them by its hardware
// level (at most 2×). The runtime owns the rest of what the old Graphics
// panel did: Auto and the level choice, render scale and the pixel-ratio
// cap, adaptive resolution, the frame-rate limit and readout. The old
// panel's per-effect overrides are not offered (the runtime's Options choose
// a level); the menus' backdrop blur (High/Ultra) is not ported.
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Car bodies and scenery: Lambert (Low), standard (Balanced), clear-coated physical bodies (High/Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Asphalt texture width in px (height 2×); verge texture size. */
  road: number;
  ground: number;
  /** Geometry LOD multiplier (wheels, hubs, sky dome, trees, poles, rounded bodies). */
  segments: number;
  /** Roadside tree density (fraction of the full planting). */
  trees: number;
  /** Sky cloud noise octaves. */
  clouds: number;
  /** Multiplies boost exhaust points and speed lines. */
  sparks: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based reflections on the cars. */
  reflections: boolean;
  /** Road and verge textures, kerbs, rounded car bodies with lights, roadside scenery, clouds, the finish gate. */
  detailed: boolean;
  /** Boost effects: high = exhaust and all speed lines, low = half the lines. */
  particles: "low" | "high";
  /** Drifting clouds. */
  animatedSky: boolean;
  budget: Budget;
}

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, particles: "low", animatedSky: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "high", animatedSky: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high", animatedSky: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particles: "high", animatedSky: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", road: 128, ground: 128, segments: 0.5, trees: 0.5, clouds: 2, sparks: 0.5, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", road: 256, ground: 256, segments: 0.75, trees: 0.75, clouds: 3, sparks: 0.75, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", road: 256, ground: 256, segments: 1, trees: 1, clouds: 4, sparks: 1, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", road: 512, ground: 512, segments: 1.5, trees: 1, clouds: 5, sparks: 1.5, bloomRes: 1, aoRes: 1 },
};
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: the boost effects grow
  // with the level above the tier's first, at most 2× the tier's budget.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.round(b.sparks * k * 100) / 100;
  return { preset, ...TABLE[preset], budget: b };
}
