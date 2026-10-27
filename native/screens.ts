// The browser build's semantic HTML shell (src/ui.js + css/style.css) as
// starhermit:ui, built every frame over the road: the title (name, tagline,
// the signed-in player line with avatar and cloud-save status, the key art,
// Play stage n / Daily challenge / Practice stage 1 / How to play / Settings
// / Invite / Sign in), How to play, Settings (the runtime's Options and key
// bindings), the run's HUD (stage, score, speed, the boost pill, the player
// and sync badge, the pause button, the progress bar and the three-lane
// hazard mirror), the Left / Boost / Right tray, the pause and results panels
// (the score breakdown, time and best, the leaderboard line, new best) and
// the account toast. The browser's media queries are layouts picked by the
// window's logical size: phone (≤ 520 px wide: tighter HUD, smaller panel
// padding), short (≤ 620 px tall: no key art), desktop pointer (slimmer tray).
import { frame, openMenu } from "starhermit:engine";
import { requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Prog, Rules } from "./game.ts";
import { t } from "./i18n.ts";
import * as platform from "./platform.ts";
import {
  app, back, command, copyInvite, hudRects, keysFor, leaderboardLine, nextStage, openPage, pauseRun, playDaily, playNext, playPractice,
  playing, progress, quit, restart, resumeRun, signIn, stageLabel, touchOnly,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; phone: boolean; short: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, phone: lw <= 520, short: lh <= 620 };
}
const lastSize = new Map<string, number>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
interface Btn { id: string; text: string; style?: string; act: () => void }
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 4;
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  const s: ui.Style = width != null ? { width } : {};
  if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 40);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(style, s).id(b.id).button(b.text, opts) && frame().frame !== app.openedFrame) b.act();
}
/** Buttons at their own widths in rows that wrap at `width` (style.css .menu: flex-wrap, gap 10). */
function flow(label: string, list: Btn[], width: number, gap = 10): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b.text, b.style ?? "btn"));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b.text, b.style ?? "btn") > width ? width : null);
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "body", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: string, text: string, width: number, id?: string): void {
  if (textWidth(text, cls, "heading") <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  if (app.screen === "game") gameScreen(L);
  else {
    // style.css #overlay: the dark wash over the attract scene (or the paused run).
    if (app.under === "game" && app.screen !== "title") hud(L, false);
    wash(L);
    switch (app.screen) {
      case "title": page("title", L, titleScreen); break;
      case "help": page("help", L, helpScreen); break;
      case "settings": page("settings", L, settingsScreen); break;
    }
  }
  toast(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

/** style.css #overlay: the dark wash over the scene and the HUD (a placed widget, so it covers the HUD's widgets too). */
function wash(L: Layout): void {
  const f = frame();
  ui.place("wash", { anchor: "top-start", x: -f.safeArea.left / L.sc, y: -f.safeArea.top / L.sc }, () => {
    ui.widget("", { role: "none", size: { width: f.width / L.sc, height: f.height / L.sc }, draw: () => draw.box(0, 0, f.width, f.height, "overlay") });
  });
}
/** A panel (style.css .screen): centred, at most 560 px wide, scrolling inside when taller than the window. */
function page(key: string, L: Layout, build: (w: number, L: Layout) => void): void {
  const pad = L.phone ? 18 : L.lh <= 500 ? 14 : 24;
  const outer = Math.min(560, L.lw - 32);
  const avail = Math.max(80, L.lh - (L.lh <= 500 ? 16 : 32));
  const h = lastSize.get(key) ?? 0;
  const scroll = h > avail;
  const inner = outer - 2 * pad - (scroll ? 14 : 0);
  const fresh = frame().frame - app.openedFrame <= 5;
  ui.place(`page-${key}`, "center", () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => build(inner, L), { style: "panel", width: outer - (scroll ? 14 : 0), spacing: L.lh <= 500 ? 6 : 12, padding: pad });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, fresh ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
}
function art(cls: string, w: number, aspect: number): void {
  const aw = Math.min(w, 460);
  ui.style(cls).widget("", { role: "image", size: { width: aw, height: aw / aspect } });
}

// ------------------------------------------------------------------ title, help, settings
const SYNC: Record<string, { key: string; cls: string }> = {
  synced: { key: "syncSynced", cls: "sync-synced" }, saving: { key: "syncSaving", cls: "player-line" },
  error: { key: "syncError", cls: "sync-error" }, local: { key: "syncOffline", cls: "player-line" },
};
function playerLine(w: number): void {
  if (!platform.signedIn()) return;
  const sync = SYNC[platform.syncState()]!;
  ui.row("player-row", () => {
    const av = platform.avatarBitmap();
    if (av) ui.widget("", { role: "image", size: { width: 20, height: 20 }, draw: (r) => draw.image(av, r.x, r.y, r.width, r.height) });
    const name = platform.displayName();
    if (name) para(t("playingAs", { name }), Math.max(60, w - 200), "player-line", "player-name");
    ui.style(sync.cls).id("sync-badge").label(t(sync.key));
  }, { spacing: 6, align: "center" });
}
function titleScreen(w: number, L: Layout): void {
  heading(w < 360 ? "title-small" : "title", t("title"), w, "title-h");
  para(t("tagline"), w, "tagline", "tagline");
  playerLine(w);
  if (!L.short && !ui.preferences().highContrast) art("art-title", w, 16 / 9);
  const list = [
    { id: "btn-play", text: t("play", { n: Prog.nextStage(progress()) }), style: "btn-primary", act: playNext },
    { id: "btn-daily", text: t("daily"), act: playDaily },
    { id: "btn-practice", text: t("practice"), act: playPractice },
    { id: "btn-help", text: t("help"), act: () => openPage("help") },
    { id: "btn-settings", text: t("settings"), act: () => openPage("settings") },
  ];
  if (platform.inviteLink()) list.push({ id: "btn-invite", text: t("sh.invite"), act: copyInvite });
  if (!platform.signedIn()) list.push({ id: "btn-signin", text: t("sh.signIn"), act: signIn });
  flow("title-menu", list, w);
}
function helpScreen(w: number): void {
  heading("h2", t("help"), w, "help-h");
  para(t("helpBody"), w, "body", "help-body");
  heading("h3", t("helpControls"), w, "help-controls");
  para(t("helpKeys", {
    left: keysFor("lane_left"), right: keysFor("lane_right"), boost: keysFor("boost"), pause: keysFor("pause"), restart: keysFor("restart"),
  }), w, "body", "help-keys");
  para(t("helpTouch"), w, "body", "help-touch");
  para(t("helpPad"), w, "body", "help-pad");
  flow("help-nav", [{ id: "btn-back", text: t("back"), style: "btn-primary", act: back }], w);
}
function settingsScreen(w: number): void {
  heading("h2", t("settings"), w, "settings-h");
  para(t("optionsNote"), w, "body", "options-note");
  flow("settings-btns", [
    { id: "btn-options", text: t("openOptions"), act: () => openMenu() },
    { id: "btn-rebind", text: t("keyBindings"), act: () => requestRebind() },
  ], w);
  flow("settings-nav", [{ id: "btn-back", text: t("back"), style: "btn-primary", act: back }], w);
}

// ------------------------------------------------------------------ the HUD
function rect(r: { x: number; y: number; width: number; height: number }): void { hudRects.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }
function boostView(): { label: string; state: "ready" | "cooldown" | "active" } {
  const s = app.session!.state;
  if (s.boostActive) return { label: t("boostActive"), state: "active" };
  const remain = s.boostReadyAt - s.elapsed;
  if (remain > 0) return { label: t("boostCooldown", { s: Math.ceil(remain) }), state: "cooldown" };
  return { label: t("boostReady"), state: "ready" };
}
/** Lanes with traffic inside the reaction window, for the HUD mirror (index.js hazardLanes). */
function hazardLanes(): number[] {
  const st = app.session!.state;
  const out: number[] = [];
  for (const car of st.traffic) {
    const gap = car.z - st.position;
    if (gap > 0 && gap < 55 && !out.includes(car.lane)) out.push(car.lane);
  }
  return out;
}
function item(id: string, label: string | null, value: string, cls: string): void {
  ui.column(id, () => {
    if (label) ui.style("hud-label").label(label);
    ui.style(cls).id(`${id}-v`).label(value);
  }, { spacing: 0 });
}
/** style.css #hud: the status row, the progress bar and the lane mirror over a top gradient. */
function hud(L: Layout, interactive: boolean): void {
  const s = app.session;
  if (!s || !app.stage) return;
  const st = s.state;
  const f = frame();
  const padX = 12;
  const w = Math.min(1100, L.lw - 2 * padX);
  const bv = boostView();
  const hz = hazardLanes();
  const r = (): void => {
    ui.place("hud", { anchor: "top", y: 8 }, () => ui.column("hud-col", () => {
      const row = (): void => {
        item("hud-stage", t("stageLabel"), stageLabel(app.stage!), "hud-value");
        item("hud-score", t("score"), String(Rules.scoreBreakdown(st).total), "hud-score");
        item("hud-speed", t("speed"), `${Math.round(st.speed * 3.6)} km/h`, L.phone ? "hud-value-small" : "hud-value");
        ui.column("hud-boost", () => ui.style(`boost-text-${bv.state}`).id("hud-boost-v").label(bv.label), { style: `boost-${bv.state}` });
        if (platform.signedIn()) {
          const sync = SYNC[platform.syncState()]!;
          ui.column("hud-player", () => {
            ui.style("hud-label").label(t("player"));
            ui.style("hud-player").label(platform.displayName() || "—");
            ui.style(sync.cls).label(t(sync.key));
          }, { spacing: 0 });
        }
      };
      ui.row("hud-row", () => {
        ui.row("hud-items", row, { spacing: L.phone ? 10 : 16, align: "center" });
        ui.spacer();
        if (interactive) {
          const pr = ui.style("btn").id("btn-pause").button(t("pause"));
          if (pr && frame().frame !== app.openedFrame) { ui.setFocus(null); pauseRun(); }
        }
      }, { width: w, align: "center" });
      const pct = Rules.progressPct(st);
      ui.widget(t("progress"), {
        role: "meter", size: { width: w, height: 8 }, value: Math.round(pct), min: 0, max: 100,
        draw: (rr, ws) => {
          draw.roundRect(rr.x, rr.y, rr.width, rr.height, 4, ws.highContrast ? "#ffffff66" : "#ffffff2e");
          if (pct > 0) draw.roundRect(rr.x, rr.y, Math.max(rr.height, rr.width * pct / 100), rr.height, 4, ws.highContrast ? "#ffe600" : "#2fd6c8");
        },
      });
      const cw = Math.min(320, w);
      ui.row("hud-lanes", () => {
        for (let i = 0; i < Rules.LANE_COUNT; i++) {
          const me = i === st.lane, danger = hz.includes(i);
          const kind = me ? "player" : danger ? "hazard" : "";
          const text = `${i + 1}${me ? " ▲" : ""}${danger ? " ✕" : ""}`;
          ui.column(`lane-${i}`, () => ui.style(kind ? `lane-text-${kind}` : "lane-text").label(text),
            { style: me ? "lane-player" : danger ? "lane-hazard" : "lane-cell", width: (cw - 12) / 3, align: "center" });
        }
      }, { spacing: 6, width: cw });
    }, { spacing: 8, width: w, align: "center" }));
  };
  draw.box(0, 0, f.width, Math.min(f.height, (L.phone ? 150 : 120) * L.sc + f.safeArea.top), "hud-shade");
  r();
  if (interactive) rect({ x: 0, y: 0, width: f.width, height: (L.phone ? 130 : 110) * L.sc + f.safeArea.top });
}
/** style.css #touch-controls: Left / Boost / Right at the bottom thumb zone (slimmer with a mouse). */
function tray(L: Layout): void {
  const fine = !touchOnly();
  const gap = 12;
  const maxW = fine ? 150 : 180;
  const bw = Math.min(maxW, (L.lw - 24 - 2 * gap) / 3);
  const h = fine ? 48 : 60;
  const btns: [string, string, "lane_left" | "boost" | "lane_right", string][] = [
    ["btn-left", `◀ ${t("left")}`, "lane_left", "btn-touch"],
    ["btn-boost", t("boost"), "boost", "btn-boost"],
    ["btn-right", `${t("right")} ▶`, "lane_right", "btn-touch"],
  ];
  ui.place("tray", { anchor: "bottom", y: 12 }, () => ui.row("tray-row", () => {
    for (const [id, text, action, cls] of btns) {
      const style = ui.style(cls, { width: bw, minHeight: h });
      if (style.id(id).button(text) && frame().frame !== app.openedFrame) { ui.setFocus(null); command(action); }
    }
  }, { spacing: gap }));
  const f = frame();
  const trayH = (h + 12) * L.sc + f.safeArea.bottom;
  rect({ x: 0, y: f.height - trayH - 4 * L.sc, width: f.width, height: trayH + 4 * L.sc });
}

function gameScreen(L: Layout): void {
  if (!app.session) return;
  const live = playing();
  hud(L, live);
  if (live) tray(L);
  if (app.overlay === "pause") { wash(L); page("pause", L, pausePanel); }
  else if (app.overlay === "results" && app.results) { wash(L); page("results", L, resultsPanel); }
}

// ------------------------------------------------------------------ pause and results
function pausePanel(w: number): void {
  heading("h2", t("paused"), w, "pause-h");
  flow("pause-menu", [
    { id: "btn-resume", text: t("resume"), style: "btn-primary", act: resumeRun },
    { id: "btn-restart", text: t("restart"), act: restart },
    { id: "btn-help", text: t("help"), act: () => openPage("help") },
    { id: "btn-settings", text: t("settings"), act: () => openPage("settings") },
    { id: "btn-quit", text: t("quit"), act: quit },
  ], w);
}
function resultsPanel(w: number, L: Layout): void {
  const r = app.results!;
  heading("h2", r.finished ? t("finished") : t("crashed"), w, "results-h");
  if (r.finished && !L.short && !ui.preferences().highContrast) art("art-finish", w, 1024 / 346);
  const rows: [string, number][] = [
    [t("breakdownDistance"), r.breakdown.distance], [t("breakdownPasses"), r.breakdown.passes], [t("breakdownPads"), r.breakdown.pads],
    [t("breakdownTime"), r.breakdown.timeBonus], [t("breakdownFinish"), r.breakdown.finishBonus], [t("breakdownTotal"), r.breakdown.total],
  ];
  ui.column("breakdown", () => rows.forEach(([k, v], i) => {
    const total = i === rows.length - 1;
    ui.row(`bd-${i}`, () => {
      para(k, w - 90, total ? "dt-total" : "dt");
      ui.spacer();
      ui.style(total ? "dd-total" : "dd").id(`bd-${i}-v`).label(String(v));
    }, { width: w, align: "center", style: "row-rule" });
  }), { spacing: 0, width: w });
  para(`${t("elapsed")}: ${r.elapsed.toFixed(1)}s · ${t("best")}: ${r.best}`, w, "body", "results-meta");
  const lb = leaderboardLine();
  if (lb) para(lb, w, "body", "results-lb");
  if (r.newBest) para(t("newBest"), w, "new-best", "results-new-best");
  const list: { id: string; text: string; style?: string; act: () => void }[] = [];
  const next = r.finished && r.hasNextStage;
  if (next) list.push({ id: "btn-results-first", text: t("nextStage"), style: "btn-primary", act: nextStage });
  list.push({ id: next ? "btn-retry" : "btn-results-first", text: t("retry"), style: next ? "btn" : "btn-primary", act: restart });
  list.push({ id: "btn-quit", text: t("quit"), act: quit });
  flow("results-menu", list, w);
}

// ------------------------------------------------------------------ the toast
function toast(L: Layout): void {
  const tt = app.toast;
  if (!tt) return;
  const w = Math.min(L.lw - 32, 520);
  ui.place("toast", { anchor: "bottom", y: 16 }, () => ui.column("toast-col", () => para(tt.text, w - 32, "toast-text", "toast-text"), { style: "toast", align: "center" }));
}
