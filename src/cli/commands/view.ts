// `etude view`: what the open app shows in the Notebook, and changing it from outside (the CLI, `etude mcp`, an
// agent in Ask), anything a person can do with the mouse: open, split, close and focus tabs, pin them and give
// them icons, move them between panes, make and edit tab groups, resize and zoom panes, fold the sidebar, show or hide
// Notes' pages and the Ask panel, and go to another screen. The app and these commands meet through files in the
// Etude home (core/view-remote.ts).
import { command, group, CliError, type Ctx } from "../registry.ts";
import { pushViewCommand, readViewState, viewDir, type SidebarMode, type ViewCommand, type ViewSide, type ViewTarget, type ViewWhere } from "../../core/view-remote.ts";

group({ name: "view", summary: "What the open app shows, and changing it like a person would: tabs, panes, groups, sidebar, Ask panel", defaultVerb: "show" });

const WHERE: ViewWhere[] = ["tab", "replace", "right", "left", "top", "bottom"];
const SIDES: ViewSide[] = ["right", "left", "top", "bottom"];
const MODES: SidebarMode[] = ["open", "rail", "none"];
const COLORS = ["gray", "blue", "red", "yellow", "green", "pink", "purple", "orange"];

function dir(ctx: Ctx) {
  return viewDir(ctx.home, ctx.dbPath);
}

/** The app has to be open: a command no one picks up is dropped after a few seconds. */
function liveState(ctx: Ctx) {
  const s = readViewState(dir(ctx));
  if (!s?.live) throw new CliError(s ? `the app isn't open (it last said what it shows at ${s.at})` : "the app isn't open on this computer", "conflict");
  return s;
}

/**
 * A tab as the app knows it: a chat tab or a New tab as `view show` lists it, a note (id, its start, title or path),
 * or a file in a folder open on this computer (its fs: id, "Folder name/path/inside", or its path on disk).
 */
function tab(ctx: Ctx, v: string): string {
  if (/^(chat|new):/.test(v)) return v;
  if (v.startsWith("fs:")) return ctx.e.folders.ref(v);
  try {
    return ctx.e.notes.resolve(v).id;
  } catch (e) {
    try {
      return ctx.e.folders.ref(v);
    } catch {
      throw e;
    }
  }
}

/** A pane number (1 first), "chat" for the pane with an Ask chat, or a tab open there. */
function target(ctx: Ctx, v: string): ViewTarget {
  if (/^\d+$/.test(v)) return { pane: Number(v) };
  if (v === "chat") return { chat: true };
  if (v === "panel") return { panel: true };
  return { note: tab(ctx, v) };
}

function color(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const c = String(v).toLowerCase();
  if (COLORS.includes(c) || /^#[0-9a-f]{6}$/.test(c)) return c;
  throw new CliError(`a colour is one of ${COLORS.join(", ")}, or #rrggbb`);
}

/** Queues the command, then waits a moment for the app to show the result. */
async function send(ctx: Ctx, cmd: ViewCommand) {
  const before = liveState(ctx);
  const d = dir(ctx);
  const seq = pushViewCommand(d, cmd);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const s = readViewState(d);
    if (s?.failed?.seq === seq) throw new CliError(s.failed.error || "the app couldn't do that");
    if (s && (s.applied ?? 0) >= seq) return { done: true, view: s };
  }
  return { done: false, note: "the app hasn't shown it yet (it may be busy or on another screen)", view: readViewState(d) ?? before };
}

const tabArg = { name: "tab", description: "A tab: a note (id or its start, title, path), or a chat:… / new:… tab as `view show` lists it.", required: true };
const groupArg = { name: "group", description: "The group: its id or its name.", required: true };

