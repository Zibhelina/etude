// Moving files of a folder on this computer into the collection, as notes: the other way of folder-take.ts, so a
// file or a page can be dragged from any space to any other. A .etude file becomes the page, canvas or board it
// holds, a Markdown or text file a file note of the same name, an .html file a web file, a PDF a PDF note, a
// directory a folder note with what's in it under it. Images, sound, video and other binary files have no note
// kind, so a move that holds one is refused before anything changes.
//
// Nothing is deleted. The notes are made and read back inside one transaction (a mistake leaves the collection as
// it was and the files where they are); only then do links to the files follow them and the files go to their
// folder's trash, where Undo and the file manager find them.
import fs from "node:fs";
import { EtudeError, type Etude } from "./engine.ts";
import { nativeFromText, type LocalSummary } from "./folders.ts";
import { docText } from "./notes.ts";

export interface BringReport {
  dryRun?: boolean;
  /** The files that were asked for. */
  from: string[];
  /** Where they went: a note's id, or null for the top level. */
  to: string | null;
  /** Notes made: one per file or directory moved. */
  moved: { file: string; id: string; kind: string; title: string; path: string }[];
  /** Links between the files that moved, pointed at the notes. */
  links: number;
  /** Other places that linked to a file that moved and follow it now: pages kept as files, and notes in the collection. */
  relinked: { files: number; notes: number };
  /** Where each file went in its folder's trash (an id of the file, then the trash path), for Undo. */
  trashed: { file: string; trashed: string }[];
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

type Planned = { src: LocalSummary; parent: Planned | null; dir: boolean };

export async function bringIntoNotebook(e: Etude, fileIds: string[], parentId: string | null, opts: { dryRun?: boolean; index?: number } = {}): Promise<BringReport> {
  if (!fileIds.length) throw new EtudeError("name the files to move");
  const parent = parentId ? e.notes.get(parentId) : null;
  if (parent?.archived) throw new EtudeError(`"${parent.title}" is in the Archive: bring it back first`);

  // ---- The plan: a note for every file and directory, in the tree they are in.
  const plan: Planned[] = [];
  const unsupported: string[] = [];
  const walk = (src: LocalSummary, up: Planned | null) => {
    const dir = src.kind === "folder";
    const p: Planned = { src, parent: up, dir };
    plan.push(p);
    if (dir) {
      for (const c of e.folders.children(src.id)) walk(c, p);
      return;
    }
    if (!(["etude", "markdown", "text", "web", "pdf"] as string[]).includes(src.local.type)) unsupported.push(`${src.local.name} (${src.local.type === "other" ? "not text" : src.local.type})`);
  };
  const roots: Planned[] = [];
  for (const id of new Set(fileIds)) {
    const src = e.folders.summary(id);
    if (!src.local.path) throw new EtudeError("that's the open folder itself: take a folder inside it, or close it");
    const before = plan.length;
    walk(src, null);
    roots.push(plan[before]);
  }
  if (unsupported.length) {
    throw new EtudeError(
      `${unsupported.length === 1 ? "this file has" : "these files have"} no note kind in the collection (a note is a page, canvas, board, text file, web file or PDF): ${unsupported.slice(0, 5).join(", ")}${unsupported.length > 5 ? ` and ${unsupported.length - 5} more` : ""}`,
    );
  }
  const titleOf = (p: Planned): string => {
    const t = p.src.local.type;
    if (p.dir) return p.src.local.name;
    if (t === "pdf") return p.src.local.name.replace(/\.pdf$/i, "");
    if (t === "etude") return p.src.local.name.replace(/\.etude$/i, "");
    return p.src.local.name;
  };
  const relOf = (p: Planned): string => (p.parent ? `${relOf(p.parent)}/${titleOf(p)}` : titleOf(p));
  const report: BringReport = {
    from: fileIds,
    to: parentId,
    moved: plan.map((p) => ({ file: p.src.id, id: "", kind: p.dir ? "folder" : p.src.local.type, title: titleOf(p), path: relOf(p) })),
    links: 0,
    relinked: { files: 0, notes: 0 },
    trashed: [],
  };
  if (opts.dryRun) return { ...report, dryRun: true };

  // ---- The notes. Made and read back inside one transaction.
  const newIds = new Map<string, string>();
  const made = new Map<Planned, string>();
  const bodies = new Map<Planned, { kind: "page" | "canvas" | "kanban"; doc?: unknown; scene?: unknown; board?: unknown }>();
  const checks: (() => void)[] = [];
  e.db.tx(() => {
    for (const p of plan) {
      const at = p.parent ? made.get(p.parent)! : parentId;
      const title = titleOf(p);
      const t = p.src.local.type;
      let note;
      if (p.dir) {
        note = e.notes.create({ title, parentId: at, kind: "folder" });
      } else if (t === "etude") {
        const f = nativeFromText(fs.readFileSync(e.folders.pathOf(p.src.id), "utf8"));
        // A page with a title of its own comes back under it; one without takes the file's name.
        const head = { title: f.title ?? title, parentId: at, icon: f.icon ?? null, look: f.look ?? {} };
        if (f.kind === "canvas") note = e.notes.create({ ...head, kind: "canvas", scene: f.scene });
        else if (f.kind === "kanban") note = e.notes.create({ ...head, kind: "kanban", board: f.board });
        else note = e.notes.create({ ...head, doc: f.doc });
        bodies.set(p, { kind: f.kind as "page" | "canvas" | "kanban", doc: f.doc, scene: f.scene, board: f.board });
        const want = f.kind === "canvas" || f.kind === "kanban" ? null : docText(f.doc!);
        const id = note.id;
        checks.push(() => {
          const back = e.notes.get(id);
          if (back.kind !== f.kind) throw new EtudeError(`${p.src.local.name} didn't read back as the ${f.kind} it was written from`);
          if (want !== null && back.text !== want) throw new EtudeError(`${p.src.local.name} didn't read back as the page it was written from`);
        });
      } else if (t === "pdf") {
        const bytes = fs.readFileSync(e.folders.pathOf(p.src.id));
        const stored = e.storeMedia(p.src.local.name, new Uint8Array(bytes));
        note = e.notes.create({ title, parentId: at, kind: "pdf", file: stored.file });
        const id = note.id;
        checks.push(() => {
          const back = e.notes.get(id);
          const kept = back.file ? e.readMediaFile(back.file) : null;
          if (!kept || Buffer.compare(Buffer.from(kept), bytes) !== 0) throw new EtudeError(`${p.src.local.name} isn't the same PDF in the collection`);
        });
      } else {
        const content = e.folders.get(p.src.id).content;
        if (content === null) throw new EtudeError(`${p.src.local.name} can't be read as text here (too big or not UTF-8)`);
        note = e.notes.create({ title, parentId: at, kind: t === "web" ? "web" : "file", content });
        const id = note.id;
        checks.push(() => {
          if (e.notes.get(id).content !== content) throw new EtudeError(`${p.src.local.name} didn't read back as the file it was written from`);
        });
      }
      made.set(p, note.id);
      if (!p.dir) newIds.set(p.src.id, note.id);
      report.moved[plan.indexOf(p)].id = note.id;
    }
    // Links among the files that moved point at the notes now.
    for (const [p, body] of bodies) {
      const id = made.get(p)!;
      const r = body.kind === "canvas" ? repoint(body.scene, newIds) : body.kind === "kanban" ? repoint(body.board, newIds) : repoint(body.doc, newIds);
      if (!r.changed) continue;
      report.links += r.changed;
      e.notes.update(id, body.kind === "canvas" ? { scene: r.value } : body.kind === "kanban" ? { board: r.value } : { doc: r.value });
    }
    for (const check of checks) check();
    // Their place among the notes already there, in the order they were asked for.
    roots.forEach((r, k) => e.notes.move(made.get(r)!, parentId, opts.index === undefined ? undefined : opts.index + k));
    // Pins follow the files.
    for (const p of plan) if (!p.dir && p.src.pinned) e.notes.pin(made.get(p)!);
  });

  // ---- What linked to a file that moved follows it: pages kept as files, then notes in the collection.
  const mine = new Set(plan.map((p) => p.src.id));
  for (const id of await e.folders.referring([...newIds.keys()])) {
    if (mine.has(id)) continue;
    const path = e.folders.pathOf(id);
    try {
      const st = fs.statSync(path);
      const was = nativeFromText(fs.readFileSync(path, "utf8"));
      const body = was.kind === "canvas" ? repoint(was.scene, newIds) : was.kind === "kanban" ? repoint(was.board, newIds) : repoint(was.doc, newIds);
      if (!body.changed) continue;
      e.folders.writePage(id, was.kind === "canvas" ? { scene: body.value } : was.kind === "kanban" ? { board: body.value } : { doc: body.value });
      fs.utimesSync(path, st.atime, st.mtime);
      report.relinked.files++;
    } catch {
      // Not a page this Etude reads: left as it is.
    }
  }
  const madeIds = new Set(made.values());
  e.db.tx(() => {
    const marks = [...newIds.keys()].map(() => "?").join(",");
    if (!newIds.size) return;
    for (const r of e.db.all(`SELECT DISTINCT from_id FROM note_links WHERE to_id IN (${marks})`, ...newIds.keys())) {
      const id = String(r.from_id);
      if (madeIds.has(id)) continue;
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
  });

  // ---- The files go to their folder's trash (a directory with everything in it, once).
  for (const r of roots) {
    const t = e.folders.trash(r.src.id);
    report.trashed.push({ file: r.src.id, trashed: t.trashed });
  }
  return report;
}
