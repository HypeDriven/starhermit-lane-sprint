// Lane Sprint — Three.js rendering: scene graph, semantic entity views, camera, lighting, VFX.
// Pools every repeated mesh and disposes GPU resources on scene changes.
'use strict';

import * as THREE from 'three';
import { LANE_COUNT, LANE_WIDTH, CAR_LENGTH } from './rules.js';
import { getTheme } from './content.js';

// The chase camera looks toward +z, so screen-left is world +x: lane 0 (the
// left lane in the HUD) sits at +x.
const LANES_X = [LANE_WIDTH, 0, -LANE_WIDTH];
const ROAD_WIDTH = LANE_WIDTH * (LANE_COUNT + 1);
const SEGMENT_LENGTH = 20;      // road/marking repeat length in metres
const VIEW_AHEAD = 170;         // metres of track kept resident
const VIEW_BEHIND = 40;
const SPEED_LINE_COUNT = 28;

let renderer = null;
let scene = null;
let camera = null;
let disposables = [];
let reducedMotion = false;
let highContrast = false;

let playerMesh = null;
let playerGlow = null;
let trafficPool = [];
let padPool = [];
let markingPool = [];
let speedLines = null;
let roadMesh = null;
let shoulderLeft = null;
let shoulderRight = null;
let finishLine = null;
let skyDome = null;
let ambient = null;
let keyLight = null;
let currentTheme = null;

let laneVisual = 1;             // smoothed lane index for the car
let shake = 0;
let contextLost = false;

function track(obj) { disposables.push(obj); return obj; }

// Shared geometry/material for repeated car parts; only the body tint is per car.
let carParts = null;
function ensureCarParts() {
	if (carParts) return carParts;
	carParts = {
		bodyGeo: track(new THREE.BoxGeometry(1.5, 0.55, CAR_LENGTH * 0.95)),
		cabinGeo: track(new THREE.BoxGeometry(1.25, 0.5, CAR_LENGTH * 0.42)),
		cabinMat: track(new THREE.MeshStandardMaterial({ color: 0x121a2a, roughness: 0.25, metalness: 0.1 })),
		wheelGeo: track(new THREE.CylinderGeometry(0.34, 0.34, 0.28, 12)),
		wheelMat: track(new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.9 })),
	};
	return carParts;
}

// Authored silhouette: chassis + cabin + wheels, grouped so a car is a single
// semantic view rather than a bare box. Body mesh is always children[0].
function makeCar(color) {
	const parts = ensureCarParts();
	const g = new THREE.Group();
	const body = new THREE.Mesh(parts.bodyGeo, track(new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.25 })));
	body.position.y = 0.45;
	g.add(body);
	const cabin = new THREE.Mesh(parts.cabinGeo, parts.cabinMat);
	cabin.position.set(0, 0.95, -0.2);
	g.add(cabin);
	for (const [x, z] of [[-0.78, 1.3], [0.78, 1.3], [-0.78, -1.3], [0.78, -1.3]]) {
		const w = new THREE.Mesh(parts.wheelGeo, parts.wheelMat);
		w.rotation.z = Math.PI / 2;
		w.position.set(x, 0.34, z);
		g.add(w);
	}
	return g;
}

