# Lane Sprint — Game Design Document

**Pitch:** three lanes, one road, one boost charge — read the traffic ahead and thread a clean line to the finish before par time.

| | |
|---|---|
| Genre | Single-player arcade lane-switching racer, short stages |
| Players | 1; asynchronous score comparison via local bests |
| Session length | 25–70 s per stage; 3–10 min per sitting |
| Platforms | Desktop and mobile browsers, portrait and landscape |
| Rendering | Three.js (WebGL) playfield inside a semantic HTML shell |
| Simulation | Fixed 60 Hz deterministic step, seeded PRNG, replayable |

## 1. File map

| Path | Responsibility |
|---|---|
| `index.html` | Entry point: canvas, HUD, overlay container, touch tray, live region. |
| `css/style.css` | Palette tokens, HUD, overlays, thumb tray, high-contrast and reduced-motion modes, key art. |
| `src/index.js` | Bootstrap, phase machine, input map, rAF loop, HUD projection, `window.__laneSprint` test handles. |
| `src/rules.js` | Pure rules: state, legality, fixed step, collision, scoring, hashing, PRNG. |
| `src/content.js` | 40 authored stages, Daily stage, 5 themes, offline validator and reference solver. |
| `src/session.js` | Command queue, fixed-step accumulator, replay envelope, snapshots, replay verification. |
| `src/render.js` | Three.js scene, pooled meshes, camera, theme application, crash shake, disposal. |
| `src/ui.js` | DOM rendering of every screen, HUD write-out, lane mirror, focus, live announcements. |
| `src/audio.js` | WebAudio buses, sample rotation per event, synth fallback, focus suspension. |
| `src/store.js` | Versioned, sanitized `localStorage` save (settings, best scores, highest stage). |
| `src/platform.js` | Launch-token capture + 45-min refresh (memory only), profile fetch, cloud-save slot, round-trip-corrected clock sync. |
| `src/i18n.js` | Nine locale tables, negotiation, `{param}` interpolation, `missingKeys()` test hook. |
| `server.js` | Static file server, `GET /api/v1/time`, validated `/ws` echo, traversal rejection. |
| `assets/` | Title and results key art (WebP). |
| `sfx/` | 18 Opus clips, `manifest.txt` (canonical), `manifest.json` (generator), `manifest.md` (audit). |
| `tests/unit.mjs`, `tests/e2e.mjs` | 23 rules/content/i18n/server assertions; full Playwright playthrough. |

## 2. Design pillars

**1. The road is the interface.** Everything a player must decide is visible in the 170 m of track ahead: which lanes are blocked, where the next pad sits, how far the finish is. This rules in a chase camera with a long, uncluttered sightline and pooled, high-contrast car silhouettes. It rules out minimaps, off-screen warnings, and any hazard that appears inside the reaction window without warning.

**2. One charge, one decision.** Boost is not a resource to spam: 2.2 s of thrust, then a 6.0 s lockout (`TUNING` in `rules.js`). This rules in pads that top the charge up as a reward for lane discipline, and a HUD chip that always states ready/active/cooldown. It rules out held-throttle steering, fuel meters, and any per-frame skill that a touch player cannot perform.

**3. Fair speed.** Layout generation guarantees at least one open lane per row and never lets row speed decrease with distance, so two rows can never close into a wall (`buildLayout`). This rules in aggressive difficulty scaling through row spacing and double-blocked rows. It rules out random unavoidable deaths — and every one of the 40 stages is proved finishable without boosting by a solver that runs in `npm test`.

**4. A crash must be legible in retrospect.** Death is instant, but the results screen breaks the score into five named components and states the elapsed time. This rules in a numbers-first results table and a persistent per-stage best. It rules out unexplained totals, hidden multipliers, and score inflation from cosmetic play.

**5. The whole game survives the canvas being useless.** The HUD, lane mirror, live region and all menus are real DOM. This rules in a three-cell lane mirror that mirrors the player and hazard lanes every tick. It rules out canvas-only text, colour-only hazard signalling, and hover-dependent controls.

## 3. Player experience

**Target player:** anyone who wants a complete, sharp arcade run in under a minute — the pick-up-and-play mobile player and the desktop player chasing par time on stage 34.

