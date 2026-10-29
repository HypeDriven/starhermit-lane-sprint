// The road on starhermit:scene, as the browser build's src/render.js drew it
// with three.js: the endless three-lane strip (asphalt with tyre tracks,
// verges, edge lines, red-white kerbs, pooled lane dashes) recycled as the
// player drives, the gradient sky dome with its sun glow, drifting fbm clouds
// and night stars (WGSL), roadside scenery placed by a pure hash of the world
// slot (instanced trees, lamp posts with glowing heads, guard-rail posts and
// rails), the cars (chassis, cabin and wheels; rounded bodies with lights,
// hubs, bumpers and the player's spoiler on detailed scenery; clear-coated
// paint with reflections), boost pads with their chevrons, the chequered
// finish line and gate, the boost glow under the player, speed lines and the
// additive exhaust, the chase camera with its boost pull, attract drift and
// crash shake, and the key light whose shadow follows the player.
//
// From three.js r170: light intensities are ÷ π (the engine's convention);
// the sky ShaderMaterial is WGSL; RoomEnvironment(renderer) gives the
// image-based lighting; the post chain (GTAOPass, UnrealBloomPass threshold
// 0.95, the GradeShader before the output, FXAA / SMAA / MSAA) is
// renderer.ao / bloom / grade / antialias; the shadow box (±34 m around the
// player) is the engine's `shadow.distance`; the procedural asphalt and verge
// canvases are baked PNGs (tools/bake-textures.mjs). Adaptive resolution,
// the pixel-ratio cap and the frame-rate readout are the runtime's.
// Cosmetic randomness never touches the rules' stream.
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, ClampToEdgeWrapping, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DynamicDrawUsage, Fog, Group, HemisphereLight, InstancedMesh, LineBasicMaterial,
  LineSegments, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera,
  PlaneGeometry, PMREMGenerator, Points, PointsMaterial, Quaternion, RepeatWrapping, RoomEnvironment, RoundedBoxGeometry, ShaderMaterial,
  SphereGeometry, SRGBColorSpace, TextureLoader, Vector3, renderer, scene,
  type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { Content, Rules, type State } from "./game.ts";
import type { Look } from "./quality.ts";

const PI = Math.PI;
const { LANE_COUNT, LANE_WIDTH, CAR_LENGTH } = Rules;
// The chase camera looks toward +z, so screen-left is world +x: lane 0 (the left lane in the HUD) sits at +x.
const LANES_X = [LANE_WIDTH, 0, -LANE_WIDTH];
const ROAD_WIDTH = LANE_WIDTH * (LANE_COUNT + 1);
const HALF_ROAD = ROAD_WIDTH / 2;
const SEGMENT_LENGTH = 20;
const VIEW_AHEAD = 170;
const VIEW_BEHIND = 40;
const STRIP_LENGTH = VIEW_AHEAD + VIEW_BEHIND + SEGMENT_LENGTH;
const SPEED_LINE_COUNT = 28;
const EXHAUST_COUNT = 64;
const SPEED_LINE_MAX = SPEED_LINE_COUNT * 3;
const EXHAUST_MAX = EXHAUST_COUNT * 3;
const TREE_SPACING = 10;
const TREE_SLOTS = Math.ceil(STRIP_LENGTH / TREE_SPACING) + 1;
const LAMP_SPACING = 40;
const LAMP_SLOTS = Math.ceil(STRIP_LENGTH / LAMP_SPACING) + 1;
const POST_SPACING = 5;
const POST_SLOTS = Math.ceil(STRIP_LENGTH / POST_SPACING) + 1;

interface ThemeFx {
  zenith: number; ground: number; foliage: number; trunk: number; key: number; keyI: number; hemiSky: number; hemiGround: number; hemiI: number;
  sun: [number, number, number]; sunGlow: number; lamps: number; stars: number; clouds: number;
}
// Per-theme lighting/scenery extras layered on top of src/content.js themes (render.js THEME_FX; three.js intensities).
const THEME_FX: Record<string, ThemeFx> = {
  coastal: { zenith: 0x3b86d6, ground: 0x3f8a58, foliage: 0x2f6e3e, trunk: 0x5a3f2a, key: 0xfff1dc, keyI: 2.1, hemiSky: 0xd6ecff, hemiGround: 0x3a5a44, hemiI: 1.0, sun: [-0.45, 0.8, -0.4], sunGlow: 0.35, lamps: 0.3, stars: 0, clouds: 0xffffff },
  sunset: { zenith: 0x4e3f7c, ground: 0x6f5a3e, foliage: 0x3f4f2c, trunk: 0x4a3222, key: 0xffb27a, keyI: 2.0, hemiSky: 0xffd2b0, hemiGround: 0x4a3440, hemiI: 0.9, sun: [-0.08, 0.16, 1], sunGlow: 1.0, lamps: 1.6, stars: 0, clouds: 0xffc6a0 },
  night: { zenith: 0x03060f, ground: 0x15302a, foliage: 0x10261e, trunk: 0x22180f, key: 0x9fb8ff, keyI: 0.9, hemiSky: 0x5a6f9a, hemiGround: 0x101820, hemiI: 0.6, sun: [-0.3, 0.7, 0.6], sunGlow: 0.25, lamps: 5.0, stars: 1, clouds: 0x2a3a5a },
  snow: { zenith: 0x8fbbe6, ground: 0xcfd9e4, foliage: 0x2d4a3f, trunk: 0x4a3a30, key: 0xffffff, keyI: 1.7, hemiSky: 0xe8f2ff, hemiGround: 0x8a98a8, hemiI: 0.95, sun: [-0.45, 0.6, -0.5], sunGlow: 0.3, lamps: 0.6, stars: 0, clouds: 0xffffff },
  desert: { zenith: 0x4f93d6, ground: 0xd2ad76, foliage: 0x6b7f34, trunk: 0x6b4a2a, key: 0xfff0d0, keyI: 2.3, hemiSky: 0xfff0d6, hemiGround: 0x8a6a44, hemiI: 1.0, sun: [-0.5, 0.85, -0.2], sunGlow: 0.4, lamps: 0.3, stars: 0, clouds: 0xfff6ea },
};

renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const camera = new PerspectiveCamera(58, 16 / 9, 0.5, 600);

let look: Look | null = null;
let reducedMotion = false;
let highContrast = false;
let attract = false;
let themeId = "coastal";

// -- lights (three.js intensities ÷ π) and environment ---------------------------------------
const ambient = new HemisphereLight(0xffffff, 0x334455, 1.1 / PI);
const keyLight = new DirectionalLight(0xffffff, 1.6 / PI);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.distance = 70;
const keyDir = new Vector3(0, 1, 0);
scene.add(ambient, keyLight, keyLight.target);
const fog = new Fog(0xa8dcff, 90, 260);
scene.fog = fog;
let envTex: Texture | null = null;
function envMap(): Texture | null {
  if (!envTex) {
    try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTex;
}

// -- textures -------------------------------------------------------------------------------
function canvasTexture(w: number, h: number, paint: (ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) => void): Texture {
  const cv = new OffscreenCanvas(w, h);
  paint(cv.getContext("2d"), w, h);
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  return t;
}
function repeat(t: Texture, x: number, y: number): Texture {
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  t.repeat.set(x, y);
  return t;
}
const loader = new TextureLoader();
function image(path: string, rx: number, ry: number): Texture {
  const t = loader.load(path, undefined, (e: unknown) => console.warn(`${path}: ${e instanceof Error ? e.message : String(e)}`));
  t.colorSpace = SRGBColorSpace;
  return repeat(t, rx, ry);
}
const textures = {
  road: image("assets/textures/road.png", 1, STRIP_LENGTH / SEGMENT_LENGTH),
  ground: image("assets/textures/ground.png", 4, STRIP_LENGTH / 10),
  kerb: repeat(canvasTexture(32, 128, (ctx, w, h) => {
    ctx.fillStyle = "#bcbcbc"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#b3322a"; ctx.fillRect(0, 0, w, h / 2);
  }), 1, STRIP_LENGTH / 4),
  checker: canvasTexture(128, 32, (ctx, w, h) => {
    const n = 16, s = w / n;
    for (let y = 0; y < h / s; y++) for (let x = 0; x < n; x++) {
      ctx.fillStyle = (x + y) % 2 ? "#111" : "#f4f4f4";
      ctx.fillRect(x * s, y * s, s, s);
    }
  }),
  blob: canvasTexture(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(0,0,0,0.55)"); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }),
  spark: canvasTexture(32, 32, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.4, "rgba(255,255,255,0.5)"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }),
};
textures.blob.wrapS = textures.blob.wrapT = ClampToEdgeWrapping;
textures.spark.wrapS = textures.spark.wrapT = ClampToEdgeWrapping;

// -- the sky: a gradient dome with sun glow, fbm clouds and stars (WGSL port of render.js SKY_FRAG) --
const SKY_FRAG = /* wgsl */ `
fn lsHash3(p0: vec3f) -> f32 {
  var p = fract(p0 * 0.3183099 + 0.1);
  p = p * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
fn lsHash2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn lsNoise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(lsHash2(i), lsHash2(i + vec2f(1.0, 0.0)), f.x), mix(lsHash2(i + vec2f(0.0, 1.0)), lsHash2(i + vec2f(1.0, 1.0)), f.x), f.y);
}
fn lsFbm(p0: vec2f) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var p = p0;
  for (var i = 0; i < 5; i++) {
    if (f32(i) >= uniforms.uOctaves) { break; }
    v = v + a * lsNoise(p);
    p = p * 2.03;
    a = a * 0.5;
  }
  return v / (1.0 - a * 2.0 + 0.0001) * 0.9375;
}
fn fragment(f: Fragment) -> vec4f {
  let d = normalize(f.world - uniforms.uCenter);
  let h = d.y;
  var col = mix(uniforms.uHorizon, uniforms.uMid, smoothstep(0.0, 0.14, h));
  col = mix(col, uniforms.uTop, smoothstep(0.14, 0.65, h));
  let sd = max(dot(d, normalize(uniforms.uSunDir)), 0.0);
  col = col + uniforms.uSunColor * (pow(sd, 6.0) * 0.28 + pow(sd, 600.0) * 3.0) * uniforms.uSunGlow;
  if (uniforms.uStars > 0.0 && h > 0.04) {
    let cell = floor(d * 600.0);
    let r = lsHash3(cell);
    col = col + vec3f(0.9, 0.95, 1.0) * step(0.9992, r) * (0.6 + 0.8 * fract(r * 91.7)) * smoothstep(0.04, 0.25, h) * uniforms.uStars;
  }
  if (uniforms.uClouds > 0.0 && h > 0.0) {
    let p = d.xz / (h + 0.12) * 1.3 + vec2f(uniforms.uTime * 0.012, uniforms.uTime * 0.005);
    let n = lsFbm(p);
    let c = smoothstep(0.52, 0.82, n) * smoothstep(0.0, 0.18, h) * uniforms.uClouds;
    col = mix(col, uniforms.uCloudColor * (0.85 + 0.25 * n), c * 0.8);
  }
  return vec4f(col, 1.0);
}`;
const skyMat = new ShaderMaterial({
  uniforms: {
    uTop: { value: new Color() }, uMid: { value: new Color() }, uHorizon: { value: new Color() },
    uSunColor: { value: new Color() }, uCloudColor: { value: new Color() }, uSunDir: { value: new Vector3(0, 1, 0) },
    uCenter: { value: new Vector3() }, uTime: { value: 0 }, uClouds: { value: 0 }, uStars: { value: 0 }, uSunGlow: { value: 0 }, uOctaves: { value: 4 },
  },
  fragmentShader: SKY_FRAG, side: BackSide, depthWrite: false, fog: false,
});
const u = skyMat.uniforms as Record<string, { value: unknown }>;
const uColor = (k: string): Color => u[k]!.value as Color;

// -- the world (rebuilt when the look's assets change) ---------------------------------------------
interface CarView { group: Group; body: Mesh; cabin: Mesh; detail: Group; blob: Mesh; paint: Material }
interface Scenery { trunks: InstancedMesh; crowns: InstancedMesh; poles: InstancedMesh; arms: InstancedMesh; heads: InstancedMesh; posts: InstancedMesh; rails: Mesh[] }
interface World {
  root: Group; sky: Mesh; road: Mesh; roadMat: MeshStandardMaterial | MeshLambertMaterial; shoulders: Mesh[]; groundMat: MeshStandardMaterial | MeshLambertMaterial;
  edges: Mesh[]; kerbs: Mesh[]; dashes: Mesh[]; scenery: Scenery | null; trunkMat: Material; crownMat: Material; lampMat: MeshStandardMaterial | MeshLambertMaterial;
  player: CarView; glow: Mesh; glowMat: MeshBasicMaterial; traffic: CarView[]; pads: Group[]; padBaseMat: MeshStandardMaterial;
  finishLine: Mesh; finishGate: Group; speedLines: LineSegments; exhaust: Points; exhaustAge: Float32Array; exhaustCount: number;
  carParts: CarParts; sceneryAnchor: number;
}
interface CarParts {
  bodyGeo: BufferGeometry; cabinGeo: BufferGeometry; cabinMat: Material; wheelGeo: BufferGeometry; wheelMat: Material; hubGeo: BufferGeometry; hubMat: Material;
  headGeo: BufferGeometry; headMat: Material; tailGeo: BufferGeometry; tailMat: Material; bumperGeo: BufferGeometry; bumperMat: Material;
  spoilerGeo: BufferGeometry; blobGeo: BufferGeometry; blobMat: Material;
}
let world: World | null = null;

const seg = (n: number, min = 3): number => Math.max(min, Math.round(n * (look?.budget.segments ?? 1)));
type MatParams = { color?: number; roughness?: number; metalness?: number; emissive?: number; emissiveIntensity?: number; map?: Texture | null; flatShading?: boolean };
/** Material class per budget: Lambert on Low, standard above (render.js mat). */
function mat(p: MatParams): MeshStandardMaterial | MeshLambertMaterial {
  if (look?.budget.material === "lambert") {
    const { roughness: _r, metalness: _m, ...rest } = p;
    return new MeshLambertMaterial(rest);
  }
  return new MeshStandardMaterial(p);
}
/** Car paint per budget: Lambert (Low), standard (Balanced), clear-coated physical (High/Ultra) — render.js bodyMaterial + applyBodyQuality. */
function paint(color: number): Material {
  const kind = look?.budget.material ?? "physical";
  if (kind === "lambert") return new MeshLambertMaterial({ color });
  const glossy = !!look?.reflections;
  if (kind === "standard") return new MeshStandardMaterial({ color, roughness: glossy ? 0.32 : 0.4, metalness: glossy ? 0.35 : 0.25 });
  return new MeshPhysicalMaterial({ color, roughness: glossy ? 0.32 : 0.4, metalness: glossy ? 0.35 : 0.25, clearcoat: glossy ? 0.7 : 0, clearcoatRoughness: 0.08 });
}

function carParts(detailed: boolean): CarParts {
  return {
    bodyGeo: detailed ? new RoundedBoxGeometry(1.5, 0.55, CAR_LENGTH * 0.95, seg(3, 1), 0.16) : new BoxGeometry(1.5, 0.55, CAR_LENGTH * 0.95),
    cabinGeo: detailed ? new RoundedBoxGeometry(1.25, 0.5, CAR_LENGTH * 0.42, seg(3, 1), 0.14) : new BoxGeometry(1.25, 0.5, CAR_LENGTH * 0.42),
    // envMapIntensity 1: three.js lit the scene's environment by environmentIntensity alone.
    cabinMat: mat({ color: 0x121a2a, roughness: 0.5, metalness: 0.1 }),
    wheelGeo: new CylinderGeometry(0.34, 0.34, 0.28, seg(16, 8)),
    wheelMat: mat({ color: 0x14161c, roughness: 0.85 }),
    hubGeo: new CylinderGeometry(0.18, 0.18, 0.3, seg(12, 6)),
    hubMat: mat({ color: 0xb8c0cc, roughness: 0.3, metalness: 0.9 }),
    headGeo: new BoxGeometry(0.34, 0.12, 0.06),
    headMat: mat({ color: 0xfff6dc, emissive: 0xfff2cc, emissiveIntensity: 1.6 }),
    tailGeo: new BoxGeometry(0.42, 0.12, 0.06),
    tailMat: mat({ color: 0x5a0a0a, emissive: 0xff2a1a, emissiveIntensity: 2.4 }),
    bumperGeo: new BoxGeometry(1.52, 0.16, 0.14),
    bumperMat: mat({ color: 0x1b1f27, roughness: 0.6, metalness: 0.2 }),
    spoilerGeo: new BoxGeometry(1.4, 0.06, 0.34),
    blobGeo: new PlaneGeometry(2.3, 5.0),
    blobMat: new MeshBasicMaterial({ map: textures.blob, transparent: true, depthWrite: false }),
  };
}

/** render.js makeCar: chassis + cabin + wheels, the blob shadow, and the detail group (lights, hubs, bumpers, spoiler). */
function makeCar(parts: CarParts, color: number, isPlayer: boolean, detailed: boolean): CarView {
  const g = new Group();
  const p = paint(color);
  const body = new Mesh(parts.bodyGeo, p);
  body.position.y = 0.45;
  body.castShadow = true;
  const cabin = new Mesh(parts.cabinGeo, parts.cabinMat);
  cabin.position.set(0, 0.95, -0.2);
  cabin.castShadow = true;
  g.add(body, cabin);
  for (const [x, z] of [[-0.78, 1.3], [0.78, 1.3], [-0.78, -1.3], [0.78, -1.3]] as const) {
    const w = new Mesh(parts.wheelGeo, parts.wheelMat);
    w.rotation.z = PI / 2;
    w.position.set(x, 0.34, z);
    w.castShadow = true;
    g.add(w);
  }
  const blob = new Mesh(parts.blobGeo, parts.blobMat);
  blob.rotation.x = -PI / 2;
  blob.position.y = 0.025;
  blob.renderOrder = -1;
  blob.noAO = true;
  g.add(blob);
  const detail = new Group();
  const front = CAR_LENGTH * 0.475;
  for (const x of [-0.5, 0.5]) {
    const hl = new Mesh(parts.headGeo, parts.headMat); hl.position.set(x, 0.55, front + 0.01); detail.add(hl);
    const tl = new Mesh(parts.tailGeo, parts.tailMat); tl.position.set(x * 1.02, 0.58, -front - 0.01); detail.add(tl);
    const hub = new Mesh(parts.hubGeo, parts.hubMat); hub.rotation.z = PI / 2; hub.position.set(x * 1.56, 0.34, 1.3); detail.add(hub);
    const hub2 = new Mesh(parts.hubGeo, parts.hubMat); hub2.rotation.z = PI / 2; hub2.position.set(x * 1.56, 0.34, -1.3); detail.add(hub2);
  }
  for (const z of [front + 0.02, -front - 0.02]) {
    const b = new Mesh(parts.bumperGeo, parts.bumperMat); b.position.set(0, 0.28, z); detail.add(b);
  }
  if (isPlayer) {
    const sp = new Mesh(parts.spoilerGeo, parts.bumperMat); sp.position.set(0, 0.92, -front + 0.25); sp.castShadow = true; detail.add(sp);
    for (const x of [-0.5, 0.5]) {
      const strut = new Mesh(parts.bumperGeo, parts.bumperMat);
      strut.scale.set(0.05, 1.4, 1); strut.position.set(x, 0.8, -front + 0.25); detail.add(strut);
    }
  }
  detail.visible = detailed;
  g.add(detail);
  return { group: g, body, cabin, detail, blob, paint: p };
}

function buildScenery(root: Group, trunkMat: Material, crownMat: Material, metalMat: Material, lampMat: Material): Scenery {
  const trunkGeo = new CylinderGeometry(0.16, 0.24, 1.6, seg(6, 4)); trunkGeo.translate(0, 0.8, 0);
  const crownGeo = new ConeGeometry(1.3, 3.4, seg(7, 5)); crownGeo.translate(0, 3.1, 0);
  const poleGeo = new CylinderGeometry(0.07, 0.1, 6.2, seg(8, 4)); poleGeo.translate(0, 3.1, 0);
  const armGeo = new BoxGeometry(1.7, 0.08, 0.1); armGeo.translate(-0.85, 6.1, 0);
  const headGeo = new BoxGeometry(0.6, 0.12, 0.26); headGeo.translate(-1.55, 6.02, 0);
  const postGeo = new BoxGeometry(0.1, 0.7, 0.1); postGeo.translate(0, 0.35, 0);
  const inst = (geo: BufferGeometry, m: Material, count: number, cast: boolean): InstancedMesh => {
    const im = new InstancedMesh(geo, m, count);
    im.instanceMatrix.setUsage(DynamicDrawUsage);
    im.frustumCulled = false;
    im.castShadow = cast;
    root.add(im);
    return im;
  };
  const railGeo = new BoxGeometry(0.08, 0.26, STRIP_LENGTH);
  const rails = [-1, 1].map((side) => {
    const r = new Mesh(railGeo, metalMat);
    r.position.set(side * (HALF_ROAD + 1.35), 0.58, 0);
    r.castShadow = true;
    root.add(r);
    return r;
  });
  return {
    trunks: inst(trunkGeo, trunkMat, TREE_SLOTS * 2, true), crowns: inst(crownGeo, crownMat, TREE_SLOTS * 2, true),
    poles: inst(poleGeo, metalMat, LAMP_SLOTS * 2, true), arms: inst(armGeo, metalMat, LAMP_SLOTS * 2, false),
    heads: inst(headGeo, lampMat, LAMP_SLOTS * 2, false), posts: inst(postGeo, metalMat, POST_SLOTS * 2, false), rails,
  };
}

function makePad(baseGeo: BufferGeometry, baseMat: Material, chevGeo: BufferGeometry, chevMat: Material): Group {
  const g = new Group();
  const base = new Mesh(baseGeo, baseMat);
  base.position.y = 0.06;
  base.receiveShadow = true;
  g.add(base);
  // Chevrons reinforce the pad's meaning without relying on colour alone.
  for (let i = 0; i < 2; i++) {
    const c = new Mesh(chevGeo, chevMat);
    c.rotation.x = -PI / 2;
    c.position.set(0, 0.14, -0.7 + i * 1.4);
    g.add(c);
  }
  return g;
}

/** Cosmetic stream for the speed lines (render.js used Math.random). */
function cosmetic(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function buildWorld(): World {
  const L = look!;
  const detailed = L.detailed;
  const root = new Group();
  const sky = new Mesh(new SphereGeometry(320, seg(32, 12), seg(16, 6)), skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  sky.noAO = true;
  root.add(sky);

  const roadMat = mat({ color: 0x39404e, roughness: 0.92, map: detailed ? textures.road : null });
  const road = new Mesh(new PlaneGeometry(ROAD_WIDTH, STRIP_LENGTH), roadMat);
  road.rotation.x = -PI / 2;
  road.receiveShadow = true;
  const groundMat = mat({ color: 0x2f7f6d, roughness: 1, map: detailed ? textures.ground : null });
  const shoulderGeo = new PlaneGeometry(40, STRIP_LENGTH);
  const shoulders = [-1, 1].map((side) => {
    const s = new Mesh(shoulderGeo, groundMat);
    s.rotation.x = -PI / 2; s.position.set(side * (HALF_ROAD + 20), -0.12, 0); s.receiveShadow = true;
    return s;
  });
  root.add(road, ...shoulders);

  // Solid edge lines frame the three lanes; kerbs sit just outside them.
  const edgeGeo = new PlaneGeometry(0.16, STRIP_LENGTH);
  const edgeMat = new MeshBasicMaterial({ color: 0xe6ebf2 });
  const kerbGeo = new PlaneGeometry(0.7, STRIP_LENGTH);
  const kerbMat = mat({ map: textures.kerb, roughness: 0.7 });
  const edges: Mesh[] = [], kerbs: Mesh[] = [];
  for (const side of [-1, 1]) {
    const e = new Mesh(edgeGeo, edgeMat);
    e.rotation.x = -PI / 2; e.position.set(side * (HALF_ROAD - 0.3), 0.021, 0);
    edges.push(e);
    const k = new Mesh(kerbGeo, kerbMat);
    k.rotation.x = -PI / 2; k.position.set(side * (HALF_ROAD + 0.35), 0.015, 0);
    k.receiveShadow = true;
    kerbs.push(k);
    root.add(e, k);
  }
  // Lane markings: pooled dashes recycled as the road scrolls.
  const dashGeo = new PlaneGeometry(0.18, SEGMENT_LENGTH * 0.45);
  const dashMat = new MeshBasicMaterial({ color: 0xf2f6ff });
  const dashes: Mesh[] = [];
  for (let i = 0; i < Math.ceil((VIEW_AHEAD + VIEW_BEHIND) / SEGMENT_LENGTH) * 2; i++) {
    const m = new Mesh(dashGeo, dashMat);
    m.rotation.x = -PI / 2; m.position.y = 0.02;
    dashes.push(m);
    root.add(m);
  }

  const trunkMat = mat({ color: 0x5a3f2a, roughness: 1 });
  const crownMat = mat({ color: 0x2f6e3e, roughness: 0.9, flatShading: true });
  const metalMat = mat({ color: 0x9aa4b2, roughness: 0.35, metalness: 0.85 });
  const lampMat = mat({ color: 0xfff1d0, emissive: 0xffd89a, emissiveIntensity: 1 });
  const scenery = buildScenery(root, trunkMat, crownMat, metalMat, lampMat);

  const parts = carParts(detailed);
  const player = makeCar(parts, 0xffcc33, true, detailed);
  root.add(player.group);
  const glowMat = new MeshBasicMaterial({ color: 0x2fd6c8, transparent: true, opacity: 0, depthWrite: false });
  const glow = new Mesh(new PlaneGeometry(2.4, 5.2), glowMat);
  glow.rotation.x = -PI / 2;
  glow.position.y = 0.03;
  glow.noAO = true;
  root.add(glow);

  const finishLine = new Mesh(new PlaneGeometry(ROAD_WIDTH, 3), new MeshBasicMaterial({ color: 0xffffff, map: textures.checker }));
  finishLine.rotation.x = -PI / 2;
  finishLine.position.y = 0.04;
  finishLine.visible = false;
  const finishGate = new Group();
  const gatePostGeo = new BoxGeometry(0.35, 5.4, 0.35);
  const gateMat = new MeshStandardMaterial({ color: 0x20262f, roughness: 0.4, metalness: 0.6 });
  for (const side of [-1, 1]) {
    const p = new Mesh(gatePostGeo, gateMat); p.position.set(side * (HALF_ROAD + 0.6), 2.7, 0); p.castShadow = true; finishGate.add(p);
  }
  const banner = new Mesh(new BoxGeometry(ROAD_WIDTH + 1.6, 0.9, 0.2),
    new MeshStandardMaterial({ map: textures.checker, emissive: 0xffffff, emissiveMap: textures.checker, emissiveIntensity: 0.35 }));
  banner.position.y = 5.0; banner.castShadow = true;
  finishGate.add(banner);
  finishGate.visible = false;
  root.add(finishLine, finishGate);

  // Speed lines: bounded, cosmetic.
  const rnd = cosmetic(0x5eed);
  const positions = new Float32Array(SPEED_LINE_MAX * 2 * 3);
  for (let i = 0; i < SPEED_LINE_MAX; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * (HALF_ROAD + 0.6 + rnd() * 3), y = 0.6 + rnd() * 4, z = rnd() * VIEW_AHEAD;
    positions.set([x, y, z, x, y, z + 6], i * 6);
  }
  const lineGeo = new BufferGeometry();
  lineGeo.setAttribute("position", new BufferAttribute(positions, 3));
  const speedLines = new LineSegments(lineGeo, new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
  speedLines.frustumCulled = false;
  speedLines.visible = false;
  root.add(speedLines);

  // Boost exhaust: additive points, faded through vertex colour.
  const exGeo = new BufferGeometry();
  exGeo.setAttribute("position", new BufferAttribute(new Float32Array(EXHAUST_MAX * 3), 3));
  exGeo.setAttribute("color", new BufferAttribute(new Float32Array(EXHAUST_MAX * 3), 3));
  const exhaustAge = new Float32Array(EXHAUST_MAX);
  for (let i = 0; i < EXHAUST_MAX; i++) exhaustAge[i] = i / EXHAUST_MAX;
  const exhaust = new Points(exGeo, new PointsMaterial({
    size: 0.5, map: textures.spark, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending,
  }));
  exhaust.frustumCulled = false;
  exhaust.visible = false;
  const exhaustCount = Math.min(EXHAUST_MAX, Math.max(8, Math.round(EXHAUST_COUNT * L.budget.sparks)));
  exGeo.setDrawRange(0, exhaustCount);
  root.add(exhaust);

  const padBaseMat = new MeshStandardMaterial({ color: 0x2fd6c8, emissive: 0x1a8f86, emissiveIntensity: 0.8, roughness: 0.3 });
  scene.add(root);
  return {
    root, sky, road, roadMat, shoulders, groundMat, edges, kerbs, dashes, scenery, trunkMat, crownMat, lampMat, player, glow, glowMat,
    traffic: [], pads: [], padBaseMat, finishLine, finishGate, speedLines, exhaust, exhaustAge, exhaustCount, carParts: parts, sceneryAnchor: NaN,
  };
}

let padGeo: { base: BufferGeometry; chev: BufferGeometry; chevMat: Material } | null = null;
function padParts(): { base: BufferGeometry; chev: BufferGeometry; chevMat: Material } {
  return (padGeo ??= { base: new RoundedBoxGeometry(1.9, 0.08, 3.2, 2, 0.03), chev: new ConeGeometry(0.55, 1.0, 3), chevMat: new MeshBasicMaterial({ color: 0xffffff }) });
}

function disposeTree(o: Object3D): void {
  const seen = new Set<unknown>();
  const keep = new Set<unknown>([skyMat, padGeo?.base, padGeo?.chev, padGeo?.chevMat]);
  o.traverse((ch) => {
    const m = ch as Mesh;
    if (m.geometry && !seen.has(m.geometry) && !keep.has(m.geometry)) { seen.add(m.geometry); m.geometry.dispose(); }
    const mt = (m as { material?: Material | Material[] }).material;
    if (mt) for (const x of Array.isArray(mt) ? mt : [mt]) {
      if (seen.has(x) || keep.has(x)) continue;
      seen.add(x);
      x.dispose();
    }
  });
}

// -- theme, quality and options -----------------------------------------------------------------
/** render.js setTheme (+ applyQualityToScene): sky, fog, lights, ground and scenery colours. */
function applyTheme(): void {
  const w = world;
  if (!w || !look) return;
  const theme = Content.getTheme(themeId);
  const fx = THEME_FX[theme.id] ?? THEME_FX.coastal!;
  const hc = highContrast;
  const sky = hc ? 0x05070c : theme.sky;
  const fogC = hc ? 0x05070c : theme.fog;
  uColor("uTop").setHex(hc ? sky : fx.zenith);
  uColor("uMid").setHex(sky);
  uColor("uHorizon").setHex(fogC);
  uColor("uSunColor").setHex(fx.key);
  uColor("uCloudColor").setHex(fx.clouds);
  (u.uSunDir!.value as Vector3).set(fx.sun[0], fx.sun[1], fx.sun[2]).normalize();
  u.uSunGlow!.value = hc ? 0 : fx.sunGlow;
  u.uStars!.value = hc ? 0 : fx.stars;
  u.uOctaves!.value = look.budget.clouds;
  u.uClouds!.value = look.detailed && !hc ? 1 : 0;
  w.roadMat.color.setHex(hc ? 0x14161c : theme.road);
  w.groundMat.color.setHex(hc ? 0x1e2a24 : fx.ground);
  fog.color.setHex(fogC);
  scene.background = new Color(sky);
  keyLight.color.setHex(fx.key);
  keyLight.intensity = fx.keyI / PI;
  ambient.color.setHex(fx.hemiSky);
  ambient.groundColor.setHex(fx.hemiGround);
  // IBL adds diffuse fill, so the hemisphere backs off to keep exposure stable.
  ambient.intensity = (fx.hemiI * (look.reflections ? 0.7 : 1)) / PI;
  // Light direction: toward the sun, so shadows fall away from it.
  keyDir.set(fx.sun[0], Math.max(0.35, fx.sun[1]), fx.sun[2]).normalize();
  w.glowMat.color.setHex(hc ? 0xffff00 : theme.accent);
  (w.crownMat as MeshStandardMaterial).color.setHex(fx.foliage);
  (w.trunkMat as MeshStandardMaterial).color.setHex(fx.trunk);
  w.lampMat.emissiveIntensity = fx.lamps;
  w.sceneryAnchor = NaN;
  for (const k of w.kerbs) k.visible = look.detailed && !hc;
  const sc = w.scenery;
  if (sc) {
    const on = look.detailed && !hc;
    for (const m of [sc.trunks, sc.crowns, sc.poles, sc.arms, sc.heads, sc.posts, ...sc.rails]) m.visible = on;
  }
  scene.environment = look.reflections ? envMap() : null;
  scene.environmentIntensity = 0.35;
  applyGrade();
}
function applyGrade(): void {
  if (!look?.grade) { renderer.grade = null; return; }
  // render.js GradeShader (before the output, linear light): a 0.22 S-curve, +10 % saturation, warm highlights
  // and cool shadows, a blue night tint on the night theme, the 0.24 vignette (off in high contrast).
  const n = themeId === "night" ? [0.955, 0.976, 1.036] : [1, 1, 1];
  renderer.grade = {
    space: "linear", contrast: 0.22, saturation: 1.1, split: [0.2, 0.8],
    shadows: [0.96 * n[0]!, 0.98 * n[1]!, 1.05 * n[2]!], highlights: [1.04 * n[0]!, 1.0 * n[1]!, 0.96 * n[2]!],
    vignette: { amount: highContrast ? 0 : 0.24, inner: 0.38, outer: 0.9, scale: [1, 1] },
  };
}

export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const before = look;
  look = next;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.7, radius: 0.9, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only lamps, lights, pads and the sun bloom.
  renderer.bloom = next.bloom ? { strength: 0.45, radius: 0.4, threshold: 0.95, resolution: next.budget.bloomRes } : null;
  renderer.antialias = next.antialias;
  renderer.shadowMap.enabled = next.shadows > 0;
  keyLight.castShadow = next.shadows > 0;
  if (next.shadows > 0) keyLight.shadow.mapSize = next.shadows;
  const b = before?.budget, nb = next.budget;
  if (!world || !b || b.material !== nb.material || b.segments !== nb.segments || before!.detailed !== next.detailed
    || before!.reflections !== next.reflections || b.sparks !== nb.sparks) {
    if (world) { scene.remove(world.root); disposeTree(world.root); }
    world = buildWorld();
  }
  applyTheme();
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; }
export function setHighContrast(on: boolean): void {
  if (on === highContrast) return;
  highContrast = on;
  applyTheme();
}
/** Title attract scene: gentle camera drift and idle bob (off with reduced motion). */
export function setAttract(on: boolean): void { attract = on; }
export function setTheme(id: string): void { themeId = Content.getTheme(id).id; applyTheme(); }
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }
export function markCrash(): void { if (!reducedMotion) shake = 1; }

// -- per frame ------------------------------------------------------------------------------------
const tmpMatrix = new Matrix4();
const tmpPos = new Vector3();
const tmpQuat = new Quaternion();
const tmpScale = new Vector3();
const UP = new Vector3(0, 1, 0);
// Integer hash → [0,1): scenery placement is a pure function of the world slot.
function slotRand(i: number, salt: number): number {
  let h = (i * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function placeScenery(w: World, anchor: number): void {
  const sc = w.scenery;
  if (!sc || anchor === w.sceneryAnchor) return;
  w.sceneryAnchor = anchor;
  const start = anchor - VIEW_BEHIND;
  const desert = themeId === "desert";
  const density = look!.budget.trees;
  let n = 0;
  const firstTree = Math.floor(start / TREE_SPACING);
  for (let i = 0; i < TREE_SLOTS; i++) {
    const slot = firstTree + i;
    for (let side = -1; side <= 1; side += 2) {
      const salt = side < 0 ? 1 : 2;
      const present = slotRand(slot, salt) < (desert ? 0.35 : 0.8) * density;
      const s = present ? 0.75 + slotRand(slot, salt + 10) * 0.7 : 0;
      tmpPos.set(side * (HALF_ROAD + 4 + slotRand(slot, salt + 20) * 16), 0, slot * TREE_SPACING + slotRand(slot, salt + 30) * TREE_SPACING * 0.8);
      tmpQuat.setFromAxisAngle(UP, slotRand(slot, salt + 40) * PI * 2);
      tmpScale.set(s, s * (desert ? 0.6 : 1), s);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      sc.trunks.setMatrixAt(n, tmpMatrix);
      sc.crowns.setMatrixAt(n, tmpMatrix);
      n++;
    }
  }
  sc.trunks.instanceMatrix.needsUpdate = true;
  sc.crowns.instanceMatrix.needsUpdate = true;
  n = 0;
  const firstLamp = Math.floor(start / LAMP_SPACING);
  for (let i = 0; i < LAMP_SLOTS; i++) {
    const z = (firstLamp + i) * LAMP_SPACING;
    for (let side = -1; side <= 1; side += 2) {
      tmpPos.set(side * (HALF_ROAD + 2.0), 0, z + (side < 0 ? LAMP_SPACING / 2 : 0));
      tmpQuat.setFromAxisAngle(UP, side > 0 ? 0 : PI);
      tmpScale.set(1, 1, 1);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      sc.poles.setMatrixAt(n, tmpMatrix);
      sc.arms.setMatrixAt(n, tmpMatrix);
      sc.heads.setMatrixAt(n, tmpMatrix);
      n++;
    }
  }
  for (const m of [sc.poles, sc.arms, sc.heads]) m.instanceMatrix.needsUpdate = true;
  n = 0;
  const firstPost = Math.floor(start / POST_SPACING);
  tmpQuat.identity(); tmpScale.set(1, 1, 1);
  for (let i = 0; i < POST_SLOTS; i++) {
    for (let side = -1; side <= 1; side += 2) {
      tmpPos.set(side * (HALF_ROAD + 1.35), 0, (firstPost + i) * POST_SPACING);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      sc.posts.setMatrixAt(n++, tmpMatrix);
    }
  }
  sc.posts.instanceMatrix.needsUpdate = true;
}

const laneX = (idx: number): number => LANES_X[Math.max(0, Math.min(LANE_COUNT - 1, idx))]!;
let laneVisual = 1;
let shake = 0;
let clock = 0;
let crashTilt = false;
const hsl = new Color();

function updateExhaust(w: World, state: State, px: number, pos: number, dt: number): void {
  const on = !reducedMotion && state.boostActive && look!.particles === "high";
  w.exhaust.visible = on;
  if (!on) return;
  const p = w.exhaust.geometry.getAttribute("position")!.array as Float32Array;
  const c = w.exhaust.geometry.getAttribute("color")!.array as Float32Array;
  const accent = w.glowMat.color;
  for (let i = 0; i < w.exhaustCount; i++) {
    let a = w.exhaustAge[i]! + dt * 2.2;
    if (a >= 1) a -= 1;
    w.exhaustAge[i] = a;
    const side = i % 2 === 0 ? -0.42 : 0.42;
    const jitter = Math.sin(i * 12.9898 + a * 7) * 0.12 * a;
    p[i * 3] = px + side + jitter;
    p[i * 3 + 1] = 0.32 + a * 0.55;
    p[i * 3 + 2] = pos - CAR_LENGTH * 0.5 - a * 5.5;
    const f = (1 - a) * (1 - a) * 0.9;
    c[i * 3] = (0.6 + accent.r) * f; c[i * 3 + 1] = (0.6 + accent.g) * f; c[i * 3 + 2] = (0.6 + accent.b) * f;
  }
  w.exhaust.geometry.getAttribute("position")!.needsUpdate = true;
  w.exhaust.geometry.getAttribute("color")!.needsUpdate = true;
}

/** render.js render(): one frame of the state, `alpha` of a step past it (interpolation). */
export function update(state: State | null, alpha: number, dtIn: number, width: number, height: number, dpr = 1): void {
  const w = world;
  if (!w || !look || !state) return;
  if (width > 0 && height > 0) camera.aspect = width / height;
  // three.js sizes attenuated points by size × pixel ratio × half the CSS height; the engine (1.24.0) takes
  // half the window's physical height, so the pixel ratio counts twice (repro in the port report): divide it out once.
  (w.exhaust.material as PointsMaterial).size = 0.5 / Math.max(1, dpr);
  camera.updateProjectionMatrix();
  const dt = Math.min(0.05, dtIn || 0.016);
  if (!reducedMotion) clock += dt;
  const pos = state.position + (state.crashed || state.finished ? 0 : state.speed * alpha * Rules.DT);

  // Lane interpolation is derived from simulation state, not frame count.
  const target = state.lane;
  laneVisual += (target - laneVisual) * Math.min(1, (reducedMotion ? 40 : 12) * dt);
  if (Math.abs(target - laneVisual) < 0.001) laneVisual = target;
  const px = LANES_X[0]! + (laneVisual / (LANE_COUNT - 1)) * (LANES_X[LANE_COUNT - 1]! - LANES_X[0]!);
  const bob = reducedMotion || state.crashed ? 0 : Math.sin(clock * (attract ? 2.2 : 14)) * (attract ? 0.02 : 0.012);
  const pm = w.player.group;
  pm.position.set(px, bob, pos);
  pm.rotation.y = reducedMotion ? 0 : (target - laneVisual) * -0.25;
  pm.rotation.z = reducedMotion ? 0 : (target - laneVisual) * 0.12;
  if (state.crashed) pm.rotation.z = 0.5;
  crashTilt = state.crashed;
  w.glow.position.set(px, 0.03, pos - 0.6);
  w.glowMat.opacity = state.boostActive ? 0.55 : 0;
  w.glow.visible = state.boostActive;
  const blobs = look.shadows === 0;
  w.player.blob.visible = blobs;

  // Scroll the ground planes with the player so the road looks endless.
  const anchor = Math.floor(pos / SEGMENT_LENGTH) * SEGMENT_LENGTH;
  const stripZ = anchor + (VIEW_AHEAD - VIEW_BEHIND) / 2;
  for (const m of [w.road, ...w.shoulders, ...w.edges, ...w.kerbs]) m.position.z = stripZ;
  if (w.scenery) {
    for (const r of w.scenery.rails) r.position.z = stripZ;
    if (w.scenery.trunks.visible) placeScenery(w, anchor);
  }
  w.sky.position.set(0, 0, pos);
  (u.uCenter!.value as Vector3).set(0, 0, pos);
  u.uTime!.value = look.animatedSky ? clock : 0;
  for (let i = 0; i < w.dashes.length; i++) {
    const lane = i % 2 === 0 ? -LANE_WIDTH / 2 : LANE_WIDTH / 2;
    w.dashes[i]!.position.set(lane, 0.02, anchor - VIEW_BEHIND + Math.floor(i / 2) * SEGMENT_LENGTH);
  }

  // Traffic: only cars inside the view window get a (pooled) view.
  let slot = 0;
  for (const car of state.traffic) {
    if (car.z < pos - VIEW_BEHIND || car.z > pos + VIEW_AHEAD) continue;
    let v = w.traffic[slot];
    if (!v) { v = makeCar(w.carParts, 0xdd5533, false, look.detailed); w.traffic.push(v); w.root.add(v.group); }
    slot++;
    v.group.visible = true;
    v.group.position.set(laneX(car.lane), 0, car.z);
    v.blob.visible = blobs;
    hsl.setHSL(highContrast ? 0.02 : 0.02 + car.hue * 0.12, highContrast ? 1 : 0.7, highContrast ? 0.65 : 0.45);
    (v.paint as MeshStandardMaterial).color.copy(hsl);
  }
  for (let i = slot; i < w.traffic.length; i++) w.traffic[i]!.group.visible = false;

  slot = 0;
  for (const p of state.pads) {
    if (p.taken || p.z < pos - VIEW_BEHIND || p.z > pos + VIEW_AHEAD) continue;
    let g = w.pads[slot];
    if (!g) { const pp = padParts(); g = makePad(pp.base, w.padBaseMat, pp.chev, pp.chevMat); w.pads.push(g); w.root.add(g); }
    slot++;
    g.visible = true;
    g.position.set(laneX(p.lane), 0, p.z);
  }
  for (let i = slot; i < w.pads.length; i++) w.pads[i]!.visible = false;
  w.padBaseMat.emissiveIntensity = look.detailed && !reducedMotion ? 1.3 + Math.sin(clock * 5) * 0.5 : 0.8;

  w.finishLine.visible = state.stageLength - pos < VIEW_AHEAD;
  w.finishLine.position.z = state.stageLength;
  w.finishGate.visible = w.finishLine.visible && look.detailed;
  w.finishGate.position.z = state.stageLength;

  w.speedLines.visible = !reducedMotion && state.boostActive;
  // Speed lines: the Particles tier × the budget's sparks factor.
  const lines = Math.min(SPEED_LINE_MAX, Math.max(6, Math.round(SPEED_LINE_COUNT * look.budget.sparks)));
  w.speedLines.geometry.setDrawRange(0, (look.particles === "high" ? lines : Math.round(lines / 2)) * 2);
  w.speedLines.position.z = anchor;
  updateExhaust(w, state, px, pos, dt);

  // Chase camera (render.js updateCamera).
  const boostPull = state.boostActive ? 2.2 : 0;
  let x = px * 0.35, y = 5.4;
  if (attract && !reducedMotion) { x += Math.sin(clock * 0.25) * 1.6; y += Math.sin(clock * 0.18) * 0.4; }
  if (shake > 0) {
    shake = Math.max(0, shake - dt * 2.5);
    x += (Math.random() - 0.5) * shake * 0.6;
    y += (Math.random() - 0.5) * shake * 0.4;
  }
  camera.position.set(x, y, pos - 11.5 - boostPull);
  camera.lookAt(px * 0.5, 1.1, pos + 14 + boostPull * 3);

  // The key light follows the player (the old shadow box ±34 m around pos + 16).
  const cz = pos + 16;
  keyLight.target.position.set(0, 0, cz);
  keyLight.position.set(keyDir.x * 60, keyDir.y * 60, cz + keyDir.z * 60);
}
/** Whether the player's car shows its crash tilt (for tests and the results backdrop). */
export function crashed(): boolean { return crashTilt; }
