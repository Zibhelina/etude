import { test } from "node:test";
import assert from "node:assert/strict";
import { allReady, existsSync, filesUnder, flush, mkdirSync, mountOpfs, readdirSync, readFile, readFileSync, ready, renameSync, rmSync, statSync, takeMissed, writeFileSync } from "../src/browser/shims/vfs.ts";

// Sync skips the media pass while no media folder's time moved, and reuses a file's hash while its
// size and time hold; the browser's file system has to keep those times the way a disk does.
test("browser file system: times move like a disk's, and entries aren't symlinks", () => {
  mkdirSync("/vfs-test/media/anki", { recursive: true });
  const t = (p: string) => statSync(p).mtimeMs;
  writeFileSync("/vfs-test/media/anki/a.png", "a");
  const dir = t("/vfs-test/media/anki"), file = t("/vfs-test/media/anki/a.png");
  assert.equal(t("/vfs-test/media/anki"), dir, "stable while nothing changes");
  writeFileSync("/vfs-test/media/anki/a.png", "a, rewritten");
  assert.equal(t("/vfs-test/media/anki"), dir, "rewriting a file leaves its folder");
  assert.ok(t("/vfs-test/media/anki/a.png") > file, "but moves the file");
  writeFileSync("/vfs-test/media/anki/b.png", "b");
  const added = t("/vfs-test/media/anki");
  assert.ok(added > dir, "adding a file moves the folder");
  renameSync("/vfs-test/media/anki/b.png", "/vfs-test/media/anki/c.png");
  const renamed = t("/vfs-test/media/anki");
  assert.ok(renamed > added, "so does renaming one");
  rmSync("/vfs-test/media/anki/c.png");
  assert.ok(t("/vfs-test/media/anki") > renamed, "and removing one");
  const media = t("/vfs-test/media");
  mkdirSync("/vfs-test/media/files", { recursive: true });
  assert.ok(t("/vfs-test/media") > media, "a new folder moves its parent");
  assert.deepEqual((readdirSync("/vfs-test/media", { withFileTypes: true }) as any[]).map((d) => [d.name, d.isDirectory(), d.isSymbolicLink()]), [["anki", true, false], ["files", true, false]]);
  rmSync("/vfs-test", { recursive: true, force: true });
});

