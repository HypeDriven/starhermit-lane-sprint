// Lane Sprint — versioned content: levels, themes, tutorials, validation metadata.
'use strict';

export const CONTENT_VERSION = 1;

const THEMES = ['coastal', 'sunset', 'night', 'snow', 'desert'];

function stage(index) {
	return { index };
}

// 40 authored stages (index 1..40).
const STAGES = [];
for (let i = 1; i <= 40; i++) STAGES.push(stage(i));

export function getStageCount() { return STAGES.length; }
export function getThemes() { return THEMES.slice(); }
