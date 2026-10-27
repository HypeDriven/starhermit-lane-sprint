// Lane Sprint on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (src/rules.js), content
// (src/content.js), session with its command log and replay check
// (src/session.js) and progress document (src/progress.js) are the browser
// build's, unchanged in what they decide; this module is what src/index.js
// did around them — the phase machine (title with the attract scene → play ⇄
// paused → results), input (the lane and boost actions from keys and pads,
// taps on the left or right half of the road, the Left / Boost / Right tray),
// the event presentation (a sound per rules event, the crash shake, lane
// announcements), results with the local bests, unlocking the next stage and
// posting the run to the high-score board, and the lifecycle (a hidden window
// pauses the run, as visibilitychange did). Screens and HUD are drawn by
// screens.ts (starhermit:ui), the road by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps at the rules' 60 Hz: one rules step per
// fixed step while the run is active, so pauses, a hidden window and slow
// frames never cost time and play scripts replay exactly. Commands land on
// the tick they were pressed on, as before (session.sendCommand), and the
// road is drawn between steps by the frame's interpolation.
import "./i18n.ts";
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { bindings, isDown, onAction, onPointerButton, onTouch, primaryPointer } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { Content, Prog, Rules, Sess, type Breakdown, type Session, type Stage } from "./game.ts";
import * as audio from "./audio.ts";
import { t } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyContrast, initStyles } from "./style.ts";

export type Screen = "title" | "help" | "settings" | "game";
export interface Results {
  finished: boolean; breakdown: Breakdown; elapsed: number; best: number; newBest: boolean; hasNextStage: boolean;
}

export const app = {
  screen: "title" as Screen,
  /** Over the run: the pause menu or the results. */
  overlay: null as "pause" | "results" | null,
  /** Where How to play and Settings go back to (the title, or the run's pause menu / results). */
  under: "title" as Screen,
  /** Frame the screen or overlay opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  /** The live run (or the title's attract stage, never advanced). */
  session: null as Session | null,
  stage: null as Stage | null,
  isDaily: false,
  results: null as Results | null,
  lb: null as { posted: boolean; rank: number | null } | "posting" | null,
  toast: null as { text: string; until: number } | null,
};
const now = (): number => frame().time;

// ------------------------------------------------------------------ helpers
let lastAnnouncement = "";
/** Polite live region; repeated text is skipped so screen readers stay usable (ui.js announce). */
export function announce(text: string): void {
  if (!text || text === lastAnnouncement) return;
  lastAnnouncement = text;
  ui.announce(text.slice(0, 500), { politeness: "polite" });
}
/** ui.js toast(): 3.5 s over any screen. */
export function toast(text: string): void {
  app.toast = { text, until: now() + 3.5 };
  ui.announce(text, { politeness: "polite" });
}
export function click(): void { audio.event("ui"); }
export function progress(): platform.Progress { return platform.progress(); }
/** Pure-touch devices: the tray and taps (a phone reports no pointer before its first touch). */
export function touchOnly(): boolean {
  const pp = primaryPointer();
  if (pp !== "none") return pp === "coarse";
  const f = frame(), sc = ui.preferences().scale;
  const w = f.width / sc, h = f.height / sc;
  return (w <= 640 && h >= w) || (w > h && h <= 500);
}
const KEY_GLYPHS: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc", Space: "␣" };
/** The effective keys of an action, e.g. "← / A" (the old keyHintText glyphs). */
export function keysFor(action: string, sep = " / "): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => KEY_GLYPHS[b.label] ?? b.label); } catch { /* before the first frame */ }
  return [...new Set(list)].join(sep);
}
export function stageLabel(stage: Stage): string {
  return stage.dayKey ? t("dailyStage", { d: stage.dayKey }) : t("stage", { n: stage.index });
}

