// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (src/progress.js: the furthest unlocked stage, the best score
//   per stage and per Daily date) is the game's save (starhermit:storage
//   `saves`) on the device and in the player's cloud slot; two devices'
//   copies merge on a conflict (src/progress.js merge: the best of each, as
//   the browser build's saveconflict merge). The slot the browser build wrote
//   (the JS SDK's writeSave of its whole store document as JSON under
//   game:<slug>) shows as foreign: it is merged in and replaced once;
// - the browser build's own options (reduced motion, high contrast, sound,
//   graphics) and its account settings KV mirror of them are the runtime's
//   Options now: the old KV keys (and the language helper's ui.language) are
//   removed;
// - the player (signed in or a guest) and their avatar, the invite link, the
//   platform's clock for the Daily, and posting a finished run's total
//   through score-script.js (a practice session whose socket carries
//   { type: 'result', scores }, as the JS SDK's submitScores did) with the
//   rank on the high-score board.
import type { JsonValue } from "starhermit:engine";
import {
  avatar as fetchAvatar, connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions,
  type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store } from "starhermit:storage";
import type { ImageBitmap } from "starhermit:canvas";
import { Prog, type Progress } from "./game.ts";

export type { Progress };

// --- the progress save ------------------------------------------------------------------
let live: Progress = Prog.normalize(null);
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

/** The live progress document (runs update it in place, then saveNow()). */
export function progress(): Progress { return live; }
/** Saves the progress (device at once, the account debounced by the runtime). */
export function saveNow(opts: { replaceForeign?: boolean } = {}): void {
  try { saves.save(live as unknown as JsonValue, { schema: 1, ...opts }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
/** Merges another copy into the live document (and saves); whether anything changed. */
function adopt(other: unknown): boolean {
  const next = Prog.merge(live, other);
  if (JSON.stringify(next) === JSON.stringify(live)) return false;
  live.highestStage = next.highestStage;
  live.bestScores = next.bestScores;
  live.dailyBest = next.dailyBest;
  saveNow();
  return true;
}
saves.onConflict((local, remote) => ({ merged: Prog.merge(local?.data ?? null, remote.data) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud save: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const doc = Prog.readForeign(old.text);
  const changed = doc ? adopt(doc) : false;
  saveNow({ replaceForeign: true });
  if (changed) merged();
}

/** For the title's player line: local (a guest) | saving | synced | error. */
export function syncState(): "local" | "saving" | "synced" | "error" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// The browser build mirrored its options into the account's settings KV
// (reducedMotion, highContrast, sound, graphics) and the language helper kept
// ui.language there: all are the runtime's Options now, so they are removed.
export const BROWSER_KEYS = ["reducedMotion", "highContrast", "sound", "graphics", "ui.language"];
function removeLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const key of keys) if (BROWSER_KEYS.includes(key)) store.removeLegacy(key);
}

/** Reads the device's save (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  live = Prog.normalize(cur?.data ?? null);
  store.onLegacy(removeLegacy);
  removeLegacy();
  if (saves.state() === "foreign") migrateForeign();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player, the avatar and the clock ------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
let avatarImage: ImageBitmap | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
/** The signed-in player's avatar once loaded, else null. */
export function avatarBitmap(): ImageBitmap | null { return player() ? avatarImage : null; }
function refreshPlayer(): void {
  invite = null;
  avatarImage = null;
  board = undefined;
  const me = player();
  if (!me) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
  fetchAvatar(me.userId).then((b) => { if (player()?.userId === me.userId) avatarImage = b; }, () => undefined);
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's (the Daily's day). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// --- the high-score board ------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? null;
  return board;
}

/** Signed in only: post a finished run's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
