// Lane Sprint — Three.js rendering: scene graph, semantic entity views, camera, lighting, VFX, quality tiers.
'use strict';

import * as THREE from 'three';
import { LANE_COUNT } from './rules.js';

const LANES_X = [-2.0, 0.0, 2.0]; // lane center x positions (meters)

let renderer = null;
let scene = null;
let camera = null;
let clock = new THREE.Clock();

// --- semantic entity views ---
let playerMesh = null;
let trafficGroup = null;
let boostPadGroup = null;
let roadGroup = null;
let speedLineGroup = null;
let skyDome = null;

const _v3a = new THREE.Vector3();

export function init(canvas) {
	renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	scene = new THREE.Scene();
	camera = new THREE.PerspectiveCamera(60, 1, 0.1, 300);

	const amb = new THREE.AmbientLight(0xffffff, 0.55); scene.add(amb);
	const dir = new THREE.DirectionalLight(0xffffff, 1.0);
	dir.position.set(-4, 8, -6); scene.add(dir);

	// sky dome (large sphere)
	skyDome = new THREE.Mesh(new THREE.SphereGeometry(200, 32, 16), new THREE.MeshBasicMaterial({ color: 0x9fd8ff }));
	scene.add(skyDome);

	// road base plane
	const roadGeo = new THREE.PlaneGeometry(40, 40);
	const roadMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4b });
	roadGroup = new THREE.Group(); scene.add(roadGroup);
	const roadMesh = new THREE.Mesh(roadGeo, roadMat);
	roadMesh.rotation.x = -Math.PI / 2; roadMesh.position.y = -0.5;
	roadGroup.add(roadMesh);

	// player car (box)
	playerMesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 2.6), new THREE.MeshStandardMaterial({ color: 0xffcc33 }));
	scene.add(playerMesh);

	trafficGroup = new THREE.Group(); scene.add(trafficGroup);
	boostPadGroup = new THREE.Group(); scene.add(boostPadGroup);
	speedLineGroup = new THREE.Group(); scene.add(speedLineGroup);

	resize(canvas.clientWidth, canvas.clientHeight);
}

export function resize(w, h) {
	if (!renderer) return;
	renderer.setSize(w, h, false);
	camera.aspect = w / Math.max(1, h);
	camera.updateProjectionMatrix();
}

function laneX(laneIdx) { return LANES_X[laneIdx]; }

// Traffic cars: index 0..N-1 with (lane, z).
export function setTraffic(cars) {
	if (!trafficGroup) return;
	while (trafficGroup.children.length < cars.length) {
		const m = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 2.6), new THREE.MeshStandardMaterial({ color: 0xdd5533 }));
		trafficGroup.add(m);
	}
	while (trafficGroup.children.length > cars.length) { trafficGroup.remove(trafficGroup.children[trafficGroup.children.length - 1]); }
	for (let i = 0; i < cars.length; i++) {
		const c = cars[i]; const m = trafficGroup.children[i];
		m.position.set(laneX(c.lane), 0, c.z);
	}
}

// Boost pads: index 0..N-1 with (lane, z).
export function setBoostPads(pads) {
	if (!boostPadGroup) return;
	while (boostPadGroup.children.length < pads.length) {
		const m = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.2, 1.6), new THREE.MeshStandardMaterial({ color: 0x33ccff }));
		boostPadGroup.add(m);
	}
	while (boostPadGroup.children.length > pads.length) { boostPadGroup.remove(boostPadGroup.children[boostPadGroup.children.length - 1]); }
	for (let i = 0; i < pads.length; i++) {
		const p = pads[i]; const m = boostPadGroup.children[i];
		m.position.set(laneX(p.lane), 0, p.z);
	}
}

export function setSpeedLines(active) {
	if (!speedLineGroup) return;
	for (const child of speedLineGroup.children) child.visible = !!active;
}

function updateCamera(state) {
	const t = state.tick % 10 === 9 ? 1 : 0; // placeholder, no-op
	void t;
	camera.position.set(0, 6, -8);
	_v3a.set(laneX(state.lane), 0, state.position * 0 + 4);
	camera.lookAt(_v3a.x * 0.2, 1, _v3a.z);
}

export function render(state) {
	if (!renderer || !scene || !camera) return;
	playerMesh.position.set(laneX(state.lane), 0, state.position + 4);
	updateCamera(state);
	renderer.render(scene, camera);
}
