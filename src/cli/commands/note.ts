import { command, group, CliError } from "../registry.ts";
import { parseJson, readSource, textInput } from "../input.ts";
import { docFromText, isTextFile, sceneFromExcalidraw } from "../../core/notes.ts";

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
  args: [{ name: "note", description: "Page id, or its exact title.", required: true }],
  flags: [{ name: "text", type: "boolean", description: "Print only the plain text." }],
  output: "{ id, kind, parentId, title, icon, look, …, text, doc, scene } (or the text with --text)",
  run(ctx) {
    const n = ctx.e.notes.resolve(ctx.args.note);
    return ctx.flags.text ? n.text : n;
  },
});

const docFlags = [
  { name: "text", type: "string" as const, description: "Body as plain text: one paragraph per line, `# ` headings, `- ` bullets, `- [ ] ` tasks. `-` reads stdin." },
  { name: "text-file", type: "string" as const, description: "Read the plain-text body from a file.", placeholder: "PATH" },
  { name: "doc", type: "string" as const, description: "Body as a document tree (ProseMirror JSON, as `note show` prints it). `-` reads stdin." },
  { name: "doc-file", type: "string" as const, description: "Read the document tree from a file.", placeholder: "PATH" },
];

const lookFlags = [
  { name: "cover", type: "string" as const, description: "Cover across the top: a preset (sky, teal, plum, mustard, brick, moss, rose, night, dawn, sea, paper, ink), image:files/<sha>.<ext>[:y], or none." },
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
  { name: "content", type: "string" as const, description: "A file's text, exactly as written. `-` reads stdin.", placeholder: "TEXT" },
  { name: "content-file", type: "string" as const, description: "Read a file's text from this file on disk.", placeholder: "PATH" },
];
/** --content / --content-file, for a file note. */
const contentOf = (ctx: any): string | undefined => textInput(ctx, ctx.flags.content, ctx.flags["content-file"]);

function docOf(ctx: any): unknown {
  const text = textInput(ctx, ctx.flags.text, ctx.flags["text-file"]);
  const docRaw = ctx.flags.doc === "-" ? ctx.stdin() : ctx.flags.doc ?? (ctx.flags["doc-file"] !== undefined ? readSource(ctx, ctx.flags["doc-file"]) : undefined);
  if (text !== undefined && docRaw !== undefined) throw new CliError("give --text or --doc, not both");
  if (docRaw !== undefined) return parseJson(docRaw, "--doc");
  if (text !== undefined) return docFromText(text);
  return undefined;
}

command({
  name: "note new",
  summary: "Make a page, or with --folder a folder that only holds pages, or with --file a code or text file (main.py, notes.tex) opened in a plain editor.",
  args: [{ name: "title", description: "Its title.", required: true }],
  flags: [{ name: "parent", type: "string", description: "Put it inside this page or folder (id or exact title)." }, { name: "folder", type: "boolean", description: "Make a folder: it holds pages and has no body of its own." }, { name: "icon", type: "string", description: "One emoji." }, { name: "canvas", type: "boolean", description: "Make a canvas (a whiteboard you draw on) instead of a page." }, { name: "pdf", type: "string", description: "Make a PDF note from this file: it opens as the document itself. The file goes into the collection's media.", placeholder: "PATH" }, { name: "scene", type: "string", description: "A canvas's drawing as Excalidraw JSON ({ elements, appState, files }, or a whole .excalidraw file). `-` reads stdin.", placeholder: "JSON" }, { name: "scene-file", type: "string", description: "Read the canvas's drawing from a .excalidraw file.", placeholder: "PATH" }, { name: "file", type: "boolean", description: "Make a file: plain text kept exactly as written, highlighted by the extension in its title (main.py, report.tex)." }, ...contentFlags, ...docFlags, ...lookFlags],
  writes: true,
  dryRun: true,
  examples: ['etude note new "CMPT 307" --icon 📘', 'etude note new "Fall 2026" --folder', 'etude note new main.py --file --content-file ./main.py', 'etude note new "Week 1" --parent "CMPT 307" --text "# Greedy\\n- exchange argument"'],
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
    const content = contentOf(ctx);
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
  summary: "Change a page's title, icon, body or look (cover, width, font, text size), or turn it into a folder and back.",
  args: [{ name: "note", description: "Page id, or its exact title.", required: true }],
  flags: [{ name: "title", type: "string", description: "New title." }, { name: "kind", type: "string", description: "page or folder. Only an empty page can become a folder." }, { name: "icon", type: "string", description: "One emoji; empty to remove." }, { name: "scene", type: "string", description: "A canvas's new drawing as Excalidraw JSON. `-` reads stdin.", placeholder: "JSON" }, { name: "scene-file", type: "string", description: "Read a canvas's new drawing from a .excalidraw file.", placeholder: "PATH" }, ...contentFlags, ...docFlags, ...lookFlags],
  writes: true,
  dryRun: true,
  examples: ['etude note edit main.py --content-file ./main.py', 'etude note edit "Week 1" --title "Week 1 · Greedy"', 'etude note edit "Week 1" --text-file week1.txt', 'etude note edit "Week 1" --cover dawn --font serif --width wide'],
  output: "the page after the change",
  run(ctx) {
    const n = ctx.e.notes.resolve(ctx.args.note);
    const doc = docOf(ctx);
    const look = lookOf(ctx, n.look as Record<string, unknown>);
    const scene = sceneOf(ctx);
    const content = contentOf(ctx);
    if (ctx.flags.title === undefined && ctx.flags.icon === undefined && ctx.flags.kind === undefined && doc === undefined && look === undefined && scene === undefined && content === undefined) throw new CliError("nothing to change: give --title, --icon, --kind, --text, --doc, --scene, --content, --cover, --width, --font or --size");
    return ctx.e.notes.update(n.id, { title: ctx.flags.title, icon: ctx.flags.icon, doc, look, kind: ctx.flags.kind, scene, content });
  },
});

