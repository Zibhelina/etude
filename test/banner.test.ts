// Your banner: the synced `banner` setting, its validation, media cleanup, the CLI and how it travels through Sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Etude } from "../src/core/engine.ts";
import { BANNER_PRESETS, normalizeBanner } from "../src/core/banner.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { drain, receive, type Change } from "../src/core/sync/log.ts";
import { project } from "../src/core/sync/project.ts";

const temp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-banner-"));
const SHA = "b".repeat(64);
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

test("normalizeBanner: object forms, short forms, and what it refuses", () => {
  assert.equal(BANNER_PRESETS.length, 12);
  assert.deepEqual(BANNER_PRESETS.map((p) => p.id), ["sky", "teal", "plum", "mustard", "brick", "moss", "rose", "night", "dawn", "sea", "paper", "ink"]);
  assert.equal(normalizeBanner(null), null);
  assert.equal(normalizeBanner({}), null, "a banner Sync cleared comes back as {}");
  assert.equal(normalizeBanner("match"), null);
  assert.equal(normalizeBanner(""), null);
  assert.deepEqual(normalizeBanner("night"), { kind: "preset", id: "night" });
  assert.deepEqual(normalizeBanner("preset:Sea"), { kind: "preset", id: "sea" });
  assert.deepEqual(normalizeBanner({ kind: "preset", id: "moss", media: "stale", y: 3 }), { kind: "preset", id: "moss" }, "fields of another kind are dropped");
  assert.deepEqual(normalizeBanner({ kind: "image", media: `media:files/${SHA}.webp` }), { kind: "image", media: `files/${SHA}.webp`, y: 50 });
  assert.deepEqual(normalizeBanner(`image:files/${SHA}.jpg:30`), { kind: "image", media: `files/${SHA}.jpg`, y: 30 });
  assert.deepEqual(normalizeBanner({ kind: "image", media: `files/${SHA}.png`, y: 12.345, id: "sky" }), { kind: "image", media: `files/${SHA}.png`, y: 12.3 });
  assert.throws(() => normalizeBanner({ kind: "preset", id: "lava" }), /doesn't exist/);
  assert.throws(() => normalizeBanner("lava"), /doesn't exist/);
  assert.throws(() => normalizeBanner({ kind: "image", media: "../etc/passwd.png", y: 50 }), /media/);
  assert.throws(() => normalizeBanner({ kind: "image", media: `files/${SHA}.svg`, y: 50 }), /media/);
  assert.throws(() => normalizeBanner({ kind: "image", media: "https://example.com/a.png", y: 50 }), /media/);
  assert.throws(() => normalizeBanner({ kind: "image", media: `files/${SHA}.png`, y: 140 }), /0 \(top\) to 100/);
  assert.throws(() => normalizeBanner({ kind: "image", media: `files/${SHA}.png`, y: "up" }), /0 \(top\) to 100/);
  assert.throws(() => normalizeBanner({ kind: "video" }), /kind/);
  assert.throws(() => normalizeBanner([1]), /object/);
});

test("settings.banner: null by default, saved, validated, and an image keeps its file out of media cleanup", async () => {
  const dir = temp();
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  try {
    assert.equal(e.settings().banner, null);
    assert.deepEqual(e.updateSettings({ banner: { kind: "preset", id: "plum" } }).banner, { kind: "preset", id: "plum" });
    assert.throws(() => e.updateSettings({ banner: { kind: "preset", id: "nope" } as any }), /doesn't exist/);
    assert.throws(() => e.updateSettings({ banner: { kind: "image", media: "files/x.png", y: 50 } as any }), /media/);
    assert.deepEqual(e.settings().banner, { kind: "preset", id: "plum" }, "a refused value changes nothing");
    const m = e.storeMedia("cover.png", PNG);
    const other = e.storeMedia("other.png", Buffer.concat([PNG, Buffer.from([1])]));
    e.updateSettings({ banner: { kind: "image", media: m.file, y: 20 } });
    // Files changed in the last hour are always kept; age both so only naming decides.
    const old = new Date(Date.now() - 7200_000);
    for (const f of [m.file, other.file]) utimesSync(join(e.mediaDir, f), old, old);
    const unused = e.unusedMedia().map((f) => f.path);
    assert.ok(!unused.includes(m.file), "the banner image is named by the setting");
    assert.ok(unused.includes(other.file), "an image nothing names is still cleaned up");
    e.deleteUnusedMedia();
    assert.deepEqual(e.settings().banner, { kind: "image", media: m.file, y: 20 });
    assert.equal(e.updateSettings({ banner: null }).banner, null);
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the banner syncs: a preset, an image, match my picture, a preset again", async () => {
  const dir = temp();
  const e = await Etude.open(join(dir, "a.db"), { home: join(dir, "home") });
  const f = await Etude.open(join(dir, "b.db"), { home: join(dir, "home-b") });
  try {
    syncFor(e).setup({ folder: join(dir, "shared") });
    syncFor(f).setup({ folder: join(dir, "shared-b") });
    const carry = () => {
      drain(e.db);
      for (const r of e.db.all<{ id: string; body: string }>("SELECT id, body FROM sync_events WHERE sent=0")) {
        const ev = JSON.parse(r.body) as Change;
        if (ev.table === "settings") receive(f.db, `${r.id}`, ev);
        e.db.run("UPDATE sync_events SET sent=1 WHERE id=?", r.id);
      }
      project(f);
    };
    e.updateSettings({ banner: { kind: "preset", id: "night" } });
    carry();
    assert.deepEqual(f.settings().banner, { kind: "preset", id: "night" });
    e.updateSettings({ banner: { kind: "image", media: `files/${SHA}.webp`, y: 35 } });
    carry();
    assert.deepEqual(f.settings().banner, { kind: "image", media: `files/${SHA}.webp`, y: 35 }, "the preset's id doesn't linger");
    e.updateSettings({ banner: null });
    carry();
    assert.equal(f.settings().banner, null);
    e.updateSettings({ banner: { kind: "preset", id: "sea" } });
    carry();
    assert.deepEqual(f.settings().banner, { kind: "preset", id: "sea" });
  } finally {
    e.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: settings shows the banner; settings set banner=… and settings banner set take presets, images and match", async () => {
  const dir = temp();
  const db = join(dir, "etude.db");
  const etude = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli", "main.ts"), "--db", db, ...args], { env: { ...process.env, ETUDE_HOME: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  try {
    assert.equal(etude("settings").banner, null);
    assert.equal(etude("settings", "banner", "get").presets.length, 12);
    assert.deepEqual(etude("settings", "set", "banner=night").settings.banner, { kind: "preset", id: "night" });
    assert.deepEqual(etude("settings", "set", 'banner={"kind":"preset","id":"teal"}').settings.banner, { kind: "preset", id: "teal" });
    const pic = join(dir, "cover.png");
    writeFileSync(pic, PNG);
    const img = etude("settings", "banner", "set", `image:${pic}`, "--y", "30").to;
    assert.equal(img.kind, "image");
    assert.match(img.media, /^files\/[0-9a-f]{64}\.png$/);
    assert.equal(img.y, 30);
    assert.equal(etude("settings", "set", "banner.y=70").settings.banner.y, 70);
    assert.equal(etude("settings", "get", "banner.y").value, 70);
    assert.equal(etude("settings", "banner", "set", "match").to, null);
    assert.equal(etude("settings", "banner", "set", "sky", "--dry-run").to?.id, "sky");
    assert.equal(etude("settings").banner, null, "a dry run changes nothing");
    assert.throws(() => etude("settings", "set", "banner=lava"), /doesn't exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
