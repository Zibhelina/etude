import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { docFromText, docText } from "../src/core/notes.ts";

test("notes: pages nest, move, archive with their children, and search title and text", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const course = e.notes.create({ title: "CMPT 307", icon: "📘" });
  const w1 = e.notes.create({ title: "Week 1", parentId: course.id, doc: docFromText("# Greedy\n- exchange argument\n- [x] read 4.1") });
  const w2 = e.notes.create({ title: "Week 2", parentId: course.id });
  assert.deepEqual(e.notes.list().map((n) => n.title), ["CMPT 307", "Week 1", "Week 2"]);
  assert.equal(e.notes.get(course.id).children, 2);
  assert.equal(w1.text, "Greedy\nexchange argument\nread 4.1");
  assert.equal(e.notes.search("exchange")[0].id, w1.id);
  assert.equal(e.notes.search("week")[0].title.startsWith("Week"), true);
  assert.throws(() => e.notes.move(course.id, w1.id), /inside itself/);
  e.notes.move(w2.id, course.id, 0);
  assert.deepEqual(e.notes.list().map((n) => n.title), ["CMPT 307", "Week 2", "Week 1"]);
  e.notes.move(w1.id, null);
  assert.equal(e.notes.get(w1.id).parentId, null);
  assert.deepEqual(e.notes.setArchived(course.id, true).ids.sort(), [course.id, w2.id].sort());
  assert.deepEqual(e.notes.list().map((n) => n.title), ["Week 1"]);
  e.notes.setArchived(course.id, false);
  assert.equal(e.notes.list().length, 3);
  const upd = e.notes.update(w1.id, { title: "Week 1 · Greedy", doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] } });
  assert.equal(upd.text, "hi");
  assert.throws(() => e.notes.update(w1.id, { doc: "<p>raw html</p>" }), /document/);
  assert.throws(() => e.notes.update(w1.id, { doc: { type: "doc", content: [{ type: "<script>" }] } }), /valid document/);
  assert.deepEqual(e.notes.delete(course.id).ids.length, 2);
  assert.deepEqual(e.notes.list().map((n) => n.title), ["Week 1 · Greedy"]);
});

test("notes: the HTTP API creates, saves and lists pages", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const app = createApp(e);
  const j = (method: string, path: string, body?: unknown) =>
    Promise.resolve(app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) })).then(async (r: Response) => ({ status: r.status, body: await r.json() }));
  const made = await j("POST", "/api/notes", { title: "Inbox" });
  assert.equal(made.status, 200);
  const saved = await j("PATCH", `/api/notes/${made.body.id}`, { doc: docFromText("hello world") });
  assert.equal(saved.body.text, "hello world");
  assert.equal((await j("GET", "/api/notes")).body.length, 1);
  assert.equal((await j("GET", "/api/notes/search?q=hello")).body[0].id, made.body.id);
  assert.equal((await j("GET", "/api/notes/nope")).status, 404);
  assert.equal(docText(saved.body.doc), "hello world");
});

test("notes: an Obsidian vault imports with its folders, [[links]], backlinks, and links that resolve later", async (t) => {
  const { markdownToDoc, docToMarkdown } = await import("../src/core/notes-md.ts");
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const r = e.notes.importMarkdown(
    [
      { path: "Vault/CMPT 307.md", text: "---\ntags: x\n---\n# CMPT 307\nSee [[Greedy]] and [[Dynamic programming|DP]]. %%hidden%%" },
      { path: "Vault/CMPT 307/Week 1/Greedy.md", text: "## Exchange\n- [x] **swap**\n  - nested\n\n![[d.png]]\n\nBack to [[CMPT 307]]." },
      { path: "Vault/.obsidian/x.md", text: "skip me" },
    ],
    { media: { "d.png": "/media/files/" + "a".repeat(64) + ".png" } },
  );
  assert.equal(r.pages, 2);
  assert.equal(r.links, 2);
  assert.equal(r.unresolved, 1);
  assert.deepEqual(e.notes.list().map((n) => n.title), ["Vault", "CMPT 307", "Week 1", "Greedy"]);
  // Folders without a note of their own come in as folders; CMPT 307 has CMPT 307.md beside it, so it's a page.
  assert.deepEqual(e.notes.list().map((n) => n.kind), ["folder", "page", "folder", "page"]);
  const course = e.notes.resolve("CMPT 307");
  assert.ok(!course.text.includes("hidden"));
  assert.equal(course.doc.content?.[0].type, "paragraph", "the heading repeating the title is dropped");
  const greedy = e.notes.resolve("Greedy");
  assert.ok(greedy.doc.content?.some((b) => b.type === "image"));
  assert.deepEqual(e.notes.backlinks(greedy.id).map((b) => b.title), ["CMPT 307"]);
  assert.deepEqual(e.notes.backlinks(course.id).map((b) => b.title), ["Greedy"]);
  // A page later named like the unresolved link claims it.
  const dp = e.notes.create({ title: "Dynamic programming" });
  assert.deepEqual(e.notes.backlinks(dp.id).map((b) => b.title), ["CMPT 307"]);
  const md = docToMarkdown(e.notes.get(course.id).doc);
  assert.match(md, /\[\[Dynamic programming\|DP\]\]/);
  assert.equal(markdownToDoc("[x](other.md)").content?.[0].content?.[0].type, "noteLink");
});