// ------------------------------------------------------------------ navigation
export function show(screen: Screen, focus: string | null = null): void {
  app.screen = screen;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
}
/** index.js goTitle: the title over the attract scene (the furthest stage, rendered but never advanced). */
export function goTitle(): void {
  app.overlay = null;
  app.results = null;
  app.lb = null;
  const stage = Content.getStage(Prog.nextStage(progress()));
  app.stage = stage;
  app.isDaily = false;
  app.session = Sess.startSession(stage);
  render.setTheme(stage.theme);
  render.setAttract(true);
  show("title", "btn-play");
  announce(t("title"));
}
/** How to play / Settings over the title, or over the paused run or its results. */
export function openPage(screen: "help" | "settings"): void {
  click();
  if (app.screen === "game" && app.overlay === null) pauseRun();
  if (app.screen !== "help" && app.screen !== "settings") app.under = app.screen;
  show(screen, "btn-back");
}
export function back(): void {
  click();
  if (app.under === "game" && app.session) { show("game", app.overlay === "results" ? "btn-results-first" : "btn-resume"); return; }
  show("title", "btn-play");
}

// ------------------------------------------------------------------ the run
export function startStage(stage: Stage, daily: boolean): void {
  app.stage = stage;
  app.isDaily = daily;
  app.session = Sess.startSession(stage);
  app.overlay = null;
  app.results = null;
  app.lb = null;
  render.setTheme(stage.theme);
  render.setAttract(false);
  audio.setSuspended(false);
  show("game", null);
  announce(`${stageLabel(stage)} — ${t("go")}`);
}
export function playNext(): void { click(); startStage(Content.getStage(Prog.nextStage(progress())), false); }
export function playDaily(): void { click(); startStage(Content.getDailyStage(platform.nowMs()), true); }
export function playPractice(): void { click(); startStage(Content.getStage(1), false); }
export function restart(): void { click(); if (app.stage) startStage(app.stage, app.isDaily); }
export function nextStage(): void {
  click();
  const s = app.stage;
  if (s && !app.isDaily && s.index < Content.STAGE_COUNT) startStage(Content.getStage(s.index + 1), false);
}
export function quit(): void { click(); goTitle(); }

export function playing(): boolean { return app.screen === "game" && app.overlay === null && !!app.session && !Rules.isTerminal(app.session.state); }
export function pauseRun(): void {
  if (!playing()) return;
  app.overlay = "pause";
  app.openedFrame = frame().frame;
  app.focusNext = "btn-resume";
  ui.setFocus(null);
  audio.setSuspended(true);
  announce(t("paused"));
}
export function resumeRun(): void {
  if (app.overlay !== "pause") return;
  click();
  app.overlay = null;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
  audio.setSuspended(false);
}

/** A lane or boost command: applied at once on the current tick (session.sendCommand), as before. */
export function command(action: "lane_left" | "lane_right" | "boost"): void {
  const s = app.session;
  if (!s || !playing()) return;
  Sess.sendCommand(s, action);
  handleEvents();
  if (action !== "boost") announce(t("announceLane", { n: s.state.lane + 1, total: Rules.LANE_COUNT }));
}
function handleEvents(): void {
  for (const name of Sess.drainEvents(app.session!)) {
    audio.event(name);
    if (name === "crash") render.markCrash();
  }
}

/** index.js endStage: the score, the local best, the next stage unlocked, the results, the board. */
function endStage(): void {
  const s = app.session!, stage = app.stage!;
  const state = s.state;
  const breakdown = Rules.scoreBreakdown(state);
  const key = stage.dayKey || stage.id;
  const doc = progress();
  const newBest = Prog.recordScore(doc, key, breakdown.total, app.isDaily);
  if (state.finished && !app.isDaily) Prog.unlockStage(doc, Math.min(Content.STAGE_COUNT, stage.index + 1));
  platform.saveNow();
  app.results = {
    finished: state.finished, breakdown, elapsed: state.elapsed, best: Prog.bestScore(doc, key, app.isDaily), newBest,
    hasNextStage: !app.isDaily && stage.index < Content.STAGE_COUNT,
  };
  app.overlay = "results";
  app.openedFrame = frame().frame;
  app.focusNext = "btn-results-first";
  ui.setFocus(null);
  announce(state.finished ? t("announceFinish", { s: state.elapsed.toFixed(1) }) : t("announceCrash", { m: Math.round(state.position) }));
  if (platform.signedIn()) {
    app.lb = "posting";
    void platform.postLeaderboard(breakdown.total).then((r) => { if (app.session === s) app.lb = r; });
  }
}
export function leaderboardLine(): string | null {
  const r = app.lb;
  if (!r) return null;
  if (r === "posting") return t("sh.lbPosting");
  return !r.posted ? t("sh.lbNotPosted") : r.rank ? t("sh.lbRank", { rank: r.rank }) : t("sh.lbPosted");
}

