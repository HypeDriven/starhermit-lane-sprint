// Lane Sprint — main entry: host handshake, capability detection, lifecycle; wires rules/session/render/ui/audio/content/platform.
'use strict';

import * as rules from './rules.js';
import * as sessionMod from './session.js';
import * as renderMod from './render.js';
import * as uiMod from './ui.js';
import * as audioMod from './audio.js';
import { getStageCount, getThemes } from './content.js';

let _started = false;

function start() {
	if (_started) return; _started = true;
	uiMod.init();
	renderMod.init(document.getElementById('game-canvas'));
	window.__laneSprintRender = renderMod;
	window.__laneSprintUiHandleAction = (a) => {};
}

export function boot() { start(); }
