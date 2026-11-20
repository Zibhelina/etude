import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { fsId } from "../src/core/folders.ts";
import { diskName, takeIntoFolder } from "../src/core/folder-take.ts";
import { run } from "../src/cli/run.ts";

type T = { after(fn: () => void): void };
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (t: string) => ({ type: "text", text: t });
const docOf = (...blocks: unknown[]) => ({ type: "doc", content: blocks });
const tree = (dir: string, prefix = ""): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? [`${prefix}${d.name}/`, ...tree(join(dir, d.name), `${prefix}${d.name}/`)] : [`${prefix}${d.name}`])).sort();

/** A collection with a Notebook like a real one: folders, pages under pages, a file, a PDF, and kinds that can't be files. */
async function setup(t: T) {
  // By its real path: on a Mac the temp folder is behind a link, and an open folder is kept by where it really is.
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-take-")));
  const e = await Etude.open(join(root, "etude.db"), { home: join(root, "home") });
  t.after(() => {
    e.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const vault = join(root, "Vault");
  mkdirSync(vault);
  const f = e.folders.open(vault, { name: "Vault" });
  const pdfBytes = Buffer.from("%PDF-1.4\n% a small test file\n");
  const sha = createHash("sha256").update(pdfBytes).digest("hex");
  mkdirSync(join(e.mediaDir, "files"), { recursive: true });
  writeFileSync(join(e.mediaDir, "files", `${sha}.pdf`), pdfBytes);
  const N = e.notes;
  const main = N.create({ title: "Home", kind: "folder" });
  const ideas = N.create({ title: "Reading list", parentId: main.id, doc: docOf(para(text("An idea."))), icon: "emoji:💡" });
  N.pin(ideas.id);
  const journal = N.create({ title: "Diary 3/4", parentId: main.id, doc: docOf(para(text("See "), { type: "noteLink", attrs: { id: ideas.id, title: "Reading list", label: null } }, text(" for more."))) });
  const course = N.create({ title: "Course: botany", parentId: main.id, doc: docOf(para(text("The course page."))) });
  const week = N.create({ title: "Week 1", parentId: course.id, doc: docOf(para(text("Ferns have fronds."))) });
  const slides = N.create({ title: "Slides", parentId: course.id, kind: "pdf", file: `files/${sha}.pdf` });
  const drawing = N.create({ title: "Course · canvas", parentId: course.id, kind: "canvas", scene: { type: "excalidraw", version: 2, elements: [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 5, height: 5 }], appState: {}, files: {} } });
  N.update(course.id, { doc: docOf(para(text("The course page.")), { type: "canvasEmbed", attrs: { id: drawing.id, title: "Course · canvas" } }) });
  const board = N.create({ title: "Tasks", parentId: main.id, kind: "kanban" });
  const code = N.create({ title: "main.py", parentId: main.id, kind: "file", content: "print('hi')\n" });
  const web = N.create({ title: "Demo", parentId: main.id, kind: "web", content: "<h1>Demo</h1>" });
  const empty = N.create({ title: "Empty", parentId: main.id, kind: "folder" });
  const twinA = N.create({ title: "Same", parentId: empty.id, doc: docOf(para(text("first"))) });
  const twinB = N.create({ title: "Same", parentId: empty.id, doc: docOf(para(text("second"))) });
  // One that was archived long ago, under a note that will move: it isn't counted as moved or archived again.
  N.setArchived(N.create({ title: "Old draft", parentId: ideas.id, doc: docOf(para(text("old"))) }).id, true);
  const other = N.create({ title: "Not taken", doc: docOf(para(text("stays, and points at "), { type: "noteLink", attrs: { id: week.id, title: "Week 1", label: null } })) });
  return { e, f, vault, main, ideas, journal, course, week, slides, drawing, board, code, web, empty, twinA, twinB, other, pdfBytes };
}

test("folder take: a title becomes a name every disk takes", () => {
  assert.equal(diskName("Diary 3/4"), "Diary 3-4");
  assert.equal(diskName("Unit 2: limits"), "Unit 2 - limits");
  assert.equal(diskName("a:b*c?"), "a-b-c-");
  assert.equal(diskName("  .hidden  "), "_hidden");
  assert.equal(diskName("ends with dots..."), "ends with dots");
  assert.equal(diskName(""), "Untitled");
  assert.equal(diskName("line\nbreak\ttab"), "line break tab");
});

test("folder take: a note and what's under it become files, in the tree they were in", async (t) => {
  const s = await setup(t);
  const { e, f, vault } = s;

  // Looking first: the plan, with nothing written and nothing changed.
  const plan = await takeIntoFolder(e, "Home", "Vault/Notes", { dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.moved.map((m) => m.path), [
    "Home",
    "Home/Reading list.etude",
    "Home/Diary 3-4.etude",
    "Home/Course - botany/Course - botany.etude",
    "Home/Course - botany/Week 1.etude",
    "Home/Course - botany/Slides.pdf",
    "Home/Course - botany/Course · canvas.etude",
    "Home/Tasks.etude",
    "Home/main.py",
    "Home/Demo.html",
    "Home/Empty",
    "Home/Empty/Same.etude",
    "Home/Empty/Same 2.etude",
  ]);
  assert.deepEqual(tree(vault), []);
  assert.equal(e.notes.list().length, 14);

  const done = await takeIntoFolder(e, "Home", "Vault/Notes");
  assert.deepEqual(tree(vault), [
    "Notes/",
    "Notes/Home/",
    "Notes/Home/Course - botany/",
    "Notes/Home/Course - botany/Course - botany.etude",
    "Notes/Home/Course - botany/Course · canvas.etude",
    "Notes/Home/Course - botany/Slides.pdf",
    "Notes/Home/Course - botany/Week 1.etude",
    "Notes/Home/Demo.html",
    "Notes/Home/Diary 3-4.etude",
    "Notes/Home/Empty/",
    "Notes/Home/Empty/Same 2.etude",
    "Notes/Home/Empty/Same.etude",
    "Notes/Home/Reading list.etude",
    "Notes/Home/Tasks.etude",
    "Notes/Home/main.py",
  ]);
  // Each file is what its note was.
  const at = (rel: string) => fsId(f.id, `Notes/Home/${rel}`);
  const ideas = e.folders.get(at("Reading list.etude"));
  assert.deepEqual([ideas.kind, ideas.title, ideas.icon, ideas.doc], ["page", "Reading list", "emoji:💡", s.ideas.doc]);
  assert.equal(e.folders.get(at("Course - botany/Week 1.etude")).text.includes("Ferns have fronds"), true);
  // A page keeps its title as its own, even where the disk needed another name for it.
  assert.equal(ideas.local.pageTitle, "Reading list");
  assert.equal(e.folders.get(at("Diary 3-4.etude")).local.pageTitle, "Diary 3/4");
  assert.deepEqual(readFileSync(join(vault, "Notes/Home/Course - botany/Slides.pdf")), s.pdfBytes);
  assert.equal(readFileSync(join(vault, "Notes/Home/main.py"), "utf8"), "print('hi')\n");
  assert.deepEqual([e.folders.get(at("Empty/Same.etude")).text.trim(), e.folders.get(at("Empty/Same 2.etude")).text.trim()], ["first", "second"]);
  // A canvas, a board and a web file are files of their own kinds.
  const canvas = e.folders.get(at("Course - botany/Course · canvas.etude"));
  assert.deepEqual([canvas.kind, canvas.title, (canvas.scene!.elements[0] as any).id], ["canvas", "Course · canvas", "r1"]);
  const tasks = e.folders.get(at("Tasks.etude"));
  assert.deepEqual([tasks.kind, tasks.board!.columns.length > 0], ["kanban", true]);
  assert.equal(tasks.local.pageTitle, "Tasks");
  assert.equal(canvas.local.pageTitle, undefined);
  const web = e.folders.get(at("Demo.html"));
  assert.deepEqual([web.kind, web.content], ["web", "<h1>Demo</h1>"]);
  // A link between two notes that moved points at the file now, and so does the drawing a page shows.
  const link = (e.folders.get(at("Diary 3-4.etude")).doc.content![0] as any).content[1];
  assert.deepEqual([link.type, link.attrs.id], ["noteLink", at("Reading list.etude")]);
  const embed = e.folders.get(at("Course - botany/Course - botany.etude")).doc.content![1] as any;
  assert.deepEqual([embed.type, embed.attrs.id], ["canvasEmbed", at("Course - botany/Course · canvas.etude")]);
  assert.equal(done.links, 2);
  // A note that stayed and linked to one that moved follows it.
  assert.deepEqual(done.relinked, { files: 0, notes: 1 });
  assert.equal((e.notes.get(s.other.id).doc.content![0] as any).content[1].attrs.id, at("Course - botany/Week 1.etude"));
  // The tree lists them in the order the Notebook had, not by name: the page first in its own directory.
  const listed = (rel: string) => e.folders.children(fsId(f.id, rel)).map((r) => r.local.name);
  assert.deepEqual(listed("Notes"), ["Home"]);
  assert.deepEqual(listed("Notes/Home"), ["Reading list.etude", "Diary 3-4.etude", "Course - botany", "Tasks.etude", "main.py", "Demo.html", "Empty"]);
  assert.deepEqual(listed("Notes/Home/Course - botany"), ["Course - botany.etude", "Week 1.etude", "Slides.pdf", "Course · canvas.etude"]);
  // A file is as old as its note's last change.
  assert.equal(Math.abs(statSync(join(vault, "Notes/Home/Reading list.etude")).mtimeMs - new Date(s.ideas.updated).getTime()) < 1000, true);
  // The pin follows the file.
  assert.deepEqual(e.folders.marked("pinned").map((r) => r.id), [at("Reading list.etude")]);
  assert.equal(e.notes.pinnedList().length, 0);

  // In the collection everything that moved is in the Archive, as it was.
  assert.equal(done.archived, 13);
  assert.deepEqual(e.notes.list().map((n) => n.title), ["Not taken"]);
  assert.equal(e.notes.get(s.ideas.id).archived, true);
  assert.deepEqual(e.notes.get(s.ideas.id).doc, s.ideas.doc, "the archived note is as it was");
  // Nothing was deleted: bringing one back works.
  e.notes.setArchived(s.week.id, false);
  assert.equal(e.notes.get(s.week.id).archived, false);
});

test("folder take: --keep copies, a folder goes into its directory when it's already there, and pages kept as files follow a note that moves later", async (t) => {
  const s = await setup(t);
  const { e, f, vault } = s;
  const kept = await takeIntoFolder(e, s.course.id, "Vault", { keep: true });
  assert.deepEqual([kept.archived, kept.relinked], [0, { files: 0, notes: 0 }]);
  assert.deepEqual(tree(vault), ["Course - botany/", "Course - botany/Course - botany.etude", "Course - botany/Course · canvas.etude", "Course - botany/Slides.pdf", "Course - botany/Week 1.etude"]);
  assert.equal(e.notes.list().length, 14, "the notes are all still there");
  assert.equal((e.notes.get(s.other.id).doc.content![0] as any).content[1].attrs.id, s.week.id, "a copy changes no link");
  // The same again lands beside it, never on top.
  await takeIntoFolder(e, s.course.id, "Vault", { keep: true });
  assert.equal(tree(vault).includes("Course - botany 2/Course - botany.etude"), true);

  // A page moves first; the page it links to moves later, somewhere else: the file that links to it follows.
  await takeIntoFolder(e, s.journal.id, "Vault/First");
  const journal = fsId(f.id, "First/Diary 3-4.etude");
  assert.equal((e.folders.get(journal).doc.content![0] as any).content[1].attrs.id, s.ideas.id, "still the note's id: it hasn't moved");
  const before = statSync(join(vault, "First/Diary 3-4.etude")).mtimeMs;
  const later = await takeIntoFolder(e, s.ideas.id, "Vault/Second");
  assert.deepEqual(later.relinked, { files: 1, notes: 0 });
  assert.equal((e.folders.get(journal).doc.content![0] as any).content[1].attrs.id, fsId(f.id, "Second/Reading list.etude"));
  assert.equal(statSync(join(vault, "First/Diary 3-4.etude")).mtimeMs, before, "following a link isn't an edit");

  // A folder taken where a directory of its name already is goes into it; files never land on top of one another.
  mkdirSync(join(vault, "Third", "Empty"), { recursive: true });
  writeFileSync(join(vault, "Third", "Empty", "Same.etude"), "{}");
  const merged = await takeIntoFolder(e, s.empty.id, "Vault/Third");
  assert.deepEqual(merged.moved.map((m) => m.path), ["Empty", "Empty/Same 2.etude", "Empty/Same 3.etude"]);
  // A directory that was there and lists by name keeps doing so; one made by a take is in the Notebook's order.
  assert.deepEqual(e.folders.children(fsId(f.id, "Third/Empty")).map((r) => r.local.name), ["Same 2.etude", "Same 3.etude", "Same.etude"]);
  assert.equal(e.folders.isArranged(fsId(f.id, "Third/Empty")), false);
  assert.equal(e.folders.isArranged(fsId(f.id, "Course - botany")), true);
  assert.equal(readFileSync(join(vault, "Third", "Empty", "Same.etude"), "utf8"), "{}");

  await assert.rejects(() => takeIntoFolder(e, s.code.id, "Nope/x"), /no folder "Nope"/);
  await assert.rejects(() => takeIntoFolder(e, s.code.id, "/somewhere/else"), /no folder|isn't a file in a folder/);
  writeFileSync(join(vault, "a file"), "x");
  await assert.rejects(() => takeIntoFolder(e, s.code.id, "Vault/a file"), /is a file/);
  // A note in a shared space belongs to everyone in it.
  e.notes.shareOf = () => new Map([[s.code.id, { space: "space-1", role: "owner", root: true } as never]]);
  await assert.rejects(() => takeIntoFolder(e, s.code.id, "Vault"), /is in a shared space/);
  e.notes.shareOf = null;
  assert.equal(e.notes.get(s.code.id).archived, false);
});

test("folder take: the CLI asks before it moves anything", async (t) => {
  const s = await setup(t);
  const { e, vault } = s;
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const code = await run(argv, { stdout: (x) => out.push(x), stderr: (x) => out.push(x), stdin: () => "", isTTY: false, env: process.env }, { etude: e });
    return { code, text: out.join("") };
  };
  const dry = JSON.parse((await cli("folder", "take", "Home/Empty", "Vault/Notes", "--dry-run")).text);
  assert.deepEqual([dry.dryRun, dry.moved.length, dry.archived], [true, 3, 0]);
  assert.notEqual((await cli("folder", "take", "Home/Empty", "Vault/Notes")).code, 0, "without --yes it doesn't run");
  assert.deepEqual(tree(vault), []);
  const done = JSON.parse((await cli("folder", "take", "Home/Empty", "Vault/Notes", "--yes")).text);
  assert.deepEqual([done.moved.map((m: any) => m.path), done.archived], [["Empty", "Empty/Same.etude", "Empty/Same 2.etude"], 3]);
  assert.deepEqual(tree(vault), ["Notes/", "Notes/Empty/", "Notes/Empty/Same 2.etude", "Notes/Empty/Same.etude"]);
});