**First 60 seconds.** The title screen shows the name, a one-line tagline, decorative coastal key art, and five buttons; the attract scene behind it is a real stage rendered statically, so the canvas is never blank. "Play stage 1" or "Practice stage 1" is one click away. The run opens with the live region announcing `Stage 1 — Go!`, the HUD showing the boost chip in **Boost ready**, and the lane mirror already marking hazards with `✕`. Stage 1 is 900 m with 78 m row spacing and a 10 % chance of a double-blocked row: a player who does nothing survives several seconds, so the first lane change is discovered under low pressure. Boost pads appear at ~50 % of rows in early stages, and touching one triggers boost automatically with its own pickup chime, teaching what boost feels like before the player ever spends the manual charge. "How to play" states every control in one screen.

**Session shape.** Play stage → crash or finish in 25–70 s → read the breakdown → "Next stage" (finish) or "Retry stage" (crash) → repeat. Progress unlocks one stage at a time; the title button always offers the highest unlocked stage.

**Emotional beat.** The held breath of a two-lane-blocked row at 58 m/s, then the release of the finish fanfare with a time bonus still on the clock.

## 4. Core loop and rules contract

Owner of every rule below: `src/rules.js`, unless stated.

### Entities

- **Road:** 3 lanes, 2.4 m apart (`LANE_WIDTH`), lane index 0–2, player starts in lane 1.
- **Player:** `{ lane, position (m), speed (m/s), boostActive, boostTimer, boostReadyAt }`. Starts at 18 m/s.
- **Traffic:** rows generated every `stage.rowSpacing` metres from z = 140 m to `length + 60`. Each row blocks 1 lane, or 2 with probability `stage.doubleBlockChance`. Cars carry `{ row, lane, z, speed, passed, hue }` and drive forward at their row speed.
- **Boost pads:** placed with probability `stage.padChance` in the last lane of the shuffled row order, at `z + spacing/2`.

### Legal actions (`isLegalAction`)

| Action | Legal when | Keys / touch |
|---|---|---|
| `lane_left` | `lane > 0`, run not terminal | ←, A, left half of canvas, ◀ button |
| `lane_right` | `lane < 2`, run not terminal | →, D, right half of canvas, ▶ button |
| `boost` | not already boosting **and** `elapsed >= boostReadyAt` | Space, W, ↑, Boost button |

An illegal action increments `state.invalidActions` and is otherwise a no-op — the run is never corrupted by mashing.

### Resolution order (one `step()`, exactly 1/60 s)

1. `tick += 1`, `elapsed += DT`.
2. Decay `boostTimer`; clear `boostActive` when it hits zero.
3. Approach the target speed (`58 m/s` boosting, `34 m/s` cruising) at 16 m/s².
4. `position += speed * DT`.
5. Advance every car by its speed; **collision first** — same lane and `|car.z − position| < 3.61 m` ends the run with `crashed` and a `crash` event; otherwise, cars newly behind `position − 2.1 m` count as a clean pass.
6. Pads: same lane and within 2.6 m → `taken`, `padsCollected += 1`, boost forced on for at least 2.2 s (no cooldown cost), `pad` event.
7. Checkpoints: crossing each quarter of the stage raises `checkpointIndex` and emits `checkpoint`.
8. Finish: `position >= stageLength` clamps position, sets `finished`, emits `finish`.

Commands are applied by `session.sendCommand` before the next step, so an input always lands on a deterministic tick regardless of frame rate. `session.advance` consumes wall-clock time in fixed steps, capped at 12 catch-up steps so a stalled tab cannot fast-forward the player into traffic.

### Scoring (`scoreBreakdown`, integers only)

```
distance   = round(min(position, stageLength))
passes     = cleanPasses * 25
pads       = padsCollected * 40
timeBonus  = finished ? max(0, round((parTime - elapsed) * 60)) : 0
finishBonus= finished ? 500 : 0
total      = distance + passes + pads + timeBonus + finishBonus
```

**Worked example** (real e2e run, stage 1, par 30 s): 900 m travelled, 4 clean passes, 2 pads, finished at 23.37 s → `900 + 100 + 80 + round(6.63 × 60)=398 + 500 = 1978`. This is the exact total the results screen prints.