command({
  name: "view show",
  summary: "What the open app shows: the screen, its Notebook panes (numbered from 1) with their tabs, groups, pins and sizes, and the sidebar, Notes' pages and the Ask panel.",
  output: "{ live, at, route, shell: { sidebar, pages, panel }, panes: [{ n, focused, box, front, tabs: [{ id, kind, title, pinned?, icon?, group? }], groups: [{ id, name, color, collapsed, tabs }] }] }",
  examples: ["etude view", "etude view show"],
  run(ctx) {
    return readViewState(dir(ctx)) ?? { live: false, panes: [] };
  },
});

command({
  name: "view open",
  summary: "Open a note in the app (or, with no note, a New tab): in a pane of its own beside another (right, left, top, bottom), as a new tab, or in place of the front page. An open tab moves there.",
  args: [{ name: "note", description: "Id (or its start), exact title, or path. Leave out for a New tab." }],
  flags: [
    { name: "where", type: "string", values: WHERE, default: "tab", description: "right, left, top or bottom: a pane of its own on that side; tab: a new tab; replace: in place of the page in front." },
    { name: "beside", type: "string", description: "The pane it goes beside or into: its number (as `view show` counts), a tab open there, or chat for the pane with an Ask chat. The focused pane by default.", placeholder: "PANE" },
    { name: "before", type: "string", description: "As a tab: the tab it goes in front of, or end for the end of the strip. Next to the page in front when left out.", placeholder: "TAB" },
  ],
  writes: true,
  examples: ["etude view open", "etude view open --before end", 'etude view open "Week 3" --before "Week 1"', 'etude view open "Cleópatra VII" --where right', 'etude view open "Week 3" --where bottom --beside 2', "etude view open lecture.pdf --where right --beside chat"],
  output: "{ done, view } with what the app shows after",
  async run(ctx) {
    const where = String(ctx.flags.where ?? "tab") as ViewWhere;
    if (!WHERE.includes(where)) throw new CliError(`--where is one of ${WHERE.join(", ")}`);
    const note = ctx.args.note ? tab(ctx, ctx.args.note) : undefined;
    const b = ctx.flags.before === undefined ? undefined : String(ctx.flags.before);
    if (b !== undefined && where !== "tab") throw new CliError("--before only goes with --where tab");
    const before = b === undefined ? undefined : b === "end" ? null : tab(ctx, b);
    return send(ctx, { action: "open", note, where, beside: ctx.flags.beside ? target(ctx, String(ctx.flags.beside)) : undefined, before });
  },
});

command({
  name: "view close",
  summary: "Close a tab in the app, or with --pane every tab in that pane.",
  args: [{ ...tabArg, required: false }],
  flags: [{ name: "pane", type: "string", description: "Close this whole pane instead (its number, or chat).", placeholder: "N" }],
  writes: true,
  examples: ['etude view close "Cleópatra VII"', "etude view close --pane 2"],
  output: "{ done, view }",
  async run(ctx) {
    if (!ctx.args.tab && !ctx.flags.pane) throw new CliError("give the tab to close, or --pane");
    return send(ctx, { action: "close", target: ctx.flags.pane ? target(ctx, String(ctx.flags.pane)) : target(ctx, ctx.args.tab) });
  },
});

command({
  name: "view close-others",
  summary: "Close every other tab in that tab's pane. Pinned tabs stay, like in a browser.",
  args: [tabArg],
  writes: true,
  examples: ['etude view close-others "Week 3"'],
  output: "{ done, view }",
  run: (ctx) => send(ctx, { action: "close-others", tab: tab(ctx, ctx.args.tab) }),
});

command({
  name: "view focus",
  summary: "Bring a tab to the front in its pane, or focus a pane.",
  args: [{ name: "tab", description: "An open tab, a pane number, or chat.", required: true }],
  writes: true,
  examples: ['etude view focus "Week 3"', "etude view focus 2"],
  output: "{ done, view }",
  run: (ctx) => send(ctx, { action: "focus", target: target(ctx, ctx.args.tab) }),
});

