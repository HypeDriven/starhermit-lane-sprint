// The look of the menus, HUD and dialogs: the browser build's css/style.css,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start with the theme the runtime's own widgets (dialogs, scroll bars) take.
// The browser build's body.high-contrast palette is a token set here, applied
// while the runtime's high-contrast option is on; the key art (title) and the
// finish illustration (results) are image backgrounds with the panel colour
// behind them while they load.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
/** style.css body.high-contrast: black panels, white muted text and borders, a yellow accent. */
const HIGH_CONTRAST: Tokens = {
  panel: "#000000", muted: "#ffffff", accent: "#ffe600", "accent-hover": "#fff066", "accent-ink": "#000000", danger: "#ff2d00",
  "panel-border": "#ffffff", btn: "#000000", "btn-hover": "#1a1a1a", "btn-border": "#ffffff", touch: "#000000", focus: "#ffe600",
  "lane-player": "#ffe60038", "boost-touch": "#000000",
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 13, headingSize: 30, padding: 8, spacing: 10, radius: 10,
    text: "#f2f7ff", muted: "#a9c0da", panel: "#081422", control: "#1a2738", hovered: "#24344a",
    pressed: "#142030", field: "#0d2135", accent: "#2fd6c8", focus: "#2fd6c8", outline: "#ffffff47",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    dialog: {
      background: "$panel", radius: 12, padding: 24, border: { width: 1, color: "$panel-border" },
      parts: { backdrop: { background: "#030a13d6" } },
    },
    scrollArea: { parts: { bar: { background: "$muted", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$ink" }, radius: 6, padding: 6 },
    // The decorative key art (title) and finish illustration (results), as the old <img>s.
    ".art-title": { background: [{ image: "assets/title-key-art.webp", size: "cover" }, "#0d2135"], radius: 12, border: { width: 1, color: "#2fd6c859" } },
    ".art-finish": { background: [{ image: "assets/results-finish.webp", size: "cover" }, "#0d2135"], radius: 12, border: { width: 1, color: "#2fd6c859" } },
  });
}

let hcKey: boolean | null = null;
/** The high-contrast tokens over the sheet's while the runtime's option is on. */
export function applyContrast(highContrast: boolean): void {
  if (hcKey === highContrast) return;
  hcKey = highContrast;
  ui.setTokens(highContrast ? { ...base, ...HIGH_CONTRAST } : base);
}