### Terminal states and tie-breaks

`isTerminal` is `finished || crashed`; `terminalReason` returns `'finished'`, `'crashed'` or `''`. A crash keeps distance, passes and pads but forfeits both bonuses — the reason finishing at par beats a long, greedy, doomed run. Where two results must be ordered, the order is: objective completion (finished over crashed), then fewer `invalidActions`, then lower `elapsed`, then the stable session identifier.

### RNG, determinism and replay

`createRng` is mulberry32; stage seeds are FNV-1a hashes of `lane-sprint/v2/stage-N` (`hashSeed`), so layouts are identical on every device and build. `stateHash` folds seed, tick, lane, centi-metre position and speed, passes, pads and the flag byte. `session.verifyReplay` re-runs the recorded command list from the seed and asserts an identical hash; both `npm test` and the e2e test call it on a completed run.

There is no undo (the simulation is continuous and real-time) and no hint system; the lane mirror plus the 170 m sightline are the assistance the design provides.

## 5. Modes and progression

| Mode | Entry | Stage | Differs by |
|---|---|---|---|
| Journey | "Play stage N" | Highest unlocked stage (`store.highestStage`, capped at 40) | Finishing unlocks the next stage; the results screen offers "Next stage". |
| Practice | "Practice stage 1" | Stage 1 | Always the tutorial stage; no unlock pressure, best score still recorded. |
| Daily | "Daily challenge" | `getDailyStage(platform.now())` | One shared seed per UTC day, fixed 1400 m, kept in a separate `dailyBest` map, never unlocks stages. |

**Curve.** Across stages 1→40, `t` runs 0→1: length 900→1800 m, row spacing 78→44 m, double-block chance 0.10→0.65, pad chance 0.50→0.30, traffic 12–20 → 18–28 m/s, par time = length/30 s, theme cycling through the five palettes. Difficulty therefore comes from a shrinking reaction window and denser walls, not from raising the player's speed.

**Daily content.** The day key is `YYYY-MM-DD` UTC and the seed hashes `lane-sprint/v2/daily/<key>`; spacing (50–70 m) and double-block chance (0.25–0.60) are derived from the seed. Days are immutable once published; `platform.syncTime()` corrects the clock against the host so a skewed device does not get yesterday's stage.

**Unlocks** are stage access only. There is no currency, no cosmetic shop and no stat progression.

## 6. Controls and interaction

| Input | Desktop | Mobile | Feedback |
|---|---|---|---|
| Move left | ← / A | ◀ button, tap left half of the canvas | Car banks and slides, `lane` whoosh, mirror updates, live-region "Lane n of 3" |
| Move right | → / D | ▶ button, tap right half of the canvas | as above |
| Boost | Space / W / ↑ | Boost button | Teal ground glow, speed lines, camera pull-back, `boost` clip, HUD chip → **Boosting** |
| Pause | Esc / P | Pause button in the HUD | Simulation halts, pause overlay takes focus, audio context suspends |
| Restart | R | "Restart" / "Retry stage" | Fresh session at tick 0 |
| Menu action | Click / Enter / Space on a button | Tap | `ui` click clip |

**Input locking.** Gameplay keys are ignored outside the `play` phase; `keydown` is skipped for `SELECT`/`INPUT` targets and for repeats and modifier combos, so buttons keep native Enter/Space activation and the locale `<select>` keeps its arrow keys. Canvas taps only steer during play. Illegal actions are rejected by the rules, not by the input layer, and are counted.

**Automatic pause.** `visibilitychange` pauses the run and suspends audio; the accumulator is cleared on resume so a backgrounded tab loses no ground and gains none.

## 7. Screens and UI flow

Phases in `src/index.js`: `title → play ↔ paused → results`, with `overlay` for help/settings reached from title or results (from play, opening an overlay pauses first and returns to the pause screen). `ui.showScreen(id)` shows exactly one of `title | help | settings | paused | results` or none (`play`), hides the touch tray and pause button whenever an overlay is up, and moves focus to the first button or select in the shown screen — or back to the canvas when play resumes.

