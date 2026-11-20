import { command, group, CliError } from "../registry.ts";
import { textInput } from "../input.ts";
import { numberedText, patchDoc, patchText } from "../../core/notes-edit.ts";
import { docToMarkdown, markdownToDoc } from "../../core/notes-md.ts";
import { PAGE_EXT } from "../../core/folders.ts";
import { bringIntoNotebook } from "../../core/folder-bring.ts";
import { takeIntoFolder } from "../../core/folder-take.ts";

group({ name: "folder", summary: "Folders on this computer, open in the Notebook: read and changed where they are, nothing copied. Each file keeps its format: Markdown and text as text, a page as a .etude file", defaultVerb: "list" });

const mdFlags = [
  { name: "md", type: "string" as const, description: "A page's body as Markdown: headings, lists, `- [ ]` to-dos, tables, code, `$math$`, callouts. `-` reads stdin.", placeholder: "MARKDOWN" },
  { name: "md-file", type: "string" as const, description: "Read the page's Markdown body from a file.", placeholder: "PATH" },
];

const fileArg = { name: "file", description: 'A file or folder: "Folder name/path/inside", its path on disk, or its fs: id.', required: true };
const row = (r: any) => ({ id: r.id, kind: r.kind, type: r.local.type, name: r.local.name, path: r.local.path, size: r.local.size, updated: r.updated, ...(r.kind === "folder" ? { children: r.children } : {}) });

command({
  name: "folder list",
  summary: "The folders open in the Notebook.",
  output: "array of { id, name, path, trash, hidden, created, missing, elsewhere }",
  run(ctx) {
    return ctx.e.folders.list();
  },
});

command({
  name: "folder open",
  summary: "Open a folder on this computer in the Notebook. Its files stay where they are; Markdown opens in a live editor, .etude pages in the page editor, code and text in the file editor, PDFs and pictures as themselves.",
  args: [{ name: "path", description: "The folder's path.", required: true }],
  flags: [
    { name: "name", type: "string", description: "What the Notebook calls it (default: the folder's own name)." },
    { name: "trash", type: "string", description: "Where removed files go, inside the folder (default: .trash).", placeholder: "DIR" },
    { name: "hidden", type: "boolean", description: "Show names that start with a dot." },
  ],
  examples: ["etude folder open ~/Notes", "etude folder open ~/vault --name Vault --trash trash"],
  writes: true,
  output: "{ id, name, path, trash, hidden, created, missing, elsewhere }",
  run(ctx) {
    if (ctx.dry) return { dryRun: true, path: ctx.args.path };
    return ctx.e.folders.open(ctx.args.path, { name: ctx.flags.name, trash: ctx.flags.trash, hidden: !!ctx.flags.hidden });
  },
  dryRun: "self",
});

command({
  name: "folder edit",
  summary: "Change what the Notebook calls an open folder, where its removed files go, or whether dot-names show.",
  args: [{ name: "folder", description: "The folder's name or id.", required: true }],
  flags: [
    { name: "name", type: "string", description: "A new name in the Notebook (the folder on disk keeps its own)." },
    { name: "trash", type: "string", description: "Where removed files go, inside the folder.", placeholder: "DIR" },
    { name: "hidden", type: "string", description: "Show names that start with a dot: show or hide.", values: ["show", "hide"] },
  ],
  writes: true,
  dryRun: true,
  output: "{ id, name, path, trash, hidden, created, missing, elsewhere }",
  run(ctx) {
    return ctx.e.folders.edit(ctx.args.folder, { name: ctx.flags.name, trash: ctx.flags.trash, hidden: ctx.flags.hidden === undefined ? undefined : ctx.flags.hidden === "show" });
  },
});

command({
  name: "folder close",
  summary: "Take a folder out of the Notebook. The folder and everything in it stay on disk.",
  args: [{ name: "folder", description: "The folder's name or id.", required: true }],
  writes: true,
  dryRun: true,
  output: "{ id, name, path, … } (the folder that was closed)",
  run(ctx) {
    return ctx.e.folders.close(ctx.args.folder);
  },
});

