// Moving notes out of the collection into a folder on this computer (src/core/folders.ts opens it), as files:
// a page, a canvas and a kanban board each become Name.etude, a file note the file it names, a web file Name.html,
// a PDF note its PDF, a folder a directory. The tree is kept: a note with notes under it becomes a directory of its
// name with the note inside, beside what was under it. A folder whose directory is already there is added to.
// The order the notes had in the Notebook is kept: each new directory lists its files that way.
//
// Nothing is deleted. Every file is read back and compared before anything in the collection changes; then links to
// the notes that moved (from other notes, and from pages already kept as files) are pointed at the files, and the
// notes are archived (they come back from the Archive), unless `keep` leaves everything in the collection as it is.
import fs from "node:fs";
import { dirname, join } from "node:path";
import { EtudeError, type Etude } from "./engine.ts";
import { cleanTitle, fsId, nativeFromText, nativeToText, PAGE_EXT, parseFsId, type NativeFile } from "./folders.ts";
import type { NoteSummary } from "./notes.ts";
import { sha256Hex } from "./sync/crypto.ts";

export interface TakeReport {
  dryRun?: boolean;
  /** The note that was asked for, and where on disk its files went. */
  from: string;
  to: string;
  /** Notes that are files now: where each went, inside the destination. */
  moved: { id: string; kind: string; title: string; path: string; file: string }[];
  /** Links between the notes that moved, pointed at the files. */
  links: number;
  /** Other places that linked to a note that moved and follow it now: pages kept as files, and notes still in the collection. */
  relinked: { files: number; notes: number };
  /** Notes archived in the collection once their files were checked (0 with `keep`, or on a dry run). */
  archived: number;
}

/** A title as a name every disk (and Obsidian) takes: no slashes, colons or control characters, no leading dot. */
export function diskName(title: string, fallback = "Untitled"): string {
  let n = String(title ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s*:\s+/g, " - ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "_")
    .replace(/[. ]+$/, "");
  while (new TextEncoder().encode(n).length > 180) n = n.slice(0, -1).trimEnd();
  return n || fallback;
}

/** Every string in a value that is one of `ids` becomes what it maps to. Returns how many changed. */
function repoint<T>(node: T, ids: Map<string, string>): { value: T; changed: number } {
  let changed = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const to = ids.get(v);
      if (to === undefined) return v;
      changed++;
      return to;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(node) as T, changed };
}

