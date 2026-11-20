import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { WEB_STARTER } from "../src/core/notes.ts";

const HTML = '<div id="t">Timeline</div>\n<script>document.getElementById("t").textContent += " ok";</script>\n';

test("notebook portals: a web file is its own note, HTML kept as written, opened by id in pages", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());

  const w = e.notes.create({ title: "Term timeline", kind: "web", content: HTML });
  assert.equal(w.kind, "web");
  assert.equal(w.content, HTML);
  assert.equal(e.notes.create({ title: "Blank", kind: "web" }).content, WEB_STARTER);
  // A web file is its HTML: no doc, and it stays a web file.
  assert.throws(() => e.notes.create({ title: "x", kind: "web", doc: { type: "doc", content: [] } }), /not a doc/);
  assert.throws(() => e.notes.update(w.id, { doc: { type: "doc", content: [] } }), /not a doc/);
  assert.throws(() => e.notes.update(w.id, { kind: "page" }), /stays a web file/);
  assert.equal(e.notes.update(w.id, { content: HTML + "<!-- v2 -->" }).content, HTML + "<!-- v2 -->");

  const page = e.notes.create({ title: "Journal", doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "today" }] }] } });
  const after = e.notes.portal(page.id, w.id);
  assert.deepEqual(after.doc.content?.map((b) => b.type), ["paragraph", "portal"]);
  assert.equal(after.doc.content?.[1].attrs?.id, w.id);
  // At the top, with a height.
  const top = e.notes.portal(page.id, w.id, { at: 0, height: 420 });
  assert.deepEqual(top.doc.content?.map((b) => b.type), ["portal", "paragraph", "portal"]);
  assert.equal(top.doc.content?.[0].attrs?.height, 420);
  // A portal is a link: the web file knows the page it's in, and the page's text names it.
  assert.ok(e.notes.backlinks(w.id).some((b: any) => b.id === page.id));
  assert.match(e.notes.get(page.id).text, /Term timeline/);

  // Portals open onto web files and canvases, only in pages.
  const other = e.notes.create({ title: "Other" });
  assert.throws(() => e.notes.portal(page.id, other.id), /onto a web file, a canvas or a kanban board/);
  assert.throws(() => e.notes.portal(w.id, w.id), /only a page can hold a portal/);
  assert.throws(() => e.notes.portal(page.id, w.id, { height: 5 }), /height/);
  const canvas = e.notes.create({ title: "Sketch", kind: "canvas" });
  assert.equal(e.notes.portal(page.id, canvas.id).doc.content?.at(-1)?.type, "canvasEmbed");

  // The start page previews a web file by its first lines, like a file.
  assert.equal(e.notes.previews([w.id])[0].head?.split("\n")[0], '<div id="t">Timeline</div>');

  // HTTP: create, embed and download as .html.
  const app = createApp(e);
  const made = await (await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "web", title: "Grades", content: "<p>hi</p>" }) })).json();
  assert.equal(made.kind, "web");
  const emb = await app.request(`/api/notes/${other.id}/portal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: made.id }) });
  assert.equal(emb.status, 200);
  assert.equal((await emb.json()).doc.content.at(-1).type, "portal");
  const dl = await app.request(`/api/notes/${made.id}/export`);
  assert.match(dl.headers.get("content-type") ?? "", /text\/html/);
  assert.match(dl.headers.get("content-disposition") ?? "", /Grades\.html/);
  assert.equal(await dl.text(), "<p>hi</p>");
});

test("notebook portals: the CLI makes a web file and opens a portal to it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "etude-portals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "e.db");
  const html = join(dir, "timeline.html");
  writeFileSync(html, HTML);
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli", "main.ts"), "--db", db, ...args], { env: { ...process.env, ETUDE_HOME: dir }, encoding: "utf8" }));
  const w = cli("note", "new", "Term timeline", "--web", "--content-file", html);
  assert.equal(w.kind, "web");
  assert.equal(w.content, HTML);
  cli("note", "new", "Journal", "--text", "today");
  const dry = cli("note", "portal", "Term timeline", "Journal", "--at", "0", "--dry-run");
  assert.equal(dry.doc.content[0].type, "portal");
  assert.equal(cli("note", "show", "Journal").doc.content.length, 1, "dry run wrote nothing");
  const page = cli("note", "portal", "Term timeline", "Journal", "--at", "0");
  assert.deepEqual(page.doc.content.map((b: any) => b.type), ["portal", "paragraph"]);
  assert.equal(execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli", "main.ts"), "--db", db, "note", "export", "Term timeline"], { env: { ...process.env, ETUDE_HOME: dir }, encoding: "utf8" }).includes("Timeline"), true);
});