command({
  name: "folder ls",
  summary: "What's right inside a folder: folders first, then files by name.",
  args: [{ name: "file", description: 'A folder: "Folder name/path/inside", its path on disk, or its fs: id. Without it, the open folders.' }],
  examples: ["etude folder ls", "etude folder ls Notes/Journal"],
  output: "array of { id, kind, type, name, path, size, updated, children? }",
  run(ctx) {
    const f = ctx.e.folders;
    return (ctx.args.file ? f.children(f.ref(ctx.args.file)) : f.roots()).map(row);
  },
});

command({
  name: "folder read",
  summary: "A file's text exactly as it is on disk, after a line with its place, id and last change. A page (.etude) reads as Markdown, the way `note read` shows one.",
  args: [fileArg],
  flags: [{ name: "lines", type: "boolean", description: "With line numbers." }],
  examples: ["etude folder read Notes/Journal/Monday.md"],
  output: "text",
  run(ctx) {
    const f = ctx.e.folders;
    const n = f.get(f.ref(ctx.args.file));
    const head = `<!-- ${f.pathOf(n.id)} · ${n.local.type} · ${n.id} · updated ${n.updated} -->\n`;
    if (n.kind === "folder") return head + f.children(n.id).map((r) => `${r.local.name}${r.kind === "folder" ? "/" : ""}`).join("\n");
    if (n.kind === "page") return head + docToMarkdown(n.doc);
    if (n.content === null) throw new CliError(n.local.locked === "large" ? "that file is too big to read here (5 MB at most)" : `${n.local.name} isn't text (${n.local.type}); it's at ${f.pathOf(n.id)}`, "validation");
    return head + (ctx.flags.lines ? numberedText(n.content) : n.content);
  },
});

command({
  name: "folder write",
  summary: "Replace a file's text on disk. Line ends and a byte-order mark stay as the file had them. A page (.etude) takes its body as Markdown (--md), which drops what Markdown can't say (columns, portals): for a small change use `folder patch`.",
  args: [fileArg],
  flags: [
    { name: "content", type: "string", description: "The text. `-` reads stdin.", placeholder: "TEXT" },
    { name: "content-file", type: "string", description: "Read the text from this file.", placeholder: "PATH" },
    ...mdFlags,
    { name: "base", type: "string", description: "The `updated` you read: the write is refused if the file changed on disk since.", placeholder: "STAMP" },
  ],
  writes: true,
  dryRun: "self",
  output: "{ id, path, updated, bytes }",
  run(ctx) {
    const f = ctx.e.folders;
    const id = f.ref(ctx.args.file);
    const content = textInput(ctx, ctx.flags.content, ctx.flags["content-file"]);
    const md = textInput(ctx, ctx.flags.md, ctx.flags["md-file"]);
    if (md !== undefined) {
      if (content !== undefined) throw new CliError("give the body as --md or the text as --content, not both");
      if (ctx.dry) return { dryRun: true, id, path: f.pathOf(id), blocks: (markdownToDoc(md).content ?? []).length };
      const n = f.writePage(id, { doc: markdownToDoc(md) }, { base: ctx.flags.base });
      return { id: n.id, path: f.pathOf(n.id), updated: n.updated, bytes: n.local.size };
    }
    if (content === undefined) throw new CliError("give --content or --content-file (or --md for a page)");
    if (ctx.dry) return { dryRun: true, id, path: f.pathOf(id), bytes: new TextEncoder().encode(content).length };
    const n = f.write(id, content, { base: ctx.flags.base });
    return { id: n.id, path: f.pathOf(n.id), updated: n.updated, bytes: n.local.size };
  },
});

