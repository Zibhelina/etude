import { command, group, CliError } from "../registry.ts";
import { parseJson, readSource, textInput } from "../input.ts";
import { isInsideAttachmentDir } from "../../core/agent-guard.ts";
import { docFromText, isTextFile, sceneFromExcalidraw } from "../../core/notes.ts";
import { blockList, blocksFromMarkdown, checkBlocks, deleteBlocks, getBlock, insertBlocks, insertText, moveBlocks, notePaths, numberedText, patchDoc, patchText, setBlock, treeText, type MdContext } from "../../core/notes-edit.ts";
import { addElement, deleteElements, editElement, imageSize, listElements } from "../../core/canvas-edit.ts";

group({ name: "note", summary: "Notes (beta): pages you write in, in a tree of their own", defaultVerb: "list" });

command({
  name: "note list",
  summary: "Every page, in tree order (parents before their pages).",
  flags: [{ name: "archived", type: "boolean", description: "The archived pages instead." }],
  output: "array of { id, kind, parentId, title, icon, look, position, archived, created, updated, children, empty, pinned, opened }",
  run(ctx) {
    return ctx.e.notes.list({ archived: !!ctx.flags.archived });
  },
});

command({
  name: "note show",
  summary: "A page (its title, plain text and document tree) or a canvas (its title, text and Excalidraw scene).",
  args: [{ name: "note", description: "Id (or its start), exact title, or path (Folder/Page).", required: true }],
  flags: [{ name: "text", type: "boolean", description: "Print only the plain text." }],
  output: "{ id, kind, parentId, title, icon, look, …, text, doc, scene } (or the text with --text)",
  run(ctx) {
    const n = ctx.e.notes.resolve(ctx.args.note);
    return ctx.flags.text ? n.text : n;
  },
});

const docFlags = [
  { name: "md", type: "string" as const, description: "Body as Markdown: headings, lists, `- [ ]` to-dos, tables, code, `$math$`, callouts, [[links]]. `-` reads stdin.", placeholder: "MARKDOWN" },
  { name: "md-file", type: "string" as const, description: "Read the Markdown body from a file.", placeholder: "PATH" },
  { name: "text", type: "string" as const, description: "Body as plain text: one paragraph per line, `# ` headings, `- ` bullets, `- [ ] ` tasks. `-` reads stdin." },
  { name: "text-file", type: "string" as const, description: "Read the plain-text body from a file.", placeholder: "PATH" },
  { name: "doc", type: "string" as const, description: "Body as a document tree (ProseMirror JSON, as `note show` prints it). `-` reads stdin." },
  { name: "doc-file", type: "string" as const, description: "Read the document tree from a file.", placeholder: "PATH" },
];

const lookFlags = [
  { name: "cover", type: "string" as const, description: "Cover across the top: a preset (sky, teal, plum, mustard, brick, moss, rose, night, dawn, sea, paper, ink), a picture file on disk (copied into the media), image:files/<sha>.<ext>[:y], or none." },
  { name: "width", type: "string" as const, description: "Page width: normal, wide or full." },
  { name: "font", type: "string" as const, description: "Page font: sans, serif or mono." },
  { name: "size", type: "string" as const, description: "Text size: small, normal or large." },
  { name: "list-icon", type: "string" as const, description: "Show the page's icon in the sidebar list: show or hide. Hidden by default, so the list shows names only, like Obsidian." },
];

/** The look flags given, merged over the page's current look (undefined when none were given). */
function lookOf(ctx: any, current: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  const given = ["cover", "width", "font", "size"].filter((k) => ctx.flags[k] !== undefined);
  const icon = ctx.flags["list-icon"];
  if (!given.length && icon === undefined) return undefined;
  const out: Record<string, unknown> = { ...current };
  for (const k of given) out[k] = ctx.flags[k] === "none" || ctx.flags[k] === "" ? undefined : ctx.flags[k];
  // A cover from a picture on disk: copied into the media, like dropping it on the page.
  const cv = ctx.flags.cover;
  if (typeof cv === "string" && /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(cv) && !cv.startsWith("image:")) {
    const m = ctx.e.importMedia(cv, { dryRun: ctx.dry });
    out.cover = `image:${m.file}`;
  }
  if (icon !== undefined) out.showIcon = icon;
  return out;
}

/** --scene / --scene-file as a canvas scene (inline pictures go into the media). */
function sceneOf(ctx: any): unknown {
  const raw = ctx.flags.scene === "-" ? ctx.stdin() : ctx.flags.scene ?? (ctx.flags["scene-file"] !== undefined ? readSource(ctx, ctx.flags["scene-file"]) : undefined);
  if (raw === undefined) return undefined;
  return sceneFromExcalidraw(parseJson(raw, "--scene"), (name, data) => ctx.e.storeMedia(name, data, { dryRun: ctx.dry }));
}

const contentFlags = [
  { name: "content", type: "string" as const, description: "A file's text exactly as written, or a web file's HTML. `-` reads stdin.", placeholder: "TEXT" },
  { name: "content-file", type: "string" as const, description: "Read a file's text (or a web file's HTML) from this file on disk.", placeholder: "PATH" },
];
/** --content / --content-file, for a file note. */
const contentOf = (ctx: any): string | undefined => textInput(ctx, ctx.flags.content, ctx.flags["content-file"]);

function docOf(ctx: any): unknown {
  const text = textInput(ctx, ctx.flags.text, ctx.flags["text-file"]);
  const md = textInput(ctx, ctx.flags.md, ctx.flags["md-file"]);
  const docRaw = ctx.flags.doc === "-" ? ctx.stdin() : ctx.flags.doc ?? (ctx.flags["doc-file"] !== undefined ? readSource(ctx, ctx.flags["doc-file"]) : undefined);
  if ([text, md, docRaw].filter((x) => x !== undefined).length > 1) throw new CliError("give one of --md, --text or --doc");
  if (docRaw !== undefined) return parseJson(docRaw, "--doc");
  if (md !== undefined) return { type: "doc", content: md.trim() ? blocksFromMarkdown(md, mdContext(ctx)) : [{ type: "paragraph" }] };
  if (text !== undefined) return docFromText(text);
  return undefined;
}

/**
 * How Markdown from outside resolves: [[Title]] → the live note with that title (any case) when exactly one has it;
 * a picture at a local path → copied into the collection's media; one already in the media or on the web → kept.
 */
