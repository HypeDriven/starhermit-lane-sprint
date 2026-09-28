// Lane Sprint — Three.js rendering: scene graph, semantic entity views, camera,
// lighting, VFX and the graphics-quality pipeline (shadows, IBL, post chain,
// adaptive resolution). Pools every repeated mesh and disposes GPU resources.
'use strict';

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { LANE_COUNT, LANE_WIDTH, CAR_LENGTH } from './rules.js';
import { getTheme } from './content.js';
import { detectPreset, resolve, describe, SHADOW_MAP } from './gfx.js';

// The chase camera looks toward +z, so screen-left is world +x: lane 0 (the
// left lane in the HUD) sits at +x.
const LANES_X = [LANE_WIDTH, 0, -LANE_WIDTH];
const ROAD_WIDTH = LANE_WIDTH * (LANE_COUNT + 1);
const HALF_ROAD = ROAD_WIDTH / 2;
const SEGMENT_LENGTH = 20;      // road/marking repeat length in metres
const VIEW_AHEAD = 170;         // metres of track kept resident
const VIEW_BEHIND = 40;
const STRIP_LENGTH = VIEW_AHEAD + VIEW_BEHIND + SEGMENT_LENGTH;
const SPEED_LINE_COUNT = 28;
const EXHAUST_COUNT = 64;
const TREE_SPACING = 10;
const TREE_SLOTS = Math.ceil(STRIP_LENGTH / TREE_SPACING) + 1;
const LAMP_SPACING = 40;
const LAMP_SLOTS = Math.ceil(STRIP_LENGTH / LAMP_SPACING) + 1;
const POST_SPACING = 5;
const POST_SLOTS = Math.ceil(STRIP_LENGTH / POST_SPACING) + 1;
const SHADOW_EXTENT = 34;       // half-size of the shadow box around the play area

// Per-theme lighting/scenery extras layered on top of content.js themes.
const THEME_FX = {
	coastal: { zenith: 0x3b86d6, ground: 0x3f8a58, foliage: 0x2f6e3e, trunk: 0x5a3f2a, key: 0xfff1dc, keyI: 2.1, hemiSky: 0xd6ecff, hemiGround: 0x3a5a44, hemiI: 1.0, sun: [-0.45, 0.8, -0.4], sunGlow: 0.35, lamps: 0.3, stars: 0, clouds: 0xffffff },
	sunset: { zenith: 0x4e3f7c, ground: 0x6f5a3e, foliage: 0x3f4f2c, trunk: 0x4a3222, key: 0xffb27a, keyI: 2.0, hemiSky: 0xffd2b0, hemiGround: 0x4a3440, hemiI: 0.9, sun: [-0.08, 0.16, 1], sunGlow: 1.0, lamps: 1.6, stars: 0, clouds: 0xffc6a0 },
	night: { zenith: 0x03060f, ground: 0x15302a, foliage: 0x10261e, trunk: 0x22180f, key: 0x9fb8ff, keyI: 0.9, hemiSky: 0x5a6f9a, hemiGround: 0x101820, hemiI: 0.6, sun: [-0.3, 0.7, 0.6], sunGlow: 0.25, lamps: 5.0, stars: 1, clouds: 0x2a3a5a },
	snow: { zenith: 0x8fbbe6, ground: 0xcfd9e4, foliage: 0x2d4a3f, trunk: 0x4a3a30, key: 0xffffff, keyI: 1.7, hemiSky: 0xe8f2ff, hemiGround: 0x8a98a8, hemiI: 0.95, sun: [-0.45, 0.6, -0.5], sunGlow: 0.3, lamps: 0.6, stars: 0, clouds: 0xffffff },
	desert: { zenith: 0x4f93d6, ground: 0xd2ad76, foliage: 0x6b7f34, trunk: 0x6b4a2a, key: 0xfff0d0, keyI: 2.3, hemiSky: 0xfff0d6, hemiGround: 0x8a6a44, hemiI: 1.0, sun: [-0.5, 0.85, -0.2], sunGlow: 0.4, lamps: 0.3, stars: 0, clouds: 0xfff6ea },
};

let renderer = null;
let scene = null;
let camera = null;
let disposables = [];
let reducedMotion = false;
let highContrast = false;
let attract = false;

let playerMesh = null;
let playerGlow = null;
let trafficPool = [];
let padPool = [];
let markingPool = [];
let speedLines = null;
let exhaust = null;
let exhaustAge = null;
let roadMesh = null;
let shoulderLeft = null;
let shoulderRight = null;
let edgeLines = [];
let kerbs = [];
let finishLine = null;
let finishGate = null;
let skyDome = null;
let ambient = null;
let keyLight = null;
let currentTheme = null;
let scenery = null;             // { trunks, crowns, poles, arms, heads, posts, rails[] }
let lastSceneryAnchor = NaN;
let bodyMaterials = [];
let blobs = [];

let laneVisual = 1;             // smoothed lane index for the car
let shake = 0;
let contextLost = false;
let clock = 0;                  // ambient-animation time; frozen under reduced motion

// Graphics pipeline state.
let canvasEl = null;
let gpu = '';
let detected = 'balanced';
let saved = {};
let q = resolve({}, 'balanced');
let composer = null;
let gradePass = null;
let postKey = null;
let postFailed = false;
let envTexture = null;
let size = [1, 1];
let pixelRatio = 1;
let adaptiveScale = 1;
let frameTimes = [];
let fps = 0;
let lastNow = 0;
const textures = {};

function track(obj) { disposables.push(obj); return obj; }

// ---------------------------------------------------------------- procedural textures

function canvasTexture(w, h, draw, repeat) {
	const c = document.createElement('canvas');
	c.width = w; c.height = h;
	draw(c.getContext('2d'), w, h);
	const tex = track(new THREE.CanvasTexture(c));
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.anisotropy = 4;
	if (repeat) tex.repeat.set(repeat[0], repeat[1]);
	return tex;
}

