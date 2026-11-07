import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { isTextFile } from "../src/core/notes.ts";
import { execFileSync } from "node:child_process";

const PY = "def f(x):\n\treturn x  # tabs and trailing spaces stay   \n\n\n";
const TEX = "\\documentclass{article}\n\\begin{document}\n$\\int_0^1 x\\,dx$ #notatag\n\\end{document}\n";

test("notes files: code and text kept exactly as written, searchable, never pages", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const f = e.notes.create({ title: "main.py", kind: "file", content: PY });
  assert.equal(f.kind, "file");
  assert.equal(f.content, PY);
  assert.equal(e.notes.get(f.id).content, PY);
  assert.equal(e.notes.search("trailing")[0].id, f.id);
  const tex = e.notes.update(e.notes.create({ title: "report.tex", kind: "file" }).id, { content: TEX });
  assert.equal(tex.content, TEX);
  // A #word inside a file isn't a tag.
  assert.deepEqual(e.notes.graph().nodes.find((n) => n.id === tex.id)?.tags, []);
  // A page has no content, a file has no doc, and neither turns into the other.
  assert.equal(e.notes.create({ title: "p" }).content, null);
  assert.throws(() => e.notes.update(f.id, { doc: { type: "doc", content: [] } }), /not a doc/);
  assert.throws(() => e.notes.create({ title: "p", content: "x" }), /only a file/);
  assert.throws(() => e.notes.update(f.id, { kind: "page" }), /stays a file/);
  assert.throws(() => e.notes.update(f.id, { content: "a\u0000b" }), /binary/);
  assert.throws(() => e.notes.update(f.id, { content: 3 as any }), /text/);
  assert.equal(isTextFile("a/b/report.tex"), true);
  assert.equal(isTextFile("Makefile"), true);
  assert.equal(isTextFile("notes.md"), false);
  assert.equal(isTextFile("photo.png"), false);
});

test("notes files: a folder import brings code as files beside the pages, and the API/CLI read and write them", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const r = e.notes.importMarkdown([
    { path: "proj/README.md", text: "# Readme\nsee [[main.py]]" },
    { path: "proj/src/main.py", text: PY },
    { path: "proj/paper/report.tex", text: TEX },
  ]);
  assert.equal(r.pages, 1);
  assert.equal(r.files, 2);
  const by = new Map(e.notes.list().map((n) => [n.title, n]));
  assert.equal(by.get("main.py")?.kind, "file");
  assert.equal(by.get("src")?.kind, "folder");
  assert.equal(by.get("main.py")?.parentId, by.get("src")?.id);
  assert.equal(e.notes.get(by.get("report.tex")!.id).content, TEX);

  const app = createApp(e);
  const created = await (await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "a.js", kind: "file", content: "let x = 1\n" }) })).json();
  assert.equal(created.content, "let x = 1\n");
  const patched = await (await app.request(`/api/notes/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "let x = 2\n" }) })).json();
  assert.equal(patched.content, "let x = 2\n");
  const dl = await app.request(`/api/notes/${created.id}/export`);
  assert.equal(await dl.text(), "let x = 2\n");
  assert.match(dl.headers.get("content-disposition") ?? "", /a\.js$/);

  const dir = mkdtempSync(join(tmpdir(), "etude-notes-files-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "c.db");
  writeFileSync(join(dir, "solve.py"), PY);
  mkdirSync(join(dir, "vault"));
  writeFileSync(join(dir, "vault", "plot.m"), "x = 1:10;\nplot(x)\n");
  writeFileSync(join(dir, "vault", "Week 1.md"), "hello");
  const cli = async (...args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli", "main.ts"), "--db", db, ...args], { env: { ...process.env, ETUDE_HOME: dir }, encoding: "utf8" }) };
    } catch (err: any) {
      return { code: err.status ?? 1, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
    }
  };
  const made = await cli("note", "new", "solve.py", "--file", "--content-file", join(dir, "solve.py"));
  assert.equal(made.code, 0, made.out);
  const id = JSON.parse(made.out).id;
  assert.equal((await cli("note", "export", id)).out.includes("tabs and trailing"), true);
  const imp = JSON.parse((await cli("note", "import", join(dir, "vault"))).out);
  assert.equal(imp.files, 1);
  assert.equal(imp.pages, 1);
  assert.equal((await cli("settings", "set", "vim=true")).code, 0);
  const s = JSON.parse((await cli("settings", "get")).out);
  assert.equal(s.vim, true);
});
