import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { addCard, archiveCard, boardToMarkdown, editColumn, moveCard } from "../src/core/kanban.ts";
import { docFromText } from "../src/core/notes.ts";
import { docToMarkdown } from "../src/core/notes-md.ts";

test("kanban: a board is a note of its own, its cards are pages, and pages show it through a portal", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());

  const folder = e.notes.create({ title: "Projetos", kind: "folder" });
  const b = e.notes.create({ title: "Semana", kind: "kanban", parentId: folder.id });
  assert.equal(b.kind, "kanban");
  assert.deepEqual(b.board!.columns.map((c) => [c.name, c.done]), [["To do", false], ["Doing", false], ["Done", true]]);
  assert.equal(e.notes.create({ title: "W", kind: "kanban", template: "week" }).board!.columns.length, 6);
  assert.equal(e.notes.create({ title: "E", kind: "kanban", template: "empty" }).board!.columns.length, 0);
  // A board has a board, never a doc; it stays a board.
  assert.throws(() => e.notes.create({ title: "x", kind: "kanban", doc: { type: "doc", content: [] } }), /not a doc/);
  assert.throws(() => e.notes.update(b.id, { doc: { type: "doc", content: [] } }), /not a doc/);
  assert.throws(() => e.notes.update(b.id, { kind: "page" }), /stays a kanban board/);
  assert.throws(() => e.notes.update(folder.id, { board: b.board }), /only a kanban board/);

  // Cards: a page each, with labels, due days and to-dos.
  let board = b.board!;
  ({ board } = addCard(board, "To do", { title: "Lab 2 · DNS", due: "2026-11-08", labels: ["CMPT 371:blue"], doc: { type: "doc", content: [...docFromText("- [x] traces\n- [ ] Q1–Q9").content!, { type: "paragraph", content: [{ type: "text", text: "See " }, { type: "noteLink", attrs: { id: null, title: "Lab notes" } }] }] } }));
  ({ board } = addCard(board, undefined, { title: "Read Russell" }));
  const saved = e.notes.update(b.id, { board });
  const lab = Object.values(saved.board!.cards).find((c) => c.title === "Lab 2 · DNS")!;
  assert.equal(saved.board!.labels[0].name, "CMPT 371");
  assert.equal(saved.board!.labels[0].color, "blue");
  assert.deepEqual(lab.labels, [saved.board!.labels[0].id]);
  // Search finds what's on the cards.
  assert.ok(e.notes.search("Q1–Q9").some((h) => h.id === b.id));
  assert.ok(e.notes.search("russell").some((h) => h.id === b.id));

  // Moving, archiving, columns.
  board = moveCard(saved.board!, lab.id, "Done", 0);
  assert.equal(board.columns[2].cards[0], lab.id);
  board = archiveCard(board, "Read Russell");
  assert.equal(board.columns[0].cards.length, 0);
  assert.equal(board.archived.length, 1);
  board = archiveCard(board, "Read Russell", false);
  assert.equal(board.columns[0].cards.length, 1);
  board = editColumn(board, "Review", { at: 2, color: "purple", limit: 3 });
  assert.deepEqual(board.columns.map((c) => c.name), ["To do", "Doing", "Review", "Done"]);
  assert.equal(board.columns[2].limit, 3);
  board = editColumn(board, "To do", { remove: true });
  assert.equal(board.archived.length, 1);
  assert.throws(() => moveCard(board, lab.id, "Nope"), /no column "Nope"/);
  const after = e.notes.update(b.id, { board });
  assert.deepEqual(after.board!.columns.map((c) => c.name), ["Doing", "Review", "Done"]);

  // A board in order: a card is in one place only, unknown labels and dangling ids are dropped, dates are days.
  const messy = { columns: [{ id: "a", name: "A", cards: ["k1", "k1", "ghost"] }, { id: "a", name: "B", cards: ["k1", "k2"] }], cards: { k1: { title: "one", labels: ["nope"] }, k2: { title: "two" }, k3: { title: "lost" } } };
  const clean = e.notes.update(b.id, { board: messy }).board!;
  assert.deepEqual(clean.columns.map((c) => c.cards), [["k1"], ["k2"]]);
  assert.notEqual(clean.columns[0].id, clean.columns[1].id);
  assert.deepEqual(clean.cards.k1.labels, []);
  assert.deepEqual(clean.archived, ["k3"]);
  assert.throws(() => e.notes.update(b.id, { board: { columns: [], cards: { k: { title: "x", due: "next week" } }, archived: ["k"] } }), /YYYY-MM-DD/);
  assert.throws(() => e.notes.update(b.id, { board: { columns: [{ name: "A", limit: 5000, cards: [] }], cards: {} } }), /limit/);
  e.notes.update(b.id, { board: after.board });

  // A portal shows it in a page, and counts as a link.
  const page = e.notes.create({ title: "Journal" });
  const withPortal = e.notes.portal(page.id, b.id);
  assert.equal(withPortal.doc.content?.at(-1)?.type, "kanbanEmbed");
  assert.equal(withPortal.doc.content?.at(-1)?.attrs?.id, b.id);
  assert.ok(e.notes.backlinks(b.id).some((x: any) => x.id === page.id));
  // A [[link]] on a card counts as the board's link.
  const notes = e.notes.create({ title: "Lab notes" });
  assert.ok(e.notes.backlinks(notes.id).some((x: any) => x.id === b.id));
  const claimed = Object.values(e.notes.get(b.id).board!.cards).find((c) => c.title === "Lab 2 · DNS")!;
  assert.equal(JSON.stringify(claimed.doc).includes(notes.id), true);

  // Markdown the Obsidian Kanban plugin opens.
  const md = boardToMarkdown(e.notes.get(b.id).board!, (d) => docToMarkdown(d));
  assert.match(md, /^---\n\nkanban-plugin: board/);
  assert.match(md, /## Done\n\n\*\*Complete\*\*\n- \[x\] Lab 2 · DNS #CMPT-371 @\{2026-11-08\}/);
  assert.match(md, /\t- \[x\] traces/);

  // Over HTTP: create, read, write with base, export.
  const app = createApp(e);
  const made = await (await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "HTTP board", kind: "kanban", template: "week" }) })).json();
  assert.equal(made.board.columns[0].name, "Mon");
  const r = await app.request(`/api/notes/${made.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: { ...made.board, columns: made.board.columns.slice(0, 2) }, base: made.updated }) });
  assert.equal(r.status, 200);
  const stale = await app.request(`/api/notes/${made.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: made.board, base: "2000-01-01T00:00:00.000Z" }) });
  assert.equal(stale.status, 409);
  const ex = await app.request(`/api/notes/${b.id}/export`);
  assert.equal(ex.status, 200);
  assert.match(await ex.text(), /kanban-plugin: board/);
});