command({
  name: "folder patch",
  summary: "Find-and-replace in a file's text on disk, or in a page's (.etude) Markdown, touching only the blocks it changes. The text to find must be there exactly once unless --all.",
  args: [fileArg],
  flags: [
    { name: "old", type: "string", description: "The text to find, exactly as it is in the file.", placeholder: "TEXT" },
    { name: "new", type: "string", description: "What replaces it.", placeholder: "TEXT" },
    { name: "all", type: "boolean", description: "Replace every place it appears." },
  ],
  writes: true,
  dryRun: "self",
  output: "{ id, path, replaced, lines, updated } (a page: blocks, the top-level blocks rewritten, instead of lines)",
  run(ctx) {
    const f = ctx.e.folders;
    const n = f.get(f.ref(ctx.args.file));
    if (ctx.flags.old === undefined || ctx.flags.new === undefined) throw new CliError("give --old and --new");
    if (n.kind === "page") {
      const r = patchDoc(n.doc, String(ctx.flags.old), String(ctx.flags.new), { all: !!ctx.flags.all });
      if (ctx.dry) return { dryRun: true, id: n.id, path: f.pathOf(n.id), replaced: r.replaced, blocks: r.blocks };
      const saved = f.writePage(n.id, { doc: r.doc }, { base: n.updated });
      return { id: n.id, path: f.pathOf(n.id), replaced: r.replaced, blocks: r.blocks, updated: saved.updated };
    }
    if (n.content === null) throw new CliError(`${n.local.name} isn't text Etude can edit`, "validation");
    const r = patchText(n.content, String(ctx.flags.old), String(ctx.flags.new), { all: !!ctx.flags.all });
    if (ctx.dry) return { dryRun: true, id: n.id, path: f.pathOf(n.id), replaced: r.replaced, lines: r.lines };
    const saved = f.write(n.id, r.content, { base: n.updated });
    return { id: n.id, path: f.pathOf(n.id), replaced: r.replaced, lines: r.lines, updated: saved.updated };
  },
});

command({
  name: "folder new",
  summary: "A new page, canvas, kanban board, web file, file or folder inside a folder on this computer. A name with an extension (notes.md, main.py) makes that file; a name without one makes an Etude page (Name.etude). --kind canvas or kanban makes that kind of .etude file, --kind web an .html file.",
  args: [
    { name: "file", description: 'The folder it goes in: "Folder name/path/inside", its path on disk, or its fs: id.', required: true },
    { name: "name", description: "Its name. Without one: Untitled.etude, or New folder." },
  ],
  flags: [
    { name: "kind", type: "string", description: "page, canvas or kanban (each a .etude file), web (an .html file), file (any name) or folder. Left out: by the name, as above.", values: ["page", "canvas", "kanban", "web", "file", "folder"] },
    { name: "content", type: "string", description: "A file's text. `-` reads stdin.", placeholder: "TEXT" },
    { name: "content-file", type: "string", description: "Read a file's text from this file.", placeholder: "PATH" },
    ...mdFlags,
  ],
  examples: ['etude folder new Notes/Journal "Tuesday"', 'etude folder new Notes/Journal Tuesday.md --content "# Tuesday"', 'etude folder new Notes "Reading list" --md "- [ ] Chapter 1"', "etude folder new Notes Drafts --kind folder"],
  writes: true,
  dryRun: "self",
  output: "{ id, kind, type, name, path, size, updated }",
  run(ctx) {
    const f = ctx.e.folders;
    const parent = f.ref(ctx.args.file);
    const name = String(ctx.args.name ?? "");
    const content = textInput(ctx, ctx.flags.content, ctx.flags["content-file"]);
    const md = textInput(ctx, ctx.flags.md, ctx.flags["md-file"]);
    const kind = ctx.flags.kind ?? (name.toLowerCase().endsWith(PAGE_EXT) || !/\.[A-Za-z0-9]+$/.test(name) ? (content !== undefined && md === undefined ? "file" : "page") : "file");
    if (kind !== "page" && md !== undefined) throw new CliError("--md is a page's body: for a Markdown file give its text as --content");
    if (ctx.dry) return { dryRun: true, in: f.pathOf(parent), name: name || null, kind };
    return row(f.create(parent, { title: name, kind, content, ...(md !== undefined ? { doc: markdownToDoc(md) } : {}) }));
  },
});

