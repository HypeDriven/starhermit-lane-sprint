# Lane Sprint — Game Design Document

**Pitch:** three lanes, one road, one boost charge — read the traffic ahead and thread a clean line to the finish before par time.

| | |
|---|---|
| Genre | Single-player arcade lane-switching racer, short stages |
| Players | 1; scores posted to the StarHermit high-score board |
| Session length | 25–70 s per stage; 3–10 min per sitting |
| Platforms | StarHermit engine 1.19.1 (host API 1.21): the native StarHermit client and browsers (the engine's web runtime), desktop and mobile, portrait and landscape |
| Rendering | `starhermit:scene` (three.js-like) road under an immediate-mode `starhermit:ui` shell |
| Simulation | Fixed 60 Hz deterministic step on the runtime's fixed updates, seeded PRNG, replayable |

## 1. File map

| Path | Responsibility |
|---|---|
| `starhermit.txt` | Manifest: `engine.entry=native/main.ts`, `engine.version=1.19.1`, `engine.minor=19`, capabilities `platform,storage,clipboard`, `control.*` keys and `engine.gamepad.*` pads per action, `server=score-script.js`. |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index, written by `npm run package` (never edit; re-run after every change). |
| `native/main.ts` | Entry: phase machine (title with attract scene → play ⇄ paused → results), input, fixed-step loop, results, lifecycle. |
| `native/screens.ts` | Every screen and the HUD in `starhermit:ui`. |
| `native/render.ts` | The road, cars, scenery, sky (WGSL), effects, camera and the post chain on `starhermit:scene`. |
| `native/quality.ts` | The four looks (old presets and budgets) per runtime quality tier and level. |
| `native/platform.ts` | Progress save and cloud merge, old-save migration, player/avatar/invite, server clock, score posting. |
| `native/audio.ts`, `native/i18n.ts`, `native/style.ts`, `native/game.ts` | Sound clips per event; locale from the runtime; UI style registration and high-contrast tokens; types over the pure modules. |
| `src/rules.js` | Pure rules: state, legality, fixed step, collision, scoring, hashing, PRNG. |
| `src/content.js` | 40 authored stages, Daily stage, 5 themes, offline validator and reference solver. |
| `src/session.js` | Command log, fixed-step advance, replay envelope, snapshots, replay verification. |
| `src/progress.js` | The progress document: normalize, merge, old cloud doc, bests, unlocks. |
| `src/i18n.js` | String tables in the nine locales. |
| `assets/ui-style.json` | `tools/ui-style.css` converted by `starhermit css` (`npm run css`). |
| `assets/textures/*.png` | Asphalt and verge detail maps baked from the old canvas painters (`tools/bake-textures.mjs`). |
| `score-script.js` | Server script: range-checks a run's `high-score` and returns it (the only source of leaderboard scores). |
| `tests/`, `tools/` | Node tests, engine checks and play scripts; packaging, CSS, texture bake, play-script generator, browser play (left out of the package). |

## 2. Design pillars

**1. The road is the interface.** Everything a player must decide is visible in the 170 m of track ahead: which lanes are blocked, where the next pad sits, how far the finish is. This rules in a chase camera with a long, uncluttered sightline and pooled, high-contrast car silhouettes. It rules out minimaps, off-screen warnings, and any hazard that appears inside the reaction window without warning.

**2. One charge, one decision.** Boost is not a resource to spam: 2.2 s of thrust, then a 6.0 s lockout (`TUNING` in `rules.js`). This rules in pads that top the charge up as a reward for lane discipline, and a HUD chip that always states ready/active/cooldown. It rules out held-throttle steering, fuel meters, and any per-frame skill that a touch player cannot perform.

**3. Fair speed.** Layout generation guarantees at least one open lane per row and never lets row speed decrease with distance, so two rows can never close into a wall (`buildLayout`). This rules in aggressive difficulty scaling through row spacing and double-blocked rows. It rules out random unavoidable deaths — and every one of the 40 stages is proved finishable without boosting by a solver that runs in `npm test`.

**4. A crash must be legible in retrospect.** Death is instant, but the results screen breaks the score into five named components and states the elapsed time. This rules in a numbers-first results table and a persistent per-stage best. It rules out unexplained totals, hidden multipliers, and score inflation from cosmetic play.

**5. The road is never the only channel.** The HUD, the three-cell lane mirror (player ▲ and hazard ✕ every tick), screen-reader announcements and every menu are accessible UI widgets. This rules out colour-only hazard signalling and hover-dependent controls.

## 3. Player experience

**Target player:** anyone who wants a complete, sharp arcade run in under a minute — the pick-up-and-play mobile player and the desktop player chasing par time on stage 34.

**First 60 seconds.** The title screen shows the name, a one-line tagline, decorative coastal key art, and five buttons; the attract scene behind it is a real stage rendered statically, so the canvas is never blank. "Play stage 1" or "Practice stage 1" is one click away. The run opens with the live region announcing `Stage 1 — Go!`, the HUD showing the boost chip in **Boost ready**, and the lane mirror already marking hazards with `✕`. Stage 1 is 900 m with 78 m row spacing and a 10 % chance of a double-blocked row: a player who does nothing survives several seconds, so the first lane change is discovered under low pressure. Boost pads appear at ~50 % of rows in early stages, and touching one triggers boost automatically with its own pickup chime, teaching what boost feels like before the player ever spends the manual charge. "How to play" states every control (with the player's own key bindings) in one screen.

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
| `lane_left` | `lane > 0`, run not terminal | ←, A, left half of the road, ◀ Left, D-pad/left stick left |
| `lane_right` | `lane < 2`, run not terminal | →, D, right half of the road, Right ▶, D-pad/left stick right |
| `boost` | not already boosting **and** `elapsed >= boostReadyAt` | Space, W, ↑, Boost, A / RT |

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

Commands are applied by `session.sendCommand` on the tick they are pressed on (before the next step), so an input always lands on a deterministic tick. On the engine the runtime's fixed steps run at 60 Hz and each advances the session by exactly one step (`session.advance(s, DT)`) while the run is live, so pauses, a hidden window and slow frames never cost time.

### Scoring (`scoreBreakdown`, integers only)

```
distance   = round(min(position, stageLength))
passes     = cleanPasses * 25
pads       = padsCollected * 40
timeBonus  = finished ? max(0, round((parTime - elapsed) * 60)) : 0
finishBonus= finished ? 500 : 0
total      = distance + passes + pads + timeBonus + finishBonus
```

**Worked example** (the bot run of `tests/native/stage-1-finish.play`, stage 1, par 30 s): 900 m, 5 clean passes, 2 pads, finished at 21.37 s → `900 + 125 + 80 + 518 + 500 = 2123`, the total the play script expects on the results.

### Terminal states and tie-breaks

`isTerminal` is `finished || crashed`; `terminalReason` returns `'finished'`, `'crashed'` or `''`. A crash keeps distance, passes and pads but forfeits both bonuses — the reason finishing at par beats a long, greedy, doomed run. Where two results must be ordered, the order is: objective completion (finished over crashed), then fewer `invalidActions`, then lower `elapsed`, then the stable session identifier.

### RNG, determinism and replay

`createRng` is mulberry32; stage seeds are FNV-1a hashes of `lane-sprint/v2/stage-N` (`hashSeed`), so layouts are identical on every device and build. `stateHash` folds seed, tick, lane, centi-metre position and speed, passes, pads and the flag byte. `session.verifyReplay` re-runs the recorded command list from the seed and asserts an identical hash; `npm test` calls it on completed runs.

There is no undo (the simulation is continuous and real-time) and no hint system; the lane mirror plus the 170 m sightline are the assistance the design provides.

## 5. Modes and progression

| Mode | Entry | Stage | Differs by |
|---|---|---|---|
| Journey | "Play stage N" | Highest unlocked stage (`progress.highestStage`, capped at 40) | Finishing unlocks the next stage; the results screen offers "Next stage". |
| Practice | "Practice stage 1" | Stage 1 | Always the tutorial stage; no unlock pressure, best score still recorded. |
| Daily | "Daily challenge" | `getDailyStage(platform.now())` | One shared seed per UTC day, fixed 1400 m, kept in a separate `dailyBest` map, never unlocks stages. |

**Curve.** Across stages 1→40, `t` runs 0→1: length 900→1800 m, row spacing 78→44 m, double-block chance 0.10→0.65, pad chance 0.50→0.30, traffic 12–20 → 18–28 m/s, par time = length/30 s, theme cycling through the five palettes. Difficulty therefore comes from a shrinking reaction window and denser walls, not from raising the player's speed.

**Daily content.** The day key is `YYYY-MM-DD` UTC and the seed hashes `lane-sprint/v2/daily/<key>`; spacing (50–70 m) and double-block chance (0.25–0.60) are derived from the seed. Days are immutable once published; the day comes from the platform's clock (`serverNow()`) when it has answered, else the device's UTC date.

**Unlocks** are stage access only. There is no currency, no cosmetic shop and no stat progression.

## 6. Controls and interaction

| Action | Keys (default, rebindable in Options) | Gamepad | Touch / mouse |
|---|---|---|---|
| Move left | ← / A | D-pad left, left stick left | tap or click the left half of the road; ◀ Left |
| Move right | → / D | D-pad right, left stick right | right half of the road; Right ▶ |
| Boost | Space / W / ↑ | A (South), RT | Boost |
| Pause / resume | Esc / P | Start | Pause (HUD, top right) |
| Restart | R | Y (North) | Restart in the pause menu, Retry stage on the results |

The bottom tray (Left / Boost / Right) shows during a live run, 60 px tall on touch devices and 48 px with a mouse. Presses on the HUD or the tray never count as road taps. Game keys clear the UI focus so they do not also walk or press menu buttons. Menus are driven by keyboard, pad (the runtime's UI navigation), mouse and touch; Escape closes How to play and Settings. How to play lists the player's effective key bindings.

## 7. Screens and UI flow

- **Title** over the attract scene (the furthest unlocked stage, rendered but never advanced, with a slow camera drift): name, tagline, signed-in player line (avatar, "Playing as …", cloud-save status), the key art (hidden at ≤ 620 px tall and in high contrast), Play stage N, Daily challenge, Practice stage 1, How to play, Settings, Invite a friend (signed in), Sign in with StarHermit (guest).
- **How to play**: rules, controls (keys from the bindings, touch, gamepad), Back.
- **Settings**: the game has no options of its own any more — sound, graphics, language, reduced motion, high contrast and larger text are the runtime's Options (Open Options) and Key bindings opens the runtime's rebinding; Back.
- **Run**: HUD over a top gradient (Stage, Score, Speed in km/h, the boost pill Boost ready / Boosting / Boost in Ns, Player and save status when signed in, Pause), a progress bar and the three-lane mirror; the tray below.
- **Paused**: Resume, Restart, How to play, Settings, Quit to title. A hidden window pauses the run.
- **Results**: Stage complete / Crashed, the finish illustration (finished, ≥ 620 px tall), the five-part breakdown and total, time and best, the leaderboard line (signed in), New best score!, Next stage (finished, not Daily) / Retry stage / Quit to title.

Panels are centred, at most 560 px wide, and scroll inside when taller than the window; buttons wrap into rows. Toasts (invite copied, signed out) show at the bottom for 3.5 s.

## 8. Art direction

**Palette** (`tools/ui-style.css` tokens): ink `#f2f7ff`, muted `#a9c0da`, panel `#081422e0`, accent teal `#2fd6c8` on `#06231f`, danger `#ff6b5e`. High contrast (the runtime's option) swaps to black panels, white muted text and borders, `#ffe600` accent and `#ff2d00` danger, and hides the decorative art; the 3D view goes to a flat dark sky with the roadside scenery and kerbs hidden.

**Themes** (`content.js`), one per stage cycle: coastal, sunset, night, snow, desert — each sets the sky dome (zenith → theme sky → fog-coloured horizon, sun glow, stars at night, fbm clouds), road and ground colours, fog (90–260 m), key and hemisphere light.

**Shape language and motion** are the browser build's: chunky cars (rounded bodies with lights, hubs and bumpers on detailed scenery; the player `#ffcc33` with a spoiler), teal pads with white chevrons, lane-change banking, the 5.4 m-high chase camera pulling back 2.2 m while boosting, a crash roll and shake, speed lines and additive exhaust while boosting, pulsing pads, an idle bob.

**Graphics levels.** The runtime's Options choose a graphics level (Auto by the device); `native/quality.ts` maps its quality tier to the old presets:

| Tier | Shadows | AO | Bloom / grade | AA | Reflections | Scenery detail | Boost effects | Materials, LOD, trees, cloud octaves |
|---|---|---|---|---|---|---|---|---|
| low | off (blob shadows) | off | off | MSAA | off | plain | half the speed lines | Lambert, ½, ½, 2 |
| balanced | 1024 | off | on | FXAA | on | detailed | exhaust + all lines | Standard, ¾, ¾, 3 |
| high | 2048 | on | on | SMAA | on | detailed | exhaust + all lines | clear-coated Physical, 1, 1, 4 |
| ultra | 4096 | high | on | MSAA | on | detailed | exhaust + all lines | clear-coated Physical, 1.5, 1, 5 |

Exhaust points and speed lines grow with the level within a tier (≤ 2×). Bloom (threshold 0.95: lights, lamps, pads, the sun), GTAO and the grade (S-curve 0.22, saturation 1.1, warm highlights / cool shadows, a blue tint at night, 0.24 vignette) are `renderer.bloom / ao / grade`. Render scale, the pixel-ratio cap, adaptive resolution and the frame-rate limit and readout are the runtime's. **Reduced motion** (runtime option) makes lane changes near-instant without bank, stops the bob, drift, pad pulse and cloud motion, and drops the crash shake, speed lines and exhaust.

## 9. Audio direction

Confirmatory one-shots only (no music): each event owns 2–3 clips played round-robin. Game events play on the runtime's effects bus, menu clicks on the interface bus; the runtime's Options own volumes, mute and the voice limit. Clips load one at a time once the mixer runs (after the first press in a browser); a clip still loading is silent. Sound stops while paused or hidden.

### SFX event table (source of truth for `sfx/manifest.txt`)

| Event id | Files | Description | Usage context |
|---|---|---|---|
| `lane` | `lane-whoosh-soft`, `lane-whoosh-quick`, `lane-whoosh-deep` | Airy sideways whooshes, light to heavy | Accepted lane change (`applyAction`) |
| `boost` | `boost-ignition`, `boost-surge`, `boost-roar` | Ignition burst, turbine surge, sustained roar | Manual boost spent |
| `pad` | `pad-chime`, `pad-charge` | Crystalline pickup chime; electric charge zap | Boost pad collected — distinct from a spent charge |
| `checkpoint` | `checkpoint-blip`, `checkpoint-sweep` | Two-note blip; short filter sweep | Each quarter-distance checkpoint crossed |
| `crash` | `crash-impact`, `crash-scrape`, `crash-thud` | Metallic impact, barrier scrape, body thud | Collision ends the run |
| `finish` | `finish-fanfare`, `finish-chime`, `finish-applause` | Brass fanfare, rising bells, small crowd | Finish line crossed |
| `ui` | `ui-select`, `ui-back` | Muted click; descending two-tone click | Any non-gameplay action (menu buttons) |

Format: 48 kHz mono Opus, 96 kbps VBR, loudness-normalized, generated with MOSS-SoundEffect v2.0 at 100 steps.

## 10. Localization

All strings are in `src/i18n.js` in en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT; the language is the runtime's (Options › Language, else the account's or the device's) and switches on the next frame. `npm test` checks that every key the client shows is authored in every locale.

## 11. Accessibility

Every control is a focusable widget with a name; the progress bar is a meter; the lane mirror marks the player (▲) and hazards (✕) in text, not colour alone; lane changes, the run's start and its result are announced (polite, repeats skipped). Reduced motion, high contrast and larger text follow the runtime's options; keys and pads are rebindable.

## 12. StarHermit integration

- **Saves:** the progress document `{ highestStage, bestScores, dailyBest }` is the engine save (device at once, account debounced). A conflict between devices merges (furthest stage, best per stage and per day). The browser build's cloud slot (`game:<slug>`, its whole store document as JSON) shows as foreign and is merged in and replaced once. Guests' old browser localStorage progress does not migrate.
- **Settings:** the old account-settings keys (`reducedMotion`, `highContrast`, `sound`, `graphics`, `ui.language`) are removed; those choices are the runtime's Options now.
- **Leaderboard:** after every run (finished or crashed) a signed-in player's total is sent through a practice session to `score-script.js`, which range-checks it (0–100 000) and returns it as the `high-score` score — the server script is the only source of scores; the results show the posting state and the rank.
- **Player:** display name, avatar, invite link (copied to the clipboard), Sign in for guests, a toast when signed out.
- **Clock:** the Daily's day by `serverNow()`, falling back to the device's UTC date.

## 13. Technical architecture

The pure modules (`src/*.js`) are imported unchanged by the TypeScript client (`allowJs`) and by the node tests. `native/main.ts` advances the session one rules step per 60 Hz fixed update while the run is live and applies commands on input; `render.ts` draws the state each frame, interpolating the player's position between steps. The world is rebuilt when the graphics tier changes its assets. Cosmetic randomness (speed lines, shake) never touches the rules' streams.

## 14. Testing and acceptance criteria

- `npm test` = `node tests/unit.mjs` (rules, all 40 stages solvable, the next 40 Dailies, legality, scoring, determinism and replay verification, i18n coverage, the progress document and old-save reading, the generated play script in step with the bot) + `node tests/native.mjs` (web index up to date, `tsc`, `starhermit check .` with no warnings, and each `tests/native/*.play` as a signed-out `--render-check`).
- Play scripts: `menus.play` (title, How to play, Settings, a run, boost, pause, quit); `stage-1-finish.play` (generated by `node tools/gen-plays.mjs`: the bot's exact key timings drive stage 1 to the finish and the expected total, then Next stage, pause, Restart, a crash on stage 2, Retry, R, Quit).
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged loader in Chrome on the GPU at desktop, phone (DPR 3) and landscape phone (DPR 3) — start, lane changes, boost, pause, results — failing on console errors or warnings.
- `npm run package` after the last change; `npm run css` after editing `tools/ui-style.css`.

## 15. Asset inventory

| Path | Purpose |
|---|---|
| `assets/title-key-art.webp`, `assets/results-finish.webp` | Decorative title and finish art (FLUX.2 klein) |
| `assets/textures/road.png`, `ground.png` | Asphalt (tyre tracks) and verge detail maps, baked |
| `assets/ui-style.json` | The UI style sheet |
| `cover.jpg`, `coverart.png`, `icon.png` | Platform card, cover art, icon |
| `sfx/*.opus` | The event clips above (MOSS-SoundEffect v2.0, 48 kHz mono Opus) |

The cars, pads, road, scenery and sky are procedural geometry; no 3D model files ship.

## 16. Known limitations

- **One shared board:** all modes post to the `high-score` board; there are no per-day Daily rankings. Solo scores are the client's total range-checked by `score-script.js` (no server replay verification).
- **Signed-in paths not live-tested here:** the cloud merge, old-save migration, settings-key removal and score posting are covered by unit tests of their logic only.
- **No music or ambience;** a sound clip still loading is silent (the old synth fallback blips are not ported).
- **The old Graphics panel's per-effect overrides and the menus' backdrop blur are not offered;** the runtime's level choice replaces them.
- **Boost is binary,** crashes are instant and total, and traffic never changes lanes (design).
- **Decorative art is hidden at ≤ 620 px of window height** and in high contrast.

## Design intent not yet implemented

- **Learn mode** with one-rule-at-a-time lessons; today stage 1 plus How to play carries the teaching load.
- **Challenge mode** with constrained goals (lane-lock, no-boost, pad-only runs).
- **Adaptive audio** — a speed-reactive bed that rises with boost.
