import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { install, localEvent, rows, TABLES } from "../src/core/sync/log.ts";
import { fingerprint, project, projectChanges, projectionPending } from "../src/core/sync/project.ts";

const temp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "sync-notes-"));
const password = "a test Sync password";
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const tree = (e: Etude) => e.db.all("SELECT id,parent_id,title,kind,doc,text,position,archived,pinned,look,scene,file FROM notes ORDER BY id");

async function pair(dir: string) {
  const a = await Etude.open(join(dir, "a.db"), { home: join(dir, "ha") }), b = await Etude.open(join(dir, "b.db"), { home: join(dir, "hb") });
  return { a, b, folder: join(dir, "shared") };
}
const both = async (a: Etude, b: Etude) => { await syncFor(a).now({ waitMedia: true }); await syncFor(b).now({ waitMedia: true }); await syncFor(a).now({ waitMedia: true }); };

test("notes sync between devices: made, edited, moved, pinned and deleted; when one was opened stays local", async () => {
  const dir = temp();
  const { a, b, folder } = await pair(dir);
  try {
    for (const e of [a, b]) { syncFor(e).setup({ folder }); await syncFor(e).unlock({ password }); }
    const f = a.notes.create({ title: "Course", kind: "folder" });
    const p = a.notes.create({ title: "Week 1", parentId: f.id, doc: doc("TCP has three handshakes") });
    const c = a.notes.create({ title: "main.py", parentId: f.id, kind: "file", content: "print('hi')\n" });
    const k = a.notes.create({ title: "Board", kind: "canvas" });
    await both(a, b);
    assert.deepEqual(tree(b), tree(a));
    assert.equal(b.notes.get(p.id).text.includes("three handshakes"), true);
    assert.equal(b.notes.get(c.id).content, "print('hi')\n");
    assert.equal(b.notes.search("handshakes").length, 1);
    // Edited on b, many saves: one change goes up, and a takes it.
    for (let i = 0; i < 5; i++) b.notes.update(p.id, { doc: doc(`TCP has a three-way handshake, take ${i}`) });
    b.notes.pin(k.id);
    b.notes.markOpened(p.id);
    const sent = () => b.db.all("SELECT body FROM sync_events").filter(r => { const ev = JSON.parse(r.body); return ev.table === "notes" && ev.key === p.id; }).length;
    const was = sent();
    await both(a, b);
    assert.equal(sent() - was, 1);
    // A page's search text is worked out on each device; it doesn't travel.
    assert.equal(b.db.get("SELECT 1 FROM sync_registers WHERE tbl='notes' AND key=? AND field='/text'", p.id), undefined);
    assert.ok(b.db.get("SELECT 1 FROM sync_registers WHERE tbl='notes' AND key=? AND field='/text'", c.id));
    assert.equal(a.notes.get(p.id).text.includes("take 4"), true);
    assert.deepEqual(tree(a), tree(b));
    assert.equal(a.db.get("SELECT opened FROM notes WHERE id=?", p.id)!.opened, null);
    assert.notEqual(b.db.get("SELECT opened FROM notes WHERE id=?", p.id)!.opened, null);
    // Moved out on a, then the folder deleted: the moved page stays, the rest goes on both.
    a.notes.move(c.id, null);
    a.notes.delete(f.id);
    await both(a, b);
    assert.deepEqual(tree(b), tree(a));
    assert.equal(b.db.get("SELECT 1 FROM notes WHERE id=?", p.id), undefined);
    assert.equal(b.db.get("SELECT parent_id FROM notes WHERE id=?", c.id)!.parent_id, null);
    // A full rebuild of the same registers gives the same notes.
    const before = tree(b);
    project(b);
    assert.deepEqual(tree(b), before);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a collection that synced before notes did sends its notes once, and a full rebuild doesn't drop notes it hasn't sent", async () => {
  const dir = temp();
  const { a, b, folder } = await pair(dir);
  try {
    for (const e of [a, b]) { syncFor(e).setup({ folder }); await syncFor(e).unlock({ password }); }
    await both(a, b);
    // As an older version left it: no notes triggers, nothing about notes in the registers.
    const old = a.notes.create({ title: "Written before", doc: doc("kept") });
    for (const op of ["insert", "update", "delete"]) a.db.sql.exec(`DROP TRIGGER sync_notes_${op}`);
    a.db.run("DELETE FROM sync_outbox WHERE tbl='notes'");
    a.db.run("DELETE FROM sync_registers WHERE tbl='notes'");
    project(a);
    assert.ok(a.db.get("SELECT 1 FROM notes WHERE id=?", old.id));
    install(a.db);
    install(a.db);
    assert.equal(a.db.get("SELECT count(*) n FROM sync_outbox WHERE tbl='notes' AND key=?", old.id)!.n, 1);
    await both(a, b);
    assert.equal(b.notes.get(old.id).title, "Written before");
    assert.equal(rows(b.db, "notes").has(old.id), true);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a table this version doesn't know is kept, the sync goes on, and the version that knows it builds it", async () => {
  const dir = temp();
  const { a, b, folder } = await pair(dir);
  try {
    for (const e of [a, b]) { syncFor(e).setup({ folder }); await syncFor(e).unlock({ password }); }
    await both(a, b);
    // A newer app on a syncs a table nobody here knows, and a note beside it.
    a.db.tx(() => { localEvent(a.db, "future_table", "k1", { "/x": 1 }); localEvent(a.db, "future_table", "k2", {}, true); });
    const page = a.notes.create({ title: "After the future", doc: doc("still here") });
    await both(a, b);
    assert.equal(b.notes.get(page.id).title, "After the future");
    assert.deepEqual(rows(b.db, "future_table").get("k1"), { x: 1 });
    assert.ok(b.db.get("SELECT 1 FROM sync_deleted WHERE tbl='future_table' AND key='k2'"));
    assert.equal(projectionPending(b), null);
    // An older app on b kept the notes' registers without building them; the version that knows notes builds them.
    b.db.run("DELETE FROM notes WHERE id=?", page.id);
    b.db.run("UPDATE sync_meta SET value=? WHERE key='projection'", JSON.stringify(fingerprint(b.db, TABLES.filter(t => t !== "notes"))));
    assert.equal(projectionPending(b), "full");
    projectChanges(b);
    assert.equal(b.notes.get(page.id).title, "After the future");
    assert.equal(projectionPending(b), null);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});
