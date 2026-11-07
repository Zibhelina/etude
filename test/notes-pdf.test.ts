import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

test("notes: a PDF is a note of its own that keeps its file, downloads it, and is kept by media cleanup", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const m = e.storeMedia("Lecture 3.pdf", PDF);
  assert.equal(m.kind, "document");
  const course = e.notes.create({ title: "CMPT 307" });
  const n = e.notes.create({ title: "Lecture 3", parentId: course.id, kind: "pdf", file: m.url });
  assert.equal(n.kind, "pdf");
  assert.match(n.file!, /^files\/[0-9a-f]{64}\.pdf$/);
  assert.equal(e.notes.list().find((x) => x.id === n.id)!.kind, "pdf");
  assert.throws(() => e.notes.create({ kind: "pdf" }), /PDF in the collection's media/);
  assert.throws(() => e.notes.create({ kind: "pdf", file: "files/../../etc/passwd.pdf" }), /PDF in the collection's media/);
  assert.throws(() => e.notes.create({ title: "x", file: m.url }), /only a PDF note has a file/);
  assert.throws(() => e.notes.update(n.id, { doc: { type: "doc", content: [] } }), /no body/);
  assert.throws(() => e.notes.update(n.id, { kind: "page" }), /stays a PDF/);
  assert.equal(e.notes.update(n.id, { title: "Lecture 3 · Greedy" }).title, "Lecture 3 · Greedy");
  // The PDF's file isn't unused while its note exists.
  assert.ok(!e.unusedMedia().some((u) => u.path === n.file));
  const app = createApp(e);
  const r = await app.request(`/api/notes/${n.id}/export`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("content-disposition")!, /Lecture%203%20%C2%B7%20Greedy\.pdf/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PDF);
  const api = await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Slides", kind: "pdf", file: m.url }) });
  assert.equal(api.status, 200);
  assert.equal((await api.json()).kind, "pdf");
});

test("notes: importing a vault turns its PDFs into PDF notes where they sit, and [[links]] to them resolve", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const m = e.storeMedia("Greedy.pdf", PDF);
  const r = e.notes.importMarkdown(
    [{ path: "Vault/Week 1/Notes.md", text: "See [[Greedy.pdf]] and [[Greedy]]." }],
    { pdfs: [{ path: "Vault/Week 1/Greedy.pdf", file: m.url }] },
  );
  assert.equal(r.pdfs, 1);
  const list = e.notes.list();
  const pdf = list.find((x) => x.kind === "pdf")!;
  assert.equal(pdf.title, "Greedy");
  assert.equal(list.find((x) => x.id === pdf.parentId)!.title, "Week 1");
  assert.equal(e.notes.backlinks(pdf.id).length, 1);
  // A folder with only a PDF in it still imports.
  const r2 = e.notes.importMarkdown([], { pdfs: [{ path: "Solo.pdf", file: m.url }] });
  assert.equal(r2.pdfs, 1);
});
