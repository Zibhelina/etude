import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_THEMES, THEME_ID, THEME_VARS, exportTheme, freeThemeId, parseThemeFile, themeCss, type Theme } from "../../core/themes.ts";
import { command, group, CliError } from "../registry.ts";
import { parseJson, readSource, splitPair, textInput } from "../input.ts";

group({ name: "theme", summary: "Themes: pick the app's colors, or make your own with CSS variables and extra CSS", defaultVerb: "list" });

const brief = (t: Theme & { builtin?: boolean; selected?: boolean }) => ({
  id: t.id,
  name: t.name,
  scheme: t.scheme,
  builtin: !!t.builtin,
  selected: !!t.selected,
  accent: t.vars["--highlight"],
  background: t.vars["--background"],
  css: t.css ? t.css.length : 0,
});

/** `--var name=value` pairs; the leading `--` on the name is optional. */
function varPairs(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of list ?? []) {
    const [k, v] = splitPair(p, "--var");
    out[k.startsWith("--") ? k : `--${k}`] = v;
  }
  return out;
}

const VAR_FLAGS = [
  { name: "var", type: "string" as const, multiple: true, description: "Set a CSS variable, name=value (e.g. highlight=oklch(0.7 0.15 200)). The leading -- is optional.", placeholder: "NAME=VALUE" },
  { name: "css", type: "string" as const, description: "Extra CSS rules for the app (`-` reads stdin). Remote @import and url() are removed.", placeholder: "CSS" },
  { name: "css-file", type: "string" as const, description: "Read the extra CSS from a file.", placeholder: "PATH" },
  { name: "scheme", type: "string" as const, description: "Light or dark (sets the browser's color-scheme for form controls and scrollbars).", values: ["dark", "light"] },
];

command({
  name: "theme list",
  summary: "Every theme, built-in first, with which one is selected.",
  output: "array of { id, name, scheme, builtin, selected, accent, background, css (length of extra CSS) }",
  run: (ctx) => ctx.e.listThemes().map(brief),
});

command({
  name: "theme show",
  summary: "A theme's variables and extra CSS. Without an id, the selected theme.",
  args: [{ name: "id", description: "Theme id." }],
  flags: [{ name: "css", type: "boolean", description: "Print the compiled stylesheet as text instead of JSON." }],
  examples: ["etude theme show", "etude theme show paper", "etude theme show my-theme --css"],
  output: "{ id, name, scheme, vars, css?, base?, builtin, selected }, or CSS text with --css",
  run(ctx) {
    const e = ctx.e;
    const id = ctx.args.id ?? e.currentTheme().id;
    const t = e.theme(id);
    if (ctx.flags.css) return themeCss(t);
    return { ...t, selected: e.currentTheme().id === id };
  },
});

command({
  name: "theme set",
  summary: "Use a theme in the app (every device; open pages pick it up on their next load).",
  args: [{ name: "id", description: "Theme id (see `etude theme list`).", required: true }],
  writes: true,
  dryRun: true,
  examples: ["etude theme set paper", "etude theme set midnight"],
  output: "{ selected, theme: { id, name, scheme } }",
  run(ctx) {
    const t = ctx.e.selectTheme(ctx.args.id);
    return { selected: t.id, theme: { id: t.id, name: t.name, scheme: t.scheme } };
  },
});