function mdContext(ctx: any): MdContext {
  const by = new Map<string, string | null>();
  for (const n of ctx.e.notes.list()) {
    const k = n.title.toLowerCase();
    by.set(k, by.has(k) ? null : n.id);
  }
  return {
    page: (t) => by.get(t.toLowerCase()) ?? null,
    media: (p) => {
      if (/^\/?media\//.test(p)) return p.startsWith("/") ? p : "/" + p;
      if (/^(data|blob):/i.test(p)) return null;
      if (ctx.agent && !isInsideAttachmentDir(p, ctx.attachmentDir)) {
        throw new CliError(`picture ${p}: the assistant can only import files the user attached to this chat`);
      }
      try {
        return ctx.e.importMedia(p, { dryRun: ctx.dry }).url;
      } catch (e) {
        throw new CliError(`picture ${p}: ${(e as Error).message}`);
      }
    },
  };
}

command({
  name: "note new",
  summary: "Make a page, or with --folder a folder that only holds pages, with --file a code or text file (main.py, notes.tex) opened in a plain editor, or with --web a web file (HTML, CSS and JavaScript) you can open through a portal in any page.",
  args: [{ name: "title", description: "Its title.", required: true }],
  flags: [{ name: "parent", type: "string", description: "Put it inside this page or folder (id, title or path)." }, { name: "folder", type: "boolean", description: "Make a folder: it holds pages and has no body of its own." }, { name: "icon", type: "string", description: "One emoji." }, { name: "canvas", type: "boolean", description: "Make a canvas (a whiteboard you draw on) instead of a page." }, { name: "pdf", type: "string", description: "Make a PDF note from this file: it opens as the document itself. The file goes into the collection's media.", placeholder: "PATH" }, { name: "scene", type: "string", description: "A canvas's drawing as Excalidraw JSON ({ elements, appState, files }, or a whole .excalidraw file). `-` reads stdin.", placeholder: "JSON" }, { name: "scene-file", type: "string", description: "Read the canvas's drawing from a .excalidraw file.", placeholder: "PATH" }, { name: "file", type: "boolean", description: "Make a file: plain text kept exactly as written, highlighted by the extension in its title (main.py, report.tex)." }, { name: "web", type: "boolean", description: "Make a web file: your own HTML, CSS and JavaScript, run sandboxed. It opens on its own, and live inside any page through a portal (`--content` is its HTML)." }, { name: "kanban", type: "boolean", description: "Make a kanban board (columns of cards, like Trello). It opens on its own, and live inside any page through a portal. Starts with To do · Doing · Done unless --columns says otherwise." }, { name: "columns", type: "string", description: "A new board's columns, comma separated (\"Backlog,This week,Done\"); \"week\" for Mon to Weekend, \"none\" for no columns.", placeholder: "LIST" }, ...contentFlags, ...docFlags, ...lookFlags],
  writes: true,
  dryRun: true,
  examples: ['etude note new "Algorithms" --icon 📘', 'etude note new "Week 1" --parent "Fall 2026/Algorithms" --md "# Greedy\\n\\n- exchange argument\\n- [ ] problem set 1"', 'etude note new "Term timeline" --web --content-file timeline.html', 'etude note new "Fall 2026" --folder', 'etude note new main.py --file --content-file ./main.py'],
  output: "the new page, as `note show` prints it",
  async run(ctx) {
    const parentId = ctx.flags.parent ? ctx.e.notes.resolve(ctx.flags.parent).id : null;
    if (ctx.flags.pdf !== undefined) {
      const { existsSync, readFileSync } = await import("node:fs");
      const { basename } = await import("node:path");
      if (docOf(ctx) !== undefined || ctx.flags.canvas) throw new CliError("a PDF note is its file: drop --text/--doc/--canvas");
      if (!existsSync(ctx.flags.pdf)) throw new CliError(`no such file: ${ctx.flags.pdf}`, "not_found");
      const m = ctx.e.storeMedia(basename(ctx.flags.pdf), readFileSync(ctx.flags.pdf), { dryRun: ctx.dry });
      if (m.kind !== "document") throw new CliError(`${ctx.flags.pdf} isn't a PDF`);
      return ctx.e.notes.create({ title: ctx.args.title, parentId, icon: ctx.flags.icon ?? null, kind: "pdf", file: m.url, look: lookOf(ctx) });
    }
    if (ctx.flags.kanban || ctx.flags.columns !== undefined) {
      if (docOf(ctx) !== undefined || ctx.flags.file || ctx.flags.canvas || ctx.flags.web) throw new CliError("a kanban board has columns and cards: drop --text/--doc/--file/--canvas/--web");
      const cols = ctx.flags.columns;
      const template = cols === undefined ? "basic" : cols === "week" ? "week" : cols === "none" ? "empty" : String(cols).split(",").map((x: string) => x.trim()).filter(Boolean);
      return ctx.e.notes.create({ title: ctx.args.title, parentId, icon: ctx.flags.icon ?? null, kind: "kanban", template, look: lookOf(ctx) });
    }
    const content = contentOf(ctx);
    if (ctx.flags.web) {
      if (docOf(ctx) !== undefined || ctx.flags.file || ctx.flags.canvas) throw new CliError("a web file is its HTML: use --content or --content-file");
      return ctx.e.notes.create({ title: ctx.args.title, parentId, icon: ctx.flags.icon ?? null, kind: "web", content, look: lookOf(ctx) });
    }
    if (content !== undefined || ctx.flags.file) {
      if (docOf(ctx) !== undefined) throw new CliError("a file has text content, not a body: use --content or --content-file");
      return ctx.e.notes.create({ title: ctx.args.title, parentId, icon: ctx.flags.icon ?? null, kind: "file", content: content ?? "", look: lookOf(ctx) });
    }
    const scene = sceneOf(ctx);
    if (scene !== undefined || ctx.flags.canvas) {
      if (docOf(ctx) !== undefined) throw new CliError("a canvas has a drawing, not a body: drop --text/--doc");
      return ctx.e.notes.create({ title: ctx.args.title, parentId, icon: ctx.flags.icon ?? null, kind: "canvas", scene, look: lookOf(ctx) });
    }
    return ctx.e.notes.create({ title: ctx.args.title, parentId, icon: ctx.flags.icon ?? null, doc: docOf(ctx), look: lookOf(ctx), kind: ctx.flags.folder ? "folder" : "page" });
  },
});

command({
  name: "note edit",
  summary: "Change a note's title, icon, look (cover, width, font, text size) or whole body, or turn a page into a folder and back. For part of a page use note patch or note append.",
  args: [{ name: "note", description: "Id (or its start), exact title, or path (Folder/Page).", required: true }],
  flags: [{ name: "title", type: "string", description: "New title." }, { name: "kind", type: "string", description: "page or folder. Only an empty page can become a folder." }, { name: "icon", type: "string", description: "One emoji; empty to remove." }, { name: "scene", type: "string", description: "A canvas's new drawing as Excalidraw JSON. `-` reads stdin.", placeholder: "JSON" }, { name: "scene-file", type: "string", description: "Read a canvas's new drawing from a .excalidraw file.", placeholder: "PATH" }, ...contentFlags, ...docFlags, ...lookFlags],
  writes: true,
  dryRun: true,
  examples: ['etude note edit main.py --content-file ./main.py', 'etude note edit "Week 1" --title "Week 1 · Greedy"', 'etude note edit "Week 1" --md-file week1.md', 'etude note edit "Week 1" --cover dawn --font serif --width wide'],
  output: "the page after the change",
  run(ctx) {
    const n = ctx.e.notes.resolve(ctx.args.note);
    const doc = docOf(ctx);
    const look = lookOf(ctx, n.look as Record<string, unknown>);
    const scene = sceneOf(ctx);
    const content = contentOf(ctx);
    if (ctx.flags.title === undefined && ctx.flags.icon === undefined && ctx.flags.kind === undefined && doc === undefined && look === undefined && scene === undefined && content === undefined) throw new CliError("nothing to change: give --title, --icon, --kind, --md, --text, --doc, --scene, --content, --cover, --width, --font or --size");
    return ctx.e.notes.update(n.id, { title: ctx.flags.title, icon: ctx.flags.icon, doc, look, kind: ctx.flags.kind, scene, content });
  },
});

command({
  name: "note tree",
  summary: "The notes as an indented tree, one per line: title, a mark for its kind (folders end in /) and the start of its id. Any id start, title or path works wherever a command takes a note.",
  args: [{ name: "note", description: "Only this folder or page and what's inside it: id, title or path." }],
  flags: [
    { name: "depth", type: "number", description: "Show at most this many levels.", placeholder: "N" },
    { name: "paths", type: "boolean", description: "A list of { path, id, kind } instead, with each note's full path (Folder/Page)." },
  ],
  examples: ["etude note tree", 'etude note tree Main --depth 2', "etude note tree --paths"],
  output: "the tree as text (or array of { path, id, kind, updated } with --paths)",
  run(ctx) {
    const list = ctx.e.notes.list();
    const root = ctx.args.note ? ctx.e.notes.resolve(ctx.args.note).id : null;
    if (ctx.flags.paths) {
      const paths = notePaths(list);
      const inside = (id: string | null): boolean => !root || id === root || (!!id && inside(list.find((n) => n.id === id)?.parentId ?? null));
      return list.filter((n) => inside(n.id)).map((n) => ({ path: paths.get(n.id), id: n.id, kind: n.kind, updated: n.updated }));
    }
    return treeText(list, { root, depth: ctx.flags.depth });
  },
});

command({
  name: "note read",
  summary: "A note to read: a line with its path, kind, id and last change, then a page as Markdown, a file's or web file's text, a kanban board, a canvas's elements, a PDF's place in the media, or what's in a folder.",
  args: [{ name: "note", description: "Id (or its start), exact title, or path (Folder/Page).", required: true }],
  flags: [
    { name: "blocks", type: "boolean", description: "A page's top-level blocks numbered, each as Markdown, marked * when Markdown can't hold it whole (what `note block`, `note append --at` and `note patch` work with)." },
    { name: "lines", type: "boolean", description: "A file's or web file's text with line numbers (for `note append --at`)." },
  ],
  examples: ['etude note read "Journal/2026-11-08"', "etude note read 31259d4a --blocks", "etude note read main.py --lines"],
  output: "text",
  async run(ctx) {
    const { docToMarkdown } = await import("../../core/notes-md.ts");
    const { boardToMarkdown } = await import("../../core/kanban.ts");
    const n = ctx.e.notes.resolve(ctx.args.note);
    const path = notePaths(ctx.e.notes.list()).get(n.id) ?? n.title;
    const head = `<!-- ${path} · ${n.kind} · ${n.id} · updated ${n.updated} -->\n`;
    if (n.kind === "page" && ctx.flags.blocks) {
      return head + blockList(n.doc, mdContext(ctx)).map((b) => `[${b.n}${b.exact ? "" : "*"}] ${b.exact ? "" : `(${b.type}) `}${b.markdown || "(empty line)"}`.replace(/\n/g, "\n    ")).join("\n");
    }
    if (n.kind === "file" || n.kind === "web") return head + (ctx.flags.lines ? numberedText(n.content ?? "") : n.content ?? "");
    if (n.kind === "kanban") return head + boardToMarkdown(n.board!, (d) => docToMarkdown(d));
    if (n.kind === "folder") return head + treeText(ctx.e.notes.list(), { root: n.id, depth: 2 });
    if (n.kind === "page") return head + docToMarkdown(n.doc, n.title);
    if (n.kind === "canvas") return head + JSON.stringify(listElements(n.scene!), null, 1);
    if (n.kind === "pdf") return head + `PDF in the media: ${n.file}`;
    return head + (n.text ?? "");
  },
});

const editWhere = [
  { name: "under", type: "string" as const, description: "Pages: at the end of the section under this heading (before the next heading of its level or higher). Exact text, any case, or the start of it.", placeholder: "HEADING" },
  { name: "at", type: "number" as const, description: "Pages: before top-level block N (0 = the very top; `note read --blocks` numbers them). Files: before line N (1 = the first; `note read --lines`).", placeholder: "N" },
  { name: "top", type: "boolean" as const, description: "At the very top." },
];

/** What changed, to check without reading the whole page again. */
function changedBlocks(doc: any, from: number, count: number, md: MdContext) {
  return blockList({ type: "doc", content: (doc.content ?? []).slice(from, from + count) }, md).map((b) => b.markdown).join("\n\n");
}

const pathOf = (ctx: any, id: string) => notePaths(ctx.e.notes.list()).get(id);

/** A page or a text file (file, web file) to change in place. */
const editable = (ctx: any) => {
  const n = ctx.e.notes.resolve(ctx.args.note);
  if (n.kind === "page" || n.kind === "file" || n.kind === "web") return n;
  const hint = n.kind === "kanban" ? "use note kanban …" : n.kind === "canvas" ? "use note canvas …" : n.kind === "folder" ? "a folder has no body; make a page in it" : "a PDF is its file";
  throw new CliError(`"${n.title}" is a ${n.kind}: ${hint}`);
};
const pageOf = (ctx: any) => {
  const n = ctx.e.notes.resolve(ctx.args.note);
  if (n.kind !== "page") throw new CliError(`"${n.title}" is a ${n.kind}; blocks are what pages are made of`);
  return n;
};

command({
  name: "note append",
  summary: "Add to a page or file without touching what's there: Markdown (or block JSON) to a page, text to a file or web file. At the end, at the top, under a heading or before a block or line.",
  description: "Pictures in the Markdown (`![a cat](~/Pictures/cat.png)`) are copied into the collection's media; [[Title]] links to the note of that title. For a block Markdown can't say (columns, a portal, coloured text), give its JSON with --json (`note block` prints real ones to copy).",
  args: [{ name: "note", description: "The page or file: id (or its start), exact title, or path (Folder/Page).", required: true }],
  flags: [
    { name: "md", type: "string", description: "What to add, as Markdown (a page) or plain text (a file). `-` reads stdin.", placeholder: "MARKDOWN" },
    { name: "md-file", type: "string", description: "Read what to add from a file.", placeholder: "PATH" },
    { name: "json", type: "string", description: "Pages: blocks to add as JSON (one node, a list of them or a doc). `-` reads stdin.", placeholder: "JSON" },
    ...editWhere,
  ],
  writes: true,
  dryRun: true,
  examples: ['etude note append "Journal/2026-11-08" --md "- [ ] Lab 2 · Q7"', 'etude note append Journal --under "TODO" --md-file todo.md', 'etude note append Journal --top --md "> [!note] read me first"', 'etude note append main.py --md "print(\'done\')"', 'etude note append Journal --json \'{"type":"callout","attrs":{"kind":"tip"},"content":[{"type":"paragraph","content":[{"type":"text","text":"hi"}]}]}\''],
  output: "{ id, title, path, at, added, markdown } for a page (markdown: the blocks added); { id, title, path, line } for a file",
  run(ctx) {
    const n = editable(ctx);
    const md = textInput(ctx, ctx.flags.md, ctx.flags["md-file"]);
    const json = ctx.flags.json === "-" ? ctx.stdin() : ctx.flags.json;
    if ((md === undefined) === (json === undefined)) throw new CliError("give --md (or --md-file) or --json");
    if ([ctx.flags.under !== undefined, ctx.flags.at !== undefined, !!ctx.flags.top].filter(Boolean).length > 1) throw new CliError("give one of --under, --at or --top");
    if (n.kind !== "page") {
      if (json !== undefined || ctx.flags.under !== undefined) throw new CliError(`"${n.title}" is a ${n.kind}: it takes plain text with --md, at the end, --top or --at LINE`);
      const r = insertText(n.content ?? "", md!, { at: ctx.flags.at, top: !!ctx.flags.top });
      const saved = ctx.e.notes.update(n.id, { content: r.content });
      return { id: saved.id, title: saved.title, path: pathOf(ctx, saved.id), line: r.line };
    }
    const mc = mdContext(ctx);
    const add = json !== undefined ? checkBlocks(parseJson(json, "--json")) : blocksFromMarkdown(md!, mc);
    const { doc, at } = insertBlocks(n.doc, add, { under: ctx.flags.under, at: ctx.flags.at, top: !!ctx.flags.top });
    const saved = ctx.e.notes.update(n.id, { doc });
    return { id: saved.id, title: saved.title, path: pathOf(ctx, saved.id), at, added: add.length, markdown: changedBlocks(saved.doc, at, add.length, mc) };
  },
});

command({
  name: "note patch",
  summary: "Replace a piece of a page or file, like find-and-replace: on a page's Markdown (what `note read` shows), only the blocks it touches change; on a file or web file, the exact text.",
  description:
    "`--old` must appear exactly once unless `--all`. On a page it can span several blocks (a heading and the list under it). Ticking a to-do is `--old \"- [ ] Lab 2\" --new \"- [x] Lab 2\"`; an empty `--new` removes the text. A block Markdown can't hold whole (a portal, columns, coloured text, a toggle) isn't rewritten: when the text sits inside one run of its text, it's swapped in place and the formatting stays; otherwise the change is refused unless `--force` (or change that block with `note block`).",
  args: [{ name: "note", description: "The page or file: id (or its start), exact title, or path (Folder/Page).", required: true }],
  flags: [
    { name: "old", type: "string", description: "The text to replace, as it reads in the page's Markdown or the file.", placeholder: "TEXT" },
    { name: "old-file", type: "string", description: "Read the text to replace from a file.", placeholder: "PATH" },
    { name: "new", type: "string", description: "What goes in its place (Markdown on a page). Empty to remove. `-` reads stdin.", placeholder: "TEXT" },
    { name: "new-file", type: "string", description: "Read what goes in its place from a file.", placeholder: "PATH" },
    { name: "all", type: "boolean", description: "Replace every place it appears." },
    { name: "force", type: "boolean", description: "Pages: rewrite blocks Markdown can't hold whole, losing what Markdown can't say." },
  ],
  writes: true,
  dryRun: true,
  examples: ['etude note patch Journal --old "- [ ] Networking - Lab 2" --new "- [x] Networking - Lab 2"', 'etude note patch "Main/Ideas" --old "teh" --new "the" --all', 'etude note patch main.py --old "range(10)" --new "range(n)"'],
  output: "page: { id, title, path, replaced, blocks, mode: markdown|text|mixed, notice?, markdown } (markdown: the blocks after the change; notice: when a block changed kind); file: { id, title, path, replaced, lines }",
  run(ctx) {
    const n = editable(ctx);
    const old = textInput(ctx, ctx.flags.old, ctx.flags["old-file"]);
    const neu = textInput(ctx, ctx.flags.new, ctx.flags["new-file"]);
    if (old === undefined) throw new CliError("give --old (the text to replace)");
    if (neu === undefined) throw new CliError('give --new (what goes in its place; "" removes it)');
    if (n.kind !== "page") {
      const r = patchText(n.content ?? "", old, neu, { all: !!ctx.flags.all });
      const saved = ctx.e.notes.update(n.id, { content: r.content });
      return { id: saved.id, title: saved.title, path: pathOf(ctx, saved.id), replaced: r.replaced, lines: r.lines };
    }
    const mc = mdContext(ctx);
    const r = patchDoc(n.doc, old, neu, { all: !!ctx.flags.all, force: !!ctx.flags.force, ctx: mc });
    const saved = ctx.e.notes.update(n.id, { doc: r.doc });
    const first = Math.min(...r.blocks);
    const grown = (saved.doc.content?.length ?? 0) - (n.doc.content?.length ?? 0);
    const span = Math.max(0, Math.max(...r.blocks) - first + 1 + grown);
    return { id: saved.id, title: saved.title, path: pathOf(ctx, saved.id), replaced: r.replaced, blocks: r.blocks, mode: r.mode, ...(r.notice ? { notice: r.notice } : {}), markdown: changedBlocks(saved.doc, first, span, mc) };
  },
});

command({
  name: "note block",
  summary: "One top-level block of a page as JSON (the editor's own node: columns, toggles, portals, colours and all), or change it: replace it with JSON or Markdown, move it, or delete it.",
  description:
    "Blocks are numbered from 0 as `note read --blocks` shows them. Without a change it prints the block, which is the way to see how a column layout, a callout, a coloured run or an embed is written before making one. `--to N` moves it (with `--count` the blocks after it too) to sit before block N of the page as it is now.",
  args: [
    { name: "note", description: "The page: id (or its start), exact title, or path (Folder/Page).", required: true },
    { name: "n", description: "The block's number (0 = first).", required: true },
  ],
  flags: [
    { name: "set", type: "string", description: "Replace it with this JSON (one node, or a list to put several in its place). `-` reads stdin.", placeholder: "JSON" },
    { name: "md", type: "string", description: "Replace it with this Markdown. `-` reads stdin.", placeholder: "MARKDOWN" },
    { name: "to", type: "number", description: "Move it before block N (the page's length moves it to the end).", placeholder: "N" },
    { name: "delete", type: "boolean", description: "Delete it." },
    { name: "count", type: "number", description: "With --to or --delete: this many blocks from N.", placeholder: "K" },
  ],
  writes: true,
  dryRun: true,
  examples: ['etude note block Journal 3', 'etude note block Journal 3 --to 0', 'etude note block Journal 5 --delete --count 2', "etude note block Journal 2 --set -  < block.json"],
  output: "the block's JSON; after a change { id, title, path, blocks: [{ n, type, markdown }] } (the page's blocks around it)",
  run(ctx) {
    const n = pageOf(ctx);
    const i = Number(ctx.args.n);
    if (!Number.isInteger(i)) throw new CliError("<n> is a block number");
    const set = ctx.flags.set === "-" ? ctx.stdin() : ctx.flags.set;
    const md = ctx.flags.md === "-" ? ctx.stdin() : ctx.flags.md;
    const ops = [set !== undefined, md !== undefined, ctx.flags.to !== undefined, !!ctx.flags.delete].filter(Boolean).length;
    if (!ops) return getBlock(n.doc, i);
    if (ops > 1) throw new CliError("give one of --set, --md, --to or --delete");
    const mc = mdContext(ctx);
    const count = ctx.flags.count ?? 1;
    let doc;
    let around = i;
    if (set !== undefined) doc = setBlock(n.doc, i, checkBlocks(parseJson(set, "--set")));
    else if (md !== undefined) doc = setBlock(n.doc, i, md.trim() ? blocksFromMarkdown(md, mc) : [{ type: "paragraph" }]);
    else if (ctx.flags.delete) doc = deleteBlocks(n.doc, i, count);
    else {
      doc = moveBlocks(n.doc, i, ctx.flags.to, count);
      around = ctx.flags.to > i ? ctx.flags.to - count : ctx.flags.to;
    }
    const saved = ctx.e.notes.update(n.id, { doc });
    const from = Math.max(0, around - 1);
    const list = blockList(saved.doc, mc).slice(from, from + count + 2).map(({ n, type, markdown }) => ({ n, type, markdown }));
    return { id: saved.id, title: saved.title, path: pathOf(ctx, saved.id), blocks: list };
  },
});

// ---------------------------------------------------------------- canvas elements

const canvasOf = (ctx: any, ref = ctx.args.canvas) => {
  const n = ctx.e.notes.resolve(ref);
  if (n.kind !== "canvas") throw new CliError(`"${n.title}" is a ${n.kind}, not a canvas`);
  return n;
};

const elementFlags = [
  { name: "x", type: "number" as const, description: "Left edge (canvas units; the canvas grows to fit).", placeholder: "N" },
  { name: "y", type: "number" as const, description: "Top edge.", placeholder: "N" },
  { name: "width", type: "number" as const, description: "Width.", placeholder: "N" },
  { name: "height", type: "number" as const, description: "Height.", placeholder: "N" },
  { name: "text", type: "string" as const, description: "A text element's words, or the label inside a shape or on an arrow (a frame's name). `-` reads stdin." },
  { name: "color", type: "string" as const, description: "Line and text colour: #rrggbb or black, gray, red, pink, grape, violet, indigo, blue, cyan, teal, green, lime, yellow, orange." },
  { name: "background", type: "string" as const, description: "Fill: #rrggbb, transparent, or a name (the toolbar's light shade of it)." },
  { name: "fill", type: "string" as const, description: "solid, hachure, cross-hatch or zigzag." },
  { name: "stroke-width", type: "number" as const, description: "Line width (1 thin, 2, 4 bold).", placeholder: "N" },
  { name: "stroke-style", type: "string" as const, description: "solid, dashed or dotted." },
  { name: "roughness", type: "number" as const, description: "0 clean lines, 1 hand-drawn, 2 sketchy.", placeholder: "N" },
  { name: "opacity", type: "number" as const, description: "0 to 100.", placeholder: "N" },
  { name: "font-size", type: "number" as const, description: "Text size (20 by default).", placeholder: "N" },
  { name: "font", type: "string" as const, description: "hand, normal or code." },
  { name: "align", type: "string" as const, description: "left, center or right." },
  { name: "from", type: "string" as const, description: "Arrows and lines: start at this element (it follows when the element moves).", placeholder: "ID" },
  { name: "to", type: "string" as const, description: "Arrows and lines: end at this element.", placeholder: "ID" },
  { name: "points", type: "string" as const, description: "Arrows and lines: the points it runs through, relative to x,y, as JSON ([[0,0],[120,40],[200,0]]).", placeholder: "JSON" },
  { name: "head", type: "string" as const, description: "Arrows: arrow, triangle, dot, bar, or none." },
  { name: "link", type: "string" as const, description: "A link it opens (a URL)." },
  { name: "frame", type: "string" as const, description: "Put it inside this frame (id); empty to take it out.", placeholder: "ID" },
];

function specOf(ctx: any) {
  const f = ctx.flags;
  const text = f.text === "-" ? ctx.stdin() : f.text;
  const points = f.points !== undefined ? parseJson(f.points, "--points") : undefined;
  return {
    x: f.x, y: f.y, width: f.width, height: f.height, text, color: f.color, background: f.background, fill: f.fill, strokeWidth: f["stroke-width"], strokeStyle: f["stroke-style"],
    roughness: f.roughness, opacity: f.opacity, fontSize: f["font-size"], font: f.font, align: f.align, from: f.from, to: f.to, points, head: f.head, link: f.link, frame: f.frame,
  };
}
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

command({
  name: "note canvas",
  summary: "Every element on a canvas, back to front: id, type, box (x, y, width, height), its words (or its label), what an arrow connects, colours.",
  args: [{ name: "canvas", description: "The canvas: id (or its start), exact title, or path.", required: true }],
  examples: ['etude note canvas "Study loop · canvas"'],
  output: "array of { id, type, x, y, width, height, text?, from?, to?, color?, background?, frame?, link? }",
  run: (ctx) => listElements(canvasOf(ctx).scene!),
});

command({
  name: "note canvas add",
  summary: "Draw on a canvas: a rectangle, ellipse, diamond, text, arrow, line, picture or frame. Shapes take a label with --text; arrows connect two elements with --from and --to.",
  args: [
    { name: "canvas", description: "The canvas: id (or its start), exact title, or path.", required: true },
    { name: "type", description: "rectangle, ellipse, diamond, text, arrow, line, image or frame.", required: true },
  ],
  flags: [...elementFlags, { name: "file", type: "string", description: "A picture (image): this file, copied into the collection's media.", placeholder: "PATH" }],
  writes: true,
  dryRun: true,
  examples: ['etude note canvas add Board rectangle --x 0 --y 0 --text "Encode" --background blue', 'etude note canvas add Board arrow --from k3Fh2 --to Qp81a --text "retrieve"', 'etude note canvas add Board text --x 0 --y -60 --text "The study loop" --font-size 28', "etude note canvas add Board image --file diagram.png --x 300 --y 0"],
  output: "{ id, label?, element } (element: the new one, as `note canvas list` shows it)",
  async run(ctx) {
    const n = canvasOf(ctx);
    const spec: any = specOf(ctx);
    if (ctx.flags.file !== undefined) {
      if (ctx.args.type !== "image") throw new CliError("--file is for a picture (type image)");
      const { readFileSync } = await import("node:fs");
      const m = ctx.e.importMedia(ctx.flags.file, { dryRun: ctx.dry });
      if (m.kind !== "image") throw new CliError(`${ctx.flags.file} isn't a picture`);
      let size = null;
      try {
        size = imageSize(readFileSync(ctx.flags.file.replace(/^~(?=\/)/, process.env.HOME ?? "~")));
      } catch {}
      spec.image = { media: m.file, mimeType: m.mime, ...(size ?? {}) };
    }
    const r = addElement(n.scene!, ctx.args.type, clean(spec));
    const saved = ctx.e.notes.update(n.id, { scene: r.scene });
    return { id: r.id, ...(r.label ? { label: r.label } : {}), element: listElements(saved.scene!).find((e) => e.id === r.id) };
  },
});

command({
  name: "note canvas edit",
  summary: "Change an element: its words, colours, size, place (--x/--y, or --dx/--dy to nudge), ends (arrows), or bring it to the front or send it to the back. A shape's label and the arrows tied to it follow.",
  args: [
    { name: "canvas", description: "The canvas: id (or its start), exact title, or path.", required: true },
    { name: "element", description: "The element's id (or its first 4+ characters), from `note canvas list`.", required: true },
  ],
  flags: [...elementFlags, { name: "dx", type: "number", description: "Move it right by this much (negative: left).", placeholder: "N" }, { name: "dy", type: "number", description: "Move it down by this much.", placeholder: "N" }, { name: "front", type: "boolean", description: "Bring it in front of everything." }, { name: "back", type: "boolean", description: "Send it behind everything." }],
  writes: true,
  dryRun: true,
  examples: ['etude note canvas edit Board k3Fh2 --text "Encode (week 1)"', "etude note canvas edit Board k3Fh2 --dx 120 --background green", "etude note canvas edit Board Qp81a --front"],
  output: "{ id, element }",
  run(ctx) {
    const n = canvasOf(ctx);
    if (ctx.flags.front && ctx.flags.back) throw new CliError("--front or --back, not both");
    const patch: any = clean({ ...specOf(ctx), dx: ctx.flags.dx, dy: ctx.flags.dy, order: ctx.flags.front ? "front" : ctx.flags.back ? "back" : undefined });
    if (!Object.keys(patch).length) throw new CliError("nothing to change: give --text, --x, --dx, --color, --background, --front … (see --help)");
    const r = editElement(n.scene!, ctx.args.element, patch);
    const saved = ctx.e.notes.update(n.id, { scene: r.scene });
    return { id: r.id, element: listElements(saved.scene!).find((e) => e.id === r.id) };
  },
});

command({
  name: "note canvas delete",
  summary: "Remove elements from a canvas, with their labels; arrows that pointed at them stay, let go.",
  args: [
    { name: "canvas", description: "The canvas: id (or its start), exact title, or path.", required: true },
    { name: "elements", description: "Element ids (or their first 4+ characters).", required: true, variadic: true },
  ],
  writes: true,
  dryRun: true,
  examples: ["etude note canvas delete Board k3Fh2 Qp81a"],
  output: "{ removed: [ids] }",
  run(ctx) {
    const n = canvasOf(ctx);
    const r = deleteElements(n.scene!, ctx.args.elements);
    ctx.e.notes.update(n.id, { scene: r.scene });
    return { removed: r.removed };
  },
});

command({
  name: "note portal",
  summary: "Open a portal in a page: a window onto a web file (live), a canvas or a kanban board, at the end of the page or at --at. Edits to the note show through every portal to it.",
  args: [
    { name: "note", description: "The web file, canvas or kanban board: id (or its start), exact title, or path.", required: true },
    { name: "page", description: "The page the portal goes in: id (or its start), exact title, or path.", required: true },
  ],
  flags: [
    { name: "at", type: "string", description: "Put the portal before the page's top-level block number N (0 = at the very top). The end by default.", placeholder: "N" },
    { name: "height", type: "string", description: "The portal's height in px (80 to 4000). A web file sizes itself to its content by default.", placeholder: "PX" },
  ],
  writes: true,
  dryRun: true,
  examples: ['etude note portal "Term timeline" "Journal"', 'etude note portal "Term timeline" "Journal" --at 0'],
  output: "the page after the change, as `note show` prints it",
  run(ctx) {
    const target = ctx.e.notes.resolve(ctx.args.note);
    const page = ctx.e.notes.resolve(ctx.args.page);
    const at = ctx.flags.at === undefined ? undefined : Number(ctx.flags.at);
    if (at !== undefined && !Number.isInteger(at)) throw new CliError("--at is a whole number");
    const height = ctx.flags.height === undefined ? undefined : Number(ctx.flags.height);
    return ctx.e.notes.portal(page.id, target.id, { at, height });
  },
});

command({
  name: "note move",
  summary: "Put a page inside another page, or at the top level with --top.",
  args: [
    { name: "note", description: "The note to move: id (or its start), exact title, or path.", required: true },
    { name: "parent", description: "The folder or page it goes into (id, title or path). Leave out with --top." },
  ],
  flags: [{ name: "top", type: "boolean", description: "Make it a top-level page." }, { name: "index", type: "number", description: "Place among its new siblings, 0 first. Default: last." }],
  writes: true,
  dryRun: true,
  output: "the moved page",
  run(ctx) {
    if (!ctx.flags.top && !ctx.args.parent) throw new CliError("give a parent page, or --top");
    if (ctx.flags.top && ctx.args.parent) throw new CliError("give a parent or --top, not both");
    const n = ctx.e.notes.resolve(ctx.args.note);
    const parent = ctx.flags.top ? null : ctx.e.notes.resolve(ctx.args.parent).id;
    return ctx.e.notes.move(n.id, parent, ctx.flags.index ?? undefined);
  },
});

for (const archived of [true, false]) {
  command({
    name: archived ? "note archive" : "note unarchive",
    summary: archived ? "Archive a page and the pages inside it. Nothing is deleted." : "Bring an archived page back, with the pages inside it.",
    args: [{ name: "note", description: "Id (or its start), exact title, or path (Folder/Page).", required: true }],
    writes: true,
    dryRun: true,
    output: "{ ids, archived }",
    run(ctx) {
      const id = archived ? ctx.e.notes.resolve(ctx.args.note).id : ctx.args.note;
      return ctx.e.notes.setArchived(id, archived);
    },
  });
}

command({
  name: "note delete",
  summary: "Delete a page for good, with every page inside it.",
  args: [{ name: "note", description: "Id (or its start), exact title, or path (Folder/Page).", required: true }],
  writes: true,
  dryRun: true,
  confirm: true,
  output: "{ ids }",
  run(ctx) {
    return ctx.e.notes.delete(ctx.e.notes.resolve(ctx.args.note).id);
  },
});

command({
  name: "note search",
  summary: "Pages whose title or text has every word, title matches first.",
  args: [{ name: "query", description: "Words to look for.", required: true, variadic: true }],
  flags: [{ name: "limit", type: "number", description: "At most this many.", default: 20 }],
  output: "array of { id, title, …, snippet }",
  run(ctx) {
    const q = Array.isArray(ctx.args.query) ? ctx.args.query.join(" ") : String(ctx.args.query);
    return ctx.e.notes.search(q, ctx.flags.limit ?? 20);
  },
});

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

command({
  name: "note import",
  summary: "Import markdown files or a whole folder (an Obsidian vault) as pages, PDFs as PDF notes, code and text files (.py, .tex, …) as files, and .excalidraw drawings as canvases.",
  description:
    "Each markdown file becomes a page and each folder a page holding its files, so a vault keeps its shape. [[Links]] (with |alias and #heading), relative .md links and ![[image]] embeds are understood; images found in the folder are stored in the collection's media. A folder note (Folder/Folder.md) becomes the folder's own page. Hidden folders (.obsidian, .trash) are skipped. A .excalidraw file given on its own becomes a canvas, with its pictures stored in the media. Each PDF (on its own or in a folder) becomes a PDF note that opens as the document. Code, LaTeX and other text files (.py, .tex, .js, .json, …) become files: kept exactly as written and opened in a plain editor.",
  args: [{ name: "paths", description: "Markdown files or folders.", required: true, variadic: true }],
  flags: [{ name: "parent", type: "string", description: "Put the imported pages inside this page (id or exact title)." }],
  writes: true,
  dryRun: true,
  examples: ["etude note import ~/vault", 'etude note import week1.md week2.md --parent "Algorithms"', "etude note import board.excalidraw"],
  output: "{ pages, folders, files, links, unresolved, pdfs, root, ids, media, canvases }",
  async run(ctx) {
    const { existsSync, readdirSync, readFileSync, statSync } = await import("node:fs");
    const { basename, join, relative, resolve } = await import("node:path");
    const files: { path: string; text: string }[] = [];
    const images: { rel: string; abs: string }[] = [];
    const pdfFiles: { rel: string; abs: string }[] = [];
    const all = (Array.isArray(ctx.args.paths) ? ctx.args.paths : [ctx.args.paths]).map((p: string) => resolve(p));
    const drawings = all.filter((p: string) => /\.excalidraw(\.json)?$/i.test(p));
    const paths = all.filter((p: string) => !drawings.includes(p));
    const parentFor = () => (ctx.flags.parent ? ctx.e.notes.resolve(ctx.flags.parent).id : null);
    const canvases: string[] = [];
    for (const d of drawings) {
      if (!existsSync(d)) throw new CliError(`no such file: ${d}`, "not_found");
      const scene = sceneFromExcalidraw(parseJson(readFileSync(d, "utf8"), basename(d)), (name, data) => ctx.e.storeMedia(name, data, { dryRun: ctx.dry }));
      canvases.push(ctx.e.notes.create({ title: basename(d).replace(/\.excalidraw(\.json)?$/i, ""), parentId: parentFor(), kind: "canvas", scene }).id);
    }
    if (!paths.length) return { pages: 0, folders: 0, files: 0, links: 0, unresolved: 0, pdfs: 0, root: null, ids: [], media: 0, canvases };
    for (const p of paths) {
      if (!existsSync(p)) throw new CliError(`no such file or folder: ${p}`, "not_found");
      if (statSync(p).isDirectory()) {
        const base = basename(p);
        const walk = (dir: string) => {
          for (const name of readdirSync(dir)) {
            if (name.startsWith(".")) continue;
            const abs = join(dir, name);
            const rel = join(base, relative(p, abs)).replace(/\\/g, "/");
            if (statSync(abs).isDirectory()) walk(abs);
            else if (/\.(md|markdown)$/i.test(name) || isTextFile(name)) files.push({ path: rel, text: readFileSync(abs, "utf8") });
            else if (IMAGE.test(name)) images.push({ rel: relative(p, abs).replace(/\\/g, "/"), abs });
            else if (/\.pdf$/i.test(name)) pdfFiles.push({ rel, abs });
          }
        };
        walk(p);
      } else if (/\.pdf$/i.test(p)) pdfFiles.push({ rel: basename(p), abs: p });
      else files.push({ path: basename(p), text: readFileSync(p, "utf8") });
    }
    const media: Record<string, string> = {};
    let stored = 0;
    for (const im of images) {
      const m = ctx.e.storeMedia(basename(im.abs), readFileSync(im.abs), { dryRun: ctx.dry });
      media[im.rel] = m.url;
      media[basename(im.abs)] ??= m.url;
      stored++;
    }
    const pdfs = pdfFiles.map((f) => ({ path: f.rel, file: ctx.e.storeMedia(basename(f.abs), readFileSync(f.abs), { dryRun: ctx.dry }).url }));
    const parentId = parentFor();
    return { ...ctx.e.notes.importMarkdown(files, { parentId, media, pdfs }), media: stored, canvases };
  },
});

command({
  name: "note tutorial",
  summary: "Add the Notes tutorial: a folder of pages that shows what Notes can do, each with a short Try it yourself, and the deck Notes::Notes showcase with its cards.",
  description:
    "Notes adds it by itself the first time it opens on a collection, once: archiving or deleting it doesn't bring it back. Without --if-new this adds a fresh copy at the top level (its cards keep their history). --if-new does what opening Notes does: adds it only if this collection has never had it.",
  flags: [{ name: "if-new", type: "boolean", description: "Only if this collection has never had it (what opening Notes does)." }],
  writes: true,
  dryRun: "self",
  examples: ["etude note tutorial", "etude note tutorial --if-new"],
  output: "{ added, reason?: seen|exists, root, start, notes, items }",
  async run(ctx) {
    const { addNotesTutorial } = await import("../../core/notes-tutorial.ts");
    return addNotesTutorial(ctx.e, { ifNew: !!ctx.flags["if-new"], dryRun: ctx.dry });
  },
});

command({
  name: "note export",
  summary: "A page as Markdown (with [[links]]) or as a standalone HTML file; a canvas as a .excalidraw file; a kanban board as Markdown Obsidian's Kanban plugin opens; a file as its own text.",
  args: [{ name: "note", description: "Id (or its start), exact title, or path (Folder/Page).", required: true }],
  flags: [
    { name: "format", type: "string", values: ["md", "html"], default: "md", description: "md or html (a canvas is always .excalidraw)." },
    { name: "output", short: "o", type: "string", description: "Write to this file instead of stdout.", placeholder: "PATH" },
  ],
  output: "the page's text (or { file } with -o)",
  async run(ctx) {
    const { docToHtml, docToMarkdown } = await import("../../core/notes-md.ts");
    const n = ctx.e.notes.resolve(ctx.args.note);
    const { sceneToExcalidraw } = await import("../../core/notes.ts");
    const { boardToMarkdown } = await import("../../core/kanban.ts");
    const out = n.kind === "file" || n.kind === "web" ? (n.content ?? "") : n.kind === "kanban" ? boardToMarkdown(n.board!, (d) => docToMarkdown(d)) : n.kind === "canvas" ? JSON.stringify(sceneToExcalidraw(n.scene!, (m) => ctx.e.readMediaFile(m)), null, 2) : ctx.flags.format === "html" ? docToHtml(n.doc, n.title) : docToMarkdown(n.doc, n.title);
    if (ctx.flags.output) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(ctx.flags.output, out);
      return { file: ctx.flags.output };
    }
    return out;
  },
});

