import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { Etude } from "../src/core/engine.ts";
import { findByPath, insertBlocks, insertText, moveBlocks, patchDoc, patchText, roundTrips, treeText } from "../src/core/notes-edit.ts";
import { addElement, deleteElements, editElement, imageSize, listElements } from "../src/core/canvas-edit.ts";
import { emptyScene, checkScene } from "../src/core/notes.ts";
import { docToMarkdown, markdownToDoc } from "../src/core/notes-md.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli", "main.ts");

test("notes-edit: paths hold titles with slashes, ids resolve by their start", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const main = e.notes.create({ title: "Main", kind: "folder" });
  const day = e.notes.create({ title: "Journal - 8/11/2026", parentId: main.id });
  const other = e.notes.create({ title: "Week 1", parentId: main.id });
  e.notes.create({ title: "Week 1", kind: "folder" });
  assert.equal(e.notes.resolve("Main/Journal - 8/11/2026").id, day.id);
  assert.equal(e.notes.resolve("main/journal - 8/11/2026").id, day.id);
  assert.equal(e.notes.resolve("Main/Week 1").id, other.id);
  assert.throws(() => e.notes.resolve("Week 1"), /use the id or its path/);
  assert.equal(e.notes.resolve(day.id.slice(0, 8)).id, day.id);
  assert.deepEqual(findByPath(e.notes.list(), "Main/Nope"), []);
  const tree = treeText(e.notes.list());
  assert.match(tree, /^Main\/  [0-9a-f]{8}\n  Journal - 8\/11\/2026  [0-9a-f]{8}/);
});

test("notes-edit: append goes under a heading and leaves the rest alone", () => {
  const doc = markdownToDoc("# Plan\n\n- [ ] Lab 2\n\n## Ideas\n\none\n\n## End\n\nbye");
  const before = JSON.stringify(doc.content);
  const { doc: out, at } = insertBlocks(doc, markdownToDoc("two").content!, { under: "ideas" });
  assert.equal(at, 4);
  assert.equal(docToMarkdown(out), "# Plan\n\n- [ ] Lab 2\n\n## Ideas\n\none\n\ntwo\n\n## End\n\nbye\n");
  assert.equal(JSON.stringify(doc.content), before, "the input isn't changed");
  assert.equal(docToMarkdown(insertBlocks(doc, markdownToDoc("top").content!, { top: true }).doc).split("\n")[0], "top");
  assert.match(docToMarkdown(insertBlocks(doc, markdownToDoc("last").content!).doc), /bye\n\nlast\n$/);
  assert.throws(() => insertBlocks(doc, [], { under: "Nowhere" }), /no heading/);
  // A blank page starts fresh instead of keeping its empty line first.
  assert.equal(insertBlocks({ type: "doc", content: [{ type: "paragraph" }] }, markdownToDoc("hi").content!).doc.content!.length, 1);
});

