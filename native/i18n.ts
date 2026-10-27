// Localization: the browser build's string tables (src/i18n.js: short keys,
// the nine StarHermit locales, en-US filling gaps) in the interface language
// the runtime reports (preferences().language: the player's choice in
// Options › Language, else the account's preferred language or the
// device's). The runtime's Options replaced the game's own Language setting
// (sh-language.js) and the DOM re-labelling: every string is drawn through
// t() each frame, so a change shows on the next frame without touching the run.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import * as I18n from "../src/i18n.js";

const api = I18n as unknown as {
  LOCALES: { id: string }[];
  setLocale(id: string): string;
  t(key: string, params?: Record<string, string | number>): string;
};
export const LOCALES = api.LOCALES.map((l) => l.id);

/** The shipped locale nearest a BCP 47 tag (en-GB, es-ES and fr-CA by region; es-MX → es-419). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US");
  const exact = LOCALES.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const [lang = "", region = ""] = s.toLowerCase().split("-");
  if (lang === "en") return ["gb", "uk", "ie", "au", "nz", "za", "in"].includes(region) ? "en-GB" : "en-US";
  if (lang === "es") return region === "es" ? "es-ES" : "es-419";
  if (lang === "fr") return region === "ca" ? "fr-CA" : "fr-FR";
  return ({ de: "de-DE", pt: "pt-BR", it: "it-IT" } as Record<string, string>)[lang] ?? "en-US";
}

let locale = "en-US";
/** A string by key in the player's language; `{name}` placeholders from vars. */
export function t(key: string, vars?: Record<string, string | number>): string { return api.t(key, vars); }

function apply(tag: string): void {
  locale = api.setLocale(pickLocale(tag));
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => { if (pickLocale(p.language) !== locale) apply(p.language); });
export function currentLocale(): string { return locale; }