export function copyInvite(): void {
  click();
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(t("sh.copied")); } catch { toast(t("sh.copyFailed", { link })); }
}
export function signIn(): void { click(); void requestSignIn().catch(() => undefined); }

// ------------------------------------------------------------------ input
/** HUD rectangles (window pixels) where a press belongs to the UI, set by screens.ts each frame. */
export const hudRects: { x: number; y: number; width: number; height: number }[] = [];
const onHud = (x: number, y: number): boolean => hudRects.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
const presses: { x: number; y: number }[] = [];
let lastTouch = -1e9;
onTouch((e) => {
  lastTouch = now();
  if (e.control || e.phase !== "start") return;
  presses.push({ x: e.x, y: e.y });
});
onPointerButton((e) => {
  if (e.button !== 0 || !e.pressed || now() - lastTouch < 0.6) return;
  presses.push({ x: e.x, y: e.y });
});
/** index.js onCanvasPointer: a press on the road's left or right half changes lane; decided once the frame's UI is built. */
function pointerInput(): void {
  for (const p of presses.splice(0)) {
    if (!playing() || onHud(p.x, p.y)) continue;
    command(p.x < frame().width / 2 ? "lane_left" : "lane_right");
  }
}

onAction((e) => {
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame;
  if (app.screen === "help" || app.screen === "settings") {
    if (e.action === "pause" && fresh && !ui.capturingKeys()) back();
    return;
  }
  if (app.screen !== "game") return;
  if (e.action === "pause") {
    if (!fresh) return;
    if (app.overlay === "pause") resumeRun();
    else if (app.overlay === null) pauseRun();
    return;
  }
  if (e.action === "restart") { restart(); return; }
  if (e.action === "lane_left" || e.action === "lane_right" || e.action === "boost") {
    if (!playing() || ui.capturingKeys()) return;
    // Game keys must not also walk or activate the UI focus over the HUD.
    ui.setFocus(null);
    command(e.action);
  }
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  render.setActive(true);
  goTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
onSessionEnded(() => toast(t("sh.signedOut")));
platform.onProgressMerged(() => { if (app.screen === "title" && !app.overlay) goTitle(); });
let hidden = false;
onSuspend(() => {
  hidden = true;
  // A hidden window pauses the run (index.js visibilitychange).
  pauseRun();
  audio.setSuspended(true);
  platform.flush();
});
onResume(() => {
  hidden = false;
  if (app.overlay !== "pause") audio.setSuspended(false);
});

onFixedUpdate(() => {
  const s = app.session;
  if (hidden || !s || !playing()) return;
  Sess.advance(s, Rules.DT);
  handleEvents();
  if (Rules.isTerminal(s.state)) endStage();
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  if (playing() && ["lane_left", "lane_right", "boost"].some((a) => isDown(a))) ui.setFocus(null);
  applyLook();
  const hc = ui.preferences().highContrast;
  applyContrast(hc);
  render.setHighContrast(hc);
  audio.update();
  if (app.toast && app.toast.until < now()) app.toast = null;
});
onRender((alpha) => {
  hudRects.length = 0;
  drawScreens();
  pointerInput();
  const f = frame();
  const s = app.session;
  render.update(s ? s.state : null, playing() ? Math.min(1, Math.max(0, alpha)) : 0, frameDt, f.width, f.height, f.scale);
});
