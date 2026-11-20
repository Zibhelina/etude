import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { fsId, isFsId, parseFsId } from "../src/core/folders.ts";
import { agentRefusal } from "../src/core/agent-guard.ts";
import { COMMANDS } from "../src/cli/registry.ts";
import { parseInvocation, run } from "../src/cli/run.ts";
import "../src/cli/commands/index.ts";

/** A folder on disk the way someone keeps notes: Markdown, a picture, code, a hidden folder. */
function vault(t: { after(fn: () => void): void }) {
  // By its real path: on a Mac the temp folder is behind a link, and an open folder is kept by where it really is.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "etude-folder-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "Journal"));
  mkdirSync(join(dir, "Assets"));
  mkdirSync(join(dir, ".obsidian"));
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "Welcome.md"), "# Welcome\n\nSee [[Monday]] and ![[diagram.png]].\n");
  writeFileSync(join(dir, "Journal", "Monday.md"), "Walked to the lake. Zebras everywhere.\n");
  writeFileSync(join(dir, "Journal", "10 later.md"), "ten\n");
  writeFileSync(join(dir, "Journal", "2 sooner.md"), "two\n");
  writeFileSync(join(dir, "Assets", "diagram.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  writeFileSync(join(dir, "Assets", "paper.pdf"), "%PDF-1.4\n");
  writeFileSync(join(dir, "main.py"), "print('hi')\n");
  writeFileSync(join(dir, "windows.txt"), "one\r\ntwo\r\n");
  writeFileSync(join(dir, "bom.md"), "\uFEFFwith a mark\n");
  writeFileSync(join(dir, "latin.txt"), new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  writeFileSync(join(dir, "notes"), "no extension, plain text\n");
  writeFileSync(join(dir, ".obsidian", "app.json"), "{}");
  writeFileSync(join(dir, "node_modules", "pkg", "Monday.md"), "not this one\n");
  return dir;
}

test("folders: a folder opens where it is, lists lazily and reads files as they are", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const dir = vault(t);
  assert.equal(e.folders.available, true);
  assert.deepEqual(e.folders.list(), []);
  const f = e.folders.open(dir, { name: "Vault" });
  assert.equal(f.name, "Vault");
  assert.equal(f.trash, ".trash");
  assert.throws(() => e.folders.open(dir), /already open/);
  assert.throws(() => e.folders.open(join(dir, "nope")), /isn't a folder/);
  assert.throws(() => e.folders.open(e.mediaDir), /isn't a folder|own media/);

  const [root] = e.folders.roots();
  assert.equal(root.id, fsId(f.id));
  assert.equal(root.kind, "folder");
  assert.equal(root.parentId, null);
  assert.equal(root.title, "Vault");
  assert.equal(root.local.root?.missing, false);

  // Folders first, then files by name the way people read numbers; dot-names stay out.
  const top = e.folders.children(root.id);
  assert.deepEqual(top.map((r) => r.local.name), ["Assets", "Journal", "node_modules", "bom.md", "latin.txt", "main.py", "notes", "Welcome.md", "windows.txt"]);
  assert.equal(top.find((r) => r.local.name === "Welcome.md")!.title, "Welcome");
  assert.equal(top.find((r) => r.local.name === "Welcome.md")!.parentId, root.id);
  assert.equal(top.find((r) => r.local.name === "Journal")!.children, 3);
  const journal = e.folders.children(fsId(f.id, "Journal"));
  assert.deepEqual(journal.map((r) => r.title), ["2 sooner", "10 later", "Monday"]);
  assert.equal(journal[0].parentId, fsId(f.id, "Journal"));
  assert.deepEqual(e.folders.children(fsId(f.id, "Assets")).map((r) => [r.local.name, r.kind, r.local.type]), [["diagram.png", "file", "image"], ["paper.pdf", "pdf", "pdf"]]);

  const md = e.folders.get(fsId(f.id, "Welcome.md"));
  assert.equal(md.kind, "file");
  assert.equal(md.local.type, "markdown");
  assert.match(md.content!, /^# Welcome/);
  assert.equal(md.src, `/api/folders/raw?id=${encodeURIComponent(md.id)}`);
  assert.equal(md.updated, new Date(Math.round(statSync(join(dir, "Welcome.md")).mtimeMs)).toISOString());
  // A picture has no text; a file with no extension is text when it reads as text; bytes that aren't UTF-8 are read-only.
  assert.equal(e.folders.get(fsId(f.id, "Assets/diagram.png")).content, null);
  assert.equal(e.folders.get(fsId(f.id, "notes")).local.type, "text");
  assert.equal(e.folders.get(fsId(f.id, "bom.md")).content, "with a mark\n");
  const latin = e.folders.get(fsId(f.id, "latin.txt"));
  assert.equal(latin.content, null);
  assert.equal(latin.local.locked, "encoding");
  assert.throws(() => e.folders.write(latin.id, "café\n"), /isn't text/);

  // Nothing leaves the folder.
  assert.throws(() => e.folders.get(fsId(f.id, "../outside.md")), /leaves the folder/);
  assert.throws(() => e.folders.get(fsId(f.id, "Journal/../../x")), /leaves the folder/);
  assert.throws(() => e.folders.get("fs:nope/x.md"), /no folder/);
  // Dot-names can't be reached by an id made up by hand either, until the folder shows them.
  assert.throws(() => e.folders.get(fsId(f.id, ".obsidian/app.json")), /doesn't show names that start with a dot/);
  assert.throws(() => e.folders.write(fsId(f.id, ".obsidian/app.json"), "{}"), /start with a dot/);
  assert.throws(() => e.folders.raw(fsId(f.id, ".obsidian/app.json")), /start with a dot/);
  assert.throws(() => e.folders.create(fsId(f.id, ".obsidian"), { kind: "page" }), /start with a dot/);
  assert.equal(isFsId("fs:abc"), true);
  assert.equal(isFsId("8d1c2b"), false);
  assert.deepEqual(parseFsId(fsId("abc", "a/b.md")), { folder: "abc", rel: "a/b.md" });
  assert.equal(e.folders.idOf(join(dir, "Journal", "Monday.md")), fsId(f.id, "Journal/Monday.md"));
  assert.equal(e.folders.idOf(tmpdir()), null);

  // Closing takes it out of the Notebook and leaves the disk alone.
  e.folders.close("Vault");
  assert.deepEqual(e.folders.list(), []);
  assert.equal(existsSync(join(dir, "Welcome.md")), true);
});

test("folders: saving keeps the file's line ends and mark, and refuses a save over a change made on disk", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const dir = vault(t);
  const f = e.folders.open(dir);
  const id = fsId(f.id, "Welcome.md");
  const opened = e.folders.get(id);

  const saved = e.folders.write(id, "# Welcome\n\nEdited here.\n", { base: opened.updated });
  assert.equal(readFileSync(join(dir, "Welcome.md"), "utf8"), "# Welcome\n\nEdited here.\n");
  assert.equal(saved.content, "# Welcome\n\nEdited here.\n");
  assert.deepEqual(e.folders.stamp(id), { updated: saved.updated });
  // No stray temp file beside it.
  assert.deepEqual(e.folders.children(fsId(f.id)).filter((r) => r.local.name.includes("etude-tmp")), []);

  // Another program writes the file; the editor's next save carries the old stamp.
  writeFileSync(join(dir, "Welcome.md"), "# Welcome\n\nWritten by something else.\n");
  utimesSync(join(dir, "Welcome.md"), new Date(), new Date(Date.now() + 5000));
  assert.throws(() => e.folders.write(id, "# Welcome\n\nMine.\n", { base: saved.updated }), (err: any) => err.status === 409);
  assert.equal(readFileSync(join(dir, "Welcome.md"), "utf8"), "# Welcome\n\nWritten by something else.\n");
  // The same text as on disk is never a conflict, and never a write.
  const before = statSync(join(dir, "Welcome.md")).mtimeMs;
  e.folders.write(id, "# Welcome\n\nWritten by something else.\n", { base: saved.updated });
  assert.equal(statSync(join(dir, "Welcome.md")).mtimeMs, before);
  // Without a base (the CLI, an agent) the write goes through.
  e.folders.write(id, "# Welcome\n\nFrom the command line.\n");
  assert.equal(readFileSync(join(dir, "Welcome.md"), "utf8"), "# Welcome\n\nFrom the command line.\n");

  // Windows line ends and a byte-order mark stay as the file had them; the editor works in plain \n.
  e.folders.write(fsId(f.id, "windows.txt"), "one\ntwo\nthree\n");
  assert.equal(readFileSync(join(dir, "windows.txt"), "utf8"), "one\r\ntwo\r\nthree\r\n");
  e.folders.write(fsId(f.id, "bom.md"), "still marked\n");
  assert.deepEqual([...readFileSync(join(dir, "bom.md")).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(e.folders.get(fsId(f.id, "bom.md")).content, "still marked\n");
  // The file keeps who can read it.
  assert.equal(statSync(join(dir, "Welcome.md")).mode & 0o777, statSync(join(dir, "main.py")).mode & 0o777);
  assert.throws(() => e.folders.write(fsId(f.id, "Journal"), "x"), /is a folder/);
  assert.throws(() => e.folders.write(fsId(f.id, "gone.md"), "x"), /no file/);
});

test("folders: new files, names, moves and the trash all happen on disk", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const dir = vault(t);
  const f = e.folders.open(dir);
  const root = fsId(f.id);

  // A file is made under the name it's given; one asked to be unique takes a free name.
  const a = e.folders.create(root, { kind: "file", title: "Untitled.md", unique: true });
  assert.equal(a.local.name, "Untitled.md");
  assert.equal(e.folders.create(root, { kind: "file", title: "Untitled.md", unique: true }).local.name, "Untitled 1.md");
  const idea = e.folders.create(fsId(f.id, "Journal"), { kind: "file", title: "Idea.md", content: "seed\n" });
  assert.equal(idea.id, fsId(f.id, "Journal/Idea.md"));
  assert.equal(readFileSync(join(dir, "Journal", "Idea.md"), "utf8"), "seed\n");
  assert.throws(() => e.folders.create(fsId(f.id, "Journal"), { kind: "file", title: "Idea.md" }), (err: any) => err.status === 409);
  assert.equal(e.folders.create(root, { kind: "file", title: "data.csv", content: "a,b\n" }).local.type, "text");
  assert.equal(e.folders.create(root, { kind: "folder", title: "Drafts" }).kind, "folder");
  assert.throws(() => e.folders.create(root, { kind: "pdf" }), /can't be made/);
  assert.throws(() => e.folders.create(root, { kind: "file", title: "a/b.txt" }), /can't be a file name/);
  assert.throws(() => e.folders.create(root, { kind: "file", title: ".." }), /can't be a file name/);

  // A Markdown file keeps its extension through a rename; its pin goes with it.
  e.folders.pin(idea.id, true);
  e.folders.markOpened(idea.id);
  const renamed = e.folders.rename(idea.id, "Better idea");
  assert.equal(renamed.id, fsId(f.id, "Journal/Better idea.md"));
  assert.equal(renamed.title, "Better idea");
  assert.equal(existsSync(join(dir, "Journal", "Idea.md")), false);
  assert.ok(renamed.pinned);
  assert.deepEqual(e.folders.marked("pinned").map((r) => r.id), [renamed.id]);
  assert.deepEqual(e.folders.marked("opened").map((r) => r.id), [renamed.id]);
  assert.throws(() => e.folders.rename(renamed.id, "Monday"), (err: any) => err.status === 409);

  // Moving a folder takes what's inside, and the marks of what's inside.
  const moved = e.folders.move(fsId(f.id, "Journal"), fsId(f.id, "Drafts"));
  assert.equal(moved.id, fsId(f.id, "Drafts/Journal"));
  assert.equal(existsSync(join(dir, "Drafts", "Journal", "Better idea.md")), true);
  assert.deepEqual(e.folders.marked("pinned").map((r) => r.id), [fsId(f.id, "Drafts/Journal/Better idea.md")]);
  assert.throws(() => e.folders.move(fsId(f.id, "Drafts"), fsId(f.id, "Drafts/Journal")), /inside itself/);
  assert.throws(() => e.folders.move(root, fsId(f.id, "Drafts")), /top level/);
  assert.throws(() => e.folders.move(fsId(f.id, "main.py"), "some-page-id"), /can't hold it/);

  // Removing is a move to the folder's trash, and Undo is the move back.
  const gone = e.folders.trash(fsId(f.id, "main.py"));
  assert.deepEqual(gone, { ids: [fsId(f.id, "main.py")], archived: true, trashed: ".trash/main.py" });
  assert.equal(existsSync(join(dir, "main.py")), false);
  assert.equal(readFileSync(join(dir, ".trash", "main.py"), "utf8"), "print('hi')\n");
  e.folders.restore(fsId(f.id, "main.py"), gone.trashed);
  assert.equal(readFileSync(join(dir, "main.py"), "utf8"), "print('hi')\n");
  // A second file of the same name in the trash gets a number instead of replacing the first.
  e.folders.trash(fsId(f.id, "main.py"));
  writeFileSync(join(dir, "main.py"), "again\n");
  assert.equal(e.folders.trash(fsId(f.id, "main.py")).trashed, ".trash/main 1.py");
  assert.throws(() => e.folders.trash(root), /close it instead/);
  // Undo only takes things out of the trash, never from somewhere else in the folder.
  assert.throws(() => e.folders.restore(fsId(f.id, "copy.md"), "Welcome.md"), /isn't in this folder's trash/);
  assert.throws(() => e.folders.restore(fsId(f.id, "copy.md"), ".trash/../Welcome.md"), /leaves the folder/);

  // The trash can be a folder you see.
  e.folders.edit(f.id, { trash: "Bin" });
  assert.equal(e.folders.trash(fsId(f.id, "data.csv")).trashed, "Bin/data.csv");
  assert.throws(() => e.folders.trash(fsId(f.id, "Bin/data.csv")), /already in the trash/);
  assert.throws(() => e.folders.edit(f.id, { trash: "../out" }), /inside the folder/);
});

test("folders: links resolve the way Obsidian's do, and search finds names and words", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const dir = vault(t);
  const f = e.folders.open(dir);
  const from = fsId(f.id, "Welcome.md");
  // By name anywhere (never node_modules), with an alias or a heading after it; a path beside the file; a path from the top.
  assert.equal(await e.folders.resolveLink(from, "Monday"), fsId(f.id, "Journal/Monday.md"));
  assert.equal(await e.folders.resolveLink(from, "monday#Morning|that day"), fsId(f.id, "Journal/Monday.md"));
  assert.equal(await e.folders.resolveLink(from, "diagram.png"), fsId(f.id, "Assets/diagram.png"));
  assert.equal(await e.folders.resolveLink(from, "Journal/Monday.md"), fsId(f.id, "Journal/Monday.md"));
  assert.equal(await e.folders.resolveLink(fsId(f.id, "Journal/Monday.md"), "../Welcome"), fsId(f.id, "Welcome.md"));
  assert.equal(await e.folders.resolveLink(fsId(f.id, "Journal/Monday.md"), "/Assets/paper.pdf"), fsId(f.id, "Assets/paper.pdf"));
  assert.equal(await e.folders.resolveLink(fsId(f.id, "Journal/Monday.md"), "2%20sooner.md"), fsId(f.id, "Journal/2 sooner.md"));
  assert.equal(await e.folders.resolveLink(from, "#Just a heading"), from);
  assert.equal(await e.folders.resolveLink(from, "Nowhere"), null);
  assert.equal(await e.folders.resolveLink(from, "https://example.com"), null);
  assert.equal(await e.folders.resolveLink(from, "../../etc/passwd"), null);

  const byName = await e.folders.search("monday");
  assert.equal(byName[0].id, fsId(f.id, "Journal/Monday.md"));
  assert.equal(byName.some((r) => r.local.path.startsWith("node_modules")), false);
  const byWord = await e.folders.search("zebras");
  assert.equal(byWord[0]?.id, fsId(f.id, "Journal/Monday.md"));
  assert.match(byWord[0].snippet, /Zebras everywhere/);
  assert.deepEqual(await e.folders.search(""), []);
});

test("folders: without ripgrep the folder is walked instead, with the same answers", async (t) => {
  process.env.ETUDE_RG = "off";
  t.after(() => void delete process.env.ETUDE_RG);
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const dir = vault(t);
  const f = e.folders.open(dir);
  assert.equal(await e.folders.resolveLink(fsId(f.id, "Welcome.md"), "Monday"), fsId(f.id, "Journal/Monday.md"));
  assert.equal((await e.folders.search("diagram"))[0].id, fsId(f.id, "Assets/diagram.png"));
  const byWord = await e.folders.search("zebras");
  assert.equal(byWord[0]?.id, fsId(f.id, "Journal/Monday.md"));
  assert.match(byWord[0].snippet, /Zebras everywhere/);
  // Dot-folders are only walked when the folder shows them.
  assert.equal(await e.folders.resolveLink(fsId(f.id, "Welcome.md"), "app.json"), null);
  e.folders.edit(f.id, { hidden: true });
  assert.equal(await e.folders.resolveLink(fsId(f.id, "Welcome.md"), "app.json"), fsId(f.id, ".obsidian/app.json"));
  assert.equal(e.folders.children(fsId(f.id)).some((r) => r.local.name === ".obsidian"), true);
});

test("folders: the Notebook's own routes read and write files on disk", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const dir = vault(t);
  const app = createApp(e);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    Promise.resolve(app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const json = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    return { status: r.status, body: (await r.json()) as any };
  };
  const enc = encodeURIComponent;

  assert.deepEqual((await json("GET", "/api/folders")).body, { available: true, folders: [] });
  const opened = await json("POST", "/api/folders", { path: dir });
  assert.equal(opened.status, 200);
  const fid = opened.body.id as string;
  const root = fsId(fid);

  const tree = await json("POST", "/api/folders/entries", { dirs: [root, fsId(fid, "Journal"), fsId(fid, "Nope")] });
  assert.equal(tree.body.roots[0].id, root);
  assert.equal(tree.body.dirs[root].some((r: any) => r.title === "Welcome"), true);
  assert.equal(tree.body.dirs[fsId(fid, "Journal")].length, 3);
  assert.equal(tree.body.dirs[fsId(fid, "Nope")], null);
  assert.equal(tree.body.stamps.dirs[fsId(fid, "Nope")], "gone");
  // A new file in a folder moves that folder's stamp.
  const s1 = (await json("POST", "/api/folders/stamps", { dirs: [root] })).body.dirs[root];

  const id = fsId(fid, "Journal/Monday.md");
  const note = await json("GET", `/api/notes/${enc(id)}`);
  assert.equal(note.body.content, "Walked to the lake. Zebras everywhere.\n");
  assert.equal((await json("GET", `/api/notes/${enc(id)}/stamp`)).body.updated, note.body.updated);
  assert.deepEqual((await json("GET", `/api/notes/${enc(id)}/backlinks`)).body, []);

  const saved = await json("PATCH", `/api/notes/${enc(id)}`, { content: "Rained.\n", base: note.body.updated });
  assert.equal(saved.status, 200);
  assert.equal(readFileSync(join(dir, "Journal", "Monday.md"), "utf8"), "Rained.\n");
  utimesSync(join(dir, "Journal", "Monday.md"), new Date(), new Date(Date.now() + 9000));
  assert.equal((await json("PATCH", `/api/notes/${enc(id)}`, { content: "Late.\n", base: saved.body.updated })).status, 409);

  const made = await json("POST", "/api/notes", { parentId: root, kind: "file", title: "From the app.md" });
  assert.equal(made.body.id, fsId(fid, "From the app.md"));
  assert.equal(existsSync(join(dir, "From the app.md")), true);
  utimesSync(dir, new Date(), new Date(Date.now() + 9000));
  assert.notEqual((await json("POST", "/api/folders/stamps", { dirs: [root] })).body.dirs[root], s1);
  const renamed = await json("PATCH", `/api/notes/${enc(made.body.id)}`, { title: "Renamed" });
  assert.equal(renamed.body.id, fsId(fid, "Renamed.md"));
  const moved = await json("POST", `/api/notes/${enc(renamed.body.id)}/move`, { parentId: fsId(fid, "Journal") });
  assert.equal(moved.body.id, fsId(fid, "Journal/Renamed.md"));
  assert.equal((await json("POST", `/api/notes/${enc(moved.body.id)}/opened`)).body.id, moved.body.id);
  assert.equal((await json("GET", "/api/notes/recent")).body[0].id, moved.body.id);
  assert.equal((await json("POST", `/api/notes/${enc(moved.body.id)}/pin`, { pinned: true })).body.pinned !== null, true);
  assert.deepEqual((await json("GET", "/api/notes/pinned")).body.map((r: any) => r.id), [moved.body.id]);
  assert.equal((await json("GET", `/api/notes/previews?ids=${enc(id)}`)).body[0].head, "Rained.\n");
  assert.equal((await json("POST", "/api/folders/rows", { ids: [id, fsId(fid, "x.md")] })).body[1], null);
  assert.equal((await json("GET", `/api/folders/resolve?from=${enc(fsId(fid, "Welcome.md"))}&target=Monday`)).body.id, id);
  assert.equal((await json("GET", "/api/notes/search?q=renamed")).body.some((r: any) => r.id === moved.body.id), true);

  // The archive button is the trash, and so is delete: the file is still on disk afterwards.
  const binned = await json("POST", `/api/notes/${enc(moved.body.id)}/archive`, { archived: true });
  assert.equal(binned.body.trashed, ".trash/Renamed.md");
  assert.equal((await json("POST", "/api/folders/restore", { id: moved.body.id, trashed: binned.body.trashed })).status, 200);
  assert.equal((await json("DELETE", `/api/notes/${enc(moved.body.id)}`)).body.trashed, ".trash/Renamed.md");
  assert.equal(existsSync(join(dir, ".trash", "Renamed.md")), true);

  // A file's bytes, whole and in ranges, by id or by the link that points at it.
  const png = fsId(fid, "Assets/diagram.png");
  const whole = await call("GET", `/api/folders/raw?id=${enc(png)}`);
  assert.equal(whole.headers.get("content-type"), "image/png");
  assert.match(whole.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal((await whole.arrayBuffer()).byteLength, 14);
  const part = await call("GET", `/api/folders/raw?id=${enc(png)}`, undefined, { range: "bytes=4-7" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 4-7/14");
  assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [0, 1, 2, 3]);
  const tail = await call("GET", `/api/folders/raw?id=${enc(png)}`, undefined, { range: "bytes=-2" });
  assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [8, 9]);
  assert.equal((await call("GET", `/api/folders/raw?id=${enc(png)}`, undefined, { range: "bytes=99-" })).status, 416);
  const linked = await call("GET", `/api/folders/raw?from=${enc(fsId(fid, "Welcome.md"))}&target=${enc("diagram.png")}`);
  assert.equal((await linked.arrayBuffer()).byteLength, 14);
  assert.equal((await call("GET", `/api/folders/raw?from=${enc(fsId(fid, "Welcome.md"))}&target=missing.png`)).status, 404);
  assert.equal((await call("GET", `/api/folders/raw?id=${enc(fsId(fid, "../x"))}`)).status, 400);
  const dl = await call("GET", `/api/notes/${enc(id)}/export`);
  assert.match(dl.headers.get("content-disposition") ?? "", /Monday\.md/);

  // The collection's own notes are untouched by all this.
  const page = await json("POST", "/api/notes", { title: "A page" });
  assert.equal(isFsId(page.body.id), false);
  assert.equal((await json("GET", `/api/notes/${page.body.id}`)).body.title, "A page");
  assert.equal((await json("GET", "/api/notes")).body.length, 1);

  assert.equal((await json("DELETE", `/api/folders/${fid}`)).status, 200);
  assert.equal((await json("GET", `/api/notes/${enc(id)}`)).status, 404);
});

const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const docOf = (...blocks: unknown[]) => ({ type: "doc", content: blocks });

test("folders: a page is a .etude file: made, read, saved and renamed where it is", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const dir = vault(t);
  const f = e.folders.open(dir, { name: "Vault" });
  const root = fsId(f.id);

  // A new page is a file named after its title, holding the page's document as JSON.
  const blank = e.folders.create(root, { kind: "page" });
  assert.equal(blank.local.name, "Untitled.etude");
  assert.equal(blank.kind, "page");
  assert.equal(blank.title, "Untitled");
  assert.equal(blank.content, null);
  assert.deepEqual(blank.doc, { type: "doc", content: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "Untitled.etude"), "utf8")), { etude: 1, kind: "page", doc: { type: "doc", content: [] } });
  assert.equal(e.folders.create(root, { kind: "page" }).local.name, "Untitled 1.etude");
  const page = e.folders.create(fsId(f.id, "Journal"), { kind: "page", title: "Reading", doc: docOf(para("Chapter one, about otters.")) });
  assert.equal(page.id, fsId(f.id, "Journal/Reading.etude"));
  assert.equal(page.text.includes("otters"), true);
  assert.throws(() => e.folders.create(root, { kind: "page", title: "x", content: "text" }), /a page isn't text/);
  assert.throws(() => e.folders.create(root, { kind: "page", title: "x", doc: { type: "nope" } }));
  // In the tree it's a page, under its title.
  const row = e.folders.children(fsId(f.id, "Journal")).find((r) => r.local.name === "Reading.etude")!;
  assert.deepEqual([row.kind, row.title, row.local.type], ["page", "Reading", "etude"]);

  // The editor saves the document with the stamp it read; a save over a change made on disk is refused, to be merged.
  const saved = e.folders.writePage(page.id, { doc: docOf(para("Chapter one, about otters."), para("Chapter two.")) }, { base: page.updated });
  assert.equal(saved.doc.content!.length, 2);
  assert.equal(JSON.parse(readFileSync(join(dir, "Journal", "Reading.etude"), "utf8")).doc.content.length, 2);
  const file = join(dir, "Journal", "Reading.etude");
  writeFileSync(file, readFileSync(file, "utf8").replace("Chapter two.", "Chapter two, changed by another program."));
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.throws(() => e.folders.writePage(page.id, { doc: docOf(para("Mine.")) }, { base: saved.updated }), (err: any) => err.status === 409 && err.code === "changed");
  assert.equal(e.folders.get(page.id).text.includes("changed by another program"), true);
  // The same page again is no write at all.
  const before = statSync(file).mtimeMs;
  e.folders.writePage(page.id, { doc: e.folders.get(page.id).doc }, { base: "stale" });
  assert.equal(statSync(file).mtimeMs, before);
  // Its icon and look live in the file too.
  const looked = e.folders.writePage(page.id, { icon: "emoji:📚", look: { width: "wide" } });
  assert.deepEqual([looked.icon, looked.look], ["emoji:📚", { width: "wide" }]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))), ["etude", "kind", "icon", "look", "doc"]);
  assert.throws(() => e.folders.writePage(page.id, { look: { nope: 1 } }), /has no "nope"/);
  assert.throws(() => e.folders.writePage(fsId(f.id, "Welcome.md"), { doc: docOf() }), /isn't an Etude page/);
  // A page's file only takes text that is a page.
  assert.throws(() => e.folders.write(page.id, "just some words"), /is an Etude page/);

  // A new title renames the file and keeps what it is.
  const renamed = e.folders.rename(page.id, "Reading list");
  assert.equal(renamed.id, fsId(f.id, "Journal/Reading list.etude"));
  assert.equal(renamed.kind, "page");
  // Links and search find it by its title, and by the words in it (shown as words, not JSON).
  assert.equal(await e.folders.resolveLink(fsId(f.id, "Welcome.md"), "Reading list"), renamed.id);
  assert.equal((await e.folders.search("reading"))[0].id, renamed.id);
  const hit = (await e.folders.search("otters")).find((r) => r.id === renamed.id)!;
  assert.equal(hit.snippet, "Chapter one, about otters.");
  assert.equal(e.folders.previews([renamed.id])[0].blocks.length, 2);

  // A page's own title lives in its file, apart from its name: giving one renames nothing, and none is written until one is given.
  assert.equal(renamed.local.pageTitle, undefined);
  const titled = e.folders.writePage(renamed.id, { title: "  Books I mean\nto read  " });
  assert.equal(titled.id, renamed.id);
  assert.equal(titled.title, "Reading list");
  assert.equal(titled.local.pageTitle, "Books I mean to read");
  const onDisk = JSON.parse(readFileSync(join(dir, "Journal", "Reading list.etude"), "utf8"));
  assert.deepEqual(Object.keys(onDisk), ["etude", "kind", "title", "icon", "look", "doc"]);
  assert.equal(onDisk.title, "Books I mean to read");
  // A rename keeps it, and an empty title takes it out of the file again.
  const moved = e.folders.rename(renamed.id, "Shelf");
  assert.equal(moved.local.pageTitle, "Books I mean to read");
  assert.equal(e.folders.writePage(moved.id, { title: "   " }).local.pageTitle, undefined);
  assert.equal("title" in JSON.parse(readFileSync(join(dir, "Journal", "Shelf.etude"), "utf8")), false);
  e.folders.rename(moved.id, "Reading list");

  // A .etude file that isn't a page (or is from a newer Etude) opens as its text, saying why, and can be mended there.
  writeFileSync(join(dir, "broken.etude"), "{ not json");
  writeFileSync(join(dir, "future.etude"), JSON.stringify({ etude: 99, doc: { type: "doc", content: [] } }));
  const broken = e.folders.get(fsId(f.id, "broken.etude"));
  assert.deepEqual([broken.kind, broken.content, broken.local.type], ["file", "{ not json", "text"]);
  assert.match(broken.local.broken ?? "", /isn't JSON/);
  assert.match(e.folders.get(fsId(f.id, "future.etude")).local.broken ?? "", /newer Etude/);
  e.folders.write(fsId(f.id, "broken.etude"), JSON.stringify({ etude: 1, doc: docOf(para("Mended.")) }));
  assert.equal(e.folders.get(fsId(f.id, "broken.etude")).kind, "page");
});

test("folders: a canvas and a kanban board are .etude files too, and an .html file is a web file", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const dir = vault(t);
  const f = e.folders.open(dir, { name: "Vault" });
  const root = fsId(f.id);
  const rect = { id: "r1", type: "rectangle", x: 0, y: 0, width: 10, height: 10 };

  // A canvas: the same extension, the kind said first in the file, its drawing inside.
  const canvas = e.folders.create(root, { kind: "canvas", title: "Sketch" });
  assert.deepEqual([canvas.local.name, canvas.kind, canvas.title, canvas.scene?.elements.length, canvas.content], ["Sketch.etude", "canvas", "Sketch", 0, null]);
  assert.match(readFileSync(join(dir, "Sketch.etude"), "utf8").slice(0, 40), /"etude": 1,\s+"kind": "canvas"/);
  const drawn = e.folders.writePage(canvas.id, { scene: { ...canvas.scene!, elements: [rect] } }, { base: canvas.updated });
  assert.equal(drawn.scene!.elements.length, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, "Sketch.etude"), "utf8")).scene.elements[0].id, "r1");
  assert.throws(() => e.folders.writePage(canvas.id, { doc: docOf(para("x")) }), /a canvas has a scene, not a doc/);
  assert.throws(() => e.folders.writePage(canvas.id, { scene: { elements: "no" } }));
  assert.equal(e.folders.create(root, { kind: "canvas" }).local.name, "Untitled canvas.etude");

  // A board.
  const board = e.folders.create(root, { kind: "kanban", title: "Plan" });
  assert.deepEqual([board.local.name, board.kind, board.title], ["Plan.etude", "kanban", "Plan"]);
  assert.ok(board.board && board.board.columns.length > 0);
  const col = board.board!.columns[0];
  const withCard = { ...board.board!, cards: { c1: { id: "c1", title: "Write the plan" } }, columns: board.board!.columns.map((c) => (c.id === col.id ? { ...c, cards: ["c1"] } : c)) };
  const saved = e.folders.writePage(board.id, { board: withCard }, { base: board.updated });
  assert.equal(Object.keys(saved.board!.cards).length, 1);
  assert.equal(saved.text.includes("Write the plan"), true);
  assert.throws(() => e.folders.writePage(board.id, { scene: canvas.scene }), /only a canvas has a scene/);
  assert.throws(() => e.folders.writePage(fsId(f.id, "Welcome.md"), { board: withCard }), /isn't an Etude page/);

  // The tree knows which is which without reading the files whole, and a page is still a page.
  const page = e.folders.create(root, { kind: "page", title: "Words" });
  const kinds = Object.fromEntries(e.folders.children(root).filter((r) => r.local.type === "etude").map((r) => [r.local.name, r.kind]));
  assert.deepEqual(kinds, { "Plan.etude": "kanban", "Sketch.etude": "canvas", "Untitled canvas.etude": "canvas", "Words.etude": "page" });
  assert.throws(() => e.folders.writePage(page.id, { board: withCard }), /only a kanban board has a board/);
  // Renamed, each stays what it is.
  assert.equal(e.folders.rename(canvas.id, "Diagram").kind, "canvas");
  assert.equal(e.folders.get(fsId(f.id, "Diagram.etude")).scene!.elements.length, 1);

  // A web file is its HTML.
  const web = e.folders.create(root, { kind: "web", title: "Demo", content: "<h1>Hi</h1>" });
  assert.deepEqual([web.local.name, web.kind, web.local.type, web.content], ["Demo.html", "web", "web", "<h1>Hi</h1>"]);
  assert.equal(readFileSync(join(dir, "Demo.html"), "utf8"), "<h1>Hi</h1>");
  assert.equal(e.folders.write(web.id, "<h1>Hello</h1>", { base: web.updated }).content, "<h1>Hello</h1>");
  assert.equal(e.folders.create(root, { kind: "web" }).local.name, "Untitled.html");

  // The routes the editors use: a drawing, a board and HTML each save through the note's own address.
  const app = createApp(e);
  const json = async (method: string, path: string, body?: unknown) => {
    const r = await Promise.resolve(app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as any };
  };
  const enc = encodeURIComponent;
  const made = await json("POST", "/api/notes", { parentId: root, kind: "canvas" });
  assert.deepEqual([made.body.kind, made.body.local.name], ["canvas", "Untitled canvas 1.etude"]);
  const got = await json("GET", `/api/notes/${enc(made.body.id)}`);
  assert.equal(got.body.scene.type, "excalidraw");
  assert.equal((await json("PATCH", `/api/notes/${enc(made.body.id)}`, { scene: { ...got.body.scene, elements: [rect] } })).body.scene.elements.length, 1);
  const kb = await json("POST", "/api/notes", { parentId: root, kind: "kanban", title: "Sprint" });
  assert.equal((await json("PATCH", `/api/notes/${enc(kb.body.id)}`, { board: withCard })).body.board.cards.c1.title, "Write the plan");
  assert.equal((await json("PATCH", `/api/notes/${enc(web.id)}`, { content: "<p>saved</p>" })).body.content, "<p>saved</p>");
});

test("folders: the routes and the CLI read and write pages kept as files", async (t) => {
  const dir = vault(t);
  const home = mkdtempSync(join(tmpdir(), "etude-folder-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const e = await Etude.open(join(home, "etude.db"), { home });
  t.after(() => e.close());
  const app = createApp(e);
  const json = async (method: string, path: string, body?: unknown) => {
    const r = await Promise.resolve(app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as any };
  };
  const enc = encodeURIComponent;
  const fid = (await json("POST", "/api/folders", { path: dir, name: "Vault" })).body.id as string;

  // What "New page" in a folder does, and what the page editor then sends.
  const made = await json("POST", "/api/notes", { parentId: fsId(fid), kind: "page" });
  assert.equal(made.body.id, fsId(fid, "Untitled.etude"));
  assert.equal(made.body.kind, "page");
  const save = await json("PATCH", `/api/notes/${enc(made.body.id)}`, { doc: docOf(para("Typed in the page editor.")), base: made.body.updated });
  assert.equal(save.status, 200);
  utimesSync(join(dir, "Untitled.etude"), new Date(), new Date(Date.now() + 9000));
  assert.equal((await json("PATCH", `/api/notes/${enc(made.body.id)}`, { doc: docOf(para("Late.")), base: save.body.updated })).status, 409);
  assert.equal((await json("PATCH", `/api/notes/${enc(made.body.id)}`, { icon: "emoji:🦦" })).body.icon, "emoji:🦦");
  const named = await json("PATCH", `/api/notes/${enc(made.body.id)}`, { title: "Otters" });
  assert.equal(named.body.id, fsId(fid, "Otters.etude"));
  assert.equal(JSON.parse(readFileSync(join(dir, "Otters.etude"), "utf8")).doc.content[0].content[0].text, "Typed in the page editor.");
  // "New Markdown file" asks for a free name.
  assert.equal((await json("POST", "/api/notes", { parentId: fsId(fid), kind: "file", title: "Untitled.md", unique: true })).body.id, fsId(fid, "Untitled.md"));
  assert.equal((await json("POST", "/api/notes", { parentId: fsId(fid), kind: "file", title: "Untitled.md", unique: true })).body.id, fsId(fid, "Untitled 1.md"));

  // The CLI: a name without an extension is a page, one with an extension is that file.
  const io = (out: string[]) => ({ stdout: (x: string) => out.push(x), stderr: (x: string) => out.push(x), stdin: () => "", isTTY: false, env: { ...process.env, ETUDE_HOME: home } });
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const code = await run(argv, io(out), { etude: e });
    return { code, text: out.join("") };
  };
  const page = JSON.parse((await cli("folder", "new", "Vault/Journal", "Reading list", "--md", "# Books\n\n- [ ] Dune\n- [x] Solaris")).text);
  assert.deepEqual([page.name, page.kind, page.type], ["Reading list.etude", "page", "etude"]);
  const md = JSON.parse((await cli("folder", "new", "Vault/Journal", "Tuesday.md", "--content", "# Tuesday")).text);
  assert.deepEqual([md.name, md.kind, md.type], ["Tuesday.md", "file", "markdown"]);
  assert.equal(readFileSync(join(dir, "Journal", "Tuesday.md"), "utf8"), "# Tuesday");
  // A page reads as Markdown, and a patch rewrites only the block it touches.
  const read = (await cli("folder", "read", "Vault/Journal/Reading list.etude")).text;
  assert.match(read, /· etude · /);
  assert.match(read, /# Books/);
  assert.match(read, /- \[ \] Dune/);
  const patched = JSON.parse((await cli("folder", "patch", "Vault/Journal/Reading list.etude", "--old", "Dune", "--new", "Dune Messiah")).text);
  assert.equal(patched.replaced, 1);
  assert.match((await cli("folder", "read", "Vault/Journal/Reading list.etude")).text, /Dune Messiah/);
  assert.equal(JSON.parse((await cli("folder", "write", "Vault/Journal/Reading list.etude", "--md", "Only this now.")).text).id, page.id);
  assert.match((await cli("folder", "read", "Vault/Journal/Reading list.etude")).text, /Only this now\./);
  assert.notEqual((await cli("folder", "new", "Vault", "notes.md", "--md", "x")).code, 0);
});

test("folders: what's in a folder can be put in an order of your own", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const dir = mkdtempSync(join(tmpdir(), "etude-order-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const d of ["Drafts", "Papers", "Tasks"]) mkdirSync(join(dir, d));
  for (const f of ["a.md", "b.md", "c.md"]) writeFileSync(join(dir, f), f);
  const f = e.folders.open(dir, { name: "Vault" });
  const root = fsId(f.id);
  const at = (rel: string) => fsId(f.id, rel);
  const names = (id = root) => e.folders.children(id).map((r) => r.local.name);

  // By name, folders first, until something is placed by hand.
  assert.deepEqual(names(), ["Drafts", "Papers", "Tasks", "a.md", "b.md", "c.md"]);
  assert.equal(e.folders.roots()[0].local.arranged, undefined);
  const stamp0 = e.folders.orderStamp();
  // A folder dragged between two others in the folder it's already in: nothing moves on disk, the order is the folder's.
  assert.equal(e.folders.move(at("Tasks"), root, 0).id, at("Tasks"));
  assert.deepEqual(names(), ["Tasks", "Drafts", "Papers", "a.md", "b.md", "c.md"]);
  assert.equal(existsSync(join(dir, "Tasks")), true);
  assert.equal(e.folders.roots()[0].local.arranged, true);
  assert.notEqual(e.folders.orderStamp(), stamp0);
  // A file can go above a folder, and the place counts among the others (as it does for pages).
  e.folders.move(at("c.md"), root, 1);
  assert.deepEqual(names(), ["Tasks", "c.md", "Drafts", "Papers", "a.md", "b.md"]);
  e.folders.move(at("Tasks"), root, 5);
  assert.deepEqual(names(), ["c.md", "Drafts", "Papers", "a.md", "b.md", "Tasks"]);
  e.folders.move(at("Tasks"), root, 99);
  assert.deepEqual(names(), ["c.md", "Drafts", "Papers", "a.md", "b.md", "Tasks"]);

  // Renamed where it is, it keeps its place; made since, it goes after the rest; gone and back, it's where it was.
  e.folders.rename(at("Drafts"), "Lectures");
  assert.deepEqual(names(), ["c.md", "Lectures", "Papers", "a.md", "b.md", "Tasks"]);
  e.folders.create(root, { kind: "file", title: "0 new.md" });
  mkdirSync(join(dir, "0 folder"));
  assert.deepEqual(names(), ["c.md", "Lectures", "Papers", "a.md", "b.md", "Tasks", "0 folder", "0 new.md"]);
  const gone = e.folders.trash(at("Papers"));
  assert.deepEqual(names(), ["c.md", "Lectures", "a.md", "b.md", "Tasks", "0 folder", "0 new.md"]);
  e.folders.restore(at("Papers"), gone.trashed);
  assert.deepEqual(names(), ["c.md", "Lectures", "Papers", "a.md", "b.md", "Tasks", "0 folder", "0 new.md"]);

  // Moved into another folder at a place: on disk it moves, and that folder has an order now. Its own order goes with a folder.
  e.folders.move(at("a.md"), at("Lectures"), 0);
  e.folders.move(at("b.md"), at("Lectures"), 0);
  assert.deepEqual(names(at("Lectures")), ["b.md", "a.md"]);
  assert.deepEqual(names(), ["c.md", "Lectures", "Papers", "Tasks", "0 folder", "0 new.md"]);
  e.folders.move(at("Lectures"), at("Tasks"));
  assert.deepEqual(names(at("Tasks/Lectures")), ["b.md", "a.md"]);
  e.folders.rename(at("Tasks"), "Work");
  assert.deepEqual(names(at("Work/Lectures")), ["b.md", "a.md"]);
  // Without a place, a move into a folder that lists by name stays by name.
  e.folders.move(at("c.md"), at("Papers"));
  e.folders.create(at("Papers"), { kind: "file", title: "a first.md" });
  assert.deepEqual(names(at("Papers")), ["a first.md", "c.md"]);
  assert.equal(e.folders.children(root).find((r) => r.local.name === "Papers")!.local.arranged, undefined);
  assert.equal(e.folders.children(root).find((r) => r.local.name === "Work")!.local.arranged, undefined, "only the folder whose own files were placed says so");
  assert.equal(e.folders.children(at("Work")).find((r) => r.local.name === "Lectures")!.local.arranged, true);

  // Several at once (a selection dragged, or its Undo): each to its folder and its place, in one step.
  const moved = e.folders.place([
    { id: at("Papers/c.md"), parentId: root, index: 0 },
    { id: at("Papers/a first.md"), parentId: root, index: 1 },
    { id: at("0 new.md"), parentId: root, index: 4 },
  ]);
  assert.deepEqual(moved.map((m) => m.id), [at("c.md"), at("a first.md"), at("0 new.md")]);
  assert.deepEqual(names(), ["c.md", "a first.md", "Papers", "Work", "0 new.md", "0 folder"]);
  assert.throws(() => e.folders.place([{ id: root, parentId: root, index: 0 }]), /stays at the top level/);
  assert.throws(() => e.folders.move(at("c.md"), "not-a-folder", 0), /moves between folders on this computer/);

  // Back to names.
  assert.equal(e.folders.sortByName(root).local.arranged, undefined);
  assert.deepEqual(names(), ["0 folder", "Papers", "Work", "0 new.md", "a first.md", "c.md"]);
  assert.deepEqual(names(at("Work/Lectures")), ["b.md", "a.md"], "each folder's order is its own");

  // The routes the tree uses, and the CLI.
  const app = createApp(e);
  const json = async (method: string, path: string, body?: unknown) => {
    const r = await Promise.resolve(app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as any };
  };
  const before = (await json("POST", "/api/folders/stamps", { dirs: [] })).body.order;
  assert.equal((await json("POST", `/api/notes/${encodeURIComponent(at("Work"))}/move`, { parentId: root, index: 0 })).body.id, at("Work"));
  assert.deepEqual(names().slice(0, 2), ["Work", "0 folder"]);
  assert.notEqual((await json("POST", "/api/folders/stamps", { dirs: [] })).body.order, before);
  // The listing and the poll say the same, so the tree doesn't take every poll for a change.
  assert.deepEqual((await json("POST", "/api/folders/entries", { dirs: [root] })).body.stamps, (await json("POST", "/api/folders/stamps", { dirs: [root] })).body);
  assert.deepEqual((await json("POST", "/api/folders/place", { items: [{ id: at("c.md"), parentId: root, index: 0 }, { id: at("a first.md"), parentId: at("Papers") }] })).body, [{ from: at("c.md"), id: at("c.md") }, { from: at("a first.md"), id: at("Papers/a first.md") }]);
  assert.deepEqual(names().slice(0, 2), ["c.md", "Work"]);
  assert.equal((await json("POST", "/api/folders/entries", { dirs: [] })).body.roots[0].local.arranged, true);
  assert.equal((await json("POST", "/api/folders/sort", { id: root })).body.local.arranged, undefined);
  const out: string[] = [];
  const io = { stdout: (x: string) => out.push(x), stderr: (x: string) => out.push(x), stdin: () => "", isTTY: false, env: process.env };
  assert.equal(await run(["folder", "move", "Vault/Papers", "Vault", "--index", "0", "--dry-run"], io, { etude: e }), 0);
  assert.deepEqual(names()[0], "0 folder", "a dry run changes nothing");
  assert.equal(await run(["folder", "move", "Vault/Papers", "Vault", "--index", "0"], io, { etude: e }), 0);
  assert.deepEqual(names().slice(0, 2), ["Papers", "0 folder"]);
  out.length = 0;
  assert.equal(await run(["folder", "sort", "Vault"], io, { etude: e }), 0);
  assert.equal(JSON.parse(out.join("")).arranged, false);
  assert.deepEqual(names().slice(0, 2), ["0 folder", "Papers"]);

  // A folder that leaves the Notebook takes its orders with it.
  e.folders.move(at("c.md"), root, 0);
  e.folders.close(f.id);
  assert.deepEqual(e.folders.children(fsId(e.folders.open(dir, { name: "Vault" }).id)).map((r) => r.local.name).slice(0, 2), ["0 folder", "Papers"]);
});

test("folders: Ask Etude works inside the folders the user opened, and can't choose which are open", () => {
  const refusal = (argv: string[]) => {
    const inv = parseInvocation(argv)!;
    assert.ok(inv, argv.join(" "));
    return agentRefusal({ cmd: inv.cmd, values: inv.values, named: inv.named, attachmentDir: tmpdir() });
  };
  // Opening, closing and what a folder shows are the user's: an assistant that opened "/" could read anything.
  for (const argv of [["folder", "open", "/"], ["folder", "open", "Notes"], ["folder", "close", "Vault"], ["folder", "edit", "Vault", "--hidden", "show"], ["folder", "edit", "Vault", "--trash", "x"]])
    assert.match(refusal(argv) ?? "", /can't choose which folders/, argv.join(" "));
  // Inside an open folder it reads, searches and changes files, named any of the ways a file can be.
  const allowed: string[][] = [
    ["folder", "list"],
    ["folder", "ls"],
    ["folder", "ls", "Vault/Journal"],
    ["folder", "read", "Vault/Journal/Monday.md"],
    ["folder", "read", "fs:abc/Journal/Monday.md", "--lines"],
    ["folder", "search", "lake"],
    ["folder", "write", "Vault/a.md", "--content", "x"],
    ["folder", "patch", "Vault/a.md", "--old", "a", "--new", "b"],
    ["folder", "new", "Vault/Journal", "Tuesday", "--content", "# Tuesday"],
    ["folder", "rename", "Vault/a.md", "b"],
    ["folder", "move", "Vault/a.md", "Vault/Journal"],
    ["folder", "trash", "Vault/a.md"],
    ["folder", "restore", "Vault/a.md", ".trash/a.md"],
    ["folder", "where", "/home/someone/vault/a.md"],
    ["folder", "sync", "list"],
    ["folder", "take", "Journal", "Vault/Journal", "--dry-run"],
    ["folder", "bring", "Vault/Journal/Monday.md", "--dry-run"],
    ["folder", "sort", "Vault/Journal"],
  ];
  // Which folders Sync carries is the user's too; looking at the list is fine.
  for (const argv of [["folder", "sync", "on", "Vault"], ["folder", "sync", "link", "Notes", "/tmp/x"], ["folder", "sync", "off", "Vault", "--everywhere"], ["folder", "sync", "go", "Vault"]])
    assert.match(refusal(argv) ?? "", /can't choose which folders Sync carries/, argv.join(" "));
  const seen = new Set<string>(["folder open", "folder close", "folder edit", "folder sync on", "folder sync link", "folder sync off", "folder sync go"]);
  for (const argv of allowed) {
    assert.equal(refusal(argv), null, argv.join(" "));
    seen.add(parseInvocation(argv)!.cmd.name);
  }
  // Every folder command is in one list or the other: a new one has to be placed here on purpose.
  assert.deepEqual(COMMANDS.filter((c) => c.name.startsWith("folder ")).map((c) => c.name).filter((n) => !seen.has(n)), []);
  // Text copied in from a file on the computer still has to be a file attached to the chat.
  assert.match(refusal(["folder", "write", "Vault/a.md", "--content-file", "/etc/hostname"]) ?? "", /only read files the user attached/);
  assert.match(refusal(["folder", "new", "Vault", "x.md", "--content-file", "../secret.txt"]) ?? "", /only read files the user attached/);
});

test("folders: a name the assistant gives never leaves the open folders", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const dir = vault(t);
  const f = e.folders.open(dir, { name: "Vault" });
  // The ways out: a path on disk outside every open folder, dots, a folder that isn't open, a dot-name.
  for (const ref of ["/etc/hostname", join(dir, "..", "x"), "Vault/../x", "Vault/Journal/../../x", "Nope/x", "Vault/.obsidian/app.json", `fs:${f.id}/../x`, "~/.ssh/id_ed25519"])
    assert.throws(() => e.folders.get(e.folders.ref(ref)), /no folder|leaves the folder|start with a dot/, ref);
  assert.equal(e.folders.ref("Vault/Journal/Monday.md"), fsId(f.id, "Journal/Monday.md"));
  assert.equal(e.folders.ref(join(dir, "Welcome.md")), fsId(f.id, "Welcome.md"));
});