command({
  name: "folder rename",
  summary: "Give a file or folder a new name where it is. A Markdown file or a page keeps its extension when the new name leaves it out.",
  args: [fileArg, { name: "name", description: "The new name.", required: true }],
  writes: true,
  dryRun: "self",
  output: "{ id, kind, type, name, path, size, updated }",
  run(ctx) {
    const f = ctx.e.folders;
    const id = f.ref(ctx.args.file);
    if (ctx.dry) return { dryRun: true, from: f.pathOf(id), name: ctx.args.name };
    return row(f.rename(id, ctx.args.name));
  },
});

command({
  name: "folder move",
  summary: "Move a file or folder into another folder on this computer, keeping its name. With --index it goes at that place among what's there, which also works in the folder it's already in: that puts a folder's files in an order of your own (a disk has none, so Etude keeps it for this computer; `folder sort` goes back to names).",
  args: [fileArg, { name: "to", description: "The folder it goes into (same ways to name it).", required: true }],
  flags: [{ name: "index", type: "number", description: "Its place among what's in the folder, 0 first. Left out: where its name puts it, or the end in a folder with an order of its own." }],
  examples: ["etude folder move Notes/draft.md Notes/Archive", "etude folder move Notes/Journal Notes --index 0"],
  writes: true,
  dryRun: "self",
  output: "{ id, kind, type, name, path, size, updated }",
  run(ctx) {
    const f = ctx.e.folders;
    const id = f.ref(ctx.args.file);
    const to = f.ref(ctx.args.to);
    if (ctx.dry) return { dryRun: true, from: f.pathOf(id), to: f.pathOf(to), ...(ctx.flags.index === undefined ? {} : { index: ctx.flags.index }) };
    return row(f.move(id, to, ctx.flags.index));
  },
});

command({
  name: "folder sort",
  summary: "Put what's in a folder back in the order of its names (folders first), dropping the order it was given by hand.",
  args: [fileArg],
  examples: ["etude folder sort Notes/Journal"],
  writes: true,
  output: "{ id, name, arranged }",
  run(ctx) {
    const f = ctx.e.folders;
    const r = f.sortByName(f.ref(ctx.args.file));
    return { id: r.id, name: r.local.name, arranged: !!r.local.arranged };
  },
});

command({
  name: "folder trash",
  summary: "Move a file or folder to its folder's trash (.trash unless changed). Nothing is deleted.",
  args: [fileArg],
  writes: true,
  dryRun: "self",
  output: "{ ids, archived, trashed } (trashed: where it went, inside the open folder)",
  run(ctx) {
    const f = ctx.e.folders;
    const id = f.ref(ctx.args.file);
    if (ctx.dry) return { dryRun: true, from: f.pathOf(id) };
    return f.trash(id);
  },
});

command({
  name: "folder restore",
  summary: "Put something back from a folder's trash where it was.",
  args: [
    { name: "file", description: 'Where it goes back to: "Folder name/path/inside".', required: true },
    { name: "trashed", description: "Where it is now, as `folder trash` printed it (.trash/name).", required: true },
  ],
  writes: true,
  dryRun: "self",
  output: "{ id, kind, type, name, path, size, updated }",
  run(ctx) {
    const f = ctx.e.folders;
    const id = f.ref(ctx.args.file);
    if (ctx.dry) return { dryRun: true, to: f.pathOf(id), from: ctx.args.trashed };
    return row(f.restore(id, ctx.args.trashed));
  },
});

command({
  name: "folder search",
  summary: "Files in the open folders by name, then Markdown and text files by the words in them.",
  args: [{ name: "query", description: "Words in the name, or text in the file.", required: true }],
  flags: [{ name: "limit", type: "number", description: "At most this many (default 20).", default: 20 }],
  output: "array of { id, kind, type, name, path, size, updated, folder, snippet }",
  async run(ctx) {
    const f = ctx.e.folders;
    const names = new Map(f.list().map((x) => [x.id, x.name]));
    return (await f.search(ctx.args.query, ctx.flags.limit)).map((r) => ({ ...row(r), folder: names.get(r.local.folder) ?? "", snippet: r.snippet }));
  },
});

