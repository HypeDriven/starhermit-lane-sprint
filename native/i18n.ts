// Localization: the engine's string tables (assets/strings.json, generated from
// the browser build's tables: short keys, the nine StarHermit locales, en-US
// filling gaps) in the interface language the runtime reports (the player's
// choice in Options › Language, else the account's preferred language or the
// device's). The runtime's Options replaced the game's own Language setting
// (sh-language.js) and the DOM re-labelling: every string is drawn through t()
// each frame, so a change shows on the next frame without touching the run. The
// account lines are the engine's `starhermit.*` keys.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

/** A string by key in the player's language; `{name}` placeholders from vars. */
export function t(key: string, vars?: Record<string, string | number>): string { return strings.t(key, vars); }
