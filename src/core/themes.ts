// Themes: a set of the app's CSS variables, a light or dark color scheme, and optional extra CSS.
// Shared by the engine (validation, storage), the CLI and the web app (preview, applying).
// No Node or DOM APIs here, so both sides can import it.

export type Scheme = "dark" | "light";

export interface Theme {
  /** Lowercase slug. Built-in ids can't be reused by custom themes. */
  id: string;
  name: string;
  scheme: Scheme;
  /** CSS custom properties, `--name` → value. */
  vars: Record<string, string>;
  /** Extra rules for the app (not for cards, which only get the variables). */
  css?: string;
  /** The theme it was made from, for reference. */
  base?: string;
}

export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_THEME_CSS = 20_000;
export const MAX_CUSTOM_THEMES = 100;
export const DEFAULT_THEME = "midnight";

/** Every variable a theme sets, grouped the way the editor shows them. */
export const THEME_GROUPS: { title: string; vars: { name: string; label: string; kind?: "color" | "length" | "font" }[] }[] = [
  {
    title: "Surfaces",
    vars: [
      { name: "--background", label: "Background" },
      { name: "--card", label: "Card" },
      { name: "--popover", label: "Popover" },
      { name: "--muted", label: "Muted" },
      { name: "--secondary", label: "Secondary" },
      { name: "--accent", label: "Hover / selected" },
    ],
  },
  {
    title: "Text",
    vars: [
      { name: "--foreground", label: "Text" },
      { name: "--card-foreground", label: "Card text" },
      { name: "--popover-foreground", label: "Popover text" },
      { name: "--muted-foreground", label: "Muted text" },
      { name: "--secondary-foreground", label: "Secondary text" },
      { name: "--accent-foreground", label: "Hover text" },
    ],
  },
  {
    title: "Controls",
    vars: [
      { name: "--primary", label: "Primary button" },
      { name: "--primary-foreground", label: "Primary button text" },
      { name: "--border", label: "Borders" },
      { name: "--input", label: "Input borders" },
      { name: "--ring", label: "Focus ring" },
      { name: "--destructive", label: "Destructive" },
    ],
  },
  {
    title: "Accent and status",
    vars: [
      { name: "--highlight", label: "Accent" },
      { name: "--success", label: "Success" },
      { name: "--warning", label: "Warning" },
      { name: "--danger", label: "Danger" },
    ],
  },
  {
    title: "Ratings",
    vars: [
      { name: "--again", label: "Again" },
      { name: "--hard", label: "Hard" },
      { name: "--good", label: "Good" },
      { name: "--easy", label: "Easy" },
    ],
  },
  {
    title: "Card states",
    vars: [
      { name: "--new", label: "New" },
      { name: "--learn", label: "Learning" },
      { name: "--review", label: "Review" },
    ],
  },
  {
    title: "Charts",
    vars: [
      { name: "--chart-1", label: "Chart 1" },
      { name: "--chart-2", label: "Chart 2" },
      { name: "--chart-3", label: "Chart 3" },
      { name: "--chart-4", label: "Chart 4" },
      { name: "--chart-5", label: "Chart 5" },
    ],
  },
  {
    title: "Sidebar",
    vars: [
      { name: "--sidebar", label: "Sidebar" },
      { name: "--sidebar-foreground", label: "Sidebar text" },
      { name: "--sidebar-accent", label: "Sidebar selected" },
      { name: "--sidebar-accent-foreground", label: "Sidebar selected text" },
      { name: "--sidebar-border", label: "Sidebar border" },
      { name: "--sidebar-primary", label: "Sidebar primary" },
      { name: "--sidebar-primary-foreground", label: "Sidebar primary text" },
      { name: "--sidebar-ring", label: "Sidebar focus ring" },
    ],
  },
  {
    title: "Shape and type",
    vars: [
      { name: "--radius", label: "Corner radius", kind: "length" },
      { name: "--font-sans", label: "Text font", kind: "font" },
      { name: "--font-mono", label: "Code font", kind: "font" },
    ],
  },
];