command({
  name: "folder where",
  summary: "The id the Notebook uses for a path on disk (for `etude view open`), or null when no open folder holds it.",
  args: [{ name: "path", description: "A path on this computer.", required: true }],
  output: "{ id } (null when the path isn't in an open folder)",
  run(ctx) {
    return { id: ctx.e.folders.idOf(ctx.args.path) };
  },
});

command({
  name: "folder take",
  summary: "Move a note of the collection, with what's under it, into a folder on this computer as files: a page, a canvas and a kanban board each become Name.etude, a web file Name.html, a file note the file it names, a PDF note its PDF, a folder a directory (a note with notes under it gets a directory of its name and sits inside; a folder goes into a directory of its name that's already there). Every file is read back before anything changes in the collection; then links to what moved follow it, and the notes that moved are archived (they come back from the Archive).",
  args: [
    { name: "note", description: "The note: its id, title or path in the Notebook.", required: true },
    { name: "file", description: 'The folder it goes into: "Folder name/path/inside", a path on disk inside an open folder, or an fs: id. Made when it isn\'t there.', required: true },
  ],
  flags: [{ name: "keep", type: "boolean", description: "Copy only: the notes stay in the collection as they are." }],
  examples: ['etude folder take "Journal" Notes/Journal --dry-run', 'etude folder take "Journal" Notes --yes', 'etude folder take "Reading list" ~/Notes --keep --yes'],
  writes: true,
  dryRun: "self",
  confirm: true,
  output: "{ from, to, moved: [{ id, kind, title, path, file }], links, relinked: { files, notes }, archived }",
  async run(ctx) {
    return takeIntoFolder(ctx.e, ctx.args.note, ctx.args.file, { dryRun: ctx.dry, keep: !!ctx.flags.keep });
  },
});

command({
  name: "folder bring",
  summary: "Move files of a folder on this computer into the collection as notes, the other way of `folder take`: a .etude file becomes the page, canvas or board it holds, a Markdown or text file a file note, an .html file a web file, a PDF a PDF note, a directory a folder note with what's in it. Images, sound, video and other binary files have no note kind: a move that holds one is refused before anything changes. The notes are made and read back first; then links to the files follow them and the files go to their folder's trash.",
  args: [
    { name: "file", description: 'The file or directory: "Folder name/path/inside" or an fs: id.', required: true, variadic: true },
  ],
  flags: [
    { name: "into", type: "string", description: "The note it goes under (id, title or path in the Notebook). Left out: the top level." },
    { name: "index", type: "number", description: "Its place among the notes there (left out: the end)." },
  ],
  examples: ['etude folder bring "Notes/Plan.etude" --into "Courses"', 'etude folder bring "Notes/Plan.etude" --dry-run'],
  writes: true,
  dryRun: "self",
  output: "{ from, to, moved: [{ file, id, kind, title, path }], links, relinked: { files, notes }, trashed: [{ file, trashed }] }",
  async run(ctx) {
    const files = (Array.isArray(ctx.args.file) ? ctx.args.file : [ctx.args.file]).map((f: string) => ctx.e.folders.ref(String(f)));
    const into = ctx.flags.into ? ctx.e.notes.resolve(String(ctx.flags.into)).id : null;
    return bringIntoNotebook(ctx.e, files, into, { dryRun: ctx.dry, index: typeof ctx.flags.index === "number" ? ctx.flags.index : undefined });
  },
});

// ---------------------------------------------------------------- folders Sync carries

const syncedRow = (l: { syncId: string; name: string; files: number; bytes: number; home: string }) => ({ syncId: l.syncId, name: l.name, files: l.files, bytes: l.bytes, home: l.home });