test("notes: equations, callouts and tables survive Markdown in and out; prices stay text", async () => {
  const { markdownToDoc, docToMarkdown } = await import("../src/core/notes-md.ts");
  const d = markdownToDoc("Euler $e^{i\\pi}+1=0$ costs $5 and $6.\n\n$$\n\\int_0^1 x^2 dx\n$$\n\n> [!warning] Careful\n> greedy fails here\n\n| a | b |\n|---|---|\n| 1 | $n$ |\n");
  const types = d.content!.map((b) => b.type);
  assert.deepEqual(types, ["paragraph", "mathBlock", "callout", "table"]);
  assert.deepEqual(d.content![0].content!.map((n) => n.type), ["text", "mathInline", "text"]);
  assert.match(d.content![0].content![2].text!, /\$5 and \$6/);
  assert.equal(d.content![2].attrs!.kind, "warning");
  const md = docToMarkdown(d);
  assert.match(md, /\$e\^\{i\\pi\}\+1=0\$/);
  assert.match(md, /\$\$\n\\int_0\^1 x\^2 dx\n\$\$/);
  assert.match(md, /> \[!warning\]/);
  assert.match(md, /\| 1 \| \$n\$ \|/);
  assert.deepEqual(markdownToDoc(md).content!.map((b) => b.type), types);
});

test("notes: a page's look (cover, width, font, size) is checked, stored and cleared; styled text exports as HTML", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const n = e.notes.create({ title: "Look", look: { width: "wide", font: "serif" } });
  assert.deepEqual(n.look, { width: "wide", font: "serif" });
  const u = e.notes.update(n.id, { look: { width: "normal", font: "serif", size: "large", cover: "dawn" } });
  assert.deepEqual(u.look, { font: "serif", size: "large", cover: { kind: "preset", id: "dawn" } });
  assert.equal(e.notes.list()[0].look.font, "serif");
  assert.throws(() => e.notes.update(n.id, { look: { width: "huge" } }), /width/);
  assert.throws(() => e.notes.update(n.id, { look: { colour: "red" } }), /no "colour"/);
  assert.throws(() => e.notes.update(n.id, { look: { cover: "nope" } }), /no cover/);
  assert.throws(() => e.notes.update(n.id, { look: { cover: { kind: "image", media: "../etc/passwd", y: 1 } } }), /picture in the collection/);
  const img = e.notes.update(n.id, { look: { cover: `image:files/${"a".repeat(64)}.png:30` } });
  assert.deepEqual(img.look.cover, { kind: "image", media: `files/${"a".repeat(64)}.png`, y: 30 });
  assert.deepEqual(e.notes.update(n.id, { look: {} }).look, {});
  const { docToHtml } = await import("../src/core/notes-md.ts");
  const html = docToHtml({
    type: "doc",
    content: [
      { type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "red", marks: [{ type: "textStyle", attrs: { color: "var(--nc-red)", backgroundColor: "var(--nc-yellow-bg)", fontFamily: "var(--nf-mono)" } }] }] },
      { type: "paragraph", content: [{ type: "text", text: "evil", marks: [{ type: "textStyle", attrs: { color: "red;background:url(x)" } }] }] },
      { type: "columns", content: [{ type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }, { type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] }] },
    ],
  });
  assert.match(html, /<p style="text-align:center"><span style="color:#d44c47;background:#fbf1c8;border-radius:3px;padding:0 2px;font-family:'JetBrains Mono',monospace">red<\/span><\/p>/);
  assert.match(html, /<p>evil<\/p>/);
  assert.match(html, /<div class="cols"><div><p>a<\/p><\/div><div><p>b<\/p><\/div><\/div>/);
  assert.equal(e.notes.get(n.id).text, "");
});

test("notes: a folder holds pages with no body of its own; an empty page becomes one and back", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const f = e.notes.create({ title: "Fall 2026", kind: "folder" });
  assert.equal(f.kind, "folder");
  const p = e.notes.create({ title: "CMPT 307", parentId: f.id, doc: docFromText("greedy") });
  assert.equal(p.kind, "page");
  assert.equal(e.notes.get(f.id).children, 1);
  assert.throws(() => e.notes.create({ title: "x", kind: "folder", doc: docFromText("a") }), /no body/);
  assert.throws(() => e.notes.update(f.id, { doc: docFromText("a") }), /no body/);
  assert.throws(() => e.notes.update(p.id, { kind: "folder" }), /only an empty page/);
  assert.throws(() => e.notes.create({ title: "x", kind: "box" as any }), /page.*folder/);
  // A folder doesn't show up in search; a page inside it does.
  assert.deepEqual(e.notes.search("Fall").map((n) => n.id), []);
  assert.equal(e.notes.search("greedy")[0].id, p.id);
  const empty = e.notes.create({ title: "Week 1" });
  assert.equal(e.notes.list().find((n) => n.id === empty.id)!.empty, true);
  assert.equal(e.notes.update(empty.id, { kind: "folder" }).kind, "folder");
  assert.equal(e.notes.update(empty.id, { kind: "page" }).kind, "page");
  // The HTTP API takes kind too.
  const app = createApp(e);
  const r = await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Archive", kind: "folder" }) });
  assert.equal((await r.json()).kind, "folder");
});

