// The Notes tutorial: a folder of pages (one per topic, each ending in a short "Try it yourself"), a canvas,
// a PDF, two code files and the six cards its pages hold, shipped in examples/notes-tutorial. Notes adds it
// once, the first time it opens on a collection (a flag in meta remembers, so archiving or deleting it
// doesn't bring it back), and again whenever you ask for it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EtudeError } from "./engine.ts";
import type { Etude } from "./engine.ts";
import type { DocNode, NoteKind, NoteLook, CanvasScene } from "./notes.ts";

/** The meta key that says this collection has had the tutorial (its value is the bundle's version). */
export const NOTES_TUTORIAL_FLAG = "notes_tutorial";
/** The folder's title: a collection that already has a top-level folder by this name counts as having it. */
export const NOTES_TUTORIAL_TITLE = "Notes showcase";

interface TutorialNote {
  key: string;
  parent: string | null;
  kind: NoteKind;
  title: string;
  icon: string | null;
  look?: NoteLook;
  /** Pinned to the start page, in this order. */
  pinned?: number;
  doc?: DocNode;
  scene?: CanvasScene;
  content?: string;
  file?: string;
}
export interface TutorialBundle {
  etude: "notes-tutorial/1";
  version: number;
  media: Record<string, string>;
  notes: TutorialNote[];
  pack: any;
}

export interface TutorialResult {
  added: boolean;
  /** Why nothing was added (with ifNew): it was added before, or the collection already has the folder. */
  reason?: "seen" | "exists";
  /** The tutorial's folder and its Start here page (null when nothing was added). */
  root: string | null;
  start: string | null;
  notes: number;
  items: number;
  dryRun?: boolean;
}

// Static URLs, so the browser build ships these files as assets (fetched only when the tutorial is added) while
// Node reads them from the install.
const FILES: Record<string, URL> = {
  "tutorial.json": new URL("../../examples/notes-tutorial/tutorial.json", import.meta.url),
  "minimi-faces.webp": new URL("../../examples/notes-tutorial/media/minimi-faces.webp", import.meta.url),
  "spaced-retrieval.pdf": new URL("../../examples/notes-tutorial/media/spaced-retrieval.pdf", import.meta.url),
};

async function readBundled(url: URL): Promise<Uint8Array> {
  if (url.protocol === "file:") return readFileSync(fileURLToPath(url));
  const r = await fetch(url);
  if (!r.ok) throw new EtudeError(`couldn't load the Notes tutorial (${r.status})`, 502);
  return new Uint8Array(await r.arrayBuffer());
}

/** The tutorial and its media files. */
export async function loadTutorial(): Promise<{ bundle: TutorialBundle; media: Map<string, Uint8Array> }> {
  let bundle: TutorialBundle;
  try {
    bundle = JSON.parse(new TextDecoder().decode(await readBundled(FILES["tutorial.json"])));
  } catch (e) {
    if (e instanceof EtudeError) throw e;
    throw new EtudeError(`the Notes tutorial isn't in this install (${(e as Error).message.slice(0, 120)})`, 404);
  }
  if (bundle?.etude !== "notes-tutorial/1" || !Array.isArray(bundle.notes)) throw new EtudeError("examples/notes-tutorial/tutorial.json isn't a Notes tutorial");
  const media = new Map<string, Uint8Array>();
  for (const name of Object.keys(bundle.media)) {
    const url = FILES[name];
    if (!url) throw new EtudeError(`the Notes tutorial has no media file "${name}"`);
    media.set(name, await readBundled(url));
  }
  return { bundle, media };
}

/**
 * Adds a fresh copy of the tutorial at the top level of Notes. With `ifNew`, only when this collection has never
 * had it (and has no top-level "Notes showcase" folder already); either way the collection then counts as having it.
 */