test("notes-edit: patch rewrites only the blocks it touches", () => {
  const portal = { type: "portal", attrs: { id: "x", title: "Board" } };
  const coloured = { type: "paragraph", content: [{ type: "text", marks: [{ type: "textStyle", attrs: { color: "var(--nc-red)" } }], text: "a red line of text" }] };
  const doc = { type: "doc", content: [...markdownToDoc("# Todo\n\n- [ ] Lab 2\n- [ ] Read").content!, portal, coloured, ...markdownToDoc("tail *here*").content!] };
  assert.equal(roundTrips(doc.content[1]), true);
  assert.equal(roundTrips(portal), false);
  assert.equal(roundTrips(coloured), false);

  // Ticking a to-do.
  let r = patchDoc(doc, "- [ ] Lab 2", "- [x] Lab 2");
  assert.equal(r.mode, "markdown");
  assert.deepEqual(r.blocks, [1]);
  assert.equal(r.doc.content![1].content![0].attrs!.checked, true);
  assert.deepEqual(r.doc.content![2], doc.content[2], "the portal block is untouched");

  // Inside a coloured run: swapped in place, the colour stays.
  r = patchDoc(doc, "red line", "blue line");
  assert.equal(r.mode, "text");
  assert.deepEqual(r.doc.content![3].content![0].marks, coloured.content[0].marks);
  assert.equal(r.doc.content![3].content![0].text, "a blue line of text");
  assert.equal(coloured.content[0].text, "a red line of text", "the input isn't changed");

  // Across a portal: refused, unless forced.
  assert.throws(() => patchDoc(doc, "- [ ] Read\n\n[[Board]]", "- [ ] Read"), /markdown can't hold whole/);
  r = patchDoc(doc, "- [ ] Read\n\n[[Board]]", "- [ ] Read", { force: true });
  assert.ok(!r.doc.content!.some((b) => b.type === "portal"));

  // Spanning a heading and its list.
  r = patchDoc(doc, "# Todo\n\n- [ ] Lab 2", "## Today\n\n- [ ] Lab 3");
  assert.equal(docToMarkdown({ type: "doc", content: r.doc.content!.slice(0, 2) }), "## Today\n\n- [ ] Lab 3\n- [ ] Read\n");

  // Unique unless --all; missing text says so.
  assert.throws(() => patchDoc(doc, "e", "E"), /appears \d+ times/);
  assert.equal(patchDoc(doc, "Lab", "Lab", { all: true }).replaced, 1);
  assert.throws(() => patchDoc(doc, "nowhere", "x"), /isn't on the page/);
  // Text the markdown escapes (a * in the text) is found in the raw text.
  const star = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "2*3 = 6" }] }] };
  assert.equal(patchDoc(star, "2*3", "2×3").doc.content![0].content![0].text, "2×3 = 6");
  // Removing everything leaves an empty line, never a page with no blocks.
  assert.equal(patchDoc({ type: "doc", content: markdownToDoc("only").content }, "only", "").doc.content!.length, 1);
});

