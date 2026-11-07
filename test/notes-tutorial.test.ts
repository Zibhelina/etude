import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";
import { addNotesTutorial, loadTutorial, NOTES_TUTORIAL_FLAG } from "../src/core/notes-tutorial.ts";
import type { DocNode } from "../src/core/notes.ts";

const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-notes-tutorial-"));
async function collection(t: { after(fn: () => void): void }) {
  const dir = scratch();
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  t.after(() => {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { e, dir };
}
const tops = (e: Etude) => e.notes.list().filter((n) => n.parentId === null).map((n) => n.title);
const nodes = (d: DocNode, type: string): DocNode[] => [...(d.type === type ? [d] : []), ...(d.content ?? []).flatMap((c) => nodes(c, type))];

test("notes tutorial: added once on first open, with its pages, links, media, pins and cards", async (t) => {
  const { e } = await collection(t);
  const r = await addNotesTutorial(e, { ifNew: true });
  assert.equal(r.added, true);
  assert.equal(r.notes, 16);
  assert.equal(r.items, 6);
  assert.deepEqual(tops(e), ["Notes showcase"]);
  const list = e.notes.list();
  const under = list.filter((n) => n.parentId === r.root).map((n) => n.title);
  assert.deepEqual(under.slice(0, 10), ["Start here", "Writing basics", "Links, tags and the graph", "Math, tables and callouts", "Look and layout", "Cards inside a page", "Code you can run", "Pictures, video and PDFs", "Drawing with canvases", "Tabs, split view and the sidebar"]);
  assert.deepEqual(list.map((n) => n.kind).sort(), ["canvas", "file", "file", "folder", "folder", "page", "page", "page", "page", "page", "page", "page", "page", "page", "page", "pdf"]);
  assert.equal(e.notes.get(r.start!).title, "Start here");
  assert.deepEqual(e.notes.pinnedList().map((n) => n.title), ["Start here", "Cards inside a page", "Why spaced retrieval works.pdf"]);

  // Every link and embed points at a note of this copy; every media file is in the collection.
  const ids = new Set(list.map((n) => n.id));
  for (const n of list.filter((x) => x.kind === "page")) {
    const doc = e.notes.get(n.id).doc;
    for (const l of [...nodes(doc, "noteLink"), ...nodes(doc, "canvasEmbed")]) if (l.attrs?.id) assert.ok(ids.has(String(l.attrs.id)), `${n.title}: ${l.attrs.title}`);
    for (const m of [...nodes(doc, "image"), ...nodes(doc, "notePdf")]) assert.ok(e.readMediaFile(String(m.attrs!.src).replace(/^\/media\//, "")), `${n.title}: ${m.attrs!.src}`);
    for (const c of nodes(doc, "noteCard")) assert.ok(e.db.get("SELECT 1 FROM items WHERE id = ?", String(c.attrs!.item)), `${n.title}: card ${c.attrs!.item}`);
    for (const c of nodes(doc, "noteCards")) assert.equal(c.attrs!.deck, "Notes::Notes showcase");
  }
  const pdf = list.find((n) => n.kind === "pdf")!;
  assert.ok(e.readMediaFile(e.notes.get(pdf.id).file!));
  assert.deepEqual(e.notes.backlinks(list.find((n) => n.title === "Writing basics")!.id).map((n) => n.title).sort(), ["Links, tags and the graph", "Start here"]);
  assert.equal(e.notes.get(list.find((n) => n.title === "fourier.py")!.id).content!.includes("def square"), true);
  const items = e.db.all("SELECT i.id, i.source FROM items i JOIN decks d ON d.id = i.deck_id WHERE d.name = 'Notes::Notes showcase' ORDER BY i.id");
  assert.equal(items.length, 6);
  for (const it of items) assert.ok(ids.has(String(it.source).replace(/^note:/, "")), it.id);

  // Opening Notes again adds nothing.
  assert.deepEqual(await addNotesTutorial(e, { ifNew: true }), { added: false, reason: "seen", root: null, start: null, notes: 0, items: 0 });
  assert.equal(e.notes.list().length, 16);
});

test("notes tutorial: archived or deleted, it doesn't come back; asked for, a fresh copy comes", async (t) => {
  const { e } = await collection(t);
  const first = await addNotesTutorial(e, { ifNew: true });
  e.notes.setArchived(first.root!, true);
  assert.equal((await addNotesTutorial(e, { ifNew: true })).added, false);
  assert.deepEqual(tops(e), []);
  e.notes.setArchived(first.root!, false);
  e.notes.delete(first.root!);
  assert.equal(e.notes.list().length, 0);
  assert.equal((await addNotesTutorial(e, { ifNew: true })).added, false);
  assert.equal(e.notes.list().length, 0);

  // On demand: a whole new copy, and the six cards keep their ids (no duplicates).
  const again = await addNotesTutorial(e);
  assert.equal(again.added, true);
  assert.notEqual(again.root, first.root);
  assert.equal(e.notes.list().length, 16);
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM items WHERE id LIKE 'notes-tutorial.%'")!.n, 6);
  const twice = await addNotesTutorial(e);
  assert.equal(twice.added, true);
  assert.deepEqual(tops(e), ["Notes showcase", "Notes showcase"]);
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM items WHERE id LIKE 'notes-tutorial.%'")!.n, 6);
});

test("notes tutorial: an existing user gets it once on update; one who already has the folder doesn't get a second", async (t) => {
  const { e } = await collection(t);
  // An existing collection (pages already, no flag) gets it the first time the new version opens Notes.
  e.notes.create({ title: "My course" });
  assert.equal((await addNotesTutorial(e, { ifNew: true })).added, true);
  assert.deepEqual(tops(e), ["My course", "Notes showcase"]);

  const other = await collection(t);
  other.e.notes.create({ title: "Notes showcase", kind: "folder" });
  assert.deepEqual(await addNotesTutorial(other.e, { ifNew: true }), { added: false, reason: "exists", root: null, start: null, notes: 0, items: 0 });
  assert.ok(other.e.db.get("SELECT 1 FROM meta WHERE key = ?", NOTES_TUTORIAL_FLAG));
  assert.equal(other.e.notes.list().length, 1);
});

test("notes tutorial: a dry run writes nothing, not even the flag", async (t) => {
  const { e, dir } = await collection(t);
  const r = await addNotesTutorial(e, { ifNew: true, dryRun: true });
  assert.equal(r.added, true);
  assert.equal(r.dryRun, true);
  assert.equal(e.notes.list().length, 0);
  assert.equal(e.db.get("SELECT 1 FROM meta WHERE key = ?", NOTES_TUTORIAL_FLAG), undefined);
  assert.equal(existsSync(join(dir, "media", "files")), false);
  assert.equal((await addNotesTutorial(e, { ifNew: true })).added, true);
});

test("notes tutorial: the HTTP route seeds once and adds on demand", async (t) => {
  const { e } = await collection(t);
  const app = createApp(e);
  const post = async (body: unknown) => (await app.request("/api/notes/tutorial", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  assert.equal((await post({ ifNew: true })).added, true);
  assert.equal((await post({ ifNew: true })).reason, "seen");
  assert.equal((await post({})).added, true);
  assert.equal(e.notes.list().filter((n) => n.parentId === null).length, 2);
});

test("notes tutorial: etude note tutorial from the command line", async (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = async (args: string[]) => {
    let out = "";
    const code = await run(args, { stdout: (s) => (out += s), stderr: () => {}, stdin: () => "", isTTY: false, env: { ETUDE_HOME: dir } });
    return { code, json: JSON.parse(out) };
  };
  assert.equal((await cli(["note", "tutorial", "--if-new", "--dry-run"])).json.dryRun, true);
  assert.deepEqual((await cli(["note", "list"])).json, []);
  const r = await cli(["note", "tutorial", "--if-new"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.added, true);
  assert.equal((await cli(["note", "tutorial", "--if-new"])).json.reason, "seen");
  assert.equal((await cli(["note", "tutorial"])).json.added, true);
  assert.equal((await cli(["note", "list"])).json.length, 32);
});

test("notes tutorial: the bundle carries nothing from a personal collection and stays small", async () => {
  const { bundle, media } = await loadTutorial();
  const text = JSON.stringify(bundle);
  // No ids, media hashes, paths or course names from the collection it was written in.
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.doesNotMatch(text, /files\/[0-9a-f]{64}/);
  assert.doesNotMatch(text, /\/home\/|\/Users\/|@gmail|CMPT|University::/i);
  for (const n of bundle.notes) if (n.parent) assert.ok(bundle.notes.some((p) => p.key === n.parent), n.key);
  const bytes = [...media.values()].reduce((a, b) => a + b.byteLength, 0) + Buffer.byteLength(text);
  assert.ok(bytes < 600_000, `the tutorial is ${bytes} bytes`);
  assert.equal(readFileSync(new URL("../examples/notes-tutorial/media/spaced-retrieval.pdf", import.meta.url)).subarray(0, 5).toString(), "%PDF-");
});
