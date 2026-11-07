import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { docFromText } from "../src/core/notes.ts";

const tick = () => new Promise((r) => setTimeout(r, 3));

test("notes start page: pins keep their order, archived pins hide and come back, unpin drops them", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const a = e.notes.create({ title: "A" });
  const b = e.notes.create({ title: "B" });
  const c = e.notes.create({ title: "C", parentId: b.id });
  assert.equal(a.pinned, null);
  e.notes.pin(c.id);
  await tick();
  e.notes.pin(a.id);
  await tick();
  // Pinning again keeps the first pin time, so the order doesn't jump.
  const before = e.notes.pinnedList().map((n) => n.pinned);
  e.notes.pin(c.id);
  assert.deepEqual(e.notes.pinnedList().map((n) => n.pinned), before);
  assert.deepEqual(e.notes.pinnedList().map((n) => n.title), ["C", "A"]);
  assert.ok(e.notes.list().find((n) => n.id === a.id)?.pinned);
  // Archiving the parent takes its pinned child off the start page; unarchiving brings it back in its place.
  e.notes.setArchived(b.id, true);
  assert.deepEqual(e.notes.pinnedList().map((n) => n.title), ["A"]);
  e.notes.setArchived(b.id, false);
  assert.deepEqual(e.notes.pinnedList().map((n) => n.title), ["C", "A"]);
  assert.equal(e.notes.unpin(c.id).pinned, null);
  assert.deepEqual(e.notes.pinnedList().map((n) => n.title), ["A"]);
  assert.throws(() => e.notes.pin("nope"), /no note/);
});

test("notes start page: opened orders Jump back in, skips folders and leaves updated alone", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const ids = ["one", "two", "three"].map((title) => e.notes.create({ title }).id);
  const folder = e.notes.create({ title: "F", kind: "folder" });
  const updated = e.notes.get(ids[0]).updated;
  for (const id of ids) {
    e.notes.markOpened(id);
    await tick();
  }
  e.notes.markOpened(ids[0]);
  e.notes.markOpened(folder.id);
  assert.deepEqual(e.notes.recent().map((n) => n.title), ["one", "three", "two"]);
  assert.deepEqual(e.notes.recent(2).map((n) => n.title), ["one", "three"]);
  assert.equal(e.notes.get(folder.id).opened, null);
  assert.equal(e.notes.get(ids[0]).updated, updated);
  e.notes.setArchived(ids[2], true);
  assert.deepEqual(e.notes.recent().map((n) => n.title), ["one", "two"]);
});

test("notes start page: previews are the first blocks of a page and the first lines of a file", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const page = e.notes.create({ title: "P", doc: docFromText(["intro", "- a", "- b", ...Array.from({ length: 20 }, (_, i) => `line ${i}`)].join("\n")) });
  const file = e.notes.create({ title: "x.py", kind: "file", content: Array.from({ length: 30 }, (_, i) => `print(${i})`).join("\n") });
  const canvas = e.notes.create({ title: "c", kind: "canvas" });
  const [p, f, cv] = e.notes.previews([page.id, file.id, canvas.id, "missing"]);
  assert.equal(p.blocks.length, 6);
  assert.equal(p.blocks[0].type, "paragraph");
  assert.equal(p.blocks[1].type, "bulletList");
  assert.equal(f.head?.split("\n").length, 10);
  assert.equal(f.head?.split("\n")[0], "print(0)");
  assert.deepEqual(cv, { id: canvas.id, kind: "canvas", blocks: [], head: null });
});

test("notes start page: the HTTP API pins, marks opened and lists both", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const app = createApp(e);
  const j = (method: string, path: string, body?: unknown) =>
    Promise.resolve(app.request(path, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) })).then(async (r: Response) => ({ status: r.status, body: await r.json() }));
  const n = e.notes.create({ title: "Hi", doc: docFromText("hello") });
  assert.ok((await j("POST", `/api/notes/${n.id}/pin`)).body.pinned);
  assert.deepEqual((await j("GET", "/api/notes/pinned")).body.map((x: any) => x.id), [n.id]);
  assert.equal((await j("POST", `/api/notes/${n.id}/pin`, { pinned: false })).body.pinned, null);
  assert.ok((await j("POST", `/api/notes/${n.id}/opened`)).body.opened);
  assert.deepEqual((await j("GET", "/api/notes/recent?limit=5")).body.map((x: any) => x.id), [n.id]);
  const pv = (await j("GET", `/api/notes/previews?ids=${n.id}`)).body;
  assert.equal(pv[0].blocks[0].content[0].text, "hello");
  assert.equal((await j("POST", "/api/notes/nope/opened")).status, 404);
});

test("notes start page: an older collection gains the pinned and opened columns; the CLI pins and lists recent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "etude-notes-start-"));
  const db = join(dir, "c.db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  {
    const e = await Etude.open(db);
    e.notes.create({ title: "Old page", doc: docFromText("kept") });
    // As a collection made before the start page: no pinned/opened columns.
    e.db.sql.exec("ALTER TABLE notes DROP COLUMN pinned");
    e.db.sql.exec("ALTER TABLE notes DROP COLUMN opened");
    assert.ok(!e.db.all("PRAGMA table_info(notes)").some((c) => c.name === "pinned"));
    e.close();
  }
  {
    const e = await Etude.open(db);
    // Notes opens its table (and adds what's missing) the first time it's used.
    const [n] = e.notes.list();
    const cols = e.db.all("PRAGMA table_info(notes)").map((c) => c.name);
    assert.ok(cols.includes("pinned") && cols.includes("opened"));
    assert.equal(n.title, "Old page");
    assert.equal(n.pinned, null);
    assert.equal(n.opened, null);
    assert.equal(e.notes.get(n.id).text, "kept");
    e.close();
  }
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli", "main.ts"), "--db", db, ...args], { env: { ...process.env, ETUDE_HOME: dir }, encoding: "utf8" }));
  assert.ok(cli("note", "pin", "Old page").pinned);
  assert.ok(cli("note", "list")[0].pinned);
  assert.equal(cli("note", "pinned").length, 1);
  assert.equal(cli("note", "unpin", "Old page").pinned, null);
  assert.deepEqual(cli("note", "recent", "--limit", "3"), []);
});