command({
  name: "folder sync list",
  summary: "The folders Sync carries to your other devices: the ones with a place on this computer (`here`), and the ones other devices carry that aren't on this computer yet (`elsewhere`).",
  examples: ["etude folder sync list"],
  output: "{ configured, here: [{ syncId, name, id, path, isHome, files, bytes, missing, paused, last }], elsewhere: [{ syncId, name, files, bytes, home }] }",
  run(ctx) {
    const s = ctx.e.folderSync.status();
    return { configured: s.configured, here: s.here.map((l) => ({ ...syncedRow(l), id: l.id, path: l.path, isHome: l.isHome, missing: l.missing, paused: l.paused, last: l.last })), elsewhere: s.elsewhere.map(syncedRow) };
  },
});

command({
  name: "folder sync on",
  summary: "Start carrying a folder of this computer to your other devices through Sync. Every file in it travels as it is (not dot-names, the trash, or files over 100 MB). This computer becomes the folder's home: when one file changes in two places, its version keeps the name. --dry-run says how much would travel.",
  args: [{ name: "file", description: 'The folder: "Folder name/path/inside", its path on disk, or its fs: id. An open folder itself, or one inside it.', required: true }],
  flags: [{ name: "name", type: "string", description: "What the other devices call it. Left out: the folder's own name.", placeholder: "NAME" }],
  examples: ["etude folder sync on Notes --dry-run", "etude folder sync on Notes/Journal", "etude sync now"],
  writes: true,
  dryRun: "self",
  output: "{ syncId, name, id, path, isHome } (--dry-run: { dryRun, id, path, files, bytes, tooBig })",
  run(ctx) {
    const f = ctx.e.folderSync;
    if (ctx.dry) return { dryRun: true, ...f.estimate(ctx.args.file) };
    const l = f.mark(ctx.args.file, { name: ctx.flags.name });
    return { syncId: l.syncId, name: l.name, id: l.id, path: l.path, isHome: l.isHome };
  },
});

command({
  name: "folder sync link",
  summary: "Give a folder another device carries a place on this computer. The directory is made when it isn't there and opened in the Notebook; the files come on the sync that follows. Files already in it stay: one that differs from the vault's is kept beside it as a (conflict …) copy.",
  args: [
    { name: "folder", description: "The synced folder: its name or its syncId (etude folder sync list).", required: true },
    { name: "dest", description: "Where it goes on this computer.", required: true },
  ],
  examples: ['etude folder sync link Notes ~/Notes', "etude sync now"],
  writes: true,
  output: "{ syncId, name, id, path, isHome }",
  run(ctx) {
    const l = ctx.e.folderSync.link(ctx.args.folder, ctx.args.dest);
    return { syncId: l.syncId, name: l.name, id: l.id, path: l.path, isHome: l.isHome };
  },
});

command({
  name: "folder sync off",
  summary: "Stop carrying a folder on this computer. Its files stay on disk as they are, here and on the other devices. --everywhere ends it for every device and takes it out of the vault's list.",
  args: [{ name: "folder", description: "The synced folder: its name, its syncId, or where it is on this computer.", required: true }],
  flags: [{ name: "everywhere", type: "boolean", description: "End it for every device, not only this computer." }],
  examples: ["etude folder sync off Notes", "etude folder sync off Notes --everywhere"],
  writes: true,
  output: "{ syncId, name, everywhere, path }",
  run(ctx) {
    return ctx.e.folderSync.unlink(ctx.args.folder, { everywhere: !!ctx.flags.everywhere });
  },
});

command({
  name: "folder sync go",
  summary: "Let through the removals Sync is holding back for a folder (a lot of its files went missing here at once, so the other devices kept theirs). They go on the sync that follows.",
  args: [{ name: "folder", description: "The synced folder: its name, its syncId, or where it is on this computer.", required: true }],
  examples: ["etude folder sync go Notes", "etude sync now"],
  writes: true,
  output: "{ syncId, name, paused }",
  run(ctx) {
    const l = ctx.e.folderSync.goAhead(ctx.args.folder);
    return { syncId: l.syncId, name: l.name, paused: l.paused };
  },
});
