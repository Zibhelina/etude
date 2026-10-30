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
  const push = (msg: string, text: string) => {
    writeFileSync(join(dev, "notes.txt"), text);
    sh(dev, ...ident, "commit", "--quiet", "-am", msg);
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

test("update: refuses to touch local changes or a diverged branch", async () => {
  const f = fixture();
  try {
    f.push("upstream change", "upstream\n");
    writeFileSync(join(f.app, "notes.txt"), "my edit\n");
    let st = await updateStatus({ root: f.app, fetch: true, force: true });
    assert.match(String(st.kind === "git" && st.blocked), /local changes/);
    assert.deepEqual(st.kind === "git" && st.dirty, ["notes.txt"]);
    await assert.rejects(applyUpdate({ root: f.app }), /local changes/);
    assert.equal(readFileSync(join(f.app, "notes.txt"), "utf8"), "my edit\n");

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
