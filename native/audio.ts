// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event, round-robin among an
// event's variants (lane whooshes, boost, crash, finish, pads, checkpoints,
// the menu clicks). The runtime's Options own the volumes, the mute and the
// voice limit (the old Sound effects toggle); game events play on the
// "effects" bus and the menu clicks on "interface". The oscillator blips the
// browser build synthesized while a sample decoded are not ported (a live
// synthesis graph makes clip loads fail on the engine's web runtime), so a
// clip still loading is silent. Every clip starts loading at start-up (the
// mixer takes them before it runs).
import { loadClip, play as playClip, type AudioClip } from "starhermit:audio";

const SFX_BY_EVENT: Record<string, string[]> = {
  lane: ["lane-whoosh-soft", "lane-whoosh-quick", "lane-whoosh-deep"],
  boost: ["boost-ignition", "boost-surge", "boost-roar"],
  crash: ["crash-impact", "crash-scrape", "crash-thud"],
  finish: ["finish-fanfare", "finish-chime", "finish-applause"],
  pad: ["pad-chime", "pad-charge"],
  checkpoint: ["checkpoint-blip", "checkpoint-sweep"],
  ui: ["ui-select", "ui-back"],
};
const clips = new Map<string, AudioClip>();
const cursor = new Map<string, number>();
let suspended = false;

/** Loads every clip at once (onStart); a cue whose clip is still loading is skipped. */
export function loadSfx(): void {
  for (const list of Object.values(SFX_BY_EVENT)) for (const name of list) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
}
/** Pause and a hidden window: no new sounds. */
export function setSuspended(on: boolean): void { suspended = on; }

/** src/audio.js playEvent(): the event's next variant that has loaded. */
export function event(name: string): void {
  const names = SFX_BY_EVENT[name];
  if (!names || suspended) return;
  const start = (cursor.get(name) ?? 0) % names.length;
  cursor.set(name, start + 1);
  for (let i = 0; i < names.length; i++) {
    const file = names[(start + i) % names.length]!;
    const clip = clips.get(file);
    if (!clip) continue;
    try { playClip(clip, { bus: name === "ui" ? "interface" : "effects" }); }
    catch { /* the mixer is full this frame: skip it */ }
    return;
  }
}
