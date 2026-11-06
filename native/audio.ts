// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event, a SoundBank taking an
// event's variants in turn (lane whooshes, boost, crash, finish, pads, checkpoints,
// the menu clicks). The runtime's Options own the volumes, the mute and the
// voice limit (the old Sound effects toggle); game events play on the
// "effects" bus and the menu clicks on "interface". The oscillator blips the
// browser build synthesized while a sample decoded are not ported, so a
// clip still loading is silent. Every clip starts loading at start-up (the
// mixer takes them before it runs).
import { loadClip, SoundBank } from "starhermit:audio";

const SFX_BY_EVENT: Record<string, string[]> = {
  lane: ["lane-whoosh-soft", "lane-whoosh-quick", "lane-whoosh-deep"],
  boost: ["boost-ignition", "boost-surge", "boost-roar"],
  crash: ["crash-impact", "crash-scrape", "crash-thud"],
  finish: ["finish-fanfare", "finish-chime", "finish-applause"],
  pad: ["pad-chime", "pad-charge"],
  checkpoint: ["checkpoint-blip", "checkpoint-sweep"],
  ui: ["ui-select", "ui-back"],
};
const banks = new Map<string, SoundBank>();
let suspended = false;

/** Loads every clip at once (onStart); an event whose clips are still loading is silent. */
export function loadSfx(): void {
  for (const [name, list] of Object.entries(SFX_BY_EVENT)) {
    void Promise.all(list.map((file) => loadClip(`sfx/${file}.opus`).catch((e: unknown) => { console.warn(`sfx ${file}: ${String(e)}`); return null; }))).then((loaded) => {
      const clips = loaded.filter((c) => c !== null);
      if (clips.length) banks.set(name, new SoundBank({ clips, order: "sequence", bus: name === "ui" ? "interface" : "effects" }));
    });
  }
}
/** Pause and a hidden window: no new sounds. */
export function setSuspended(on: boolean): void { suspended = on; }

/** src/audio.js playEvent(): the event's next variant. */
export function event(name: string): void {
  if (suspended) return;
  try { banks.get(name)?.play(); }
  catch { /* the mixer is full this frame: skip it */ }
}
