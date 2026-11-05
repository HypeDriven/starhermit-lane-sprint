// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, textures, geometry LOD, trees, clouds,
// reflections, detail, boost effects) is the browser build's four presets and
// budgets (src/gfx.js TABLE / BUDGETS) keyed by the level's quality tier, with
// the boost exhaust and speed lines scaled within the tier by the level's
// particle budget against the tier's anchor level (quantum, molecular,
// terrestrial, galactic), at most 2×. The runtime owns the rest of what the
// old Graphics panel did: Auto and the level choice, render scale and the
// pixel-ratio cap, adaptive resolution, the frame-rate limit and readout. The old
// panel's per-effect overrides are not offered (the runtime's Options choose
// a level); the menus' backdrop blur (High/Ultra) is not ported.
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
}
export interface Look {
  preset: QualityTier;
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
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

type Art = Pick<Look, "reflections" | "detailed" | "particles" | "animatedSky">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, detailed: false, particles: "low", animatedSky: false },
  balanced: { reflections: true, detailed: true, particles: "high", animatedSky: true },
  high: { reflections: true, detailed: true, particles: "high", animatedSky: true },
  ultra: { reflections: true, detailed: true, particles: "high", animatedSky: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", road: 128, ground: 128, segments: 0.5, trees: 0.5, clouds: 2, sparks: 0.5 },
  balanced: { material: "standard", road: 256, ground: 256, segments: 0.75, trees: 0.75, clouds: 3, sparks: 0.75 },
  high: { material: "physical", road: 256, ground: 256, segments: 1, trees: 1, clouds: 4, sparks: 1 },
  ultra: { material: "physical", road: 512, ground: 512, segments: 1.5, trees: 1, clouds: 5, sparks: 1.5 },
};
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // The boost effects grow with the level's particle budget above the tier's anchor, at most 2×.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.sparks = Math.round(b.sparks * k * 100) / 100;
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