**Layout.** The canvas is fixed full-viewport. The HUD is a top bar padded by `env(safe-area-inset-top)` carrying stage, score, speed, boost chip and Pause, then a progress bar, then the three-cell lane mirror. Overlays are a centred panel, max 62ch of text, scrollable, padded by both safe-area insets. The touch tray is fixed to the bottom thumb zone at `12px + env(safe-area-inset-bottom)` with 44 px minimum targets; on fine pointers it slims to 150 px wide but stays available. Below 520 px wide, the HUD tightens its gaps and type; below 620 px tall, decorative key art is dropped so the menu never scrolls out of reach.

**Never cut off:** the boost chip, the lane mirror, the primary button of any overlay, and every row of the results breakdown. The e2e test asserts no element in `#title-screen` or `#hud` overflows its own box, at 1280×800 and at a 390×844 touch viewport.

## 8. Art direction

**Palette (CSS tokens, `css/style.css`).** Ink `#f2f7ff`, muted `#a9c0da`, background `#0b1a2b`, panel `rgba(8,20,34,0.88)`, accent teal `#2fd6c8` on `#06231f`, danger `#ff6b5e`, primary hover `#56e6da`. High contrast swaps to black panels, `#ffffff` text, `#ffe600` accent and `#ff2d00` danger, and hides decorative art.

**Themes (`content.js`), one per stage cycle:** coastal (sky `#8fd4ff`, road `#39404e`, accent `#2fd6c8`), sunset (`#ff9d6e` / `#3b3340` / `#ffd166`), night (`#101c33` / `#23283a` / `#7cc6ff`), snow (`#dfeeff` / `#4a5160` / `#9ad9ff`), desert (`#f6d9a0` / `#4d4438` / `#ff8f5a`). Each theme sets sky dome, road, fog (90–260 m) and light intensity; night drops the key light to 0.9 and ambient to 0.6.

**Shape language.** Chunky, flat-shaded boxes: chassis + darker cabin + four cylinder wheels, grouped so a car reads as one object rather than a primitive. Player car is `#ffcc33` (a colour no traffic car uses — traffic is HSL-generated in a narrow red-orange band). Pads are teal slabs carrying two white cone chevrons, so their meaning survives colour blindness and high contrast.

**Typography.** System UI stack throughout. HUD labels are 11 px uppercase with 0.08em tracking; values are large and plain; the results total is 20 px accent.

**Motion.** The hero of the screen is the road rushing under the car. Lane changes interpolate at 12 units/s with a bank (yaw −0.25, roll 0.12 of the residual); the camera sits 5.4 m up and 11.5 m back and pulls back a further 2.2 m while boosting. Crashing rolls the car to 0.5 rad and triggers a 1.0 shake that decays at 2.5/s. Speed lines (28 bounded segments) render only while boosting.

**Reduced motion** raises lane interpolation to 40 units/s (near-instant, no overshoot), zeroes bank and roll, suppresses the crash shake, hides speed lines, and disables all CSS transitions and animations. Nothing informative is lost.

