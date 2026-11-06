import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "../src/browser/shims/vfs.ts";

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