test("notes: a canvas keeps its Excalidraw scene, its words are searchable, and .excalidraw goes in and out with its pictures in the media", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { sceneFromExcalidraw, sceneToExcalidraw } = await import("../src/core/notes.ts");
  const dir = mkdtempSync(join(tmpdir(), "etude-canvas-"));
  const e = await Etude.open(join(dir, "c.db"));
  t.after(() => {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const page = e.notes.create({ title: "Graphs" });
  const c = e.notes.create({ title: "Dijkstra sketch", kind: "canvas", parentId: page.id });
  assert.equal(c.kind, "canvas");
  assert.deepEqual(c.scene?.elements, []);
  assert.equal(page.scene, null);
  assert.throws(() => e.notes.update(c.id, { doc: docFromText("x") }), /scene, not a doc/);
  assert.throws(() => e.notes.update(page.id, { scene: { elements: [] } }), /only a canvas/);
  assert.throws(() => e.notes.create({ kind: "board" as any }), /a "canvas" or a "pdf"/);
  const rect = { id: "r1", type: "rectangle", x: 0, y: 0, width: 100, height: 60, version: 1 };
  const label = { id: "t1", type: "text", text: "relax edge (u,v)", containerId: null, x: 10, y: 10, version: 1 };
  const gone = { id: "d1", type: "ellipse", isDeleted: true, version: 2 };
  const upd = e.notes.update(c.id, { scene: { elements: [rect, label, gone], appState: { viewBackgroundColor: "#fff", theme: "dark", zoom: 3 }, files: {} } });
  assert.deepEqual(upd.scene!.elements.map((x) => x.id), ["r1", "t1"]);
  assert.deepEqual(upd.scene!.appState, { viewBackgroundColor: "#fff" });
  assert.equal(upd.text, "relax edge (u,v)");
  assert.equal(e.notes.search("relax")[0].id, c.id);
  assert.equal(e.notes.list().find((n) => n.id === c.id)!.kind, "canvas");
  // Inline pictures are refused: they belong in the media.
  assert.throws(() => e.notes.update(c.id, { scene: { elements: [], files: { f: { mimeType: "image/png", dataURL: "data:image/png;base64,AAAA" } } } }), /media/);
  // A .excalidraw file with an inline picture: the picture lands in the media and comes back out on export.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const file = { type: "excalidraw", version: 2, elements: [{ id: "i1", type: "image", fileId: "pic", x: 0, y: 0, width: 10, height: 10 }], appState: {}, files: { pic: { id: "pic", mimeType: "image/png", dataURL: `data:image/png;base64,${png.toString("base64")}`, created: 1 } } };
  const scene = sceneFromExcalidraw(JSON.stringify(file), (name, data) => e.storeMedia(name, data));
  assert.match(scene.files.pic.media, /^files\/[0-9a-f]{64}\.png$/);
  const made = e.notes.create({ title: "Imported", kind: "canvas", scene });
  assert.equal(made.scene!.files.pic.media, scene.files.pic.media);
  const out = sceneToExcalidraw(made.scene!, (m) => e.readMediaFile(m)) as any;
  assert.equal(out.files.pic.dataURL, file.files.pic.dataURL);
  assert.equal(e.readMediaFile("../../etc/passwd"), null);
  // The picture counts as used, so media cleanup keeps it.
  assert.ok(!e.unusedMedia().some((m) => m.path === scene.files.pic.media));
  // An embedded canvas lists the page it's in.
  e.notes.update(page.id, { doc: { type: "doc", content: [{ type: "canvasEmbed", attrs: { id: c.id, title: "Dijkstra sketch" } }] } });
  assert.deepEqual(e.notes.backlinks(c.id).map((b) => b.id), [page.id]);
  // Over HTTP: create, save, import and export.
  const app = createApp(e);
  const j = (method: string, path: string, body?: unknown) =>
    Promise.resolve(app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) }));
  const r1 = await (await j("POST", "/api/notes", { kind: "canvas", title: "API canvas" })).json();
  assert.equal(r1.kind, "canvas");
  const r2 = await (await j("PATCH", `/api/notes/${r1.id}`, { scene: { elements: [rect] } })).json();
  assert.equal(r2.scene.elements.length, 1);
  const r3 = await (await j("POST", "/api/notes/import-excalidraw", { data: JSON.stringify(file), title: "board.excalidraw" })).json();
  assert.equal(r3.title, "board");
  assert.equal(r3.kind, "canvas");
  const ex = await j("GET", `/api/notes/${r3.id}/export`);
  assert.match(ex.headers.get("content-disposition") ?? "", /board\.excalidraw/);
  assert.equal((await ex.json()).files.pic.dataURL, file.files.pic.dataURL);
  assert.equal((await j("POST", "/api/notes/import-excalidraw", { data: "nope" })).status, 400);
});