// A collection's media can be most of a gigabyte: opening lists the files on disk without reading them, and a
// file is read when it's asked for. Stands in for OPFS (folders and files) and for FileReaderSync (`read`).
test("browser file system: opening lists the files on disk without reading them; each is read when asked for", async () => {
  let reads = 0;
  const file = (text: string, mtime: number) => ({ kind: "file", text, mtime });
  const folder = (entries: Record<string, any>): any => ({
    kind: "directory",
    async *entries() { for (const [name, h] of Object.entries(entries)) yield [name, h]; },
    async getDirectoryHandle(name: string) { return entries[name] ?? folder({}); },
    async getFileHandle() { return { createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; },
    async removeEntry() {},
  });
  const root = folder({ "account.json": file("{}", 500), media: folder({ anki: folder({ "a.mp3": file("sound a", 1000), "b.mp3": file("sound b", 2000) }), "x.crswap": file("partial", 3000) }) });
  await mountOpfs("/vfs-lazy", { root: async () => root, file: async (h: any) => ({ size: new TextEncoder().encode(h.text).length, mtime: h.mtime, read: () => (reads++, new TextEncoder().encode(h.text)) }) });
  assert.equal(reads, 0, "nothing read on opening");
  assert.ok(existsSync("/vfs-lazy/media/anki/a.mp3") && !existsSync("/vfs-lazy/media/x.crswap"));
  const st = statSync("/vfs-lazy/media/anki/a.mp3");
  assert.deepEqual([st.isFile(), st.size, st.mtimeMs], [true, 7, 1000], "size and the file's own time, without reading it");
  assert.deepEqual(readdirSync("/vfs-lazy/media/anki"), ["a.mp3", "b.mp3"]);
  assert.deepEqual((readdirSync("/vfs-lazy/media", { recursive: true, withFileTypes: true }) as any[]).map((d) => [d.name, d.parentPath, d.isFile()]), [["anki", "/vfs-lazy/media", false], ["a.mp3", "/vfs-lazy/media/anki", true], ["b.mp3", "/vfs-lazy/media/anki", true]]);
  assert.equal(reads, 0);
  assert.equal(readFileSync("/vfs-lazy/media/anki/a.mp3", "utf8"), "sound a");
  assert.equal(readFileSync("/vfs-lazy/media/anki/a.mp3", "utf8"), "sound a");
  assert.equal(reads, 2, "read from disk each time, not kept in memory");
  // A file written here is in memory from then on, with a new time.
  writeFileSync("/vfs-lazy/media/anki/a.mp3", "sound a, edited");
  assert.equal(readFileSync("/vfs-lazy/media/anki/a.mp3", "utf8"), "sound a, edited");
  assert.equal(statSync("/vfs-lazy/media/anki/a.mp3").size, 15);
  assert.ok(statSync("/vfs-lazy/media/anki/a.mp3").mtimeMs > 1000);
  assert.equal(reads, 2);
  renameSync("/vfs-lazy/media/anki/b.mp3", "/vfs-lazy/media/anki/c.mp3");
  assert.ok(!existsSync("/vfs-lazy/media/anki/b.mp3"));
  assert.equal(readFileSync("/vfs-lazy/media/anki/c.mp3", "utf8"), "sound b");
  assert.deepEqual(filesUnder("/vfs-lazy").map(([p, b]) => [p, new TextDecoder().decode(b)]), [["account.json", "{}"], ["media/anki/a.mp3", "sound a, edited"], ["media/anki/c.mp3", "sound b"]]);
  rmSync("/vfs-lazy/media", { recursive: true });
  assert.ok(!existsSync("/vfs-lazy/media/anki/c.mp3") && existsSync("/vfs-lazy/account.json"));
});

// The media folder opens without waiting for each file's size and time: those come after. A read that gets
// there first throws ENOTREADY and notes the path; readying it makes the read work.
test("browser file system: a folder mounted with `later` opens before its files are ready", async () => {
  let asked = 0;
  const file = (text: string): any => ({ kind: "file", text });
  const folder = (entries: Record<string, any>): any => ({
    kind: "directory",
    async *entries() { for (const [name, h] of Object.entries(entries)) yield [name, h]; },
    async getDirectoryHandle(name: string) { return entries[name] ?? folder({}); },
    async getFileHandle() { return { createWritable: async () => ({ write: async () => {}, close: async () => {} }) }; },
    async removeEntry() {},
  });
  const root = folder({ "account.json": file("{}"), media: folder({ "a.mp3": file("sound a"), "b.mp3": file("sound b"), "c.mp3": file("sound c") }) });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await mountOpfs("/vfs-later", {
    root: async () => root,
    later: (p) => p.startsWith("/vfs-later/media/"),
    file: async (h: any) => { asked++; if (h.text !== "{}") await gate; return { size: h.text.length, mtime: 7, read: () => new TextEncoder().encode(h.text) }; },
  });
  assert.equal(readFileSync("/vfs-later/account.json", "utf8"), "{}", "other files are ready at once");
  assert.ok(existsSync("/vfs-later/media/a.mp3"));
  assert.deepEqual(readdirSync("/vfs-later/media"), ["a.mp3", "b.mp3", "c.mp3"]);
  takeMissed();
  assert.throws(() => readFileSync("/vfs-later/media/a.mp3"), (e: any) => e.code === "ENOTREADY");
  assert.throws(() => statSync("/vfs-later/media/b.mp3"), (e: any) => e.code === "ENOTREADY");
  assert.deepEqual(takeMissed().sort(), ["/vfs-later/media/a.mp3", "/vfs-later/media/b.mp3"]);
  // Written before its size came: the write wins.
  writeFileSync("/vfs-later/media/c.mp3", "new sound");
  release();
  await ready(["/vfs-later/media/a.mp3"]);
  assert.equal(readFileSync("/vfs-later/media/a.mp3", "utf8"), "sound a");
  await allReady();
  assert.equal(statSync("/vfs-later/media/b.mp3").size, 7);
  assert.equal(readFileSync("/vfs-later/media/c.mp3", "utf8"), "new sound");
  assert.equal(takeMissed().length, 0);
  rmSync("/vfs-later", { recursive: true });
});

// WebKit stops reading the snapshots getFile() gave, and forgets the handles, when its network process restarts (iOS
// does that to an app in the background). The read that finds out gets a new snapshot from a handle looked up again,
// and so does every other file; sizes and times hold meanwhile. Stands in for OPFS with a network process counter.
test("browser file system: snapshots that stopped reading are taken again", async () => {
  let net = 1, broken = false;
  const notFound = () => Object.assign(new Error("The object can not be found here."), { name: "NotFoundError" });
  const live = (made: number) => { if (made !== net) throw notFound(); };
  const tree: any = { "account.json": "{}", media: { "a.mp3": "sound a", "b.mp3": "sound b", "old.mp3": "x", "gone.mp3": "x", "bad.mp3": null } };
  const folder = (entries: any, made = net): any => ({
    kind: "directory",
    async *entries() { live(made); for (const [name, v] of Object.entries(entries)) yield [name, v && typeof v === "object" ? folder(v, made) : { kind: "file", name, entries, made }]; },
    async getDirectoryHandle(name: string, o?: { create?: boolean }) {
      live(made);
      if (!(name in entries)) { if (!o?.create) throw notFound(); entries[name] = {}; }
      return folder(entries[name], made);
    },
    async getFileHandle(name: string, o?: { create?: boolean }) {
      live(made);
      if (!(name in entries) && !o?.create) throw notFound();
      return { kind: "file", name, entries, made, createWritable: async () => ({ write: async (d: Uint8Array) => { live(made); entries[name] = new TextDecoder().decode(d); }, close: async () => {} }) };
    },
    async removeEntry(name: string) { live(made); delete entries[name]; },
  });
  const file = async (h: any) => {
    live(h.made);
    const taken = net, text = h.entries[h.name];
    return { size: text?.length ?? 0, mtime: 5, read: () => { if (taken !== net || text === null) throw notFound(); return new TextEncoder().encode(text); } };
  };
  const root = async () => { if (broken) throw new Error("disk full"); return folder(tree); };
  await mountOpfs("/vfs-net", { root, file, later: (p) => p.startsWith("/vfs-net/media/") });
  await allReady();
  assert.equal(readFileSync("/vfs-net/media/a.mp3", "utf8"), "sound a");

  net++;
  takeMissed();
  assert.throws(() => readFileSync("/vfs-net/media/a.mp3"), (e: any) => e.code === "ENOTREADY", "the read that finds out asks again");
  assert.deepEqual(takeMissed(), ["/vfs-net/media/a.mp3"]);
  assert.throws(() => readFileSync("/vfs-net/media/b.mp3"), (e: any) => e.code === "ENOTREADY", "the others wait for theirs too");
  assert.deepEqual([statSync("/vfs-net/media/b.mp3").size, statSync("/vfs-net/media/b.mp3").mtimeMs], [7, 5], "with their size and time");
  rmSync("/vfs-net/media/old.mp3");
  delete tree.media["gone.mp3"];
  await allReady();
  assert.equal(readFileSync("/vfs-net/media/a.mp3", "utf8"), "sound a");
  assert.equal(readFileSync("/vfs-net/account.json", "utf8"), "{}");
  assert.ok(!existsSync("/vfs-net/media/old.mp3"), "removed while waiting: stays removed");
  assert.ok(!existsSync("/vfs-net/media/gone.mp3"), "gone from disk: gone here");

  // readFile (the sync's media pass) waits for the new snapshot instead of failing.
  net++;
  assert.equal(await readFile("/vfs-net/media/b.mp3", "utf8"), "sound b");
  // A file whose new snapshot can't be read either throws its own error.
  await assert.rejects(readFile("/vfs-net/media/bad.mp3"), (e: any) => e.name === "NotFoundError");
  await allReady();

  // Writes reach the folder opened again, and a flush that failed doesn't stop the next one.
  net++;
  broken = true;
  writeFileSync("/vfs-net/media/c.mp3", "sound c");
  await assert.rejects(flush(), /disk full/);
  broken = false;
  await flush();
  assert.equal(tree.media["c.mp3"], "sound c");
  rmSync("/vfs-net", { recursive: true });
  await flush();
});