export const THEME_VARS = THEME_GROUPS.flatMap((g) => g.vars.map((v) => v.name));

const SANS = '"Inter", ui-sans-serif, system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, "SFMono-Regular", monospace';

/** Fills the sidebar and foreground pairs that usually just repeat other values. */
function complete(v: Record<string, string>): Record<string, string> {
  const o = { ...v };
  o["--card-foreground"] ??= o["--foreground"];
  o["--popover-foreground"] ??= o["--foreground"];
  o["--secondary-foreground"] ??= o["--foreground"];
  o["--accent-foreground"] ??= o["--foreground"];
  o["--sidebar-foreground"] ??= o["--foreground"];
  o["--sidebar-primary"] ??= o["--primary"];
  o["--sidebar-primary-foreground"] ??= o["--primary-foreground"];
  o["--sidebar-accent-foreground"] ??= o["--foreground"];
  o["--sidebar-ring"] ??= o["--ring"];
  o["--chart-1"] ??= o["--highlight"];
  o["--radius"] ??= "0.75rem";
  o["--font-sans"] ??= SANS;
  o["--font-mono"] ??= MONO;
  return o;
}

export const BUILTIN_THEMES: Theme[] = [
  {
    id: "midnight",
    name: "Midnight",
    scheme: "dark",
    vars: complete({
      "--background": "oklch(0.13 0 0)",
      "--foreground": "oklch(0.97 0 0)",
      "--card": "oklch(0.17 0 0)",
      "--popover": "oklch(0.19 0 0)",
      "--primary": "oklch(0.96 0 0)",
      "--primary-foreground": "oklch(0.18 0 0)",
      "--secondary": "oklch(0.23 0 0)",
      "--muted": "oklch(0.22 0 0)",
      "--muted-foreground": "oklch(0.68 0 0)",
      "--accent": "oklch(0.24 0 0)",
      "--destructive": "oklch(0.68 0.19 22)",
      "--border": "oklch(1 0 0 / 9%)",
      "--input": "oklch(1 0 0 / 13%)",
      "--ring": "oklch(0.6 0 0)",
      "--chart-1": "oklch(0.75 0.15 350)",
      "--chart-2": "oklch(0.72 0.12 250)",
      "--chart-3": "oklch(0.8 0.14 85)",
      "--chart-4": "oklch(0.75 0.15 150)",
      "--chart-5": "oklch(0.6 0 0)",
      "--sidebar": "oklch(0.15 0 0)",
      "--sidebar-accent": "oklch(0.22 0 0)",
      "--sidebar-border": "oklch(1 0 0 / 8%)",
      "--highlight": "oklch(0.75 0.15 350)",
      "--success": "oklch(0.78 0.16 150)",
      "--warning": "oklch(0.84 0.15 85)",
      "--danger": "oklch(0.7 0.18 22)",
      "--again": "oklch(0.7 0.18 22)",
      "--hard": "oklch(0.82 0.13 70)",
      "--good": "oklch(0.78 0.15 150)",
      "--easy": "oklch(0.74 0.12 240)",
      "--new": "oklch(0.74 0.12 240)",
      "--learn": "oklch(0.72 0.17 30)",
      "--review": "oklch(0.78 0.15 150)",
    }),
  },
  {
    id: "graphite",
    name: "Graphite",
    scheme: "dark",
    vars: complete({
      "--background": "oklch(0.2 0.006 70)",
      "--foreground": "oklch(0.94 0.012 80)",
      "--card": "oklch(0.235 0.007 70)",
      "--popover": "oklch(0.255 0.008 70)",
      "--primary": "oklch(0.93 0.014 80)",
      "--primary-foreground": "oklch(0.22 0.006 70)",
      "--secondary": "oklch(0.29 0.008 70)",
      "--muted": "oklch(0.275 0.008 70)",
      "--muted-foreground": "oklch(0.72 0.014 75)",
      "--accent": "oklch(0.3 0.009 70)",
      "--destructive": "oklch(0.68 0.16 28)",
      "--border": "oklch(0.95 0.02 80 / 10%)",
      "--input": "oklch(0.95 0.02 80 / 15%)",
      "--ring": "oklch(0.64 0.014 70)",
      "--chart-1": "oklch(0.76 0.12 15)",
      "--chart-2": "oklch(0.72 0.09 230)",
      "--chart-3": "oklch(0.8 0.11 80)",
      "--chart-4": "oklch(0.74 0.11 145)",
      "--chart-5": "oklch(0.62 0.012 70)",
      "--sidebar": "oklch(0.18 0.006 70)",
      "--sidebar-accent": "oklch(0.27 0.008 70)",
      "--sidebar-border": "oklch(0.95 0.02 80 / 8%)",
      "--highlight": "oklch(0.76 0.12 15)",
      "--success": "oklch(0.76 0.12 145)",
      "--warning": "oklch(0.82 0.12 82)",
      "--danger": "oklch(0.7 0.15 28)",
      "--again": "oklch(0.7 0.15 28)",
      "--hard": "oklch(0.8 0.11 72)",
      "--good": "oklch(0.76 0.12 145)",
      "--easy": "oklch(0.74 0.09 235)",
      "--new": "oklch(0.74 0.09 235)",
      "--learn": "oklch(0.73 0.13 45)",
      "--review": "oklch(0.76 0.12 145)",
    }),
  },
  {
    // For older or cheap panels (TN, poor gamma) that crush near-black shades together: a mid-dark
    // slate base, surfaces a visible step apart, borders strong enough to survive the panel.
    id: "dusk",
    name: "Dusk",
    scheme: "dark",
    vars: complete({
      "--background": "oklch(0.31 0.012 255)",
      "--foreground": "oklch(0.96 0.005 255)",
      "--card": "oklch(0.45 0.015 255)",
      "--popover": "oklch(0.42 0.015 255)",
      "--primary": "oklch(0.95 0.006 255)",
      "--primary-foreground": "oklch(0.26 0.012 255)",
      "--secondary": "oklch(0.47 0.016 255)",
      "--muted": "oklch(0.41 0.014 255)",
      "--muted-foreground": "oklch(0.82 0.012 255)",
      "--accent": "oklch(0.48 0.017 255)",
      "--destructive": "oklch(0.74 0.17 22)",
      "--border": "oklch(0.97 0.01 255 / 24%)",
      "--input": "oklch(0.97 0.01 255 / 40%)",
      "--ring": "oklch(0.78 0.02 255)",
      "--chart-1": "oklch(0.8 0.15 350)",
      "--chart-2": "oklch(0.8 0.12 240)",
      "--chart-3": "oklch(0.86 0.14 85)",
      "--chart-4": "oklch(0.82 0.15 150)",
      "--chart-5": "oklch(0.72 0.01 255)",
      "--sidebar": "oklch(0.265 0.012 255)",
      "--sidebar-accent": "oklch(0.38 0.015 255)",
      "--sidebar-border": "oklch(0.97 0.01 255 / 16%)",
      "--highlight": "oklch(0.8 0.15 350)",
      "--success": "oklch(0.83 0.16 150)",
      "--warning": "oklch(0.87 0.14 85)",
      "--danger": "oklch(0.76 0.17 22)",
      "--again": "oklch(0.76 0.17 22)",
      "--hard": "oklch(0.86 0.13 70)",
      "--good": "oklch(0.83 0.16 150)",
      "--easy": "oklch(0.8 0.12 240)",
      "--new": "oklch(0.8 0.12 240)",
      "--learn": "oklch(0.8 0.15 40)",
      "--review": "oklch(0.83 0.16 150)",
    }),
  },
  {
    id: "contrast",
    name: "High contrast",
    scheme: "dark",
    vars: complete({
      "--background": "oklch(0 0 0)",
      "--foreground": "oklch(1 0 0)",
      "--card": "oklch(0.1 0 0)",
      "--popover": "oklch(0.13 0 0)",
      "--primary": "oklch(1 0 0)",
      "--primary-foreground": "oklch(0 0 0)",
      "--secondary": "oklch(0.22 0 0)",
      "--muted": "oklch(0.17 0 0)",
      "--muted-foreground": "oklch(0.86 0 0)",
      "--accent": "oklch(0.26 0 0)",
      "--destructive": "oklch(0.74 0.2 25)",
      "--border": "oklch(1 0 0 / 38%)",
      "--input": "oklch(1 0 0 / 50%)",
      "--ring": "oklch(0.97 0 0)",
      "--chart-1": "oklch(0.82 0.17 350)",
      "--chart-2": "oklch(0.8 0.13 240)",
      "--chart-3": "oklch(0.9 0.16 95)",
      "--chart-4": "oklch(0.85 0.18 150)",
      "--chart-5": "oklch(0.75 0 0)",
      "--sidebar": "oklch(0.07 0 0)",
      "--sidebar-accent": "oklch(0.24 0 0)",
      "--sidebar-border": "oklch(1 0 0 / 32%)",
      "--highlight": "oklch(0.82 0.17 350)",
      "--success": "oklch(0.85 0.18 150)",
      "--warning": "oklch(0.9 0.16 95)",
      "--danger": "oklch(0.76 0.2 25)",
      "--again": "oklch(0.76 0.2 25)",
      "--hard": "oklch(0.88 0.15 75)",
      "--good": "oklch(0.85 0.18 150)",
      "--easy": "oklch(0.82 0.13 235)",
      "--new": "oklch(0.82 0.13 235)",
      "--learn": "oklch(0.8 0.16 45)",
      "--review": "oklch(0.85 0.18 150)",
      "--radius": "0.5rem",
    }),
  },
  {
    id: "daylight",
    name: "Daylight",
    scheme: "light",
    vars: complete({
      "--background": "oklch(0.985 0 0)",
      "--foreground": "oklch(0.18 0 0)",
      "--card": "oklch(1 0 0)",
      "--popover": "oklch(1 0 0)",
      "--primary": "oklch(0.2 0 0)",
      "--primary-foreground": "oklch(0.985 0 0)",
      "--secondary": "oklch(0.95 0 0)",
      "--muted": "oklch(0.955 0 0)",
      "--muted-foreground": "oklch(0.47 0 0)",
      "--accent": "oklch(0.94 0 0)",
      "--destructive": "oklch(0.56 0.21 25)",
      "--border": "oklch(0 0 0 / 10%)",
      "--input": "oklch(0 0 0 / 15%)",
      "--ring": "oklch(0.55 0 0)",
      "--chart-1": "oklch(0.62 0.2 355)",
      "--chart-2": "oklch(0.58 0.14 250)",
      "--chart-3": "oklch(0.7 0.15 75)",
      "--chart-4": "oklch(0.6 0.15 150)",
      "--chart-5": "oklch(0.65 0 0)",
      "--sidebar": "oklch(0.97 0 0)",
      "--sidebar-accent": "oklch(0.925 0 0)",
      "--sidebar-border": "oklch(0 0 0 / 8%)",
      "--highlight": "oklch(0.6 0.2 355)",
      "--success": "oklch(0.55 0.15 150)",
      "--warning": "oklch(0.64 0.15 70)",
      "--danger": "oklch(0.56 0.2 25)",
      "--again": "oklch(0.56 0.2 25)",
      "--hard": "oklch(0.62 0.15 60)",
      "--good": "oklch(0.55 0.15 150)",
      "--easy": "oklch(0.54 0.14 245)",
      "--new": "oklch(0.54 0.14 245)",
      "--learn": "oklch(0.6 0.17 38)",
      "--review": "oklch(0.55 0.15 150)",
    }),
  },
  {
    id: "paper",
    name: "Paper",
    scheme: "light",
    vars: complete({
      "--background": "oklch(0.955 0.018 85)",
      "--foreground": "oklch(0.27 0.025 60)",
      "--card": "oklch(0.975 0.013 85)",
      "--popover": "oklch(0.98 0.012 85)",
      "--primary": "oklch(0.32 0.03 60)",
      "--primary-foreground": "oklch(0.97 0.015 85)",
      "--secondary": "oklch(0.92 0.022 80)",
      "--muted": "oklch(0.925 0.02 80)",
      "--muted-foreground": "oklch(0.5 0.03 65)",
      "--accent": "oklch(0.905 0.025 80)",
      "--destructive": "oklch(0.54 0.17 30)",
      "--border": "oklch(0.35 0.04 60 / 14%)",
      "--input": "oklch(0.35 0.04 60 / 22%)",
      "--ring": "oklch(0.55 0.04 65)",
      "--chart-1": "oklch(0.56 0.14 15)",
      "--chart-2": "oklch(0.54 0.09 235)",
      "--chart-3": "oklch(0.66 0.12 75)",
      "--chart-4": "oklch(0.55 0.11 145)",
      "--chart-5": "oklch(0.62 0.03 70)",
      "--sidebar": "oklch(0.935 0.022 82)",
      "--sidebar-accent": "oklch(0.895 0.027 80)",
      "--sidebar-border": "oklch(0.35 0.04 60 / 11%)",
      "--highlight": "oklch(0.55 0.15 15)",
      "--success": "oklch(0.52 0.12 145)",
      "--warning": "oklch(0.6 0.13 70)",
      "--danger": "oklch(0.54 0.17 30)",
      "--again": "oklch(0.54 0.17 30)",
      "--hard": "oklch(0.6 0.12 62)",
      "--good": "oklch(0.52 0.12 145)",
      "--easy": "oklch(0.52 0.1 240)",
      "--new": "oklch(0.52 0.1 240)",
      "--learn": "oklch(0.57 0.14 42)",
      "--review": "oklch(0.52 0.12 145)",
      "--radius": "0.625rem",
    }),
  },
];