command({
  name: "note pin",
  summary: "Pin a page to the start page (a New tab in Notes). Pins show in the order they were made.",
  args: [{ name: "note", description: "Id (or its start), exact title, or path (Folder/Page).", required: true }],
  writes: true,
  examples: ['etude note pin "Graphics"'],
  output: "{ id, title, …, pinned }",
  run(ctx) {
    return ctx.e.notes.pin(ctx.e.notes.resolve(ctx.args.note).id);
  },
});

command({
  name: "note unpin",
  summary: "Take a page off the start page.",
  args: [{ name: "note", description: "Id (or its start), exact title, or path (Folder/Page).", required: true }],
  writes: true,
  output: "{ id, title, …, pinned: null }",
  run(ctx) {
    return ctx.e.notes.unpin(ctx.e.notes.resolve(ctx.args.note).id);
  },
});

command({
  name: "note pinned",
  summary: "The pages pinned to the start page, in pin order (archived ones left out).",
  output: "array of { id, title, …, pinned }",
  run(ctx) {
    return ctx.e.notes.pinnedList();
  },
});

command({
  name: "note recent",
  summary: "What the app opened last, newest first: the start page's Jump back in (folders left out).",
  flags: [{ name: "limit", type: "number", description: "At most this many.", default: 10 }],
  output: "array of { id, title, …, opened }",
  run(ctx) {
    return ctx.e.notes.recent(ctx.flags.limit ?? 10);
  },
});