**Visual assets the design calls for:** decorative coastal key art on the title screen (the game's mood in one frame, no text so it localizes), a text-free finish-gate illustration on the completion results screen, and the existing 16:9 `coverart.png` for the platform card. All are decorative (`alt=""`), removed on load error, and hidden in high contrast.

## 9. Audio direction

**Mix philosophy.** No music and no engine loop: the game is short and dense, so audio is purely confirmatory. One gain bus (`fxBus`) carries everything; the Sound setting sets its gain to 0 while listeners still fire, so visual cues stay perfectly in sync when audio is muted. The context is created lazily and only unlocked by a real user gesture (`resumeAudio` on any action), and suspended whenever the document is hidden.

**Rotation.** Each event owns 2–3 clips played round-robin (`eventCursor`), so repeated lane changes never sound mechanical. Samples are fetched and decoded on first use and cached; if a clip is missing or the context is not yet unlocked, a synth `blip` fallback plays instead, so every event is always audible.

### SFX event table (source of truth for `sfx/manifest.txt`)

| Event id | Files | Description | Usage context |
|---|---|---|---|
| `lane` | `lane-whoosh-soft`, `lane-whoosh-quick`, `lane-whoosh-deep` | Airy sideways whooshes, light to heavy | Accepted lane change (`applyAction`) |
| `boost` | `boost-ignition`, `boost-surge`, `boost-roar` | Ignition burst, turbine surge, sustained roar | Manual boost spent |
| `pad` | `pad-chime`, `pad-charge` | Crystalline pickup chime; electric charge zap | Boost pad collected — distinct from a spent charge |
| `checkpoint` | `checkpoint-blip`, `checkpoint-sweep` | Two-note blip; short filter sweep | Each quarter-distance checkpoint crossed |
| `crash` | `crash-impact`, `crash-scrape`, `crash-thud` | Metallic impact, barrier scrape, body thud | Collision ends the run |
| `finish` | `finish-fanfare`, `finish-chime`, `finish-applause` | Brass fanfare, rising bells, small crowd | Finish line crossed |
| `ui` | `ui-select`, `ui-back` | Muted click; descending two-tone click | Any non-gameplay action dispatched by `handleAction` |

Fallback synth voices: lane 440 Hz triangle, boost 880 Hz saw, pad 660 Hz triangle, checkpoint 523 Hz sine, crash 160 Hz square, finish 987 Hz triangle, ui 330 Hz sine.

Format: 48 kHz mono Opus, 96 kbps VBR, loudness-normalized, generated with MOSS-SoundEffect v2.0 at 100 steps.

## 10. Localization

Ships en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT. Strings live in `src/i18n.js` as one full en-US table plus per-locale override tables merged over it, so a missing key can never render as blank — and `missingKeys()` is asserted empty for all nine locales in `npm test`.

Selection order: saved `settings.locale` → `navigator.languages` exact match → base-language mapping (`es-ES` vs `es-419`, `fr-CA` vs `fr-FR`, `en-GB` vs `en-US`, `pt`→`pt-BR`, `de`, `it`) → `en-US`. Changing the language in Settings re-renders every screen immediately and sets `document.documentElement.lang`.

Interpolation is `{name}` token replacement (`t(key, params)`); a unit test asserts every locale keeps its `{n}` parameter and leaves no unsubstituted braces. Layout allows roughly 60 % expansion: menu buttons wrap rather than truncate, panel text is capped at 62ch, and no shipped image contains words.

## 11. Accessibility

- **Keyboard-only path:** boot → Tab to "Play" → play with arrows/Space → Esc to pause → Tab/Enter through the pause menu → results buttons. Every overlay moves focus to its first control on open; `:focus-visible` is a 3 px accent outline, including on the canvas.
- **Screen readers:** `#live-region` is `role="status" aria-live="polite"` and announces stage start, lane changes ("Lane 2 of 3") and the terminal outcome with time or distance; repeated text is suppressed so the reader is not flooded. Each lane-mirror cell carries an `aria-label` naming the lane and whether a hazard is ahead. The progress bar is a real `role="progressbar"` with a live `aria-valuenow`. Settings toggles expose `aria-pressed`.
- **Non-colour signalling:** the lane mirror prints `▲` for the player lane and `✕` for a hazard lane; pads carry chevrons; the boost chip prints its state as words.
- **Contrast:** default ink on background exceeds 4.5:1; High contrast mode forces black panels, white borders and a yellow accent, and re-themes the 3D scene (road `#14161c`, sky `#05070c`, yellow player glow, saturated traffic).
- **Reduced motion:** honoured from `prefers-reduced-motion` on first boot and toggleable in Settings; see §8.
- **Targets:** 44×44 CSS px minimum on the touch tray with 8 px separation, kept clear of browser chrome and cutouts by safe-area padding.
- **No time-limited interaction outside the run itself**, and no audio-only information.

## 12. StarHermit integration

`starhermit.txt` declares `name`, `launch=index.html`, `owner` and `server=server.js`; `coverart.png` is the platform card.

**Used:** launch-context handshake — `platform.readLaunchContext()` reads the `#game_token=<jwt>` fragment once (query params remain a local-dev fallback), strips it via `history.replaceState`, decodes `sub`/`game_scope` (never hard-coded), and marks the session hosted; every platform request then carries `Authorization: Bearer …`. Token refresh — `POST /api/v1/games/{slug}/launch-token` every 45 min (60 s retry on failure), swapping in the re-minted token. Account identity — `GET /api/v1/users/{sub}/profile`, showing the nickname (never a username; `"Player "+id8` fallback) in the HUD and title line. Cloud saves — the `lane-sprint/v1` document is mirrored to `GET`/`PUT /api/v1/me/cloud-saves/{slug}` as a stored zip+base64 (remote wins on boot when present; localStorage stays the offline cache; saves debounce 2 s and flush on `pagehide`), with a sync badge in the HUD. Authoritative time — `GET /api/v1/time` with round-trip correction (`syncTime`) so the Daily stage matches the platform's UTC day rather than the device clock. A validated `/ws` endpoint is served and hardened (16 KB max payload, JSON shape check, `ping`/`pong`) as the transport for future hosted features.

**Not used:** leaderboards, achievements, friend presence, and server-side session records. Best scores remain personal records, mirrored through the cloud save. Nothing in the game requires a host to be playable.

## 13. Technical architecture

**Dependency direction:** `rules` ← `content` ← `session` ← `index` → {`render`, `ui`, `audio`, `store`, `platform`, `i18n`}; `store` → `platform` for the cloud mirror. `rules.js` imports nothing and touches no DOM, so it runs unchanged in Node for tests, validators and the solver. `render.js` reads state, never writes it.

**Determinism and replay.** Fixed 1/60 s step, integer-friendly scoring, seeded layouts, per-tick command log with an FNV state hash every 60 ticks. `verifyReplay` reconstructs a run from the seed and command list — it is the game's own anti-cheat and regression detector.

**Persistence.** One `localStorage` key `lane-sprint/v1`, written through `sanitize()`, which clamps `highestStage` to 1–999 and rejects non-finite or negative scores, so a corrupted or hand-edited save degrades to defaults rather than breaking boot. Storage is probed in a `try/catch`; private-mode failures leave the game fully playable and stateless. Hosted sessions mirror the same document to the platform cloud slot (remote wins on boot); localStorage remains the offline cache.

**Performance budget.** No per-frame allocation in `step()` or `render()`. Meshes are pooled and clipped to a 170 m ahead / 40 m behind window; geometry and materials are shared and tracked in a `disposables` list freed by `dispose()`. Pixel ratio capped at 2. Target 60 fps on mid-range mobile; catch-up capped at 12 steps per frame.

**Failure paths.** No WebGL → the title screen renders with an explanatory line and the game does not boot the renderer. WebGL context loss → rendering halts safely (`isContextLost`) without throwing. A missing key-art file removes its `<img>`. A missing SFX clip falls back to synthesis. A failed time sync falls back to the local clock.

**How the e2e drives the real UI.** `tests/e2e.mjs` imports the shipped `server.js`, starts it, and drives Chromium through visible controls only — clicking `[data-action]` buttons, pressing real keys, selecting the locale `<select>`, reloading to prove persistence. `window.__laneSprint` is used only to *read* phase/state/snapshot and to verify the replay hash, never to advance or shortcut play.

## 14. Testing and acceptance criteria

`npm test` = `tests/unit.mjs` (23 assertions) then `tests/e2e.mjs`.

**Unit** covers: PRNG reproducibility; all 40 stages pass `validateStage` (rows never block every lane, pads in range, positive length and par); every stage is finished by the non-boosting reference solver; the Daily seed is stable per UTC day and differs across days; legality rules including "boost must not stack" and terminal lockout; illegal actions counted, never applied; a passive run always terminates within 200 s; the score breakdown sums to its total and yields integers; unfinished runs earn no bonuses; identical command streams hash identically; replay verification matches, including a command issued on the current tick; `advance` is frame-rate independent; all nine locales complete with working interpolation; the server's content types, `/api/v1/time`, unknown-API JSON errors, 404s, traversal rejection and non-GET rejection.

**E2E** runs the whole flow twice, at 1280×800 desktop and a 390×844 mobile touch viewport: boot to title, no clipped text, help open/close, settings toggles plus a locale switch that changes `documentElement.lang`, settings surviving a reload, practice run advancing, lane controls moving the car and updating the mirror, boost activating then reporting a cooldown, pause freezing the tick and resume restoring it, restart returning to tick 0, a run reaching a terminal state and showing results, replay hash matching, quit returning to title, canvas resizing with the viewport — and it fails on any console error or warning, page error, failed request or HTTP ≥ 400.

**QA bar (checkable statements).** Every implemented feature is reachable by clicking visible UI. The console is clean across both viewports. No text or control is clipped at either size. A first-time player is taught by stage 1's low density, the always-visible boost chip, the automatic pad boost and a complete "How to play" screen. Assets that could use platform features do (time sync, launch token); no multiplayer feature exists outside the platform.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/title-key-art.webp` | Decorative coastal-highway art on the title screen | FLUX.2 klein, seed 70701, 1536×864 → WebP q80 (43 KB) | Generated this pass, wired |
| `assets/results-finish.webp` | Decorative finish-gate art on the completion results screen | FLUX.2 klein, seed 70702, 1024×576 cropped to 1024×346 → WebP q82 (24 KB) | Generated this pass, wired |
| `coverart.png` | Platform card art (16:9) | FLUX.2 klein (earlier pass) | Shipped |
| `icon.png`, `favicon.svg` | App icon and tab icon | Authored | Shipped |
| `sfx/lane-whoosh-{soft,quick,deep}.opus` | `lane` cue rotation | MOSS-SoundEffect v2.0 | Shipped |
| `sfx/boost-{ignition,surge,roar}.opus` | `boost` cue rotation | MOSS-SoundEffect v2.0 | Shipped |
| `sfx/pad-{chime,charge}.opus` | `pad` cue rotation | MOSS-SoundEffect v2.0, 100 steps | Generated this pass, wired |
| `sfx/checkpoint-{blip,sweep}.opus` | `checkpoint` cue rotation | MOSS-SoundEffect v2.0, 100 steps | Generated this pass, wired |
| `sfx/crash-{impact,scrape,thud}.opus` | `crash` cue rotation | MOSS-SoundEffect v2.0 | Shipped |
| `sfx/finish-{fanfare,chime,applause}.opus` | `finish` cue rotation | MOSS-SoundEffect v2.0 | Shipped |
| `sfx/ui-{select,back}.opus` | `ui` cue rotation | MOSS-SoundEffect v2.0, 100 steps | Generated this pass, wired |
| `vendor/three.module.min.js` | Three.js renderer | three ^0.170.0 | Shipped |

The player car, traffic cars, boost pads, road, markings, sky dome and speed lines are procedural Three.js geometry — no 3D model files ship, and none are needed at this shape fidelity.

## 16. Known limitations

- **Cloud mirror when hosted.** Best scores, highest stage and settings live in the `lane-sprint/v1` localStorage key, which is also mirrored to the platform cloud slot when a launch token is present (remote wins on boot, 2 s debounce, `pagehide` flush). Without a host — or after clearing site data with no cloud doc — progress is device-local. There are no leaderboards, friend comparisons or hosted daily rankings, so the Daily challenge is a personal-best chase.
- **WebGL context loss is survived but not recovered.** Loss is detected and rendering stops cleanly; GPU resources are not rebuilt, so the player must reload.
- **No gamepad support.** Keyboard, pointer and touch only.
- **No music or ambience.** Audio is confirmatory only; long sessions are silent between cues.
- **Boost is binary.** There is no partial charge, no charge meter beyond ready/active/cooldown text, and no way to cancel a boost early.
- **Crash is instant and total.** There is no glancing hit, damage state or recovery; the only mitigation is that distance, passes and pads are all kept.
- **Traffic never changes lanes**, so reading the road is a spatial problem rather than a predictive one.
- **Decorative key art is hidden below 620 px of viewport height** (landscape phones) to protect the menu; those players see the 3D attract scene alone.

## Design intent not yet implemented

- **Learn mode** with one-rule-at-a-time lessons; today stage 1 plus the "How to play" screen carries the teaching load.
- **Challenge mode** with constrained goals (lane-lock, no-boost, pad-only runs).
- **Score chase** against validated seeds shared through the platform, and hosted daily rankings via the reserved `/ws` channel.
- **Adaptive audio** — a speed-reactive bed that rises with boost.
- **Quality tiers** selecting pixel ratio and effect density from measured frame time.