export async function takeIntoFolder(e: Etude, noteRef: string, destRef: string, opts: { dryRun?: boolean; keep?: boolean } = {}): Promise<TakeReport> {
  const root = e.notes.resolve(noteRef);
  if (root.archived) throw new EtudeError(`"${root.title}" is in the Archive: bring it back first`);
  const all = e.notes.list();
  const kids = new Map<string, NoteSummary[]>();
  for (const n of all) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  for (const list of kids.values()) list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const start = all.find((n) => n.id === root.id);
  if (!start) throw new EtudeError(`"${root.title}" isn't in the Notebook`);
  const subtree: NoteSummary[] = [];
  const collect = (n: NoteSummary) => {
    subtree.push(n);
    for (const c of kids.get(n.id) ?? []) collect(c);
  };
  collect(start);
  const shared = subtree.find((n) => n.share);
  if (shared) throw new EtudeError(`"${shared.title}" is in a shared space: its pages belong to everyone in it and stay in the collection`);

  // Where it goes: a folder inside one that's open in the Notebook, made when it isn't there yet.
  const destId = e.folders.ref(destRef);
  const destPath = e.folders.pathOf(destId);
  const destStat = fs.statSync(destPath, { throwIfNoEntry: false });
  if (destStat && !destStat.isDirectory()) throw new EtudeError(`${destPath} is a file`);
  const dest = parseFsId(destId);
  const full = (rel: string) => (rel ? join(destPath, ...rel.split("/")) : destPath);

  // ---- The plan: a name for everything, in the tree the notes are in.
  type Planned = { note: NoteSummary; rel: string; dir: boolean };
  const plan: Planned[] = [];
  const dirs = new Set<string>();
  const used = new Map<string, Set<string>>();
  const taken = (dir: string): Set<string> => {
    let t = used.get(dir);
    if (!t) {
      t = new Set<string>();
      try {
        for (const x of fs.readdirSync(full(dir))) t.add(x.toLowerCase());
      } catch {}
      used.set(dir, t);
    }
    return t;
  };
  const free = (dir: string, name: string): string => {
    const t = taken(dir);
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let out = name;
    for (let i = 2; t.has(out.toLowerCase()); i++) out = `${stem} ${i}${ext}`;
    t.add(out.toLowerCase());
    return out;
  };
  const at = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
  // What goes into each directory, in the order the Notebook had it; and the directories made here.
  const order = new Map<string, string[]>();
  const made = new Set<string>();
  const lists = (dir: string, name: string) => void order.set(dir, [...(order.get(dir) ?? []), name]);
  if (!destStat) made.add("");
  const place = (n: NoteSummary, dir: string) => {
    const kind = n.kind ?? "page";
    const below = kids.get(n.id) ?? [];
    if (kind === "folder") {
      // A directory of the folder's name that's already there is the same folder: what's in the note goes into it.
      const want = diskName(n.title, "New folder");
      const there = !dirs.has(at(dir, want)) && !!fs.statSync(full(at(dir, want)), { throwIfNoEntry: false })?.isDirectory();
      const name = there ? want : free(dir, want);
      if (there) taken(dir).add(want.toLowerCase());
      else made.add(at(dir, name));
      lists(dir, name);
      dirs.add(at(dir, name));
      plan.push({ note: n, rel: at(dir, name), dir: true });
      for (const c of below) place(c, at(dir, name));
      return;
    }
    const titled = n.title.toLowerCase();
    const ext = kind === "page" || kind === "canvas" || kind === "kanban" ? PAGE_EXT : kind === "pdf" ? ".pdf" : kind === "web" ? (/\.html?$/.test(titled) ? titled.slice(titled.lastIndexOf(".")) : ".html") : "";
    const base = diskName(ext && titled.endsWith(ext) ? n.title.slice(0, -ext.length) : n.title);
    // With notes under it, it gets a directory of its name, and sits inside with them.
    let into = dir;
    if (below.length) {
      const name = free(dir, base);
      into = at(dir, name);
      lists(dir, name);
      made.add(into);
      dirs.add(into);
    }
    const file = free(into, `${base}${ext}`);
    lists(into, file);
    plan.push({ note: n, rel: at(into, file), dir: false });
    for (const c of below) place(c, into);
  };
  place(start, "");
  const idOf = (rel: string) => fsId(dest.folder, dest.rel ? `${dest.rel}/${rel}` : rel);
  const newIds = new Map(plan.filter((p) => !p.dir).map((p) => [p.note.id, idOf(p.rel)]));
  const report: TakeReport = {
    from: root.title,
    to: destPath,
    moved: plan.map((p) => ({ id: p.note.id, kind: p.note.kind ?? "page", title: p.note.title, path: p.rel, file: p.dir ? "" : idOf(p.rel) })),
    links: 0,
    relinked: { files: 0, notes: 0 },
    archived: 0,
  };
  if (opts.dryRun) return { ...report, dryRun: true };

  // ---- The files. Nothing in the collection changes until every one is written and read back the same.
  fs.mkdirSync(destPath, { recursive: true });
  for (const d of [...dirs].sort()) fs.mkdirSync(full(d), { recursive: true });
  const checks: (() => Promise<void>)[] = [];
  for (const p of plan) {
    if (p.dir) continue;
    const n = e.notes.get(p.note.id);
    const path = full(p.rel);
    fs.mkdirSync(dirname(path), { recursive: true });
    const kind = n.kind ?? "page";
    if (kind === "page" || kind === "canvas" || kind === "kanban") {
      // A page or board keeps the title it had as its own; the file's name comes from it too, but renaming one leaves the other.
      const head = { title: kind === "canvas" ? null : cleanTitle(n.title), icon: n.icon ?? null, look: n.look ?? {} };
      const body = kind === "canvas" ? repoint(n.scene!, newIds) : kind === "kanban" ? repoint(n.board!, newIds) : repoint(n.doc, newIds);
      report.links += body.changed;
      const file = (kind === "canvas" ? { kind, ...head, scene: body.value } : kind === "kanban" ? { kind, ...head, board: body.value } : { kind: "page", ...head, doc: body.value }) as NativeFile;
      const text = nativeToText(file);
      fs.writeFileSync(path, text, { flag: "wx" });
      checks.push(async () => {
        // Read through the same door the editor uses: the same kind, and the same file to the byte when written again.
        const back = e.folders.get(idOf(p.rel));
        const again = nativeToText({ kind: back.kind as NativeFile["kind"], title: back.local?.pageTitle ?? null, icon: back.icon ?? null, look: back.look ?? {}, doc: back.doc, scene: back.scene ?? undefined, board: back.board ?? undefined });
        if (back.kind !== kind || again !== text) throw new EtudeError(`${p.rel} didn't read back as the ${kind} it was written from`);
      });
    } else if (kind === "pdf") {
      const src = join(e.mediaDir, String(n.file ?? ""));
      if (!n.file || !fs.existsSync(src)) throw new EtudeError(`the PDF of "${n.title}" isn't in the collection's media`);
      fs.copyFileSync(src, path, fs.constants.COPYFILE_EXCL);
      checks.push(async () => {
        const [a, b] = await Promise.all([sha256Hex(new Uint8Array(fs.readFileSync(src))), sha256Hex(new Uint8Array(fs.readFileSync(path)))]);
        if (a !== b) throw new EtudeError(`${p.rel} isn't the same PDF as the note's`);
      });
    } else {
      const content = n.content ?? "";
      fs.writeFileSync(path, content, { flag: "wx" });
      checks.push(async () => {
        if (fs.readFileSync(path, "utf8") !== content) throw new EtudeError(`${p.rel} didn't read back as the file it was written from`);
      });
    }
    // The file is as old as the note's last change, so "recent" still means what it meant.
    const when = new Date(n.updated);
    if (!Number.isNaN(when.getTime())) fs.utimesSync(path, when, when);
  }
  for (const check of checks) await check();
  // A directory made here lists its files in the Notebook's order; so does one that already had an order of its own
  // (what's new goes after what was there). One that lists by name is left that way.
  for (const [dir, names] of order) {
    const id = dir ? idOf(dir) : destId;
    if (made.has(dir) || e.folders.isArranged(id)) e.folders.arrange(id, names);
  }
  if (opts.keep) return report;

  // ---- What linked to a note that moved follows it: pages already kept as files, then notes still in the collection.
  const mine = new Set(newIds.values());
  for (const id of await e.folders.referring([...newIds.keys()])) {
    if (mine.has(id)) continue;
    const path = e.folders.pathOf(id);
    try {
      const st = fs.statSync(path);
      const was = nativeFromText(fs.readFileSync(path, "utf8"));
      const body = was.kind === "canvas" ? repoint(was.scene, newIds) : was.kind === "kanban" ? repoint(was.board, newIds) : repoint(was.doc, newIds);
      if (!body.changed) continue;
      e.folders.writePage(id, was.kind === "canvas" ? { scene: body.value } : was.kind === "kanban" ? { board: body.value } : { doc: body.value });
      // Following a link isn't an edit: the file keeps its time.
      fs.utimesSync(path, st.atime, st.mtime);
      report.relinked.files++;
    } catch {
      // Not a page this Etude reads: left as it is.
    }
  }
  const moving = new Set(plan.map((p) => p.note.id));
  e.db.tx(() => {
    const marks = [...newIds.keys()].map(() => "?").join(",");
    for (const r of newIds.size ? e.db.all(`SELECT DISTINCT from_id FROM note_links WHERE to_id IN (${marks})`, ...newIds.keys()) : []) {
      const id = String(r.from_id);
      if (moving.has(id)) continue;
      const n = e.notes.get(id);
      if (n.archived || n.share) continue;
      if (n.kind === "kanban" && n.board) {
        const b = repoint(n.board, newIds);
        if (b.changed) (e.notes.update(id, { board: b.value }), report.relinked.notes++);
      } else if ((n.kind ?? "page") === "page") {
        const d = repoint(n.doc, newIds);
        if (d.changed) (e.notes.update(id, { doc: d.value }), report.relinked.notes++);
      }
    }
    // Pins follow the files, and what moved goes to the Archive.
    for (const p of plan) {
      if (p.dir || !p.note.pinned) continue;
      e.folders.pin(idOf(p.rel), true);
      e.notes.unpin(p.note.id);
    }
    // Counted as the notes that were in the Notebook and aren't any more (archiving a note also names what was
    // already in the Archive under it).
    const live = () => Number(e.db.get("SELECT count(*) AS n FROM notes WHERE archived = 0")!.n);
    const before = live();
    for (const p of plan) {
      const now = e.db.get("SELECT archived FROM notes WHERE id = ?", p.note.id);
      if (!now || now.archived) continue;
      e.notes.setArchived(p.note.id, true);
    }
    report.archived = before - live();
  });
  return report;
}