export function init(canvas, options) {
	const opts = options || {};
	reducedMotion = !!opts.reducedMotion;
	highContrast = !!opts.highContrast;

	renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.05;

	canvas.addEventListener('webglcontextlost', onContextLost, false);
	canvas.addEventListener('webglcontextrestored', onContextRestored, false);

	scene = new THREE.Scene();
	camera = new THREE.PerspectiveCamera(58, 1, 0.5, 600);

	ambient = new THREE.HemisphereLight(0xffffff, 0x334455, 1.1);
	scene.add(ambient);
	keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
	keyLight.position.set(-6, 14, 10);
	scene.add(keyLight);

	skyDome = new THREE.Mesh(
		track(new THREE.SphereGeometry(320, 24, 12)),
		track(new THREE.MeshBasicMaterial({ color: 0x8fd4ff, side: THREE.BackSide, fog: false })));
	scene.add(skyDome);

	roadMesh = new THREE.Mesh(
		track(new THREE.PlaneGeometry(ROAD_WIDTH, VIEW_AHEAD + VIEW_BEHIND + SEGMENT_LENGTH)),
		track(new THREE.MeshStandardMaterial({ color: 0x39404e, roughness: 0.95 })));
	roadMesh.rotation.x = -Math.PI / 2;
	scene.add(roadMesh);

	const shoulderMat = track(new THREE.MeshStandardMaterial({ color: 0x2f7f6d, roughness: 1 }));
	const shoulderGeo = track(new THREE.PlaneGeometry(40, VIEW_AHEAD + VIEW_BEHIND + SEGMENT_LENGTH));
	shoulderLeft = new THREE.Mesh(shoulderGeo, shoulderMat);
	shoulderRight = new THREE.Mesh(shoulderGeo, shoulderMat);
	for (const s of [shoulderLeft, shoulderRight]) { s.rotation.x = -Math.PI / 2; s.position.y = -0.12; scene.add(s); }
	shoulderLeft.position.x = -(ROAD_WIDTH / 2 + 20);
	shoulderRight.position.x = ROAD_WIDTH / 2 + 20;

	// Lane markings: pooled dashes recycled as the road scrolls.
	const dashGeo = track(new THREE.PlaneGeometry(0.18, SEGMENT_LENGTH * 0.45));
	const dashMat = track(new THREE.MeshBasicMaterial({ color: 0xf2f6ff }));
	const dashCount = Math.ceil((VIEW_AHEAD + VIEW_BEHIND) / SEGMENT_LENGTH) * 2;
	for (let i = 0; i < dashCount; i++) {
		const m = new THREE.Mesh(dashGeo, dashMat);
		m.rotation.x = -Math.PI / 2; m.position.y = 0.02;
		markingPool.push(m); scene.add(m);
	}

	playerMesh = makeCar(0xffcc33);
	scene.add(playerMesh);
	playerGlow = new THREE.Mesh(
		track(new THREE.PlaneGeometry(2.4, 5.2)),
		track(new THREE.MeshBasicMaterial({ color: 0x2fd6c8, transparent: true, opacity: 0.0, depthWrite: false })));
	playerGlow.rotation.x = -Math.PI / 2;
	playerGlow.position.y = 0.03;
	scene.add(playerGlow);

	finishLine = new THREE.Mesh(
		track(new THREE.PlaneGeometry(ROAD_WIDTH, 3)),
		track(new THREE.MeshBasicMaterial({ color: 0xffffff })));
	finishLine.rotation.x = -Math.PI / 2;
	finishLine.position.y = 0.04;
	finishLine.visible = false;
	scene.add(finishLine);

	// Speed lines: bounded, cosmetic, never raycast against.
	const lineGeo = track(new THREE.BufferGeometry());
	const positions = new Float32Array(SPEED_LINE_COUNT * 2 * 3);
	for (let i = 0; i < SPEED_LINE_COUNT; i++) {
		const side = i % 2 === 0 ? -1 : 1;
		const x = side * (ROAD_WIDTH / 2 + 0.6 + Math.random() * 3);
		const y = 0.6 + Math.random() * 4;
		const z = Math.random() * VIEW_AHEAD;
		positions.set([x, y, z, x, y, z + 6], i * 6);
	}
	lineGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	speedLines = new THREE.LineSegments(lineGeo, track(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })));
	speedLines.frustumCulled = false;
	speedLines.visible = false;
	scene.add(speedLines);

	setTheme('coastal');
	resize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height);
}

function onContextLost(e) { e.preventDefault(); contextLost = true; }
function onContextRestored() { contextLost = false; }

export function isContextLost() { return contextLost; }

export function setAccessibility(opts) {
	if (!opts) return;
	if ('reducedMotion' in opts) reducedMotion = !!opts.reducedMotion;
	if ('highContrast' in opts) {
		highContrast = !!opts.highContrast;
		if (currentTheme) setTheme(currentTheme.id);
	}
}