command({
  name: "note graph",
  summary: "Every page as a point and every [[link]] between pages as a line (what the graph view draws).",
  output: "{ nodes: [{ id, kind, title, icon, parentId, links, created, tags }], links: [{ from, to, kind: link|parent }] }",
  run(ctx) {
    return ctx.e.notes.graph();
  },
});

command({
  name: "note backlinks",
  summary: "The pages that link to a page.",
  args: [{ name: "note", description: "Id (or its start), exact title, or path (Folder/Page).", required: true }],
  output: "array of { id, title, …, snippet }",
  run(ctx) {
    return ctx.e.notes.backlinks(ctx.e.notes.resolve(ctx.args.note).id);
  },
});

// ---------------------------------------------------------------- kanban boards

const boardOf = (ctx: any) => {
  const n = ctx.e.notes.resolve(ctx.args.board);
  if (n.kind !== "kanban") throw new CliError(`"${n.title}" isn't a kanban board`);
  return n;
};
const dueOf = (v: unknown): string | null | undefined => {
  if (v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "" || s === "none") return null;
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (s === "today") return day(new Date());
  if (s === "tomorrow") return day(new Date(Date.now() + 864e5));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new CliError("--due is a day: YYYY-MM-DD, today, tomorrow or none");
  return s;
};
const cardFlags = [
  { name: "due", type: "string" as const, description: "Due day: YYYY-MM-DD, today, tomorrow, or none to clear it.", placeholder: "DAY" },
  { name: "label", type: "string" as const, multiple: true, description: "A label by name (made if the board doesn't have it; name:colour picks its colour). Repeat for more.", placeholder: "NAME" },
  { name: "cover", type: "string" as const, description: "A colour across the top: grey, red, orange, gold, green, teal, blue, purple, pink, or none.", placeholder: "COLOUR" },
  { name: "text", type: "string" as const, description: "The card's page as plain text: one paragraph per line, `# ` headings, `- ` bullets, `- [ ] ` to-dos (they show as n/m on the card). `-` reads stdin." },
  { name: "md", type: "string" as const, description: "The card's page as Markdown (headings, - [ ] to-dos, tables, pictures, [[links]]). `-` reads stdin.", placeholder: "MARKDOWN" },
  { name: "doc", type: "string" as const, description: "The card's page as a document tree (ProseMirror JSON). `-` reads stdin." },
];
const cardDoc = (ctx: any) => {
  const text = textInput(ctx, ctx.flags.text, undefined);
  const md = textInput(ctx, ctx.flags.md, undefined);
  const raw = ctx.flags.doc === "-" ? ctx.stdin() : ctx.flags.doc;
  if ([text, md, raw].filter((x) => x !== undefined).length > 1) throw new CliError("give one of --md, --text or --doc");
  if (md !== undefined) return { type: "doc", content: md.trim() ? blocksFromMarkdown(md, mdContext(ctx)) : [{ type: "paragraph" }] };
  return raw !== undefined ? parseJson(raw, "--doc") : text !== undefined ? docFromText(text) : undefined;
};
const coverOf = (v: unknown) => (v === undefined ? undefined : String(v) === "none" ? null : String(v));
/** The board in short: each column with its cards, for reading at a glance. */
function boardBrief(n: any) {
  const b = n.board;
  const label = new Map(b.labels.map((l: any) => [l.id, l.name]));
  const doneOf = (doc: any) => {
    let all = 0, done = 0;
    const walk = (x: any) => (x.type === "taskItem" && (all++, x.attrs?.checked && done++), x.content?.forEach(walk));
    walk(doc);
    return all ? `${done}/${all}` : undefined;
  };
  return {
    id: n.id,
    title: n.title,
    columns: b.columns.map((c: any) => ({
      id: c.id, name: c.name, ...(c.limit ? { limit: c.limit } : {}), ...(c.done ? { done: true } : {}),
      cards: c.cards.map((k: string) => { const x = b.cards[k]; return { id: x.id, title: x.title, ...(x.due ? { due: x.due } : {}), ...(x.labels.length ? { labels: x.labels.map((l: string) => label.get(l)) } : {}), ...(doneOf(x.doc) ? { todos: doneOf(x.doc) } : {}) }; }),
    })),
    ...(b.archived.length ? { archived: b.archived.length } : {}),
  };
}