command({
  name: "view pin",
  summary: "Pin a tab (small, at the start of its strip, kept by Close other tabs), or unpin it with --off.",
  args: [tabArg],
  flags: [{ name: "off", type: "boolean", description: "Unpin it." }],
  writes: true,
  examples: ['etude view pin "Scratchpad"', 'etude view pin "Scratchpad" --off'],
  output: "{ done, view }",
  run: (ctx) => send(ctx, { action: "pin", tab: tab(ctx, ctx.args.tab), on: !ctx.flags.off }),
});

command({
  name: "view icon",
  summary: "A pinned tab's own icon (an emoji, or a page icon like emoji:🧪, art:…, media:…), or the page's own again with --clear.",
  args: [tabArg, { name: "icon", description: "The icon. An emoji alone is taken as emoji:…" }],
  flags: [{ name: "clear", type: "boolean", description: "Go back to the page's own icon." }],
  writes: true,
  examples: ['etude view icon "Scratchpad" 🧰', 'etude view icon "Scratchpad" --clear'],
  output: "{ done, view }",
  run(ctx) {
    const raw = ctx.flags.clear ? null : ctx.args.icon ? String(ctx.args.icon) : null;
    if (!ctx.flags.clear && !raw) throw new CliError("give the icon, or --clear");
    const icon = raw && !/^(emoji|art|media):/.test(raw) ? `emoji:${raw}` : raw;
    return send(ctx, { action: "icon", tab: tab(ctx, ctx.args.tab), icon });
  },
});

command({
  name: "view move",
  summary: "Move a tab: into a pane's tabs (before another tab, or at the end), with --side to that side of a pane as a pane of its own, or an Ask chat with --to panel back to the side panel.",
  args: [tabArg],
  flags: [
    { name: "to", type: "string", description: "The pane: its number, a tab open there, chat, or panel (an Ask chat back to the side panel). Its own pane by default (to reorder).", placeholder: "PANE" },
    { name: "before", type: "string", description: "The tab it goes in front of. At the end when left out.", placeholder: "TAB" },
    { name: "side", type: "string", values: SIDES, description: "A pane of its own on that side of --to." },
  ],
  writes: true,
  examples: ['etude view move "Week 3" --to 2', 'etude view move "Week 3" --before "Week 1"', 'etude view move "Week 3" --to chat --side bottom'],
  output: "{ done, view }",
  run(ctx) {
    const t = tab(ctx, ctx.args.tab);
    const side = ctx.flags.side ? (String(ctx.flags.side) as ViewSide) : undefined;
    if (side && !SIDES.includes(side)) throw new CliError(`--side is one of ${SIDES.join(", ")}`);
    return send(ctx, { action: "move", tab: t, to: ctx.flags.to ? target(ctx, String(ctx.flags.to)) : { note: t }, before: ctx.flags.before ? tab(ctx, String(ctx.flags.before)) : null, side });
  },
});

command({
  name: "view group",
  summary: "Put tabs in a tab group: a new one (with --name and --color), or an existing one with --into. The tabs must be in one pane.",
  args: [{ name: "tabs", description: "The tabs.", required: true, variadic: true }],
  flags: [
    { name: "into", type: "string", description: "An existing group (id or name).", placeholder: "GROUP" },
    { name: "name", type: "string", description: "A new group's name." },
    { name: "color", type: "string", description: `A new group's colour: ${COLORS.join(", ")}, or #rrggbb.` },
  ],
  writes: true,
  examples: ['etude view group "Week 1" "Week 2" --name "Graphics" --color blue', 'etude view group "Week 3" --into "Graphics"'],
  output: "{ done, view } (the new group's id is in view.panes[].groups)",
  run(ctx) {
    const tabs = (ctx.args.tabs as string[]).map((t) => tab(ctx, t));
    return send(ctx, { action: "group", tabs, group: ctx.flags.into ? String(ctx.flags.into) : undefined, name: ctx.flags.name ? String(ctx.flags.name) : undefined, color: color(ctx.flags.color) });
  },
});