command({
  name: "theme create",
  summary: "Make a custom theme from an existing one, changing variables and adding CSS.",
  description: `Starts from --from (default: the selected theme) and applies --var pairs and --css on top. Variables: ${THEME_VARS.join(", ")}. Any other --name is accepted too and can be used from the extra CSS.`,
  args: [{ name: "id", description: "Lowercase slug for the new theme. Omit to derive one from --name." }],
  flags: [
    { name: "name", type: "string", description: "Display name. Defaults to the id." },
    { name: "from", type: "string", description: "Theme to copy. Default: the selected theme.", placeholder: "THEME" },
    ...VAR_FLAGS,
    { name: "use", type: "boolean", description: "Also select the new theme." },
  ],
  writes: true,
  dryRun: true,
  examples: [
    'etude theme create ocean --name "Ocean" --from midnight --var highlight="oklch(0.75 0.12 210)" --use',
    "etude theme create big-cards --css-file big.css",
  ],
  output: "{ theme, removed (CSS that was stripped), selected }",
  run(ctx) {
    const e = ctx.e;
    const base = e.theme(ctx.flags.from ?? e.currentTheme().id);
    const taken = e.settings().themes.map((t) => t.id);
    const id = ctx.args.id ?? freeThemeId(ctx.flags.name ?? `${base.id}-copy`, taken);
    if (!THEME_ID.test(id)) throw new CliError(`theme id must be a lowercase slug, e.g. "${freeThemeId(id, [])}"`, "validation");
    if (BUILTIN_THEMES.some((t) => t.id === id)) throw new CliError(`"${id}" is a built-in theme id`, "conflict");
    if (taken.includes(id)) throw new CliError(`theme "${id}" already exists; use \`etude theme edit\``, "conflict");
    const css = textInput(ctx, ctx.flags.css, ctx.flags["css-file"]);
    const draft = {
      id,
      name: ctx.flags.name ?? (ctx.args.id ? id : `${base.name} copy`),
      scheme: ctx.flags.scheme ?? base.scheme,
      vars: { ...base.vars, ...varPairs(ctx.flags.var) },
      css: css ?? base.css ?? "",
      base: base.builtin ? base.id : base.base,
    };
    const saved = e.saveTheme(draft, { create: true });
    if (ctx.flags.use) e.selectTheme(id);
    return { theme: saved.theme, removed: saved.removed, selected: e.currentTheme().id };
  },
});

command({
  name: "theme edit",
  summary: "Change a custom theme: name, scheme, variables or extra CSS.",
  args: [{ name: "id", description: "Custom theme id.", required: true }],
  flags: [
    { name: "name", type: "string", description: "New display name." },
    ...VAR_FLAGS,
    { name: "unset-var", type: "string", multiple: true, description: "Reset a variable to the value of the theme it was made from.", placeholder: "NAME" },
    { name: "rename", type: "string", description: "Change the id (keeps it selected if it was).", placeholder: "ID" },
  ],
  writes: true,
  dryRun: true,
  examples: ['etude theme edit ocean --var radius=0.5rem --var "--good=oklch(0.8 0.15 160)"', "etude theme edit ocean --css-file ocean.css", "etude theme edit ocean --rename deep-ocean"],
  output: "{ theme, removed, changed: [variable names and fields] }",
  run(ctx) {
    const e = ctx.e;
    const cur = e.theme(ctx.args.id);
    if (cur.builtin) throw new CliError(`"${cur.id}" is built in; copy it first with \`etude theme create --from ${cur.id}\``, "conflict");
    const vars = { ...cur.vars, ...varPairs(ctx.flags.var) };
    const changed = Object.keys(varPairs(ctx.flags.var));
    const fallback = BUILTIN_THEMES.find((t) => t.id === cur.base) ?? BUILTIN_THEMES.find((t) => t.scheme === cur.scheme)!;
    for (const n0 of ctx.flags["unset-var"] ?? []) {
      const n = n0.startsWith("--") ? n0 : `--${n0}`;
      if (fallback.vars[n] !== undefined) vars[n] = fallback.vars[n];
      else delete vars[n];
      changed.push(n);
    }
    const css = textInput(ctx, ctx.flags.css, ctx.flags["css-file"]);
    const next: Theme = { ...cur, vars, name: ctx.flags.name ?? cur.name, scheme: ctx.flags.scheme ?? cur.scheme, css: css ?? cur.css };
    if (ctx.flags.name) changed.push("name");
    if (ctx.flags.scheme) changed.push("scheme");
    if (css !== undefined) changed.push("css");
    delete (next as any).builtin;
    const newId = ctx.flags.rename;
    if (newId && newId !== cur.id) {
      if (!THEME_ID.test(newId)) throw new CliError(`theme id must be a lowercase slug`, "validation");
      if (BUILTIN_THEMES.some((t) => t.id === newId) || e.settings().themes.some((t) => t.id === newId)) throw new CliError(`theme "${newId}" already exists`, "conflict");
      const s = e.settings();
      const saved = e.saveTheme({ ...next, id: newId }, { create: true });
      const wasSelected = s.theme === cur.id;
      e.updateSettings({ themes: e.settings().themes.filter((t) => t.id !== cur.id), theme: wasSelected ? newId : s.theme });
      changed.push("id");
      return { theme: saved.theme, removed: saved.removed, changed };
    }
    const saved = e.saveTheme(next);
    return { theme: saved.theme, removed: saved.removed, changed };
  },
});