command({
  name: "note kanban",
  summary: "A kanban board at a glance: each column with its cards (id, title, due day, labels, to-dos done).",
  args: [{ name: "board", description: "The board: id (or its start), exact title, or path.", required: true }],
  flags: [{ name: "full", type: "boolean", description: "The whole board: every card's page, labels, colours, archived cards." }],
  examples: ['etude note kanban "Sprint"', 'etude note kanban "Sprint" --full'],
  output: "{ id, title, columns: [{ id, name, limit?, done?, cards: [{ id, title, due?, labels?, todos? }] }], archived? } (or the note with its board, with --full)",
  run(ctx) {
    const n = boardOf(ctx);
    return ctx.flags.full ? n : boardBrief(n);
  },
});

command({
  name: "note kanban add",
  summary: "Add a card to a board: at the end of a column (the first by default), with a due day, labels, a cover and a page.",
  args: [
    { name: "board", description: "The board: id (or its start), exact title, or path.", required: true },
    { name: "title", description: "The card's title.", required: true },
  ],
  flags: [{ name: "column", type: "string", description: "The column: its name, id or number (1 = first).", placeholder: "COLUMN" }, { name: "at", type: "number", description: "Its place in the column (0 = top). The bottom by default.", placeholder: "N" }, ...cardFlags],
  writes: true,
  dryRun: true,
  examples: ['etude note kanban add "Sprint" "Lab 2 · DNS" --column Doing --due 2026-11-08 --label "Networking:blue" --text "- [ ] traces\\n- [ ] Q1–Q9"'],
  output: "{ card, column, board } (the board in short)",
  async run(ctx) {
    const { addCard } = await import("../../core/kanban.ts");
    const n = boardOf(ctx);
    const { board, card } = addCard(n.board, ctx.flags.column, { title: ctx.args.title, due: dueOf(ctx.flags.due) ?? null, labels: ctx.flags.label, cover: coverOf(ctx.flags.cover) ?? null, doc: cardDoc(ctx), at: ctx.flags.at });
    if (ctx.dry) return { card, column: board.columns.find((c) => c.cards.includes(card.id))!.name, board: boardBrief({ ...n, board }) };
    const saved = ctx.e.notes.update(n.id, { board });
    return { card: saved.board!.cards[card.id], column: saved.board!.columns.find((c) => c.cards.includes(card.id))!.name, board: boardBrief(saved) };
  },
});