export async function addNotesTutorial(e: Etude, opts: { ifNew?: boolean; dryRun?: boolean } = {}): Promise<TutorialResult> {
  const none = (reason: "seen" | "exists"): TutorialResult => ({ added: false, reason, root: null, start: null, notes: 0, items: 0 });
  if (opts.ifNew && e.db.get("SELECT 1 FROM meta WHERE key = ?", NOTES_TUTORIAL_FLAG)) return none("seen");
  const { bundle, media: files } = await loadTutorial();
  const flag = () => {
    if (!opts.dryRun) e.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", NOTES_TUTORIAL_FLAG, String(bundle.version));
  };
  // A collection that already has the folder (made by hand before it shipped) doesn't get a second one.
  if (opts.ifNew && e.notes.list().some((n) => n.parentId === null && n.kind === "folder" && n.title === NOTES_TUTORIAL_TITLE)) {
    flag();
    return none("exists");
  }
  const media = new Map<string, { file: string; url: string }>();
  const stored = (name: string) => {
    if (!media.has(name)) {
      const data = files.get(name);
      if (!data) throw new EtudeError(`the Notes tutorial has no media file "${name}"`);
      const m = e.storeMedia(name, data, { dryRun: opts.dryRun });
      media.set(name, { file: m.file, url: m.url });
    }
    return media.get(name)!;
  };
  let result: TutorialResult | null = null;
  try {
    e.db.tx(() => {
      result = build();
      if (opts.dryRun) throw new DryRun();
    });
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return opts.dryRun ? { ...result!, dryRun: true } : result!;

  function build(): TutorialResult {
    // Two windows opening Notes at once: the second finds the flag the first just set.
    if (opts.ifNew && e.db.get("SELECT 1 FROM meta WHERE key = ?", NOTES_TUTORIAL_FLAG)) return none("seen");
    const ids = new Map<string, string>();
    const idOf = (k: string) => {
      const id = ids.get(k);
      if (!id) throw new EtudeError(`the Notes tutorial points at a note it doesn't have (${k})`);
      return id;
    };
    // Every note first (parents come before their pages), then the bodies, whose links need every id.
    for (const n of bundle.notes) {
      const parentId = n.parent ? idOf(n.parent) : null;
      const made = e.notes.create({
        title: n.title,
        parentId,
        kind: n.kind,
        icon: n.icon,
        look: n.look,
        ...(n.kind === "canvas" ? { scene: n.scene } : {}),
        ...(n.kind === "file" ? { content: n.content ?? "" } : {}),
        ...(n.kind === "pdf" ? { file: stored(String(n.file).replace(/^media:/, "")).file } : {}),
      });
      ids.set(n.key, made.id);
    }
    const fill = (node: DocNode): DocNode => {
      const out: DocNode = { ...node };
      if (node.attrs) {
        const a: Record<string, unknown> = { ...node.attrs };
        for (const [k, v] of Object.entries(a)) {
          if (typeof v !== "string") continue;
          if (v.startsWith("media:")) a[k] = stored(v.slice(6)).url;
          else if ((k === "id" && (node.type === "noteLink" || node.type === "canvasEmbed")) && v.startsWith("@")) a[k] = idOf(v.slice(1));
        }
        out.attrs = a;
      }
      if (node.content) out.content = node.content.map(fill);
      return out;
    };
    for (const n of bundle.notes) if (n.kind === "page" && n.doc) e.notes.update(idOf(n.key), { doc: fill(n.doc) });
    const pins = bundle.notes.filter((n) => n.pinned).sort((a, b) => a.pinned! - b.pinned!);
    const t0 = Date.now();
    pins.forEach((n, i) => e.db.run("UPDATE notes SET pinned = ? WHERE id = ? AND pinned IS NULL", new Date(t0 + i).toISOString(), idOf(n.key)));
    const pack = JSON.parse(JSON.stringify(bundle.pack));
    for (const it of pack.items ?? []) if (typeof it.source === "string" && it.source.startsWith("note:@")) it.source = `note:${idOf(it.source.slice(6))}`;
    const report = e.importPack(pack);
    flag();
    return { added: true, root: idOf(bundle.notes[0].key), start: ids.get("start") ?? null, notes: bundle.notes.length, items: report.items.created + report.items.updated + report.items.unchanged };
  }
}

class DryRun extends Error {}