command({
  name: "view group-edit",
  summary: "Rename, recolour, fold or unfold a tab group.",
  args: [groupArg],
  flags: [
    { name: "name", type: "string", description: "Its new name (empty for none)." },
    { name: "color", type: "string", description: `Its colour: ${COLORS.join(", ")}, or #rrggbb.` },
    { name: "fold", type: "boolean", description: "Fold it into its label." },
    { name: "unfold", type: "boolean", description: "Show its tabs again." },
  ],
  writes: true,
  examples: ['etude view group-edit "Graphics" --color red', 'etude view group-edit "Graphics" --fold', 'etude view group-edit g1 --name "Midterm"'],
  output: "{ done, view }",
  run(ctx) {
    const collapsed = ctx.flags.fold ? true : ctx.flags.unfold ? false : undefined;
    const name = ctx.flags.name === undefined ? undefined : String(ctx.flags.name);
    const c = color(ctx.flags.color);
    if (name === undefined && c === undefined && collapsed === undefined) throw new CliError("give --name, --color, --fold or --unfold");
    return send(ctx, { action: "group-edit", group: String(ctx.args.group), name, color: c, collapsed });
  },
});

command({
  name: "view ungroup",
  summary: "Dissolve a tab group (its tabs stay open), or with --tab take one tab out of its group.",
  args: [{ ...groupArg, required: false }],
  flags: [{ name: "tab", type: "string", description: "Take just this tab out of its group.", placeholder: "TAB" }],
  writes: true,
  examples: ['etude view ungroup "Graphics"', 'etude view ungroup --tab "Week 3"'],
  output: "{ done, view }",
  run(ctx) {
    if (!ctx.args.group && !ctx.flags.tab) throw new CliError("give the group, or --tab");
    return send(ctx, { action: "ungroup", group: ctx.args.group ? String(ctx.args.group) : undefined, tab: ctx.flags.tab ? tab(ctx, String(ctx.flags.tab)) : undefined });
  },
});

command({
  name: "view group-close",
  summary: "Close a tab group and every tab in it.",
  args: [groupArg],
  writes: true,
  examples: ['etude view group-close "Graphics"'],
  output: "{ done, view }",
  run: (ctx) => send(ctx, { action: "group-close", group: String(ctx.args.group) }),
});

command({
  name: "view group-move",
  summary: "Move a whole tab group: along its strip (before a tab) or into another pane's tabs.",
  args: [groupArg],
  flags: [
    { name: "to", type: "string", description: "The pane: its number, a tab open there, or chat. Its own pane by default.", placeholder: "PANE" },
    { name: "before", type: "string", description: "The tab it goes in front of. At the end when left out.", placeholder: "TAB" },
  ],
  writes: true,
  examples: ['etude view group-move "Graphics" --to 2', 'etude view group-move "Graphics" --before "Week 1"'],
  output: "{ done, view }",
  run(ctx) {
    const s = liveState(ctx);
    const g = String(ctx.args.group);
    const home = s.panes.find((p) => p.groups?.some((x) => x.id === g || x.name.toLowerCase() === g.toLowerCase()));
    const to: ViewTarget = ctx.flags.to ? target(ctx, String(ctx.flags.to)) : home ? { pane: home.n } : { pane: 1 };
    return send(ctx, { action: "group-move", group: g, to, before: ctx.flags.before ? tab(ctx, String(ctx.flags.before)) : null });
  },
});

command({
  name: "view resize",
  summary: "How much of its split a pane takes: 0.5 is half, 0.7 makes it bigger than the pane beside it.",
  args: [
    { name: "pane", description: "A pane number, a tab open there, or chat.", required: true },
    { name: "size", description: "Its share, 0.05 to 0.95 (or a percentage like 70%).", required: true },
  ],
  writes: true,
  examples: ["etude view resize 2 0.3", "etude view resize chat 40%"],
  output: "{ done, view }",
  run(ctx) {
    const raw = String(ctx.args.size).trim();
    const size = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
    if (!Number.isFinite(size) || size <= 0 || size >= 1) throw new CliError("size is between 0 and 1, or a percentage");
    return send(ctx, { action: "resize", target: target(ctx, String(ctx.args.pane)), size });
  },
});