command({
  name: "theme delete",
  summary: "Delete a custom theme. If it was selected, the app goes back to Midnight.",
  args: [{ name: "id", description: "Custom theme id.", required: true }],
  writes: true,
  dryRun: true,
  confirm: true,
  examples: ["etude theme delete ocean --yes"],
  output: "{ deleted, selected }",
  run: (ctx) => ctx.e.deleteTheme(ctx.args.id),
});

command({
  name: "theme export",
  summary: "Write a theme as JSON to share or back up.",
  args: [{ name: "id", description: "Theme id. Default: the selected theme." }],
  flags: [
    { name: "out", type: "string", short: "o", description: "Write to this file instead of stdout.", placeholder: "FILE" },
    { name: "force", type: "boolean", description: "Overwrite an existing --out file." },
  ],
  writes: true,
  examples: ["etude theme export ocean -o ocean.theme.json", "etude theme export > current.theme.json"],
  output: "{ etudeTheme: 1, id, name, scheme, vars, css? }, or { written, id } with --out",
  run(ctx) {
    const e = ctx.e;
    const t = e.theme(ctx.args.id ?? e.currentTheme().id);
    const { builtin: _b, ...plain } = t;
    const data = exportTheme(plain);
    if (!ctx.flags.out) return data;
    const path = resolve(ctx.flags.out);
    if (existsSync(path) && !ctx.flags.force) throw new CliError(`${path} exists (use --force)`, "conflict");
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
    return { written: path, id: t.id };
  },
});

command({
  name: "theme import",
  summary: "Add a theme from a JSON file made by `theme export` (or the app's Export).",
  description: "A theme whose id is taken gets a new id unless --replace is given. Missing variables are filled from Midnight or Daylight, matching the scheme. Remote @import and url() in its CSS are removed.",
  args: [{ name: "file", description: "Theme file (`-` for stdin).", required: true }],
  flags: [
    { name: "id", type: "string", description: "Store it under this id." },
    { name: "replace", type: "boolean", description: "Overwrite a custom theme with the same id." },
    { name: "use", type: "boolean", description: "Also select it." },
  ],
  writes: true,
  dryRun: true,
  examples: ["etude theme import ocean.theme.json --use", "cat t.json | etude theme import -"],
  output: "{ theme, removed, created, selected }",
  run(ctx) {
    const e = ctx.e;
    const raw = parseThemeFile(parseJson(readSource(ctx, ctx.args.file), ctx.args.file)) as Record<string, any>;
    const taken = e.settings().themes.map((t) => t.id);
    let id = ctx.flags.id ?? String(raw.id ?? "");
    if (!THEME_ID.test(id)) id = freeThemeId(id || String(raw.name ?? "theme"), taken);
    const clash = BUILTIN_THEMES.some((t) => t.id === id) || (taken.includes(id) && !ctx.flags.replace);
    if (clash) {
      if (ctx.flags.id) throw new CliError(`theme "${id}" already exists (use --replace for a custom one)`, "conflict");
      id = freeThemeId(id, taken);
    }
    const saved = e.saveTheme({ ...raw, id });
    if (ctx.flags.use) e.selectTheme(id);
    return { theme: saved.theme, removed: saved.removed, created: saved.created, selected: e.currentTheme().id };
  },
});