test("notes-edit: the CLI finds, reads, appends and patches by path", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "etude-notes-edit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "c.db");
  const cli = (...a: string[]) => execFileSync(process.execPath, [CLI, "--db", db, ...a], { encoding: "utf8" });
  cli("note", "new", "Main", "--folder");
  const made = JSON.parse(cli("note", "new", "Day 8/11", "--parent", "Main", "--md=# Todo\n\n- [ ] Lab 2\n\n# Notes\n\nsee [[Main]]"));
  assert.equal(made.doc.content[2].type, "heading");
  assert.match(cli("note", "tree"), /^Main\/  [0-9a-f]{8}\n  Day 8\/11  /);
  assert.deepEqual(JSON.parse(cli("note", "tree", "--paths")).map((x: any) => x.path), ["Main", "Main/Day 8/11"]);
  assert.match(cli("note", "read", "Main/Day 8/11"), /^<!-- Main\/Day 8\/11 · page · .* -->\n# Day 8\/11\n\n# Todo\n\n- \[ \] Lab 2/);
  const add = JSON.parse(cli("note", "append", "Main/Day 8/11", "--under", "Todo", "--md=- [ ] Lab 3"));
  assert.equal(add.at, 2);
  const p = JSON.parse(cli("note", "patch", made.id.slice(0, 8), "--old=- [ ] Lab 2", "--new=- [x] Lab 2"));
  assert.equal(p.markdown, "- [x] Lab 2");
  assert.match(cli("note", "read", "Day 8/11", "--blocks"), /\[0\] # Todo\n\[1\] - \[x\] Lab 2\n\[2\] - \[ \] Lab 3/);
  const dry = JSON.parse(cli("note", "patch", "Day 8/11", "--old=Lab 3", "--new=Lab 4", "--dry-run"));
  assert.equal(dry.dryRun, true);
  assert.match(cli("note", "export", "Day 8/11"), /Lab 3/);
});

test("notes-edit: etude mcp answers over stdio and edits notes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "etude-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "c.db");
  const child = spawn(process.execPath, [CLI, "--db", db, "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  let buf = "";
  const waiting = new Map<number, (m: any) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  let next = 1;
  const rpc = (method: string, params?: unknown) =>
    new Promise<any>((done) => {
      const id = next++;
      waiting.set(id, done);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const tool = async (name: string, args: unknown) => (await rpc("tools/call", { name, arguments: args })).result;

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.serverInfo.name, "etude");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const names = (await rpc("tools/list")).result.tools.map((x: any) => x.name);
  assert.deepEqual(names, ["notes_tree", "notes_search", "notes_read", "notes_create", "notes_append", "notes_patch", "notes_block", "notes_canvas", "notes_kanban", "notes_edit", "notes_organize", "notes_view", "etude_help", "etude_run"]);

  assert.equal((await tool("notes_create", { title: "Main", kind: "folder" })).isError, false);
  const made = await tool("notes_create", { title: "Lab 2", parent: "Main", markdown: "- [ ] traces\n- [ ] Q1–Q9" });
  assert.equal(made.isError, false, made.content[0].text);
  assert.equal((await tool("notes_patch", { note: "Main/Lab 2", old: "- [ ] traces", new: "- [x] traces" })).isError, false);
  assert.equal((await tool("notes_append", { note: "Main/Lab 2", markdown: "- next: write-up" })).isError, false);
  const read = await tool("notes_read", { note: "Main/Lab 2" });
  assert.match(read.content[0].text, /- \[x\] traces\n- \[ \] Q1–Q9\n\n- next: write-up/);
  assert.match((await tool("notes_tree", {})).content[0].text, /Main\/.*\n  Lab 2/);
  assert.match((await tool("notes_search", { query: "write-up" })).content[0].text, /Lab 2/);
  assert.match((await tool("etude_help", { query: "kanban" })).content[0].text, /note kanban add/);
  // Blocks, files, canvases and moving notes around.
  assert.match((await tool("notes_block", { note: "Main/Lab 2", n: 0 })).content[0].text, /"taskList"/);
  assert.equal((await tool("notes_block", { note: "Main/Lab 2", n: 1, action: "move", to: 0 })).isError, false);
  assert.match((await tool("notes_read", { note: "Main/Lab 2" })).content[0].text, /- next: write-up\n\n- \[x\] traces/);
  assert.equal((await tool("notes_create", { title: "lab.py", kind: "file", parent: "Main", content: "x = 1\n" })).isError, false);
  assert.equal((await tool("notes_patch", { note: "Main/lab.py", old: "x = 1", new: "x = 2" })).isError, false);
  assert.equal((await tool("notes_create", { title: "Board", kind: "canvas", parent: "Main" })).isError, false);
  const box = JSON.parse((await tool("notes_canvas", { canvas: "Main/Board", action: "add", type: "rectangle", text: "Encode", background: "blue" })).content[0].text);
  const end = JSON.parse((await tool("notes_canvas", { canvas: "Main/Board", action: "add", type: "ellipse", x: 400, text: "Retrieve" })).content[0].text);
  assert.equal((await tool("notes_canvas", { canvas: "Main/Board", action: "add", type: "arrow", from: box.id, to: end.id })).isError, false);
  assert.equal((await tool("notes_canvas", { canvas: "Main/Board", action: "edit", element: end.id, dy: 100 })).isError, false);
  const els = JSON.parse((await tool("notes_canvas", { canvas: "Main/Board" })).content[0].text);
  assert.deepEqual(els.map((e: any) => [e.type, e.text ?? null]), [["rectangle", "Encode"], ["ellipse", "Retrieve"], ["arrow", null]]);
  // A kanban board, worked like in the app.
  assert.equal((await tool("notes_create", { title: "Semana", kind: "kanban", parent: "Main" })).isError, false);
  const added = await tool("notes_kanban", { board: "Main/Semana", action: "add", card: "Lab 2", due: "2026-11-08", labels: ["CMPT 371:blue"], markdown: "- [ ] traces\n- [ ] Q1" });
  assert.equal(added.isError, false, added.content[0].text);
  assert.equal((await tool("notes_kanban", { board: "Main/Semana", action: "edit", card: "Lab 2", old: "- [ ] traces", new: "- [x] traces" })).isError, false);
  assert.equal((await tool("notes_kanban", { board: "Main/Semana", action: "edit", card: "Lab 2", append: "- [ ] write-up" })).isError, false);
  assert.equal((await tool("notes_kanban", { board: "Main/Semana", action: "move", card: "Lab 2", column: "Doing" })).isError, false);
  assert.equal((await tool("notes_kanban", { board: "Main/Semana", action: "column", column: "Review", color: "teal" })).isError, false);
  const card = JSON.parse((await tool("notes_kanban", { board: "Main/Semana", action: "card", card: "Lab 2" })).content[0].text);
  assert.deepEqual([card.column, card.due, card.labels, card.markdown], ["Doing", "2026-11-08", ["CMPT 371"], "- [x] traces\n- [ ] Q1\n\n- [ ] write-up"]);
  const board = JSON.parse((await tool("notes_kanban", { board: "Main/Semana" })).content[0].text);
  assert.deepEqual(board.columns.map((c: any) => [c.name, c.cards.map((k: any) => k.todos ?? k.title)]), [["To do", []], ["Doing", ["1/3"]], ["Done", []], ["Review", []]]);
  assert.equal((await tool("notes_kanban", { board: "Main/Semana", action: "archive", card: "Lab 2" })).isError, false);
  assert.equal((await tool("notes_organize", { note: "Main/lab.py", action: "move", top: true })).isError, false);
  assert.match((await tool("notes_tree", {})).content[0].text, /^lab\.py \(file\)/m);
  assert.equal((await tool("notes_organize", { note: "lab.py", action: "delete" })).isError, true, "delete asks for confirm");
  assert.equal((await tool("notes_organize", { note: "lab.py", action: "delete", confirm: true })).isError, false);
  assert.equal((await tool("etude_run", { argv: ["deck", "list"] })).isError, false);
  // Missing text, denied commands and --db come back as tool errors, not crashes.
  assert.match((await tool("notes_patch", { note: "Main/Lab 2", old: "zzz", new: "y" })).content[0].text, /isn't on the page/);
  assert.equal((await tool("etude_run", { argv: ["serve"] })).isError, true);
  assert.equal((await tool("etude_run", { argv: ["deck", "list", "--db", "/tmp/x.db"] })).isError, true);
  child.stdin.end();
});

test("notes-edit: files take find-and-replace and inserts by line", () => {
  assert.deepEqual(patchText("a = 1\nb = a\n", "a", "z", { all: true }), { content: "z = 1\nb = z\n", replaced: 2, lines: [1, 2] });
  assert.throws(() => patchText("a a", "a", "b"), /appears 2 times/);
  assert.equal(insertText("one\ntwo\n", "three").content, "one\ntwo\nthree\n");
  assert.equal(insertText("one\ntwo", "zero", { top: true }).content, "zero\none\ntwo");
  assert.equal(insertText("one\ntwo", "mid", { at: 2 }).content, "one\nmid\ntwo");
  assert.equal(insertText("", "first\n").content, "first\n");
});

test("notes-edit: blocks move as the page is now", () => {
  const doc = markdownToDoc("a\n\nb\n\nc\n\nd");
  const order = (d: any) => d.content.map((b: any) => b.content[0].text).join("");
  assert.equal(order(moveBlocks(doc, 3, 0)), "dabc");
  assert.equal(order(moveBlocks(doc, 0, 4)), "bcda");
  assert.equal(order(moveBlocks(doc, 0, 3, 2)), "cabd");
  assert.equal(order(moveBlocks(doc, 1, 2)), "abcd", "before itself or right after: no change");
});

test("canvas-edit: shapes with labels, arrows that follow, order and removal", () => {
  let s = emptyScene();
  let r = addElement(s, "rectangle", { x: 0, y: 0, width: 200, height: 100, text: "Encode", background: "blue" });
  s = r.scene;
  const a = r.id;
  r = addElement(s, "diamond", { x: 400, y: 0, text: "Retrieve" });
  s = r.scene;
  const b = r.id;
  r = addElement(s, "arrow", { from: a, to: b, text: "practice" });
  s = r.scene;
  const arrow = s.elements.find((e) => e.id === r.id)!;
  // Starts just right of the box and ends just left of the diamond, tied to both.
  assert.ok((arrow.x as number) > 200 && (arrow.x as number) < 220);
  assert.equal((arrow as any).startBinding.elementId, a);
  assert.ok((s.elements.find((e) => e.id === a)!.boundElements as any[]).some((x) => x.id === arrow.id));
  // Every element is complete enough for Excalidraw and passes Etude's own check.
  for (const e of s.elements) for (const k of ["id", "type", "x", "y", "width", "height", "seed", "version", "versionNonce", "index", "strokeColor", "backgroundColor"]) assert.ok(k in e, `${e.type} has ${k}`);
  assert.equal(new Set(s.elements.map((e) => e.index)).size, s.elements.length, "indices are unique");
  checkScene(s);
  // Moving the diamond moves its label and re-routes the arrow.
  const labelBefore = s.elements.find((e) => e.containerId === b)!.y as number;
  s = editElement(s, b, { dy: 200 }).scene;
  assert.equal(s.elements.find((e) => e.containerId === b)!.y, labelBefore + 200);
  assert.ok(((s.elements.find((e) => e.id === arrow.id) as any).points[1][1] as number) > 100);
  // Words change in place; the list shows labels on their shapes.
  s = editElement(s, a.slice(0, 6), { text: "Encode it" }).scene;
  assert.deepEqual(listElements(s).map((e) => e.text ?? null), ["Encode it", "Retrieve", "practice"]);
  // Front and back.
  s = editElement(s, a, { order: "front" }).scene;
  assert.equal(listElements(s).at(-1)!.id, a);
  const idx = s.elements.map((e) => e.index as string);
  assert.deepEqual([...idx].sort(), idx, "array order matches the indices");
  // Deleting the diamond takes its label and lets go of the arrow.
  s = deleteElements(s, [b]).scene;
  assert.equal(s.elements.some((e) => e.containerId === b), false);
  assert.equal((s.elements.find((e) => e.id === arrow.id) as any).endBinding, null);
  assert.throws(() => addElement(s, "star", {}), /isn't something a canvas draws/);
  assert.throws(() => addElement(s, "rectangle", { color: "chartreuse-ish" }), /isn't a colour/);
});

test("canvas-edit: picture sizes from their first bytes", () => {
  const png = Buffer.alloc(32);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(imageSize(png), { width: 640, height: 480 });
  assert.equal(imageSize(Buffer.from("not a picture")), null);
});

test("fractional-index: the same keys as the fractional-indexing package Excalidraw uses", async () => {
  const { keyBetween } = await import("../src/core/fractional-index.ts");
  const { generateKeyBetween } = await import("fractional-indexing");
  let keys: string[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 400; i++) {
    const at = Math.floor(rnd() * (keys.length + 1));
    const a = keys[at - 1] ?? null, b = keys[at] ?? null;
    const k = keyBetween(a, b);
    assert.equal(k, generateKeyBetween(a, b), `between ${a} and ${b}`);
    keys.splice(at, 0, k);
  }
  assert.deepEqual([...keys].sort(), keys);
});

test("notes-md: a list mixing plain items and to-dos keeps each as it was", () => {
  const d = markdownToDoc("- TODO:\n  - [x] a\n- [ ] b\n- c");
  assert.deepEqual(d.content!.map((b) => b.type), ["bulletList", "taskList", "bulletList"]);
  const o = markdownToDoc("1. one\n2. two\n3. [ ] three\n4. four");
  assert.deepEqual(o.content!.map((b) => [b.type, b.attrs?.start ?? null]), [["orderedList", 1], ["taskList", null], ["orderedList", 4]]);
  // A list out of a patch that lost its indent says so instead of quietly turning into to-dos.
  const r = patchDoc(markdownToDoc("- TODO:\n  - [ ] b"), "  - [ ] b", "  - [ ] b\n- [ ] c");
  assert.match(r.notice!, /bulletList\) became bulletList, taskList/);
});

test("notes: the tree stamp changes when the tree does, not when a page's text does", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const a = e.notes.create({ title: "A" });
  const s0 = e.notes.treeStamp();
  e.notes.update(a.id, { doc: markdownToDoc("typing away") });
  assert.equal(e.notes.treeStamp(), s0, "body edits leave it alone");
  e.notes.update(a.id, { title: "A2" });
  const s1 = e.notes.treeStamp();
  assert.notEqual(s1, s0);
  const b = e.notes.create({ title: "B" });
  const s2 = e.notes.treeStamp();
  assert.notEqual(s2, s1);
  e.notes.delete(b.id);
  assert.equal(e.notes.treeStamp(), s1);
});