export const builtinTheme = (id: string) => BUILTIN_THEMES.find((t) => t.id === id);

export class ThemeError extends Error {}

const VAR_NAME = /^--[a-z][a-z0-9-]{0,63}$/;
/** Another host or scheme: `https:`, `//cdn`, `javascript:`. Inline `data:` and same-origin paths are fine. */
const isRemote = (target: string) => {
  const t = target.trim().replace(/^['"]|['"]$/g, "").trim();
  return !/^data:/i.test(t) && /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\)/i.test(t);
};

/** Decodes CSS escapes (`\75 rl(` is `url(`) so checks see what the browser sees. */
const unescapeCss = (s: string) =>
  s.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff) || 0xfffd)).replace(/\\(.)/g, "$1");

/** Removes `@import`s and `url()` / `src()` / `image-set()` references to other hosts. */
export function sanitizeCss(css: string): { css: string; removed: string[] } {
  const removed: string[] = [];
  const drop = (m: string, repl = "") => {
    removed.push(m.trim().slice(0, 120));
    return repl;
  };
  let out = css.replace(/\/\*[\s\S]*?\*\//g, (m) => (/@import|url\s*\(|src\s*\(|image-set/i.test(m) ? "" : m));
  out = out.replace(/@import\b[^;]*;?/gi, (m) => drop(m));
  out = out.replace(/\b(url|src)\s*\(\s*("[^"]*"|'[^']*'|[^)]*)\s*\)/gi, (m, _fn, target: string) => (isRemote(target) ? drop(m, "none") : m));
  out = out.replace(/image-set\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi, (m, inner: string) =>
    (inner.match(/"[^"]*"|'[^']*'/g) ?? []).some(isRemote) ? drop(m, "none") : m,
  );
  // Escapes can spell an import or a remote url that the patterns above don't see; refuse those outright.
  const plain = unescapeCss(out);
  if (plain !== out && (/@import/i.test(plain) || /\b(?:url|src)\s*\(\s*['"]?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(plain.replace(/\b(?:url|src)\s*\(\s*['"]?\s*data:/gi, "")))) {
    throw new ThemeError("extra CSS uses escapes to load something from another host; write it plainly");
  }
  return { css: out.trim(), removed };
}

function cleanValue(name: string, raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") throw new ThemeError(`${name}: value must be a string`);
  const v = String(raw).trim();
  if (!v) throw new ThemeError(`${name}: empty value`);
  if (v.length > 300) throw new ThemeError(`${name}: value is too long`);
  if (/[;{}<>\\]/.test(v)) throw new ThemeError(`${name}: value can't contain ; { } < > or \\`);
  if (/url\s*\(|image-set|@import/i.test(v)) throw new ThemeError(`${name}: images and imports aren't allowed in variables`);
  return v;
}

/**
 * Checks and normalizes a theme: a valid id and name, a scheme, every known variable present
 * (missing ones come from the base theme, or Midnight/Daylight for the scheme), clean values and CSS.
 */
export function normalizeTheme(input: unknown): { theme: Theme; removed: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ThemeError("a theme must be an object");
  const t = input as Record<string, unknown>;
  const id = String(t.id ?? "").trim();
  if (!THEME_ID.test(id)) throw new ThemeError(`theme id must be a lowercase slug (a-z, 0-9, -), got "${id}"`);
  const name = String(t.name ?? id).trim().slice(0, 60) || id;
  const scheme: Scheme = t.scheme === "light" ? "light" : t.scheme === "dark" || t.scheme == null ? "dark" : (() => {
    throw new ThemeError(`scheme must be "dark" or "light"`);
  })();
  const baseId = typeof t.base === "string" && builtinTheme(t.base) ? t.base : undefined;
  const fallback = builtinTheme(baseId ?? "")?.scheme === scheme ? builtinTheme(baseId!)! : builtinTheme(scheme === "light" ? "daylight" : "midnight")!;
  const rawVars = t.vars ?? {};
  if (typeof rawVars !== "object" || Array.isArray(rawVars)) throw new ThemeError("vars must be an object of --name: value");
  const vars: Record<string, string> = { ...fallback.vars };
  const extra = Object.entries(rawVars as Record<string, unknown>);
  if (extra.length > 200) throw new ThemeError("too many variables (200 at most)");
  for (const [k0, v] of extra) {
    const k = k0.startsWith("--") ? k0 : `--${k0}`;
    if (!VAR_NAME.test(k)) throw new ThemeError(`bad variable name "${k0}"`);
    vars[k] = cleanValue(k, v);
  }
  const rawCss = t.css == null ? "" : String(t.css);
  if (rawCss.length > MAX_THEME_CSS) throw new ThemeError(`extra CSS is ${rawCss.length.toLocaleString("en")} characters; the limit is ${MAX_THEME_CSS.toLocaleString("en")}`);
  const { css, removed } = sanitizeCss(rawCss);
  const theme: Theme = { id, name, scheme, vars };
  if (css) theme.css = css;
  if (typeof t.base === "string" && t.base) theme.base = t.base.slice(0, 64);
  return { theme, removed };
}

/** The stylesheet for a theme. `html:root` beats the app's own `:root` defaults wherever they load. */
export function themeCss(t: Theme): string {
  const vars = Object.entries(t.vars)
    .filter(([k]) => VAR_NAME.test(k))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `html:root {\n${vars}\n  color-scheme: ${t.scheme};\n}\n${t.css ? `\n${t.css}\n` : ""}`;
}

/** A free id based on `want`, avoiding built-ins and `taken`. */
export function freeThemeId(want: string, taken: Iterable<string>): string {
  const used = new Set([...BUILTIN_THEMES.map((t) => t.id), ...taken]);
  const base = (want.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "theme").slice(0, 56);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** What `theme export` writes and `theme import` reads. */
export function exportTheme(t: Theme) {
  return { etudeTheme: 1, ...structuredClone(t) };
}

/** Accepts an exported file, a bare theme, or `{ theme: {...} }`. */
export function parseThemeFile(data: unknown): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (d.theme && typeof d.theme === "object") return d.theme;
    const { etudeTheme: _v, ...rest } = d;
    return rest;
  }
  throw new ThemeError("not a theme file");
}