export function setTheme(id) {
	const theme = getTheme(id);
	currentTheme = theme;
	if (!scene) return;
	const road = highContrast ? 0x14161c : theme.road;
	const sky = highContrast ? 0x05070c : theme.sky;
	skyDome.material.color.setHex(sky);
	roadMesh.material.color.setHex(road);
	scene.fog = new THREE.Fog(highContrast ? 0x05070c : theme.fog, 90, 260);
	scene.background = new THREE.Color(sky);
	keyLight.intensity = theme.id === 'night' ? 0.9 : 1.6;
	ambient.intensity = theme.id === 'night' ? 0.6 : 1.1;
	playerGlow.material.color.setHex(highContrast ? 0xffff00 : theme.accent);
}

export function resize(w, h) {
	if (!renderer) return;
	const width = Math.max(1, Math.floor(w));
	const height = Math.max(1, Math.floor(h));
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setSize(width, height, false);
	camera.aspect = width / height;
	camera.updateProjectionMatrix();
}

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
			baseGeo: track(new THREE.BoxGeometry(1.9, 0.08, 3.2)),
			baseMat: track(new THREE.MeshStandardMaterial({ color: 0x2fd6c8, emissive: 0x1a8f86, emissiveIntensity: 0.8, roughness: 0.3 })),
			chevGeo: track(new THREE.ConeGeometry(0.55, 1.0, 3)),
			chevMat: track(new THREE.MeshBasicMaterial({ color: 0xffffff })),
		};
	}
	const g = new THREE.Group();
	const base = new THREE.Mesh(padParts.baseGeo, padParts.baseMat);
	base.position.y = 0.06;
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

/**
 * Draw one frame from an immutable-enough simulation snapshot plus the
 * interpolation alpha. Performs no allocation.
 */
export function render(state, alpha, dtSeconds) {
	if (!renderer || !scene || !camera || contextLost) return;
	const dt = Math.min(0.05, dtSeconds || 0.016);
	const pos = state.position + (state.crashed || state.finished ? 0 : state.speed * alpha * (1 / 60));

	// Lane interpolation is derived from simulation state, not frame count.
	const targetLane = state.lane;
	const laneSpeed = reducedMotion ? 40 : 12;
	laneVisual += (targetLane - laneVisual) * Math.min(1, laneSpeed * dt);
	if (Math.abs(targetLane - laneVisual) < 0.001) laneVisual = targetLane;
	const px = LANES_X[0] + (laneVisual / (LANE_COUNT - 1)) * (LANES_X[LANE_COUNT - 1] - LANES_X[0]);

	playerMesh.position.set(px, 0, pos);
	playerMesh.rotation.y = reducedMotion ? 0 : (targetLane - laneVisual) * -0.25;
	playerMesh.rotation.z = reducedMotion ? 0 : (targetLane - laneVisual) * 0.12;
	if (state.crashed) playerMesh.rotation.z = 0.5;
	playerGlow.position.set(px, 0.03, pos - 0.6);
	playerGlow.material.opacity = state.boostActive ? 0.55 : 0.0;

	// Scroll the ground planes with the player so the road looks endless.
	const anchor = Math.floor(pos / SEGMENT_LENGTH) * SEGMENT_LENGTH;
	roadMesh.position.z = anchor + (VIEW_AHEAD - VIEW_BEHIND) / 2;
	shoulderLeft.position.z = roadMesh.position.z;
	shoulderRight.position.z = roadMesh.position.z;
	skyDome.position.z = pos;

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
	ensurePool(trafficPool, visibleCars, () => makeCar(0xdd5533));
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

	finishLine.visible = state.stageLength - pos < VIEW_AHEAD;
	finishLine.position.z = state.stageLength;

	speedLines.visible = !reducedMotion && state.boostActive;
	speedLines.position.z = anchor;

	updateCamera(state, px, pos, dt);
	renderer.render(scene, camera);
}

const CAM_HEIGHT = 5.4;
const CAM_BACK = 11.5;

function updateCamera(state, px, pos, dt) {
	const boostPull = state.boostActive ? 2.2 : 0;
	let x = px * 0.35;
	let y = CAM_HEIGHT;
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
	for (const d of disposables) { if (d && typeof d.dispose === 'function') d.dispose(); }
	disposables = [];
	trafficPool = []; padPool = []; markingPool = [];
	carParts = null; padParts = null;
	renderer.dispose();
	renderer = null; scene = null; camera = null;
}