command({
  name: "note kanban move",
  summary: "Move a card to a column (and a place in it); an archived card comes back this way too.",
  args: [
    { name: "board", description: "The board: id (or its start), exact title, or path.", required: true },
    { name: "card", description: "The card: id, or its exact title.", required: true },
    { name: "column", description: "The column: its name, id or number (1 = first).", required: true },
  ],
  flags: [{ name: "at", type: "number", description: "Its place in the column (0 = top). The bottom by default.", placeholder: "N" }],
  writes: true,
  dryRun: true,
  examples: ['etude note kanban move "Sprint" "Lab 2 · DNS" Done', 'etude note kanban move "Sprint" a1b2c3d4 2 --at 0'],
  output: "the board in short, as `note kanban` prints it",
  async run(ctx) {
    const { moveCard } = await import("../../core/kanban.ts");
    const n = boardOf(ctx);
    const board = moveCard(n.board, ctx.args.card, ctx.args.column, ctx.flags.at);
    return boardBrief(ctx.dry ? { ...n, board } : ctx.e.notes.update(n.id, { board }));
  },
});

command({
  name: "note kanban edit",
  summary: "Change a card: its title, due day, labels, cover or page.",
  args: [
    { name: "board", description: "The board: id (or its start), exact title, or path.", required: true },
    { name: "card", description: "The card: id, or its exact title.", required: true },
  ],
  flags: [
    { name: "title", type: "string", description: "New title." },
    { name: "no-labels", type: "boolean", description: "Take every label off." },
    ...cardFlags,
    { name: "old", type: "string", description: "Find-and-replace in the card's page: the text to replace, as `note kanban card` shows it (with --new).", placeholder: "TEXT" },
    { name: "new", type: "string", description: "What goes in place of --old (Markdown; empty removes it).", placeholder: "TEXT" },
    { name: "all", type: "boolean", description: "With --old: every place it appears." },
    { name: "append", type: "string", description: "Add Markdown at the end of the card's page. `-` reads stdin.", placeholder: "MARKDOWN" },
  ],
  writes: true,
  dryRun: true,
  examples: ['etude note kanban edit "Sprint" "Lab 2 · DNS" --due tomorrow --label Urgent', 'etude note kanban edit "Sprint" "Lab 2 · DNS" --old "- [ ] Q1–Q9" --new "- [x] Q1–Q9"', 'etude note kanban edit "Sprint" "Lab 2 · DNS" --append "- [ ] write-up"'],
  output: "{ card, board } (the board in short)",
  async run(ctx) {
    const { editCard, findCard } = await import("../../core/kanban.ts");
    const n = boardOf(ctx);
    const card = findCard(n.board, ctx.args.card);
    const id = card.id;
    let doc = cardDoc(ctx) as any;
    if (ctx.flags.old !== undefined || ctx.flags.append !== undefined) {
      if (doc !== undefined) throw new CliError("--old/--append change part of the page; --md, --text and --doc replace all of it: pick one");
      const mc = mdContext(ctx);
      doc = card.doc;
      if (ctx.flags.old !== undefined) {
        if (ctx.flags.new === undefined) throw new CliError('give --new with --old ("" removes it)');
        doc = patchDoc(doc, ctx.flags.old, ctx.flags.new, { all: !!ctx.flags.all, ctx: mc }).doc;
      }
      const add = ctx.flags.append === "-" ? ctx.stdin() : ctx.flags.append;
      if (add !== undefined) doc = insertBlocks(doc, blocksFromMarkdown(add, mc)).doc;
    }
    const board = editCard(n.board, id, { title: ctx.flags.title, due: dueOf(ctx.flags.due), labels: ctx.flags["no-labels"] ? [] : ctx.flags.label?.length ? ctx.flags.label : undefined, cover: coverOf(ctx.flags.cover), doc });
    const out = ctx.dry ? { ...n, board } : ctx.e.notes.update(n.id, { board });
    return { card: out.board!.cards[id], board: boardBrief(out) };
  },
});