function seeded(seed) {
	let s = seed >>> 0;
	return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function noiseFill(ctx, w, h, base, spread, count, size, seed) {
	const rnd = seeded(seed);
	ctx.fillStyle = `rgb(${base},${base},${base})`;
	ctx.fillRect(0, 0, w, h);
	for (let i = 0; i < count; i++) {
		const v = Math.round(base + (rnd() - 0.5) * spread);
		ctx.fillStyle = `rgba(${v},${v},${v},0.55)`;
		const s = 1 + rnd() * size;
		ctx.fillRect(rnd() * w, rnd() * h, s, s);
	}
}

function buildTextures() {
	// Asphalt: fine aggregate plus darker tyre tracks along each lane (multiplied by the theme road colour).
	textures.road = canvasTexture(256, 512, (ctx, w, h) => {
		noiseFill(ctx, w, h, 236, 60, 9000, 2, 7);
		const lanePx = w / (LANE_COUNT + 1);
		for (let lane = 0; lane < LANE_COUNT; lane++) {
			const cx = lanePx * (lane + 1);
			for (const off of [-0.22, 0.22]) {
				const g = ctx.createLinearGradient(cx + off * lanePx - 10, 0, cx + off * lanePx + 10, 0);
				g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,0.13)'); g.addColorStop(1, 'rgba(0,0,0,0)');
				ctx.fillStyle = g; ctx.fillRect(cx + off * lanePx - 10, 0, 20, h);
			}
		}
	}, [1, STRIP_LENGTH / SEGMENT_LENGTH]);
	textures.ground = canvasTexture(256, 256, (ctx, w, h) => {
		noiseFill(ctx, w, h, 225, 90, 14000, 3, 3);
		const rnd = seeded(5);
		for (let i = 0; i < 40; i++) {
			ctx.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},0.06)`;
			ctx.beginPath(); ctx.arc(rnd() * w, rnd() * h, 8 + rnd() * 26, 0, Math.PI * 2); ctx.fill();
		}
	}, [4, STRIP_LENGTH / 10]);
	textures.kerb = canvasTexture(32, 128, (ctx, w, h) => {
		ctx.fillStyle = '#bcbcbc'; ctx.fillRect(0, 0, w, h);
		ctx.fillStyle = '#b3322a'; ctx.fillRect(0, 0, w, h / 2);
	}, [1, STRIP_LENGTH / 4]);
	textures.checker = canvasTexture(128, 32, (ctx, w, h) => {
		const n = 16, s = w / n;
		for (let y = 0; y < h / s; y++) for (let x = 0; x < n; x++) {
			ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
			ctx.fillRect(x * s, y * s, s, s);
		}
	});
	textures.blob = canvasTexture(64, 64, (ctx, w, h) => {
		const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
		g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
		ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
	});
	textures.blob.wrapS = textures.blob.wrapT = THREE.ClampToEdgeWrapping;
	textures.spark = canvasTexture(32, 32, (ctx, w, h) => {
		const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
		g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
		ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
	});
	textures.spark.wrapS = textures.spark.wrapT = THREE.ClampToEdgeWrapping;
}

// ---------------------------------------------------------------- sky

const SKY_VERT = `
varying vec3 vDir;
void main() {
	vDir = position;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = `
uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uSunColor; uniform vec3 uCloudColor;
uniform vec3 uSunDir; uniform float uTime; uniform float uClouds; uniform float uStars; uniform float uSunGlow;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
	vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
void main() {
	vec3 d = normalize(vDir);
	float h = d.y;
	vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.14, h));
	col = mix(col, uTop, smoothstep(0.14, 0.65, h));
	float sd = max(dot(d, normalize(uSunDir)), 0.0);
	col += uSunColor * (pow(sd, 6.0) * 0.28 + pow(sd, 600.0) * 3.0) * uSunGlow;
	if (uStars > 0.0 && h > 0.04) {
		vec3 cell = floor(d * 600.0);
		float r = hash(cell);
		col += vec3(0.9, 0.95, 1.0) * step(0.9992, r) * (0.6 + 0.8 * fract(r * 91.7)) * smoothstep(0.04, 0.25, h) * uStars;
	}
	if (uClouds > 0.0 && h > 0.0) {
		vec2 p = d.xz / (h + 0.12) * 1.3 + vec2(uTime * 0.012, uTime * 0.005);
		float n = fbm(p);
		float c = smoothstep(0.52, 0.82, n) * smoothstep(0.0, 0.18, h) * uClouds;
		col = mix(col, uCloudColor * (0.85 + 0.25 * n), c * 0.8);
	}
	gl_FragColor = vec4(col, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- post-processing

// Colour grade + vignette: gentle S-curve, slight saturation, warm highlights / cool shadows.
const GradeShader = {
	uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.24 }, uNight: { value: 0.0 } },
	vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
	fragmentShader: `
	uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette; uniform float uNight;
	varying vec2 vUv;
	void main() {
		vec4 src = texture2D(tDiffuse, vUv);
		vec3 c = src.rgb;
		vec3 lc = clamp(c, 0.0, 1.0);
		vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.22);
		float l = dot(s, vec3(0.299, 0.587, 0.114));
		s = mix(vec3(l), s, 1.1);
		s *= mix(vec3(0.96, 0.98, 1.05), vec3(1.04, 1.0, 0.96), smoothstep(0.2, 0.8, l));
		s = mix(s, s * vec3(0.85, 0.92, 1.12), uNight * 0.3);
		c = mix(c, s + max(c - 1.0, 0.0), uAmount);
		float d = length(vUv - 0.5);
		c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
		gl_FragColor = vec4(c, src.a);
	}`,
};

// ---------------------------------------------------------------- cars

// Shared geometry/material for repeated car parts; only the body tint is per car.
let carParts = null;
function ensureCarParts() {
	if (carParts) return carParts;
	carParts = {
		bodyGeo: track(new THREE.BoxGeometry(1.5, 0.55, CAR_LENGTH * 0.95)),
		bodyRound: track(new RoundedBoxGeometry(1.5, 0.55, CAR_LENGTH * 0.95, 3, 0.16)),
		cabinGeo: track(new THREE.BoxGeometry(1.25, 0.5, CAR_LENGTH * 0.42)),
		cabinRound: track(new RoundedBoxGeometry(1.25, 0.5, CAR_LENGTH * 0.42, 3, 0.14)),
		cabinMat: track(new THREE.MeshStandardMaterial({ color: 0x121a2a, roughness: 0.5, metalness: 0.1, envMapIntensity: 0.3 })),
		wheelGeo: track(new THREE.CylinderGeometry(0.34, 0.34, 0.28, 16)),
		wheelMat: track(new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.85 })),
		hubGeo: track(new THREE.CylinderGeometry(0.18, 0.18, 0.3, 12)),
		hubMat: track(new THREE.MeshStandardMaterial({ color: 0xb8c0cc, roughness: 0.3, metalness: 0.9 })),
		headGeo: track(new THREE.BoxGeometry(0.34, 0.12, 0.06)),
		headMat: track(new THREE.MeshStandardMaterial({ color: 0xfff6dc, emissive: 0xfff2cc, emissiveIntensity: 1.6 })),
		tailGeo: track(new THREE.BoxGeometry(0.42, 0.12, 0.06)),
		tailMat: track(new THREE.MeshStandardMaterial({ color: 0x5a0a0a, emissive: 0xff2a1a, emissiveIntensity: 2.4 })),
		bumperGeo: track(new THREE.BoxGeometry(1.52, 0.16, 0.14)),
		bumperMat: track(new THREE.MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.6, metalness: 0.2 })),
		spoilerGeo: track(new THREE.BoxGeometry(1.4, 0.06, 0.34)),
		blobGeo: track(new THREE.PlaneGeometry(2.3, 5.0)),
		blobMat: track(new THREE.MeshBasicMaterial({ map: textures.blob, transparent: true, depthWrite: false })),
	};
	return carParts;
}

function bodyMaterial(color) {
	const m = track(new THREE.MeshPhysicalMaterial({ color, roughness: 0.38, metalness: 0.3, clearcoat: 0, clearcoatRoughness: 0.08 }));
	bodyMaterials.push(m);
	applyBodyQuality(m);
	return m;
}

function applyBodyQuality(m) {
	const glossy = q.reflections === 'on';
	m.clearcoat = glossy ? 0.7 : 0;
	m.roughness = glossy ? 0.32 : 0.4;
	m.metalness = glossy ? 0.35 : 0.25;
}

// Authored silhouette: chassis + cabin + wheels, grouped so a car is a single
// semantic view rather than a bare box. Body mesh is always children[0]; the
// last child is the optional detail group (lights, bumpers, spoiler).
function makeCar(color, isPlayer) {
	const parts = ensureCarParts();
	const detailed = q.detail === 'detailed';
	const g = new THREE.Group();
	const body = new THREE.Mesh(detailed ? parts.bodyRound : parts.bodyGeo, bodyMaterial(color));
	body.position.y = 0.45;
	body.castShadow = true;
	g.add(body);
	const cabin = new THREE.Mesh(detailed ? parts.cabinRound : parts.cabinGeo, parts.cabinMat);
	cabin.position.set(0, 0.95, -0.2);
	cabin.castShadow = true;
	g.add(cabin);
	for (const [x, z] of [[-0.78, 1.3], [0.78, 1.3], [-0.78, -1.3], [0.78, -1.3]]) {
		const w = new THREE.Mesh(parts.wheelGeo, parts.wheelMat);
		w.rotation.z = Math.PI / 2;
		w.position.set(x, 0.34, z);
		w.castShadow = true;
		g.add(w);
	}
	const blob = new THREE.Mesh(parts.blobGeo, parts.blobMat);
	blob.rotation.x = -Math.PI / 2;
	blob.position.y = 0.025;
	blob.renderOrder = -1;
	blob.visible = q.shadows === 'off';
	blobs.push(blob);
	g.add(blob);

	const detail = new THREE.Group();
	const front = CAR_LENGTH * 0.475;
	for (const x of [-0.5, 0.5]) {
		const hl = new THREE.Mesh(parts.headGeo, parts.headMat); hl.position.set(x, 0.55, front + 0.01); detail.add(hl);
		const tl = new THREE.Mesh(parts.tailGeo, parts.tailMat); tl.position.set(x * 1.02, 0.58, -front - 0.01); detail.add(tl);
		const hub = new THREE.Mesh(parts.hubGeo, parts.hubMat); hub.rotation.z = Math.PI / 2; hub.position.set(x * 1.56, 0.34, 1.3); detail.add(hub);
		const hub2 = new THREE.Mesh(parts.hubGeo, parts.hubMat); hub2.rotation.z = Math.PI / 2; hub2.position.set(x * 1.56, 0.34, -1.3); detail.add(hub2);
	}
	for (const z of [front + 0.02, -front - 0.02]) {
		const b = new THREE.Mesh(parts.bumperGeo, parts.bumperMat); b.position.set(0, 0.28, z); detail.add(b);
	}
	if (isPlayer) {
		const sp = new THREE.Mesh(parts.spoilerGeo, parts.bumperMat); sp.position.set(0, 0.92, -front + 0.25); sp.castShadow = true; detail.add(sp);
		for (const x of [-0.5, 0.5]) {
			const strut = new THREE.Mesh(parts.bumperGeo, parts.bumperMat);
			strut.scale.set(0.05, 1.4, 1); strut.position.set(x, 0.8, -front + 0.25); detail.add(strut);
		}
	}
	detail.visible = detailed;
	g.add(detail);
	g.userData.detail = detail;
	return g;
}

function applyCarDetail(car) {
	const parts = ensureCarParts();
	const detailed = q.detail === 'detailed';
	car.children[0].geometry = detailed ? parts.bodyRound : parts.bodyGeo;
	car.children[1].geometry = detailed ? parts.cabinRound : parts.cabinGeo;
	car.userData.detail.visible = detailed;
}

// ---------------------------------------------------------------- scenery

function buildScenery() {
	const trunkGeo = track(new THREE.CylinderGeometry(0.16, 0.24, 1.6, 6));
	trunkGeo.translate(0, 0.8, 0);
	const crownGeo = track(new THREE.ConeGeometry(1.3, 3.4, 7));
	crownGeo.translate(0, 3.1, 0);
	const poleGeo = track(new THREE.CylinderGeometry(0.07, 0.1, 6.2, 8));
	poleGeo.translate(0, 3.1, 0);
	const armGeo = track(new THREE.BoxGeometry(1.7, 0.08, 0.1));
	armGeo.translate(-0.85, 6.1, 0);
	const headGeo = track(new THREE.BoxGeometry(0.6, 0.12, 0.26));
	headGeo.translate(-1.55, 6.02, 0);
	const postGeo = track(new THREE.BoxGeometry(0.1, 0.7, 0.1));
	postGeo.translate(0, 0.35, 0);

	const trunkMat = track(new THREE.MeshStandardMaterial({ color: 0x5a3f2a, roughness: 1 }));
	const crownMat = track(new THREE.MeshStandardMaterial({ color: 0x2f6e3e, roughness: 0.9, flatShading: true }));
	const metalMat = track(new THREE.MeshStandardMaterial({ color: 0x9aa4b2, roughness: 0.35, metalness: 0.85 }));
	const lampMat = track(new THREE.MeshStandardMaterial({ color: 0xfff1d0, emissive: 0xffd89a, emissiveIntensity: 1 }));

	const inst = (geo, mat, count, cast) => {
		const m = new THREE.InstancedMesh(geo, mat, count);
		m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		m.frustumCulled = false;
		m.castShadow = !!cast;
		scene.add(m);
		track({ dispose: () => m.dispose() });
		return m;
	};
	const railGeo = track(new THREE.BoxGeometry(0.08, 0.26, STRIP_LENGTH));
	const rails = [-1, 1].map(side => {
		const r = new THREE.Mesh(railGeo, metalMat);
		r.position.set(side * (HALF_ROAD + 1.35), 0.58, 0);
		r.castShadow = true;
		scene.add(r);
		return r;
	});
	scenery = {
		trunks: inst(trunkGeo, trunkMat, TREE_SLOTS * 2, true),
		crowns: inst(crownGeo, crownMat, TREE_SLOTS * 2, true),
		poles: inst(poleGeo, metalMat, LAMP_SLOTS * 2, true),
		arms: inst(armGeo, metalMat, LAMP_SLOTS * 2, false),
		heads: inst(headGeo, lampMat, LAMP_SLOTS * 2, false),
		posts: inst(postGeo, metalMat, POST_SLOTS * 2, false),
		rails, trunkMat, crownMat, lampMat,
	};
}

// Integer hash → [0,1): scenery placement is a pure function of the world slot,
// so props never reshuffle as the strip recycles.
function slotRand(i, salt) {
	let h = (i * 374761393 + salt * 668265263) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function placeScenery(anchor) {
	if (!scenery || anchor === lastSceneryAnchor) return;
	lastSceneryAnchor = anchor;
	const start = anchor - VIEW_BEHIND;
	const desert = currentTheme && currentTheme.id === 'desert';
	let n = 0;
	const firstTree = Math.floor(start / TREE_SPACING);
	for (let i = 0; i < TREE_SLOTS; i++) {
		const slot = firstTree + i;
		for (let side = -1; side <= 1; side += 2) {
			const salt = side < 0 ? 1 : 2;
			const present = slotRand(slot, salt) < (desert ? 0.35 : 0.8);
			const s = present ? 0.75 + slotRand(slot, salt + 10) * 0.7 : 0;
			tmpPos.set(side * (HALF_ROAD + 4 + slotRand(slot, salt + 20) * 16), 0, slot * TREE_SPACING + slotRand(slot, salt + 30) * TREE_SPACING * 0.8);
			tmpQuat.setFromAxisAngle(UP, slotRand(slot, salt + 40) * Math.PI * 2);
			tmpScale.set(s, s * (desert ? 0.6 : 1), s);
			tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
			scenery.trunks.setMatrixAt(n, tmpMatrix);
			scenery.crowns.setMatrixAt(n, tmpMatrix);
			n++;
		}
	}
	scenery.trunks.instanceMatrix.needsUpdate = true;
	scenery.crowns.instanceMatrix.needsUpdate = true;

	n = 0;
	const firstLamp = Math.floor(start / LAMP_SPACING);
	for (let i = 0; i < LAMP_SLOTS; i++) {
		const z = (firstLamp + i) * LAMP_SPACING;
		for (let side = -1; side <= 1; side += 2) {
			tmpPos.set(side * (HALF_ROAD + 2.0), 0, z + (side < 0 ? LAMP_SPACING / 2 : 0));
			tmpQuat.setFromAxisAngle(UP, side > 0 ? 0 : Math.PI);
			tmpScale.set(1, 1, 1);
			tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
			scenery.poles.setMatrixAt(n, tmpMatrix);
			scenery.arms.setMatrixAt(n, tmpMatrix);
			scenery.heads.setMatrixAt(n, tmpMatrix);
			n++;
		}
	}
	for (const m of [scenery.poles, scenery.arms, scenery.heads]) m.instanceMatrix.needsUpdate = true;

	n = 0;
	const firstPost = Math.floor(start / POST_SPACING);
	tmpQuat.identity(); tmpScale.set(1, 1, 1);
	for (let i = 0; i < POST_SLOTS; i++) {
		for (let side = -1; side <= 1; side += 2) {
			tmpPos.set(side * (HALF_ROAD + 1.35), 0, (firstPost + i) * POST_SPACING);
			tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
			scenery.posts.setMatrixAt(n++, tmpMatrix);
		}
	}
	scenery.posts.instanceMatrix.needsUpdate = true;
}

function setSceneryVisible(on) {
	if (!scenery) return;
	for (const k of ['trunks', 'crowns', 'poles', 'arms', 'heads', 'posts']) scenery[k].visible = on;
	for (const r of scenery.rails) r.visible = on;
}

// ---------------------------------------------------------------- init

export function init(canvas, options) {
	const opts = options || {};
	reducedMotion = !!opts.reducedMotion;
	highContrast = !!opts.highContrast;
	canvasEl = canvas;

	renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(1);
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.05;
	renderer.shadowMap.enabled = false;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	gpu = readGpu();
	detected = detectPreset(gpu, !!opts.mobile);
	q = resolve(opts.graphics || {}, detected);
	saved = opts.graphics || {};

	canvas.addEventListener('webglcontextlost', onContextLost, false);
	canvas.addEventListener('webglcontextrestored', onContextRestored, false);

	scene = new THREE.Scene();
	camera = new THREE.PerspectiveCamera(58, 1, 0.5, 600);
	buildTextures();

	ambient = new THREE.HemisphereLight(0xffffff, 0x334455, 1.1);
	scene.add(ambient);
	keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
	keyLight.position.set(-6, 14, 10);
	keyLight.shadow.bias = -0.0004;
	keyLight.shadow.normalBias = 0.03;
	Object.assign(keyLight.shadow.camera, { left: -SHADOW_EXTENT, right: SHADOW_EXTENT, top: SHADOW_EXTENT, bottom: -SHADOW_EXTENT, near: 1, far: 140 });
	keyLight.shadow.camera.updateProjectionMatrix();
	scene.add(keyLight);
	scene.add(keyLight.target);

	skyDome = new THREE.Mesh(
		track(new THREE.SphereGeometry(320, 32, 16)),
		track(new THREE.ShaderMaterial({
			uniforms: {
				uTop: { value: new THREE.Color() }, uMid: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
				uSunColor: { value: new THREE.Color() }, uCloudColor: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
				uTime: { value: 0 }, uClouds: { value: 0 }, uStars: { value: 0 }, uSunGlow: { value: 0 },
			},
			vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
		})));
	skyDome.renderOrder = -10;
	scene.add(skyDome);

	roadMesh = new THREE.Mesh(
		track(new THREE.PlaneGeometry(ROAD_WIDTH, STRIP_LENGTH)),
		track(new THREE.MeshStandardMaterial({ color: 0x39404e, roughness: 0.92 })));
	roadMesh.rotation.x = -Math.PI / 2;
	roadMesh.receiveShadow = true;
	scene.add(roadMesh);

	const shoulderMat = track(new THREE.MeshStandardMaterial({ color: 0x2f7f6d, roughness: 1 }));
	const shoulderGeo = track(new THREE.PlaneGeometry(40, STRIP_LENGTH));
	shoulderLeft = new THREE.Mesh(shoulderGeo, shoulderMat);
	shoulderRight = new THREE.Mesh(shoulderGeo, shoulderMat);
	for (const s of [shoulderLeft, shoulderRight]) { s.rotation.x = -Math.PI / 2; s.position.y = -0.12; s.receiveShadow = true; scene.add(s); }
	shoulderLeft.position.x = -(HALF_ROAD + 20);
	shoulderRight.position.x = HALF_ROAD + 20;

	// Solid edge lines frame the three lanes; kerbs sit just outside them.
	const edgeGeo = track(new THREE.PlaneGeometry(0.16, STRIP_LENGTH));
	const edgeMat = track(new THREE.MeshBasicMaterial({ color: 0xe6ebf2 }));
	const kerbGeo = track(new THREE.PlaneGeometry(0.7, STRIP_LENGTH));
	const kerbMat = track(new THREE.MeshStandardMaterial({ map: textures.kerb, roughness: 0.7 }));
	for (const side of [-1, 1]) {
		const e = new THREE.Mesh(edgeGeo, edgeMat);
		e.rotation.x = -Math.PI / 2; e.position.set(side * (HALF_ROAD - 0.3), 0.021, 0);
		edgeLines.push(e); scene.add(e);
		const k = new THREE.Mesh(kerbGeo, kerbMat);
		k.rotation.x = -Math.PI / 2; k.position.set(side * (HALF_ROAD + 0.35), 0.015, 0);
		k.receiveShadow = true;
		kerbs.push(k); scene.add(k);
	}

	// Lane markings: pooled dashes recycled as the road scrolls.
	const dashGeo = track(new THREE.PlaneGeometry(0.18, SEGMENT_LENGTH * 0.45));
	const dashMat = track(new THREE.MeshBasicMaterial({ color: 0xf2f6ff }));
	const dashCount = Math.ceil((VIEW_AHEAD + VIEW_BEHIND) / SEGMENT_LENGTH) * 2;
	for (let i = 0; i < dashCount; i++) {
		const m = new THREE.Mesh(dashGeo, dashMat);
		m.rotation.x = -Math.PI / 2; m.position.y = 0.02;
		markingPool.push(m); scene.add(m);
	}

	buildScenery();

	playerMesh = makeCar(0xffcc33, true);
	scene.add(playerMesh);
	playerGlow = new THREE.Mesh(
		track(new THREE.PlaneGeometry(2.4, 5.2)),
		track(new THREE.MeshBasicMaterial({ color: 0x2fd6c8, transparent: true, opacity: 0.0, depthWrite: false })));
	playerGlow.rotation.x = -Math.PI / 2;
	playerGlow.position.y = 0.03;
	scene.add(playerGlow);

	finishLine = new THREE.Mesh(
		track(new THREE.PlaneGeometry(ROAD_WIDTH, 3)),
		track(new THREE.MeshBasicMaterial({ color: 0xffffff, map: textures.checker })));
	finishLine.rotation.x = -Math.PI / 2;
	finishLine.position.y = 0.04;
	finishLine.visible = false;
	scene.add(finishLine);
	finishGate = new THREE.Group();
	const gatePostGeo = track(new THREE.BoxGeometry(0.35, 5.4, 0.35));
	const gateMat = track(new THREE.MeshStandardMaterial({ color: 0x20262f, roughness: 0.4, metalness: 0.6 }));
	for (const side of [-1, 1]) {
		const p = new THREE.Mesh(gatePostGeo, gateMat); p.position.set(side * (HALF_ROAD + 0.6), 2.7, 0); p.castShadow = true; finishGate.add(p);
	}
	const banner = new THREE.Mesh(track(new THREE.BoxGeometry(ROAD_WIDTH + 1.6, 0.9, 0.2)),
		track(new THREE.MeshStandardMaterial({ map: textures.checker, emissive: 0xffffff, emissiveMap: textures.checker, emissiveIntensity: 0.35 })));
	banner.position.y = 5.0; banner.castShadow = true;
	finishGate.add(banner);
	finishGate.visible = false;
	scene.add(finishGate);

	// Speed lines: bounded, cosmetic, never raycast against.
	const lineGeo = track(new THREE.BufferGeometry());
	const positions = new Float32Array(SPEED_LINE_COUNT * 2 * 3);
	for (let i = 0; i < SPEED_LINE_COUNT; i++) {
		const side = i % 2 === 0 ? -1 : 1;
		const x = side * (HALF_ROAD + 0.6 + Math.random() * 3);
		const y = 0.6 + Math.random() * 4;
		const z = Math.random() * VIEW_AHEAD;
		positions.set([x, y, z, x, y, z + 6], i * 6);
	}
	lineGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	speedLines = new THREE.LineSegments(lineGeo, track(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })));
	speedLines.frustumCulled = false;
	speedLines.visible = false;
	scene.add(speedLines);

	// Boost exhaust: additive points in car-local space, faded through vertex colour.
	const exGeo = track(new THREE.BufferGeometry());
	exGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(EXHAUST_COUNT * 3), 3));
	exGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(EXHAUST_COUNT * 3), 3));
	exhaustAge = new Float32Array(EXHAUST_COUNT);
	for (let i = 0; i < EXHAUST_COUNT; i++) exhaustAge[i] = i / EXHAUST_COUNT;
	exhaust = new THREE.Points(exGeo, track(new THREE.PointsMaterial({
		size: 0.5, map: textures.spark, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
	})));
	exhaust.frustumCulled = false;
	exhaust.visible = false;
	scene.add(exhaust);

	setTheme('coastal');
	applyGraphics();
	resize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height);
}

function readGpu() {
	try {
		const gl = renderer.getContext();
		const ext = gl.getExtension('WEBGL_debug_renderer_info');
		return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
	} catch (_) { return ''; }
}

function onContextLost(e) { e.preventDefault(); contextLost = true; }
function onContextRestored() { contextLost = false; postKey = null; }

export function isContextLost() { return contextLost; }

export function setAccessibility(opts) {
	if (!opts) return;
	if ('reducedMotion' in opts) reducedMotion = !!opts.reducedMotion;
	if ('highContrast' in opts) {
		highContrast = !!opts.highContrast;
		if (currentTheme) setTheme(currentTheme.id);
	}
}

/** Title attract scene: gentle camera drift and idle bob (off with reduced motion). */
export function setAttract(on) { attract = !!on; }

export function setTheme(id) {
	const theme = getTheme(id);
	currentTheme = theme;
	if (!scene) return;
	const fx = THEME_FX[theme.id] || THEME_FX.coastal;
	const road = highContrast ? 0x14161c : theme.road;
	const sky = highContrast ? 0x05070c : theme.sky;
	const fog = highContrast ? 0x05070c : theme.fog;
	const u = skyDome.material.uniforms;
	u.uTop.value.setHex(highContrast ? sky : fx.zenith);
	u.uMid.value.setHex(sky);
	u.uHorizon.value.setHex(fog);
	u.uSunColor.value.setHex(fx.key);
	u.uCloudColor.value.setHex(fx.clouds);
	u.uSunDir.value.set(fx.sun[0], fx.sun[1], fx.sun[2]).normalize();
	u.uSunGlow.value = highContrast ? 0 : fx.sunGlow;
	u.uStars.value = highContrast ? 0 : fx.stars;
	roadMesh.material.color.setHex(road);
	shoulderLeft.material.color.setHex(highContrast ? 0x1e2a24 : fx.ground);
	scene.fog = new THREE.Fog(fog, 90, 260);
	scene.background = new THREE.Color(sky);
	keyLight.color.setHex(fx.key);
	keyLight.intensity = fx.keyI;
	ambient.color.setHex(fx.hemiSky);
	ambient.groundColor.setHex(fx.hemiGround);
	ambient.intensity = fx.hemiI;
	// Light direction: toward the sun, so shadows fall away from it.
	keyLight.userData.dir = new THREE.Vector3(fx.sun[0], Math.max(0.35, fx.sun[1]), fx.sun[2]).normalize();
	playerGlow.material.color.setHex(highContrast ? 0xffff00 : theme.accent);
	if (scenery) {
		scenery.crownMat.color.setHex(fx.foliage);
		scenery.trunkMat.color.setHex(fx.trunk);
		scenery.lampMat.emissiveIntensity = fx.lamps;
		lastSceneryAnchor = NaN;
	}
	if (gradePass) gradePass.uniforms.uNight.value = theme.id === 'night' ? 1 : 0;
	applyQualityToScene();
}

// ---------------------------------------------------------------- graphics settings

/** Apply saved graphics settings (the `graphics` object from the store). Live, no reload. */
export function setGraphics(next) {
	saved = next && typeof next === 'object' ? next : {};
	q = resolve(saved, detected);
	if (!renderer) return;
	applyGraphics();
}

function applyGraphics() {
	const mapSize = SHADOW_MAP[q.shadows];
	renderer.shadowMap.enabled = mapSize > 0;
	renderer.shadowMap.type = q.shadows === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
	keyLight.castShadow = mapSize > 0;
	if (mapSize > 0 && keyLight.shadow.mapSize.x !== mapSize) {
		keyLight.shadow.mapSize.set(mapSize, mapSize);
		if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; }
	}
	if (q.reflections === 'on' && !envTexture) {
		try {
			const pmrem = new THREE.PMREMGenerator(renderer);
			const room = new RoomEnvironment();
			envTexture = pmrem.fromScene(room, 0.04).texture;
			room.dispose();
			pmrem.dispose();
		} catch (_) { envTexture = null; }
	}
	for (const m of bodyMaterials) applyBodyQuality(m);
	applyQualityToScene();
	for (const car of [playerMesh, ...trafficPool]) if (car) applyCarDetail(car);
	for (const b of blobs) b.visible = q.shadows === 'off';
	adaptiveScale = 1;
	frameTimes = [];
	postKey = null;
	postFailed = false;
	showFpsMeter(q.showFps);
	document.body.dataset.gfxPreset = q.preset;
	if (canvasEl) canvasEl.dataset.gfxPreset = q.preset;
	// Materials pick up shadow-map / environment changes on recompile.
	scene.traverse(o => {
		const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
		for (const m of mats) m.needsUpdate = true;
	});
	applySize(size[0], size[1], true);
	ensurePost();
}

// Theme-dependent parts of the quality state (textures, scenery, IBL strength).
function applyQualityToScene() {
	if (!scene || !roadMesh) return;
	const detailed = q.detail === 'detailed';
	const setMap = (mat, tex) => { if (mat.map !== tex) { mat.map = tex; mat.needsUpdate = true; } };
	setMap(roadMesh.material, detailed ? textures.road : null);
	setMap(shoulderLeft.material, detailed ? textures.ground : null);
	for (const k of kerbs) k.visible = detailed && !highContrast;
	setSceneryVisible(detailed && !highContrast);
	finishGate.visible = false;
	const reflect = q.reflections === 'on';
	scene.environment = reflect ? envTexture : null;
	scene.environmentIntensity = 0.35;
	const fx = THEME_FX[currentTheme ? currentTheme.id : 'coastal'] || THEME_FX.coastal;
	// IBL adds diffuse fill, so the hemisphere backs off to keep exposure stable.
	ambient.intensity = fx.hemiI * (reflect ? 0.7 : 1);
	const u = skyDome.material.uniforms;
	u.uClouds.value = detailed && !highContrast ? 1 : 0;
}

/** What the settings panel shows: GPU, auto choice, resolved tiers and cost summary. */
export function graphicsInfo(t) {
	const px = [Math.round(size[0] * pixelRatio), Math.round(size[1] * pixelRatio)];
	return {
		gpu: gpu || 'unknown GPU',
		detected,
		resolved: q,
		summary: describe(q, px, t),
		fps: Math.round(fps),
		adaptiveScale: Math.round(adaptiveScale * 100) / 100,
		postFailed,
	};
}

function showFpsMeter(on) {
	let el = document.getElementById('fps-meter');
	if (on && !el) {
		el = document.createElement('div');
		el.id = 'fps-meter';
		el.setAttribute('aria-hidden', 'true');
		el.textContent = '— fps';
		document.body.append(el);
	}
	if (el) el.hidden = !on;
}

function ensurePost() {
	const w = size[0], h = size[1];
	const key = q.post ? [q.ao, q.bloom, q.grade, q.antialias, w, h, pixelRatio].join('|') : 'none';
	if (key === postKey) return;
	postKey = key;
	if (composer) { composer.dispose(); composer = null; }
	gradePass = null;
	if (!q.post || postFailed) return;
	try {
		const pw = Math.max(1, Math.round(w * pixelRatio)), ph = Math.max(1, Math.round(h * pixelRatio));
		const target = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType, samples: q.antialias === 'msaa' ? 4 : 0 });
		const c = new EffectComposer(renderer, target);
		c.setPixelRatio(pixelRatio);
		c.setSize(w, h);
		c.addPass(new RenderPass(scene, camera));
		if (q.ao !== 'off') {
			const ao = new GTAOPass(scene, camera, pw, ph);
			ao.output = GTAOPass.OUTPUT.Default;
			ao.blendIntensity = 0.7;
			ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: q.ao === 'high' ? 16 : 8 });
			ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: q.ao === 'high' ? 6 : 4, rings: 2, samples: q.ao === 'high' ? 16 : 8 });
			c.addPass(ao);
		}
		if (q.bloom === 'on') {
			// High threshold: only lamps, lights, pads and the sun bloom.
			c.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.45, 0.4, 0.95));
		}
		if (q.grade === 'on') {
			gradePass = new ShaderPass(GradeShader);
			gradePass.uniforms.uNight.value = currentTheme && currentTheme.id === 'night' ? 1 : 0;
			gradePass.uniforms.uVignette.value = highContrast ? 0 : 0.24;
			c.addPass(gradePass);
		}
		c.addPass(new OutputPass());
		if (q.antialias === 'smaa') c.addPass(new SMAAPass(pw, ph));
		if (q.antialias === 'fxaa') {
			const fxaa = new ShaderPass(FXAAShader);
			fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
			c.addPass(fxaa);
		}
		composer = c;
	} catch (_) {
		// Post-processing is an enhancement: render directly if the chain cannot be built.
		postFailed = true;
		composer = null;
	}
}

// Adaptive resolution: step the render scale down when frames are slow, back up when fast.
function adapt(ms) {
	frameTimes.push(ms);
	if (frameTimes.length < 90) return false;
	let sum = 0;
	for (const f of frameTimes) sum += f;
	const avg = sum / frameTimes.length;
	frameTimes.length = 0;
	fps = 1000 / avg;
	const el = document.getElementById('fps-meter');
	if (el && !el.hidden) el.textContent = `${Math.round(fps)} fps · ${Math.round(pixelRatio * 100) / 100}×`;
	if (!q.adaptive) return false;
	const before = adaptiveScale;
	if (avg > 26) adaptiveScale = Math.max(0.6, adaptiveScale - 0.1);
	else if (avg < 14 && adaptiveScale < 1) adaptiveScale = Math.min(1, adaptiveScale + 0.05);
	return before !== adaptiveScale;
}

function targetRatio() {
	const dpr = Math.min(window.devicePixelRatio || 1, q.cap);
	return Math.max(0.5, Math.min(3, dpr * q.scale * adaptiveScale));
}

function applySize(w, h, force) {
	const width = Math.max(1, Math.floor(w));
	const height = Math.max(1, Math.floor(h));
	const ratio = targetRatio();
	if (!force && width === size[0] && height === size[1] && ratio === pixelRatio) return;
	size = [width, height];
	pixelRatio = ratio;
	renderer.setPixelRatio(ratio);
	renderer.setSize(width, height, false);
	camera.aspect = width / height;
	camera.updateProjectionMatrix();
}

export function resize(w, h) {
	if (!renderer) return;
	applySize(w, h, false);
	ensurePost();
}

// ---------------------------------------------------------------- per-frame

function laneX(idx) { return LANES_X[Math.max(0, Math.min(LANE_COUNT - 1, idx))]; }

function ensurePool(pool, count, factory) {
	while (pool.length < count) { const m = factory(); pool.push(m); scene.add(m); }
	for (let i = 0; i < pool.length; i++) pool[i].visible = i < count;
	return pool;
}

let padParts = null;
function makePad() {
	if (!padParts) {
		padParts = {
			baseGeo: track(new RoundedBoxGeometry(1.9, 0.08, 3.2, 2, 0.03)),
			baseMat: track(new THREE.MeshStandardMaterial({ color: 0x2fd6c8, emissive: 0x1a8f86, emissiveIntensity: 0.8, roughness: 0.3 })),
			chevGeo: track(new THREE.ConeGeometry(0.55, 1.0, 3)),
			chevMat: track(new THREE.MeshBasicMaterial({ color: 0xffffff })),
		};
	}
	const g = new THREE.Group();
	const base = new THREE.Mesh(padParts.baseGeo, padParts.baseMat);
	base.position.y = 0.06;
	base.receiveShadow = true;
	g.add(base);
	// Chevrons reinforce the pad's meaning without relying on colour alone.
	for (let i = 0; i < 2; i++) {
		const c = new THREE.Mesh(padParts.chevGeo, padParts.chevMat);
		c.rotation.x = -Math.PI / 2;
		c.position.set(0, 0.14, -0.7 + i * 1.4);
		g.add(c);
	}
	return g;
}

export function markCrash() { if (!reducedMotion) shake = 1; }

function updateExhaust(state, px, pos, dt) {
	const on = !reducedMotion && state.boostActive && q.particles === 'high';
	exhaust.visible = on;
	if (!on) return;
	const p = exhaust.geometry.attributes.position.array;
	const c = exhaust.geometry.attributes.color.array;
	const accent = playerGlow.material.color;
	for (let i = 0; i < EXHAUST_COUNT; i++) {
		let a = exhaustAge[i] + dt * 2.2;
		if (a >= 1) a -= 1;
		exhaustAge[i] = a;
		const side = i % 2 === 0 ? -0.42 : 0.42;
		const jitter = Math.sin(i * 12.9898 + a * 7) * 0.12 * a;
		p[i * 3] = px + side + jitter;
		p[i * 3 + 1] = 0.32 + a * 0.55;
		p[i * 3 + 2] = pos - CAR_LENGTH * 0.5 - a * 5.5;
		const f = (1 - a) * (1 - a) * 0.9;
		c[i * 3] = (0.6 + accent.r) * f; c[i * 3 + 1] = (0.6 + accent.g) * f; c[i * 3 + 2] = (0.6 + accent.b) * f;
	}
	exhaust.geometry.attributes.position.needsUpdate = true;
	exhaust.geometry.attributes.color.needsUpdate = true;
}

/**
 * Draw one frame from an immutable-enough simulation snapshot plus the
 * interpolation alpha. Performs no allocation.
 */
export function render(state, alpha, dtSeconds) {
	if (!renderer || !scene || !camera || contextLost) return;
	const now = performance.now();
	const frameMs = lastNow ? Math.min(250, now - lastNow) : 16;
	lastNow = now;
	if (adapt(frameMs)) applySize(size[0], size[1], true);

	const dt = Math.min(0.05, dtSeconds || 0.016);
	if (!reducedMotion) clock += dt;
	const pos = state.position + (state.crashed || state.finished ? 0 : state.speed * alpha * (1 / 60));

	// Lane interpolation is derived from simulation state, not frame count.
	const targetLane = state.lane;
	const laneSpeed = reducedMotion ? 40 : 12;
	laneVisual += (targetLane - laneVisual) * Math.min(1, laneSpeed * dt);
	if (Math.abs(targetLane - laneVisual) < 0.001) laneVisual = targetLane;
	const px = LANES_X[0] + (laneVisual / (LANE_COUNT - 1)) * (LANES_X[LANE_COUNT - 1] - LANES_X[0]);

	const bob = reducedMotion || state.crashed ? 0 : Math.sin(clock * (attract ? 2.2 : 14)) * (attract ? 0.02 : 0.012);
	playerMesh.position.set(px, bob, pos);
	playerMesh.rotation.y = reducedMotion ? 0 : (targetLane - laneVisual) * -0.25;
	playerMesh.rotation.z = reducedMotion ? 0 : (targetLane - laneVisual) * 0.12;
	if (state.crashed) playerMesh.rotation.z = 0.5;
	playerGlow.position.set(px, 0.03, pos - 0.6);
	playerGlow.material.opacity = state.boostActive ? 0.55 : 0.0;

	// Scroll the ground planes with the player so the road looks endless.
	const anchor = Math.floor(pos / SEGMENT_LENGTH) * SEGMENT_LENGTH;
	const stripZ = anchor + (VIEW_AHEAD - VIEW_BEHIND) / 2;
	roadMesh.position.z = stripZ;
	shoulderLeft.position.z = stripZ;
	shoulderRight.position.z = stripZ;
	for (const e of edgeLines) e.position.z = stripZ;
	for (const k of kerbs) k.position.z = stripZ;
	if (scenery) {
		for (const r of scenery.rails) r.position.z = stripZ;
		if (scenery.trunks.visible) placeScenery(anchor);
	}
	skyDome.position.z = pos;
	skyDome.material.uniforms.uTime.value = q.background === 'animated' ? clock : 0;

	for (let i = 0; i < markingPool.length; i++) {
		const m = markingPool[i];
		const lane = i % 2 === 0 ? -LANE_WIDTH / 2 : LANE_WIDTH / 2;
		const slot = Math.floor(i / 2);
		m.position.set(lane, 0.02, anchor - VIEW_BEHIND + slot * SEGMENT_LENGTH);
	}

	// Traffic: only cars inside the view window get a mesh.
	let visibleCars = 0;
	const traffic = state.traffic;
	for (let i = 0; i < traffic.length; i++) {
		const car = traffic[i];
		if (car.z < pos - VIEW_BEHIND || car.z > pos + VIEW_AHEAD) continue;
		visibleCars += 1;
	}
	ensurePool(trafficPool, visibleCars, () => makeCar(0xdd5533, false));
	let slot = 0;
	for (let i = 0; i < traffic.length; i++) {
		const car = traffic[i];
		if (car.z < pos - VIEW_BEHIND || car.z > pos + VIEW_AHEAD) continue;
		const m = trafficPool[slot++];
		m.position.set(laneX(car.lane), 0, car.z);
		const body = m.children[0];
		body.material.color.setHSL(highContrast ? 0.02 : 0.02 + car.hue * 0.12, highContrast ? 1 : 0.7, highContrast ? 0.65 : 0.45);
	}

	let visiblePads = 0;
	const pads = state.pads;
	for (let i = 0; i < pads.length; i++) {
		const p = pads[i];
		if (p.taken || p.z < pos - VIEW_BEHIND || p.z > pos + VIEW_AHEAD) continue;
		visiblePads += 1;
	}
	ensurePool(padPool, visiblePads, makePad);
	slot = 0;
	for (let i = 0; i < pads.length; i++) {
		const p = pads[i];
		if (p.taken || p.z < pos - VIEW_BEHIND || p.z > pos + VIEW_AHEAD) continue;
		const m = padPool[slot++];
		m.position.set(laneX(p.lane), 0, p.z);
	}
	if (padParts) padParts.baseMat.emissiveIntensity = q.detail === 'detailed' && !reducedMotion ? 1.3 + Math.sin(clock * 5) * 0.5 : 0.8;

	finishLine.visible = state.stageLength - pos < VIEW_AHEAD;
	finishLine.position.z = state.stageLength;
	finishGate.visible = finishLine.visible && q.detail === 'detailed';
	finishGate.position.z = state.stageLength;

	speedLines.visible = !reducedMotion && state.boostActive;
	speedLines.geometry.setDrawRange(0, (q.particles === 'high' ? SPEED_LINE_COUNT : SPEED_LINE_COUNT / 2) * 2);
	speedLines.position.z = anchor;
	updateExhaust(state, px, pos, dt);

	updateCamera(state, px, pos, dt);
	updateShadowBox(pos);

	ensurePost();
	if (composer) composer.render(dt);
	else renderer.render(scene, camera);
}

// Shadow box follows the player, snapped to whole texels so it does not shimmer.
function updateShadowBox(pos) {
	const texel = keyLight.castShadow ? (SHADOW_EXTENT * 2) / keyLight.shadow.mapSize.x : 1;
	const cz = Math.round((pos + 16) / texel) * texel;
	const dir = keyLight.userData.dir;
	keyLight.target.position.set(0, 0, cz);
	keyLight.position.set(dir.x * 60, dir.y * 60, cz + dir.z * 60);
	keyLight.target.updateMatrixWorld();
}

const CAM_HEIGHT = 5.4;
const CAM_BACK = 11.5;

function updateCamera(state, px, pos, dt) {
	const boostPull = state.boostActive ? 2.2 : 0;
	let x = px * 0.35;
	let y = CAM_HEIGHT;
	if (attract && !reducedMotion) {
		x += Math.sin(clock * 0.25) * 1.6;
		y += Math.sin(clock * 0.18) * 0.4;
	}
	if (shake > 0) {
		shake = Math.max(0, shake - dt * 2.5);
		x += (Math.random() - 0.5) * shake * 0.6;
		y += (Math.random() - 0.5) * shake * 0.4;
	}
	camera.position.set(x, y, pos - CAM_BACK - boostPull);
	camera.lookAt(px * 0.5, 1.1, pos + 14 + boostPull * 3);
}

/** Explicit disposal so a scene change or teardown frees GPU resources. */
export function dispose() {
	if (!renderer) return;
	if (composer) { composer.dispose(); composer = null; }
	if (envTexture) { envTexture.dispose(); envTexture = null; }
	for (const d of disposables) { if (d && typeof d.dispose === 'function') d.dispose(); }
	disposables = [];
	trafficPool = []; padPool = []; markingPool = []; bodyMaterials = []; blobs = [];
	edgeLines = []; kerbs = []; scenery = null;
	carParts = null; padParts = null;
	renderer.dispose();
	renderer = null; scene = null; camera = null;
}