command({
  name: "note move",
  summary: "Put a page inside another page, or at the top level with --top.",
  args: [
    { name: "note", description: "Page to move (id or exact title).", required: true },
    { name: "parent", description: "New parent page. Leave out with --top." },
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
    args: [{ name: "note", description: "Page id, or its exact title.", required: true }],
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
  args: [{ name: "note", description: "Page id.", required: true }],
  writes: true,
  dryRun: true,
  confirm: true,
  output: "{ ids }",
  run(ctx) {
    return ctx.e.notes.delete(ctx.e.notes.get(ctx.args.note).id);
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
  examples: ["etude note import ~/vault", 'etude note import week1.md week2.md --parent "CMPT 307"', "etude note import board.excalidraw"],
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
  name: "note export",
  summary: "A page as Markdown (with [[links]]) or as a standalone HTML file; a canvas as a .excalidraw file; a file as its own text.",
  args: [{ name: "note", description: "Page id, or its exact title.", required: true }],
  flags: [
    { name: "format", type: "string", values: ["md", "html"], default: "md", description: "md or html (a canvas is always .excalidraw)." },
    { name: "output", short: "o", type: "string", description: "Write to this file instead of stdout.", placeholder: "PATH" },
  ],
  output: "the page's text (or { file } with -o)",
  async run(ctx) {
    const { docToHtml, docToMarkdown } = await import("../../core/notes-md.ts");
    const n = ctx.e.notes.resolve(ctx.args.note);
    const { sceneToExcalidraw } = await import("../../core/notes.ts");
    const out = n.kind === "file" ? (n.content ?? "") : n.kind === "canvas" ? JSON.stringify(sceneToExcalidraw(n.scene!, (m) => ctx.e.readMediaFile(m)), null, 2) : ctx.flags.format === "html" ? docToHtml(n.doc, n.title) : docToMarkdown(n.doc, n.title);
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
  args: [{ name: "note", description: "Page id, or its exact title.", required: true }],
  writes: true,
  examples: ['etude note pin "CMPT 361"'],
  output: "{ id, title, …, pinned }",
  run(ctx) {
    return ctx.e.notes.pin(ctx.e.notes.resolve(ctx.args.note).id);
  },
});

command({
  name: "note unpin",
  summary: "Take a page off the start page.",
  args: [{ name: "note", description: "Page id, or its exact title.", required: true }],
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
  args: [{ name: "note", description: "Page id, or its exact title.", required: true }],
  output: "array of { id, title, …, snippet }",
  run(ctx) {
    return ctx.e.notes.backlinks(ctx.e.notes.resolve(ctx.args.note).id);
  },
});
