import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { fsId } from "../src/core/folders.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { localEvent, rowFor } from "../src/core/sync/log.ts";
import type { PassReport } from "../src/core/sync/folder-files.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";

type T = { after(fn: () => void): void };
const password = "a test Sync password";
const temp = (t: T) => {
  // By its real path: on a Mac the temp folder is behind a link, and an open folder is kept by where it really is.
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-folder-sync-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** Devices of one vault, over the folder transport. `sync()` runs them in order, twice, so what a pass sends reaches the others. */
async function vault(t: T, n = 2) {
  const root = temp(t);
  const devices: Etude[] = [];
  for (let i = 0; i < n; i++) {
    const e = await Etude.open(join(root, `d${i}.db`), { home: join(root, `h${i}`) });
    t.after(() => e.close());
    syncFor(e).setup({ folder: join(root, "vault") });
    await syncFor(e).unlock({ password });
    devices.push(e);
  }
  const one = (e: Etude) => syncFor(e).now({ waitMedia: true });
  const sync = async (order: Etude[] = devices) => {
    for (let round = 0; round < 2; round++) for (const e of order) await one(e);
  };
  return { root, devices, sync, one };
}
let clock = 0;
/** Writes a file with a time of its own, so a rewrite of the same length in the same millisecond still counts as changed. */
const write = (path: string, content: string | Uint8Array) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  clock += 5000;
  utimesSync(path, new Date(), new Date(Date.now() + clock));
};
const read = (path: string) => readFileSync(path, "utf8");
const tree = (dir: string, prefix = ""): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? tree(join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`])).sort();
const last = (e: Etude): PassReport => e.folderSync.links()[0].last!;
const idle = (r: PassReport) => r.sent + r.received + r.removedHere + r.removedThere + r.renamed + r.conflicts.length === 0 && !r.paused;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254]);
/** Making a link needs a right most Windows accounts don't have. */
const LINKS = process.platform !== "win32";

function seed(dir: string) {
  write(join(dir, "Welcome.md"), "# Welcome\n");
  write(join(dir, "Journal", "Monday.md"), "Walked to the lake.\n");
  write(join(dir, "Assets", "pic.png"), PNG);
  write(join(dir, "Empty.md"), "");
  // Not carried: dot-names, the trash, code's heavy folders.
  write(join(dir, ".obsidian", "app.json"), "{}");
  write(join(dir, ".trash", "old.md"), "old\n");
  write(join(dir, "Journal", "node_modules", "x.md"), "x\n");
}

test("folder sync: a marked folder reaches another device as real files, and edits go both ways", async (t) => {
  const { root, devices: [a, b], sync, one } = await vault(t);
  const dirA = join(root, "A", "Vault"), dirB = join(root, "B", "My vault");
  seed(dirA);
  const f = a.folders.open(dirA, { name: "Vault" });

  // Looking first: what would travel.
  assert.deepEqual(a.folderSync.status(), { available: true, configured: true, here: [], elsewhere: [] });
  const est = a.folderSync.estimate("Vault");
  assert.deepEqual([est.files, est.bytes, est.tooBig], [4, 10 + 20 + PNG.length, 0]);
  const marked = a.folderSync.mark("Vault");
  assert.deepEqual([marked.name, marked.isHome, marked.id, marked.path, marked.missing], ["Vault", true, fsId(f.id), dirA, false]);
  assert.throws(() => a.folderSync.mark("Vault"), /already synced/);
  assert.throws(() => a.folderSync.mark("Vault/Journal"), /already synced: it's inside/);
  await one(a);
  assert.equal(last(a).sent, 4);
  await sync();

  // The other device sees it in the vault, and nothing of it is on its disk until it has a place there.
  const there = b.folderSync.status();
  assert.deepEqual(there.here, []);
  assert.deepEqual(there.elsewhere.map((x) => [x.syncId, x.name, x.files, x.bytes]), [[marked.syncId, "Vault", 4, 30 + PNG.length]]);
  assert.deepEqual(tree(b.mediaDir), [], "the collection's media has none of the folder's files");
  assert.throws(() => b.folderSync.link("Nope", dirB), /no synced folder "Nope"/);
  const linked = b.folderSync.link("Vault", dirB);
  assert.deepEqual([linked.syncId, linked.isHome, linked.path], [marked.syncId, false, dirB]);
  assert.equal(b.folders.list()[0].name, "Vault", "it's opened in the Notebook under the folder's name");
  assert.throws(() => b.folderSync.link("Vault", join(root, "B", "again")), /already on this computer/);
  await one(b);
  assert.equal(last(b).received, 4);
  await sync();
  assert.deepEqual(tree(dirB), ["Assets/pic.png", "Empty.md", "Journal/Monday.md", "Welcome.md"]);
  assert.equal(read(join(dirB, "Journal", "Monday.md")), "Walked to the lake.\n");
  assert.deepEqual(new Uint8Array(readFileSync(join(dirB, "Assets", "pic.png"))), PNG);
  assert.equal(read(join(dirB, "Empty.md")), "");
  assert.deepEqual(tree(b.mediaDir), []);
  // In step: nothing more to do on either side.
  await sync();
  assert.ok(idle(last(a)) && idle(last(b)), JSON.stringify([last(a), last(b)]));

  // Edited there, edited here, a new file in a new folder, a picture changed.
  write(join(dirB, "Journal", "Monday.md"), "Walked to the lake. Saw a heron.\n");
  write(join(dirA, "Welcome.md"), "# Welcome back\n");
  write(join(dirA, "Trips", "Lisbon", "Day 1.md"), "Pastéis.\n");
  write(join(dirB, "Assets", "pic.png"), new Uint8Array([1, 2, 3]));
  await sync();
  assert.equal(read(join(dirA, "Journal", "Monday.md")), "Walked to the lake. Saw a heron.\n");
  assert.equal(read(join(dirB, "Welcome.md")), "# Welcome back\n");
  assert.equal(read(join(dirB, "Trips", "Lisbon", "Day 1.md")), "Pastéis.\n");
  assert.deepEqual(new Uint8Array(readFileSync(join(dirA, "Assets", "pic.png"))), new Uint8Array([1, 2, 3]));
  assert.deepEqual(tree(dirA).filter((x) => !x.startsWith(".") && !x.includes("node_modules")), tree(dirB));
  await sync();
  assert.ok(idle(last(a)) && idle(last(b)));
  // Touched without a change is no change.
  utimesSync(join(dirA, "Welcome.md"), new Date(), new Date(Date.now() + 9e6));
  await sync();
  assert.ok(idle(last(a)) && idle(last(b)));

  // The tree says what's carried, and a folder that is can't leave the Notebook.
  assert.equal(a.folders.roots()[0].local.synced, "root");
  assert.equal(a.folders.children(fsId(f.id)).find((r) => r.local.name === "Journal")!.local.synced, "inside");
  assert.throws(() => a.folders.close(f.id), /stop syncing them on this computer first/);
});

test("folder sync: removals go to the other device's trash, names come back, and a rename is a rename", async (t) => {
  const { root, devices: [a, b], sync, one } = await vault(t);
  const dirA = join(root, "A"), dirB = join(root, "B");
  seed(dirA);
  a.folders.open(dirA, { name: "Vault" });
  // A folder inside an open one can be the one that's carried.
  const id = a.folderSync.mark("Vault/Journal").syncId;
  await sync();
  b.folderSync.link(id, dirB);
  await sync();
  assert.deepEqual(tree(dirB), ["Monday.md"]);
  assert.equal(b.folders.list()[0].name, "Journal");

  // Removed here: gone from the vault, and on the other device it's in the folder's trash, not deleted.
  unlinkSync(join(dirA, "Journal", "Monday.md"));
  await one(a);
  assert.equal(last(a).removedThere, 1);
  await one(b);
  assert.equal(last(b).removedHere, 1);
  assert.deepEqual(tree(dirB), [".trash/Monday.md"]);
  assert.equal(read(join(dirB, ".trash", "Monday.md")), "Walked to the lake.\n");
  await sync();
  assert.ok(idle(last(a)) && idle(last(b)));

  // The same name made again, on the other device, is a file again everywhere.
  write(join(dirB, "Monday.md"), "A new Monday.\n");
  await sync();
  assert.equal(read(join(dirA, "Journal", "Monday.md")), "A new Monday.\n");

  // Renamed and moved here: renamed there, without fetching it again or leaving a copy in the trash.
  mkdirSync(join(dirA, "Journal", "2026"));
  renameSync(join(dirA, "Journal", "Monday.md"), join(dirA, "Journal", "2026", "Tuesday.md"));
  await one(a);
  assert.deepEqual([last(a).sent, last(a).removedThere], [1, 1]);
  await one(b);
  assert.deepEqual([last(b).renamed, last(b).received, last(b).removedHere], [1, 0, 0]);
  await sync();
  assert.deepEqual(tree(dirB), [".trash/Monday.md", "2026/Tuesday.md"]);
  assert.equal(read(join(dirB, "2026", "Tuesday.md")), "A new Monday.\n");

  // Removed there: the same the other way, and the folder it emptied goes too.
  unlinkSync(join(dirB, "2026", "Tuesday.md"));
  await sync();
  assert.equal(existsSync(join(dirA, "Journal", "2026", "Tuesday.md")), false);
  assert.equal(read(join(dirA, ".trash", "Tuesday.md")), "A new Monday.\n", "this computer's trash is the open folder's");
  assert.equal(existsSync(join(dirA, "Journal", "2026")), false, "a folder the removal emptied doesn't stay behind");
  assert.equal(existsSync(join(dirA, "Journal")), true);
  await sync();
  assert.ok(idle(last(a)) && idle(last(b)));

  // A link in the folder isn't carried (it could point anywhere).
  if (LINKS) symlinkSync(join(dirA, "Welcome.md"), join(dirA, "Journal", "link.md"));
  write(join(dirA, "Journal", "real.md"), "real\n");
  await sync();
  assert.deepEqual(tree(dirB).filter((x) => !x.startsWith(".trash")), ["real.md"]);

  // The synced folder renamed in the Notebook is still the synced folder.
  const journal = a.folders.ref("Vault/Journal");
  assert.equal(a.folders.rename(journal, "Diary").id, a.folders.ref("Vault/Diary"));
  assert.deepEqual(a.folderSync.links().map((l) => [l.id, l.missing]), [[a.folders.ref("Vault/Diary"), false]]);
  write(join(dirA, "Diary", "after.md"), "after the rename\n");
  await sync();
  assert.equal(read(join(dirB, "after.md")), "after the rename\n");
  assert.equal(read(join(dirB, "real.md")), "real\n", "nothing was taken for removed");
});

test("folder sync: a file changed in two places keeps both, the home device's under the name", async (t) => {
  const { root, devices: [a, b, c], sync, one } = await vault(t, 3);
  const dirA = join(root, "A"), dirB = join(root, "B"), dirC = join(root, "C");
  write(join(dirA, "Note.md"), "start\n");
  write(join(dirA, "Other.md"), "start\n");
  a.folders.open(dirA, { name: "Vault" });
  const id = a.folderSync.mark("Vault").syncId;
  await sync();
  b.folderSync.link(id, dirB);
  c.folderSync.link(id, dirC);
  await sync();
  const copies = (dir: string, name: string) => readdirSync(dir).filter((n) => n.startsWith(`${name} (conflict `));

  // The other device's change reaches the vault first; the home device's still wins the name.
  write(join(dirA, "Note.md"), "from the home device\n");
  write(join(dirB, "Note.md"), "from the laptop\n");
  await one(b);
  await sync();
  for (const dir of [dirA, dirB, dirC]) {
    assert.equal(read(join(dir, "Note.md")), "from the home device\n", dir);
    assert.equal(copies(dir, "Note").length, 1, dir);
    assert.match(copies(dir, "Note")[0], /^Note \(conflict \d{4}-\d\d-\d\d \d{6}\)\.md$/);
    assert.equal(read(join(dir, copies(dir, "Note")[0])), "from the laptop\n", dir);
  }
  // The home device's change reaches the vault first: the same end.
  write(join(dirA, "Other.md"), "home again\n");
  write(join(dirB, "Other.md"), "laptop again\n");
  await one(a);
  await sync();
  for (const dir of [dirA, dirB, dirC]) {
    assert.equal(read(join(dir, "Other.md")), "home again\n", dir);
    assert.equal(read(join(dir, copies(dir, "Other")[0])), "laptop again\n", dir);
  }
  await sync();
  assert.ok([a, b, c].every((e) => idle(last(e))));
  const settled = tree(dirA);
  assert.deepEqual(tree(dirB), settled);
  assert.deepEqual(tree(dirC), settled);

  // Two devices that aren't the home: the first to reach the vault keeps the name, and nothing is lost.
  write(join(dirB, "Note.md"), "laptop\n");
  write(join(dirC, "Note.md"), "tablet\n");
  await one(c);
  await sync();
  assert.equal(read(join(dirA, "Note.md")), "tablet\n");
  assert.equal(read(join(dirB, "Note.md")), "tablet\n");
  assert.ok(copies(dirA, "Note").some((n) => read(join(dirA, n)) === "laptop\n"));
  // The same change in two places is no conflict.
  const before = tree(dirA).length;
  write(join(dirA, "Other.md"), "the same\n");
  write(join(dirB, "Other.md"), "the same\n");
  await sync();
  assert.equal(tree(dirA).length, before);
  // Removed in one place and changed in the other: the change stays.
  unlinkSync(join(dirA, "Other.md"));
  write(join(dirB, "Other.md"), "kept\n");
  await sync();
  assert.equal(read(join(dirA, "Other.md")), "kept\n");
  assert.equal(read(join(dirC, "Other.md")), "kept\n");
  // A place that already has files: one that differs from the vault's is kept as a copy, the rest just match.
  const d = await Etude.open(join(root, "d9.db"), { home: join(root, "h9") });
  t.after(() => d.close());
  syncFor(d).setup({ folder: join(root, "vault") });
  await syncFor(d).unlock({ password });
  const dirD = join(root, "D");
  write(join(dirD, "Other.md"), "kept\n");
  write(join(dirD, "Note.md"), "was already here\n");
  write(join(dirD, "Mine.md"), "only here\n");
  await syncFor(d).now({ waitMedia: true });
  d.folderSync.link(id, dirD);
  await syncFor(d).now({ waitMedia: true });
  await sync();
  assert.equal(read(join(dirD, "Note.md")), "tablet\n");
  assert.ok(copies(dirD, "Note").some((n) => read(join(dirD, n)) === "was already here\n"));
  assert.equal(read(join(dirA, "Mine.md")), "only here\n");
});

test("folder sync: a lot removed at once, or a folder that isn't there, changes nothing elsewhere until you say so", async (t) => {
  const { root, devices: [a, b], sync, one } = await vault(t);
  const dirA = join(root, "A"), dirB = join(root, "B");
  for (let i = 0; i < 30; i++) write(join(dirA, "Days", `day ${i}.md`), `day ${i}\n`);
  a.folders.open(dirA, { name: "Vault" });
  const id = a.folderSync.mark("Vault").syncId;
  await sync();
  b.folderSync.link(id, dirB);
  await sync();
  assert.equal(tree(dirB).length, 30);

  // The folder is gone from where it was (a drive not plugged in): the other device keeps everything.
  renameSync(dirA, dirA + " away");
  await sync();
  assert.match(last(a).skipped.join("\n"), /isn't on disk right now/);
  assert.equal(a.folderSync.links()[0].missing, true);
  assert.equal(tree(dirB).length, 30);
  renameSync(dirA + " away", dirA);
  await sync();
  assert.ok(idle(last(a)) && idle(last(b)));

  // Most of it removed at once: held here, with the reason, until a go-ahead.
  for (let i = 0; i < 25; i++) unlinkSync(join(dirA, "Days", `day ${i}.md`));
  write(join(dirA, "Days", "new.md"), "still travels\n");
  await one(a);
  assert.match(a.folderSync.links()[0].paused ?? "", /25 of the 30 files synced here are gone from this folder/);
  assert.deepEqual([last(a).removedThere, last(a).sent], [0, 1]);
  await sync();
  assert.equal(tree(dirB).filter((x) => !x.startsWith(".trash")).length, 31, "the new file went; nothing was removed");
  await sync();
  assert.match(a.folderSync.links()[0].paused ?? "", /25 of the 31/, "it stays held");
  a.folderSync.goAhead(id);
  await one(a);
  assert.equal(last(a).removedThere, 25);
  await sync();
  assert.equal(a.folderSync.links()[0].paused, null);
  assert.equal(tree(dirB).filter((x) => !x.startsWith(".trash")).length, 6);
  assert.equal(tree(dirB).filter((x) => x.startsWith(".trash")).length, 25, "on the other device they're in the trash");
  // A few removed is just a removal.
  unlinkSync(join(dirA, "Days", "day 25.md"));
  await sync();
  assert.equal(a.folderSync.links()[0].paused, null);
  assert.equal(existsSync(join(dirB, "Days", "day 25.md")), false);
});

test("folder sync: a name from another device never lands outside the folder", async (t) => {
  const { root, devices: [a, b], sync } = await vault(t);
  const dirA = join(root, "A"), dirB = join(root, "B"), outside = join(root, "outside");
  write(join(dirA, "Note.md"), "hello\n");
  a.folders.open(dirA, { name: "Vault" });
  const id = a.folderSync.mark("Vault").syncId;
  await sync();
  b.folderSync.link(id, dirB);
  mkdirSync(outside);
  if (LINKS) symlinkSync(outside, join(dirB, "way out"));
  await sync();
  const hash = rowFor(a.db, "media", `//${id}/Note.md`)!.hash as string;
  // What a broken or hostile device could put in the vault: paths that climb out, dot-names, a path through a link.
  for (const rel of ["../evil.md", "sub/../../evil.md", "/etc/evil.md", ".git/hooks/pre-commit", ".obsidian/x.json", "a\\b.md", ...(LINKS ? ["way out/evil.md"] : []), "node_modules/x.js", "ok/./evil.md", ""])
    localEvent(a.db, "media", `//${id}/${rel}`, { "/hash": hash, "/size": 6 });
  localEvent(a.db, "media", `//${id}/Fine/ok.md`, { "/hash": hash, "/size": 6 });
  await sync();
  assert.equal(read(join(dirB, "Fine", "ok.md")), "hello\n", "an ordinary path from the same batch is written");
  assert.deepEqual(tree(dirB), ["Fine/ok.md", "Note.md", ...(LINKS ? ["way out"] : [])]);
  assert.deepEqual(readdirSync(outside), []);
  assert.deepEqual(readdirSync(join(root)).filter((n) => n.includes("evil")), []);
  assert.equal(existsSync(join(dirB, ".git")), false);
  assert.match(last(b).skipped.join("\n"), /can't be files in this folder|way out\/evil\.md/);
  // A hash that isn't one, or bytes that don't match their hash, are never written.
  localEvent(a.db, "media", `//${id}/Bad.md`, { "/hash": "../../x", "/size": 1 });
  await sync();
  assert.equal(existsSync(join(dirB, "Bad.md")), false);
});

test("folder sync: versions no file is any more leave the vault, and nothing a file still needs does", async (t) => {
  const { root, devices: [a, b, c], sync } = await vault(t, 3);
  const dirA = join(root, "A"), dirB = join(root, "B"), dirC = join(root, "C");
  const blobs = () => (existsSync(join(root, "vault", "blobs")) ? readdirSync(join(root, "vault", "blobs")) : []);
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  /** The blob a device thinks holds these bytes of a synced file: its name, null once cleared, undefined when never there. */
  const nameOf = (e: Etude, text: string) => rowFor(e.db, "blob", `f:${sha(text)}`)?.name as string | null | undefined;
  write(join(dirA, "X.md"), "version one\n");
  write(join(dirA, "Twin 1.md"), "the same bytes\n");
  write(join(dirA, "Twin 2.md"), "the same bytes\n");
  // A media file of the collection with the very bytes of a synced file: its blob is its own.
  mkdirSync(join(a.mediaDir, "anki"), { recursive: true });
  writeFileSync(join(a.mediaDir, "anki", "clip.txt"), "version one\n");
  a.folders.open(dirA, { name: "Vault" });
  const id = a.folderSync.mark("Vault").syncId;
  await sync();
  b.folderSync.link(id, dirB);
  await sync();
  assert.equal(blobs().length, 3, "one blob for each different bytes: X, the twins, the media file");
  const v1 = nameOf(a, "version one\n")!;
  assert.ok(blobs().includes(v1));

  // Changed: the old version's blob goes once the new one is in, and the other device has the new one.
  write(join(dirA, "X.md"), "version two\n");
  await sync();
  assert.equal(read(join(dirB, "X.md")), "version two\n");
  assert.equal(blobs().includes(v1), false, "the old version left the vault");
  assert.equal(blobs().length, 3);
  assert.deepEqual([nameOf(a, "version one\n"), nameOf(b, "version one\n")], [null, null], "and every device knows it did");
  // The media file with those bytes is untouched: it reached the other device, and still does for one that comes later.
  assert.equal(read(join(b.mediaDir, "anki", "clip.txt")), "version one\n");

  // Renamed: the same bytes under another name keep their blob.
  renameSync(join(dirA, "X.md"), join(dirA, "Y.md"));
  await sync();
  assert.equal(read(join(dirB, "Y.md")), "version two\n");
  assert.equal(blobs().length, 3);
  // One of two files with the same bytes removed: the other still needs them. Both removed: they go.
  const twin = nameOf(a, "the same bytes\n")!;
  unlinkSync(join(dirA, "Twin 1.md"));
  await sync();
  assert.equal(blobs().includes(twin), true);
  unlinkSync(join(dirA, "Twin 2.md"));
  await sync();
  assert.equal(blobs().includes(twin), false);
  assert.equal(blobs().length, 2);
  // Removed on a device that isn't the folder's home: it clears what it removed.
  unlinkSync(join(dirB, "Y.md"));
  await sync([b, a, c]);
  assert.equal(existsSync(join(dirA, "Y.md")), false);
  assert.equal(blobs().length, 1, "only the media file's blob is left");

  // Bytes cleared from the vault while a device holds a file that is them (it made the file before it heard):
  // a device that has the file sends them again, and one that takes the folder later gets the file.
  write(join(dirA, "Keep.md"), "kept bytes\n");
  await sync();
  const kept = nameOf(a, "kept bytes\n")!;
  rmSync(join(root, "vault", "blobs", kept));
  localEvent(a.db, "blob", `f:${sha("kept bytes\n")}`, { "/name": null });
  await sync();
  const again = nameOf(b, "kept bytes\n");
  assert.ok(again && blobs().includes(again), "the bytes are back in the vault");
  c.folderSync.link(id, dirC);
  await sync();
  assert.equal(read(join(dirC, "Keep.md")), "kept bytes\n");
  assert.equal(read(join(c.mediaDir, "anki", "clip.txt")), "version one\n");

  // A folder whose sync is ended for everyone takes its files' bytes out of the vault. The files stay on every device.
  a.folderSync.unlink(id, { everywhere: true });
  await sync();
  assert.equal(blobs().length, 1, "only the media file's blob is left");
  assert.equal(read(join(dirB, "Keep.md")), "kept bytes\n");
  assert.equal(read(join(dirC, "Keep.md")), "kept bytes\n");
  assert.deepEqual([a, b, c].map((e) => e.folderSync.hasGarbage()), [false, false, false]);
});

test("folder sync: stopping on one computer keeps the files; ending it for everyone takes it out of the vault", async (t) => {
  const { root, devices: [a, b], sync } = await vault(t);
  const dirA = join(root, "A"), dirB = join(root, "B");
  write(join(dirA, "Note.md"), "hello\n");
  const f = a.folders.open(dirA, { name: "Vault" });
  const id = a.folderSync.mark("Vault").syncId;
  await sync();
  b.folderSync.link(id, dirB);
  await sync();

  // Stopped on the other computer: its files stay, the vault still has the folder, and it can take a place again.
  assert.deepEqual(b.folderSync.unlink("Vault"), { syncId: id, name: "Vault", everywhere: false, path: dirB });
  write(join(dirA, "Note.md"), "changed after\n");
  write(join(dirB, "Note.md"), "edited while apart\n");
  await sync();
  assert.equal(read(join(dirB, "Note.md")), "edited while apart\n");
  assert.equal(b.folderSync.status().elsewhere.length, 1);
  b.folderSync.link(id, dirB);
  await sync();
  assert.equal(read(join(dirB, "Note.md")), "changed after\n");
  assert.equal(readdirSync(dirB).filter((n) => n.startsWith("Note (conflict ")).length, 1);

  // Ended for everyone, from the home device: every device keeps its files and carries them no more.
  assert.equal(a.folderSync.unlink(id, { everywhere: true }).everywhere, true);
  await sync();
  assert.deepEqual(a.folderSync.status().here, []);
  assert.deepEqual(b.folderSync.status(), { available: true, configured: true, here: [], elsewhere: [] });
  assert.equal(read(join(dirA, "Note.md")), "changed after\n");
  assert.equal(read(join(dirB, "Note.md")), "changed after\n");
  write(join(dirA, "Note.md"), "on its own now\n");
  await sync();
  assert.equal(read(join(dirB, "Note.md")), "changed after\n");
  a.folders.close(f.id);

  // Without Sync set up there's nothing to carry a folder.
  const alone = await Etude.open(":memory:");
  t.after(() => alone.close());
  alone.folders.open(dirA, { name: "Vault" });
  assert.throws(() => alone.folderSync.mark("Vault"), /set up Sync first/);
  assert.deepEqual(alone.folderSync.status(), { available: true, configured: false, here: [], elsewhere: [] });
  assert.equal(statSync(join(dirA, "Note.md")).isFile(), true);
});

test("folder sync: the CLI and the routes do what the Notebook's menus do", async (t) => {
  const { root, devices: [a, b], sync } = await vault(t);
  const dirA = join(root, "A"), dirB = join(root, "B");
  for (let i = 0; i < 24; i++) write(join(dirA, `n${i}.md`), `note ${i}\n`);
  const cli = async (e: Etude, ...argv: string[]) => {
    const out: string[] = [];
    const code = await run(argv, { stdout: (x) => out.push(x), stderr: (x) => out.push(x), stdin: () => "", isTTY: false, env: process.env }, { etude: e });
    return { code, text: out.join("") };
  };
  const json = async (e: Etude, ...argv: string[]) => JSON.parse((await cli(e, ...argv)).text);
  await cli(a, "folder", "open", dirA, "--name", "Notes");

  assert.deepEqual(await json(a, "folder", "sync", "list"), { configured: true, here: [], elsewhere: [] });
  const dry = await json(a, "folder", "sync", "on", "Notes", "--dry-run");
  assert.deepEqual([dry.dryRun, dry.files, dry.tooBig], [true, 24, 0]);
  assert.deepEqual((await json(a, "folder", "sync", "list")).here, []);
  const on = await json(a, "folder", "sync", "on", "Notes", "--name", "My notes");
  assert.deepEqual([on.name, on.isHome, on.path], ["My notes", true, dirA]);
  await sync();
  const seen = await json(b, "folder", "sync", "list");
  assert.deepEqual(seen.elsewhere.map((x: any) => [x.syncId, x.name, x.files]), [[on.syncId, "My notes", 24]]);
  const linked = await json(b, "folder", "sync", "link", "My notes", dirB);
  assert.deepEqual([linked.syncId, linked.isHome, linked.path], [on.syncId, false, dirB]);
  await sync();
  assert.equal(tree(dirB).length, 24);
  assert.notEqual((await cli(b, "folder", "sync", "link", "My notes", dirB)).code, 0);

  // The routes: the list, a look before marking, and what the tree needs with every poll.
  const app = createApp(a);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await Promise.resolve(app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as any };
  };
  const st = await call("GET", "/api/folders/sync");
  assert.deepEqual([st.body.configured, st.body.here.length, st.body.here[0].name, st.body.here[0].files], [true, 1, "My notes", 24]);
  mkdirSync(join(dirA, "Sub"));
  assert.equal((await call("POST", "/api/folders/sync", { id: "Notes/Sub", estimate: true })).body.files, 0);
  assert.equal((await call("POST", "/api/folders/sync", { id: "Notes/Sub" })).status, 409);
  let stamps = await call("POST", "/api/folders/stamps", { dirs: [] });
  assert.deepEqual([stamps.body.synced, stamps.body.held], [on.id, []]);
  assert.deepEqual((await call("POST", "/api/folders/entries", { dirs: [] })).body.stamps, stamps.body, "the listing and the poll say the same");

  // Held removals show there, and the go-ahead lets them through.
  for (let i = 0; i < 22; i++) unlinkSync(join(dirA, `n${i}.md`));
  await sync();
  stamps = await call("POST", "/api/folders/stamps", { dirs: [] });
  assert.deepEqual(stamps.body.held.map((h: any) => [h.syncId, h.name]), [[on.syncId, "My notes"]]);
  assert.match(stamps.body.held[0].why, /22 of the 24 files/);
  assert.equal(tree(dirB).length, 24);
  assert.equal((await call("POST", "/api/folders/sync/go", { syncId: on.syncId })).status, 200);
  await sync();
  assert.equal(tree(dirB).filter((x) => !x.startsWith(".trash")).length, 2);
  assert.deepEqual((await call("POST", "/api/folders/stamps", { dirs: [] })).body.held, []);

  // Stopping here, then ending it everywhere.
  assert.deepEqual(await json(b, "folder", "sync", "off", "My notes"), { syncId: on.syncId, name: "My notes", everywhere: false, path: dirB });
  assert.equal((await call("POST", "/api/folders/sync/off", { syncId: on.syncId, everywhere: true })).body.everywhere, true);
  await sync();
  assert.deepEqual(await json(b, "folder", "sync", "list"), { configured: true, here: [], elsewhere: [] });
  assert.equal((await call("POST", "/api/folders/stamps", { dirs: [] })).body.synced, "");
});