command({
  name: "note kanban card",
  summary: "One card: its column, due day, labels, cover, and its page as Markdown.",
  args: [
    { name: "board", description: "The board: id (or its start), exact title, or path.", required: true },
    { name: "card", description: "The card: id, or its exact title.", required: true },
  ],
  examples: ['etude note kanban card "Sprint" "Lab 2 · DNS"'],
  output: "{ id, title, column, due, labels, cover, archived, markdown }",
  async run(ctx) {
    const { findCard } = await import("../../core/kanban.ts");
    const { docToMarkdown } = await import("../../core/notes-md.ts");
    const n = boardOf(ctx);
    const c = findCard(n.board, ctx.args.card);
    const b = n.board!;
    const col = b.columns.find((x: any) => x.cards.includes(c.id));
    const label = new Map(b.labels.map((l: any) => [l.id, l.name]));
    return { id: c.id, title: c.title, column: col?.name ?? null, due: c.due, labels: c.labels.map((l) => label.get(l) ?? l), cover: c.cover, archived: !col, markdown: docToMarkdown(c.doc).trimEnd() };
  },
});

command({
  name: "note kanban archive",
  summary: "Archive a card (it keeps its page, out of every column), or with --restore bring it back to the first column.",
  args: [
    { name: "board", description: "The board: id (or its start), exact title, or path.", required: true },
    { name: "card", description: "The card: id, or its exact title.", required: true },
  ],
  flags: [{ name: "restore", type: "boolean", description: "Bring an archived card back." }],
  writes: true,
  dryRun: true,
  output: "the board in short, as `note kanban` prints it",
  async run(ctx) {
    const { archiveCard } = await import("../../core/kanban.ts");
    const n = boardOf(ctx);
    const board = archiveCard(n.board, ctx.args.card, !ctx.flags.restore);
    return boardBrief(ctx.dry ? { ...n, board } : ctx.e.notes.update(n.id, { board }));
  },
});

