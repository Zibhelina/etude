import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";

const custom = (id: string) => ({ id, name: id, fields: [{ name: "q", kind: "markdown" as const }], template: { html: "{{q}}" }, grader: { kind: "self" as const } });

test("type folders: create, move, rename, delete", async () => {
  const e = await Etude.open(":memory:");
  const folderOf = (id: string) => e.listTypes().find((t) => t.id === id)!.folder;
  e.saveType(custom("dns-a"));
  e.saveType(custom("dns-b"));
  e.saveType(custom("chem"));

  assert.equal(folderOf("dns-a"), "");
  assert.equal(e.createTypeFolder("  Networks :: Empty "), "Networks::Empty");
  assert.deepEqual(e.listTypeFolders(), ["Networks", "Networks::Empty"]);

  e.moveType("dns-a", "Networks::DNS");
  e.moveType("dns-b", "Networks::DNS");
  e.moveType("chem", "Science");
  assert.equal(folderOf("dns-a"), "Networks::DNS");
  assert.deepEqual(e.listTypeFolders(), ["Networks", "Networks::DNS", "Networks::Empty", "Science"]);

  // A built-in moved into a folder is still the shipped, unedited version.
  e.moveType("numeric", "Science");
  const num = e.listTypes().find((t) => t.id === "numeric")!;
  assert.equal(num.folder, "Science");
  assert.equal(num.builtin, true);
  assert.equal(num.edited, false);

  const r = e.renameTypeFolder("Networks", "Courses::Networks");
  assert.equal(r.types, 2);
  assert.equal(folderOf("dns-a"), "Courses::Networks::DNS");
  assert.deepEqual(e.listTypeFolders(), ["Courses", "Courses::Networks", "Courses::Networks::DNS", "Courses::Networks::Empty", "Science"]);
  assert.throws(() => e.renameTypeFolder("Courses", "Courses::Inner"), /inside itself/);

  // Deleting keeps the types and lifts them to the parent.
  const d = e.deleteTypeFolder("Courses::Networks");
  assert.deepEqual(d.moved.sort(), ["dns-a", "dns-b"]);
  assert.equal(folderOf("dns-a"), "Courses");
  assert.deepEqual(e.listTypeFolders(), ["Courses", "Science"]);
  e.deleteTypeFolder("Science");
  assert.equal(folderOf("chem"), "");
  assert.equal(folderOf("numeric"), "");

  e.moveType("dns-a", "");
  assert.equal(folderOf("dns-a"), "");
  assert.throws(() => e.moveType("nope", "X"), /unknown type/);

  // Deleting a type forgets where it was.
  e.moveType("chem", "Science");
  e.deleteType("chem");
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM type_placement WHERE type_id = 'chem'")!.n, 0);
  e.close();
});
