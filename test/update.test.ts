import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUpdate, updateStatus } from "../src/core/update.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ident = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];

/** A bare "GitHub" repo, a clone of it playing the install, and a second clone that pushes. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "etude-update-"));
  const origin = join(dir, "origin.git"), app = join(dir, "app"), dev = join(dir, "dev");
  sh(dir, "init", "--quiet", "--bare", "-b", "main", origin);
  sh(dir, "clone", "--quiet", "-c", "core.autocrlf=false", origin, dev);
  writeFileSync(join(dev, "package.json"), JSON.stringify({ name: "etude-fixture", version: "2.0.0" }));
  writeFileSync(join(dev, "notes.txt"), "one\n");
  sh(dev, "add", ".");
  sh(dev, ...ident, "commit", "--quiet", "-m", "first");
  sh(dev, "push", "--quiet", "origin", "main");
  sh(dir, "clone", "--quiet", "-c", "core.autocrlf=false", origin, app);
  const push = (msg: string, text: string, file = "notes.txt") => {
    writeFileSync(join(dev, file), text);
    sh(dev, "add", file);
    sh(dev, ...ident, "commit", "--quiet", "-m", msg);
    sh(dev, "push", "--quiet", "origin", "main");
  };
  return { dir, app, dev, push, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("update: sees new commits on the upstream and fast-forwards to them", async () => {
  const f = fixture();
  try {
    let st = await updateStatus({ root: f.app, fetch: true, force: true });
    assert.equal(st.kind, "git");
    if (st.kind !== "git") return;
    assert.equal(st.behind, 0);
    assert.equal(st.upstream, "origin/main");
    assert.equal(st.blocked, undefined);

    f.push("second", "two\n");
    f.push("third", "three\n");
    st = await updateStatus({ root: f.app, fetch: true, force: true });
    assert.equal(st.kind === "git" && st.behind, 2);
    assert.deepEqual(st.kind === "git" && st.incoming.map((c) => c.subject), ["third", "second"]);

    const out = await applyUpdate({ root: f.app });
    assert.equal(out.result, "updated");
    assert.deepEqual(out.commits.map((c) => c.subject), ["third", "second"]);
    assert.equal(readFileSync(join(f.app, "notes.txt"), "utf8"), "three\n");
    assert.equal(sh(f.app, "rev-parse", "--short", "HEAD"), out.to);

    assert.equal((await applyUpdate({ root: f.app })).result, "current");
  } finally {
    f.done();
  }
});

test("update: keeps local changes, drops the ones already in the update, refuses a clash or a diverged branch", async () => {
  const f = fixture();
  try {
    f.push("other file", "a\n", "other.txt");
    sh(f.app, "pull", "--quiet");
    f.push("upstream change", "upstream\n");
    f.push("a new file", "new\n", "added.txt");
    const status = sh.bind(null, f.app, "status", "--porcelain");

    // A local change the update doesn't have stays; one it already has, and an untracked copy of a file it adds, go.
    writeFileSync(join(f.app, "other.txt"), "a\nmine\n");
    writeFileSync(join(f.app, "notes.txt"), "upstream\n");
    writeFileSync(join(f.app, "added.txt"), "new\n");
    let st = await updateStatus({ root: f.app, fetch: true, force: true });
    assert.equal(st.kind === "git" && st.blocked, undefined);
    assert.deepEqual(st.kind === "git" && st.kept, ["other.txt"]);
    assert.deepEqual(st.kind === "git" && st.dirty.sort(), ["notes.txt", "other.txt"]);
    const out = await applyUpdate({ root: f.app });
    assert.equal(out.result, "updated");
    assert.equal(readFileSync(join(f.app, "other.txt"), "utf8"), "a\nmine\n");
    assert.equal(readFileSync(join(f.app, "notes.txt"), "utf8"), "upstream\n");
    assert.equal(readFileSync(join(f.app, "added.txt"), "utf8"), "new\n");
    assert.equal(status(), "M other.txt");
    assert.equal(sh(f.app, "stash", "list"), "", "no stash left behind");

    // An untracked file the update would replace with something else: refused, nothing touched.
    f.push("another new file", "theirs\n", "later.txt");
    writeFileSync(join(f.app, "later.txt"), "mine\n");
    st = await updateStatus({ root: f.app, fetch: true, force: true });
    assert.match(String(st.kind === "git" && st.blocked), /would replace an untracked file: later\.txt/);
    await assert.rejects(applyUpdate({ root: f.app }), /later\.txt/);
    assert.equal(readFileSync(join(f.app, "later.txt"), "utf8"), "mine\n");
    rmSync(join(f.app, "later.txt"));
    await applyUpdate({ root: f.app });

    // A local change that clashes with the update: everything stays as it was.
    f.push("upstream edits other", "a\ntheirs\n", "other.txt");
    const before = sh(f.app, "rev-parse", "HEAD");
    await assert.rejects(applyUpdate({ root: f.app }), /clash with the update in other\.txt\. Nothing changed/);
    assert.equal(sh(f.app, "rev-parse", "HEAD"), before);
    assert.equal(readFileSync(join(f.app, "other.txt"), "utf8"), "a\nmine\n");
    assert.equal(status(), "M other.txt");
    assert.equal(sh(f.app, "stash", "list"), "");

    sh(f.app, ...ident, "commit", "--quiet", "-am", "mine");
    st = await updateStatus({ root: f.app, fetch: true, force: true });
    assert.match(String(st.kind === "git" && st.blocked), /can't fast-forward/);
    await assert.rejects(applyUpdate({ root: f.app }), /can't fast-forward/);
  } finally {
    f.done();
  }
});

test("update: a folder that isn't a git checkout reports itself as a package install", async () => {
  const dir = mkdtempSync(join(tmpdir(), "etude-pkg-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.0.0", repository: { url: "git+https://github.com/Zibhelina/etude.git" } }));
    const st = await updateStatus({ root: dir });
    assert.equal(st.kind, "package");
    assert.equal(st.kind === "package" && st.url, "https://github.com/Zibhelina/etude/releases/latest");
    await assert.rejects(applyUpdate({ root: dir }), /can't update itself/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