command({
  name: "note kanban column",
  summary: "Add a column (when no column has this name) or change one: rename it, colour it, give it a limit, make its cards count as done, move it, or remove it (its cards go to the archive).",
  args: [
    { name: "board", description: "The board: id (or its start), exact title, or path.", required: true },
    { name: "column", description: "The column's name or id (a new name adds a column).", required: true },
  ],
  flags: [
    { name: "rename", type: "string", description: "New name.", placeholder: "NAME" },
    { name: "color", type: "string", description: "grey, red, orange, gold, green, teal, blue, purple or pink.", placeholder: "COLOUR" },
    { name: "limit", type: "number", description: "How many cards it should hold at most (shown, not enforced); 0 for none.", placeholder: "N" },
    { name: "done", type: "boolean", description: "Its cards count as done." },
    { name: "not-done", type: "boolean", description: "Its cards don't count as done." },
    { name: "at", type: "number", description: "Move it to this place (0 = first).", placeholder: "N" },
    { name: "remove", type: "boolean", description: "Remove the column; its cards go to the archive." },
  ],
  writes: true,
  dryRun: true,
  examples: ['etude note kanban column "Sprint" Review --at 2 --color purple', 'etude note kanban column "Sprint" Doing --limit 3', 'etude note kanban column "Sprint" Done --done'],
  output: "the board in short, as `note kanban` prints it",
  async run(ctx) {
    const { editColumn } = await import("../../core/kanban.ts");
    const n = boardOf(ctx);
    if (ctx.flags.done && ctx.flags["not-done"]) throw new CliError("--done or --not-done, not both");
    const board = editColumn(n.board, ctx.args.column, { name: ctx.flags.rename, color: ctx.flags.color, limit: ctx.flags.limit === undefined ? undefined : ctx.flags.limit === 0 ? null : ctx.flags.limit, done: ctx.flags.done ? true : ctx.flags["not-done"] ? false : undefined, at: ctx.flags.at, remove: !!ctx.flags.remove });
    return boardBrief(ctx.dry ? { ...n, board } : ctx.e.notes.update(n.id, { board }));
  },
});