command({
  name: "view zoom",
  summary: "A pane's own zoom, like Ctrl/⌘ + and − in it: a step in or out, reset to 100%, or a size like 125%. The rest of the window stays as it is.",
  args: [
    { name: "pane", description: "A pane number, a tab open there, or chat.", required: true },
    { name: "zoom", description: "in, out, reset, or a size: 1.25 or 125% (50% to 300%).", required: true },
  ],
  writes: true,
  examples: ["etude view zoom 2 in", "etude view zoom 1 150%", "etude view zoom chat reset"],
  output: "{ done, view }",
  run(ctx) {
    const raw = String(ctx.args.zoom).trim().toLowerCase();
    let zoom: "in" | "out" | "reset" | number;
    if (raw === "in" || raw === "out" || raw === "reset") zoom = raw;
    else {
      zoom = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
      if (!Number.isFinite(zoom) || zoom < 0.5 || zoom > 3) throw new CliError("zoom is in, out, reset, or a size from 0.5 (50%) to 3 (300%)");
    }
    return send(ctx, { action: "zoom", target: target(ctx, String(ctx.args.pane)), zoom });
  },
});

command({
  name: "view sidebar",
  summary: "The app's sidebar: open wide, folded to its icons (rail), or hidden (none).",
  args: [{ name: "mode", description: "open, rail or none.", required: true }],
  writes: true,
  examples: ["etude view sidebar rail", "etude view sidebar none", "etude view sidebar open"],
  output: "{ done, view }",
  run(ctx) {
    const mode = String(ctx.args.mode) as SidebarMode;
    if (!MODES.includes(mode)) throw new CliError(`mode is one of ${MODES.join(", ")}`);
    return send(ctx, { action: "sidebar", mode });
  },
});

const onOff = (v: string, on: string[], off: string[], what: string) => {
  const s = v.toLowerCase();
  if (on.includes(s)) return true;
  if (off.includes(s)) return false;
  throw new CliError(`${what} is ${[...on, ...off].join(", ")}`);
};

command({
  name: "view pages",
  summary: "Show or hide Notes' page tree under the Notes row in the sidebar.",
  args: [{ name: "state", description: "show or hide.", required: true }],
  writes: true,
  examples: ["etude view pages hide", "etude view pages show"],
  output: "{ done, view }",
  run: (ctx) => send(ctx, { action: "pages", open: onOff(String(ctx.args.state), ["show", "on", "open"], ["hide", "off", "close"], "state") }),
});

command({
  name: "view panel",
  summary: "Open or close the Ask side panel.",
  args: [{ name: "state", description: "open or close.", required: true }],
  writes: true,
  examples: ["etude view panel close", "etude view panel open"],
  output: "{ done, view }",
  run: (ctx) => send(ctx, { action: "panel", open: onOff(String(ctx.args.state), ["open", "show", "on"], ["close", "hide", "off"], "state") }),
});

command({
  name: "view go",
  summary: "Go to another screen of the app: notes, library, study (with ?deck=…), browse, stats, market, settings, or any path.",
  args: [{ name: "route", description: "A screen name or a path like /study?deck=CMPT%20371.", required: true }],
  writes: true,
  examples: ["etude view go stats", "etude view go notes", 'etude view go "/browse?q=tag:week3"'],
  output: "{ done, view }",
  run(ctx) {
    const r = String(ctx.args.route).trim();
    const route = r.startsWith("/") ? r : r === "library" || r === "home" ? "/" : `/${r}`;
    return send(ctx, { action: "go", route });
  },
});
