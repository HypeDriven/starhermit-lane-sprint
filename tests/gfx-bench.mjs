// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a Practice run and keeps driving with the keyboard controls (lane changes and boosts, so the
// exhaust, speed lines, traffic and scenery all animate). A finished run is restarted from the results
// screen.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
	await page.waitForSelector('[data-action="open-settings"]', { state: 'visible', timeout: 20000 });
	await page.click('[data-action="open-settings"]');
	await page.waitForSelector('#gfx-section', { state: 'visible' });
	await page.selectOption('#gfx-preset', preset);
	await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
	await page.click('#settings-screen [data-action="close-overlay"]');
	await page.waitForSelector('#title-screen', { state: 'visible' });
}

export async function start(page) {
	await page.click('[data-action="practice"]');
	await page.waitForSelector('#hud-score', { state: 'visible' });
	let stopped = false, i = 0;
	page.once('close', () => { stopped = true; });
	(async () => {
		const keys = ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowRight', 'ArrowLeft'];
		while (!stopped) {
			try {
				if (await page.locator('#results-screen').isVisible()) await page.click('#results-screen [data-action="restart"]', { timeout: 1000 });
				else await page.keyboard.press(keys[i++ % keys.length]);
			} catch { /* screen changing */ }
			await new Promise((r) => setTimeout(r, 700));
		}
	})();
	await page.waitForTimeout(1000);
}