test("kanban: the CLI makes boards and moves cards like the app does", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "etude-kanban-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "c.db");
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli", "main.ts"), "--db", db, "--json", ...args], { env: { ...process.env, ETUDE_HOME: dir }, encoding: "utf8" }));
  const made = cli("note", "new", "Semana", "--kanban", "--columns", "Backlog,Doing,Done");
  assert.equal(made.kind, "kanban");
  cli("note", "kanban", "column", "Semana", "Done", "--done");
  const a = cli("note", "kanban", "add", "Semana", "Lab 2", "--column", "Doing", "--due", "2026-11-08", "--label", "CMPT 371:blue", "--text", "- [x] traces\n- [ ] Q1");
  assert.equal(a.column, "Doing");
  assert.equal(a.card.due, "2026-11-08");
  let brief = cli("note", "kanban", "Semana");
  assert.deepEqual(brief.columns[1].cards[0], { id: a.card.id, title: "Lab 2", due: "2026-11-08", labels: ["CMPT 371"], todos: "1/2" });
  brief = cli("note", "kanban", "move", "Semana", "Lab 2", "Done");
  assert.equal(brief.columns[2].cards[0].title, "Lab 2");
  assert.equal(brief.columns[2].done, true);
  const ed = cli("note", "kanban", "edit", "Semana", a.card.id, "--title", "Lab 2 · DNS", "--due", "none", "--no-labels");
  assert.equal(ed.card.title, "Lab 2 · DNS");
  assert.equal(ed.card.due, null);
  assert.deepEqual(ed.card.labels, []);
  brief = cli("note", "kanban", "archive", "Semana", "Lab 2 · DNS");
  assert.equal(brief.archived, 1);
  brief = cli("note", "kanban", "column", "Semana", "Review", "--at", "1", "--limit", "3");
  assert.deepEqual(brief.columns.map((c: any) => c.name), ["Backlog", "Review", "Doing", "Done"]);
  const page = cli("note", "new", "Journal");
  const withPortal = cli("note", "portal", "Semana", page.id);
  assert.equal(withPortal.doc.content.at(-1).type, "kanbanEmbed");
});
