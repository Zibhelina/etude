import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { fsId } from "../src/core/folders.ts";
import { takeIntoFolder } from "../src/core/folder-take.ts";
import { bringIntoNotebook } from "../src/core/folder-bring.ts";

type T = { after(fn: () => void): void };
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (t: string) => ({ type: "text", text: t });
const docOf = (...blocks: unknown[]) => ({ type: "doc", content: blocks });

async function setup(t: T) {
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-bring-")));
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
  return { e, f, vault, sha, pdfBytes };
}

test("folder bring: a folder of notes taken out comes back as the same notes, and the files go to the trash", async (t) => {
  const { e, f, vault, sha, pdfBytes } = await setup(t);
  const N = e.notes;
  const home = N.create({ title: "Home", kind: "folder" });
  const idea = N.create({ title: "Idea", parentId: home.id, doc: docOf(para(text("An idea."))), icon: "emoji:💡" });
  const diary = N.create({ title: "Diary", parentId: home.id, doc: docOf(para(text("See "), { type: "noteLink", attrs: { id: idea.id, title: "Idea", label: null } })) });
  N.create({ title: "Slides", parentId: home.id, kind: "pdf", file: `files/${sha}.pdf` });
  N.create({ title: "main.py", parentId: home.id, kind: "file", content: "print('hi')\n" });
  N.create({ title: "Demo", parentId: home.id, kind: "web", content: "<h1>Demo</h1>" });
  N.create({ title: "Board", parentId: home.id, kind: "kanban" });
  N.create({ title: "Drawing", parentId: home.id, kind: "canvas" });
  const textOf = (id: string) => N.get(id).text;
  const ideaText = textOf(idea.id);
  const diaryText = textOf(diary.id);

  await takeIntoFolder(e, home.id, fsId(f.id, "Out"));
  assert.ok(existsSync(join(vault, "Out", "Home", "Idea.etude")));

  const dir = fsId(f.id, "Out/Home");
  const dry = await bringIntoNotebook(e, [dir], null, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.moved.length, 8);
  assert.ok(existsSync(join(vault, "Out", "Home", "Idea.etude")), "a dry run changes nothing");

  const r = await bringIntoNotebook(e, [dir], null);
  const by = (title: string) => r.moved.find((m) => m.title === title)!;
  assert.equal(N.get(by("Home").id).kind, "folder");
  assert.equal(N.get(by("Idea").id).parentId, by("Home").id);
  assert.equal(textOf(by("Idea").id), ideaText);
  assert.equal(N.get(by("Idea").id).icon, "emoji:💡");
  assert.equal(textOf(by("Diary").id), diaryText);
  // The link between two pages that moved points at the new note, not at a file or the archived original.
  assert.equal(JSON.stringify(N.get(by("Diary").id).doc).includes(by("Idea").id), true);
  assert.equal(JSON.stringify(N.get(by("Diary").id).doc).includes("fs:"), false);
  assert.equal(r.links, 1);
  assert.equal(N.get(by("Slides").id).kind, "pdf");
  assert.deepEqual(Buffer.from(e.readMediaFile(N.get(by("Slides").id).file!)!), pdfBytes);
  assert.equal(N.get(by("main.py").id).content, "print('hi')\n");
  assert.equal(N.get(by("Demo.html").id).kind, "web");
  assert.equal(N.get(by("Board").id).kind, "kanban");
  assert.equal(N.get(by("Drawing").id).kind, "canvas");
  // The files left their place for the folder's trash (nothing deleted).
  assert.equal(existsSync(join(vault, "Out", "Home")), false);
  assert.equal(r.trashed.length, 1);
  assert.ok(existsSync(join(vault, ...r.trashed[0].trashed.split("/"), "Idea.etude")));
  assert.ok(readFileSync(join(vault, ...r.trashed[0].trashed.split("/"), "Idea.etude"), "utf8").includes("An idea."));
});

test("folder bring: a note of the collection that linked to the file follows it, and the place and pin are kept", async (t) => {
  const { e, f, vault } = await setup(t);
  const N = e.notes;
  const keep = N.create({ title: "Keep", doc: docOf(para(text("first"))) });
  mkdirSync(join(vault, "Dir"));
  const made = e.folders.create(fsId(f.id, "Dir"), { title: "Plan", kind: "page", doc: docOf(para(text("the plan"))) });
  e.folders.pin(made.id, true);
  const linker = N.create({ title: "Linker", doc: docOf(para(text("see "), { type: "noteLink", attrs: { id: made.id, title: "Plan", label: null } })) });
  const r = await bringIntoNotebook(e, [made.id], null, { index: 0 });
  const plan = r.moved[0];
  assert.equal(N.get(plan.id).title, "Plan");
  assert.equal(N.get(plan.id).pinned !== null, true);
  const top = N.list().filter((n) => !n.parentId && !n.archived).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  assert.equal(top[0].id, plan.id);
  assert.ok(top.some((n) => n.id === keep.id));
  assert.equal(r.relinked.notes, 1);
  assert.ok(JSON.stringify(N.get(linker.id).doc).includes(plan.id));
});

test("folder bring: files with no note kind are refused before anything changes", async (t) => {
  const { e, f, vault } = await setup(t);
  mkdirSync(join(vault, "Mixed"));
  e.folders.create(fsId(f.id, "Mixed"), { title: "Fine", kind: "page", doc: docOf(para(text("ok"))) });
  writeFileSync(join(vault, "Mixed", "photo.png"), Buffer.from([137, 80, 78, 71]));
  const before = e.notes.list().length;
  await assert.rejects(() => bringIntoNotebook(e, [fsId(f.id, "Mixed")], null), /photo\.png \(image\)/);
  assert.equal(e.notes.list().length, before);
  assert.ok(existsSync(join(vault, "Mixed", "photo.png")));
});

test("folder bring: a Markdown file becomes a file note that keeps its name", async (t) => {
  const { e, f, vault } = await setup(t);
  writeFileSync(join(vault, "a.md"), "hello\n");
  const id = fsId(f.id, "a.md");
  const r = await bringIntoNotebook(e, [id], null);
  assert.equal(e.notes.get(r.moved[0].id).content, "hello\n");
  assert.equal(r.moved[0].title, "a.md");
});
