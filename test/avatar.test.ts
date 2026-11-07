// Your picture: the synced `avatar` setting, its validation, the CLI short forms and how it travels through Sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Etude } from "../src/core/engine.ts";
import { AVATAR_CHARACTERS, normalizeAvatar } from "../src/core/avatar.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { drain, receive, type Change } from "../src/core/sync/log.ts";
import { project } from "../src/core/sync/project.ts";

const temp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-avatar-"));
const SHA = "a".repeat(64);

test("normalizeAvatar: object forms, short forms, and what it refuses", () => {
  assert.equal(AVATAR_CHARACTERS.length, 18);
  assert.equal(normalizeAvatar(null), null);
  assert.equal(normalizeAvatar("initial"), null);
  assert.deepEqual(normalizeAvatar({ kind: "char", id: "Fox" }), { kind: "char", id: "fox" });
  assert.deepEqual(normalizeAvatar("char:owl"), { kind: "char", id: "owl" });
  assert.deepEqual(normalizeAvatar("wizard"), { kind: "char", id: "wizard" });
  assert.deepEqual(normalizeAvatar({ kind: "emoji", e: "🦊", bg: "#24726E", extra: 1 }), { kind: "emoji", e: "🦊", bg: "#24726e" });
  assert.deepEqual(normalizeAvatar("emoji:🇧🇷:#3f6b3a"), { kind: "emoji", e: "🇧🇷", bg: "#3f6b3a" });
  assert.deepEqual(normalizeAvatar("emoji:🧑🏽‍🎓"), { kind: "emoji", e: "🧑🏽‍🎓", bg: "#3d5fb8" });
  assert.deepEqual(normalizeAvatar({ kind: "photo", media: `media:files/${SHA}.webp` }), { kind: "photo", media: `files/${SHA}.webp` });
  assert.throws(() => normalizeAvatar({ kind: "char", id: "dragon" }), /doesn't exist/);
  assert.throws(() => normalizeAvatar({ kind: "emoji", e: "hi", bg: "#000000" }), /one emoji/);
  assert.throws(() => normalizeAvatar({ kind: "emoji", e: "🦊", bg: "red" }), /#rrggbb/);
  assert.throws(() => normalizeAvatar({ kind: "photo", media: "../etc/passwd.png" }), /media/);
  assert.throws(() => normalizeAvatar({ kind: "photo", media: `files/${SHA}.svg` }), /media/);
  assert.throws(() => normalizeAvatar({ kind: "video" }), /kind/);
  assert.throws(() => normalizeAvatar([1]), /object/);
});

test("settings.avatar: absent by default, saved, validated, and the photo keeps its file out of media cleanup", async () => {
  const dir = temp();
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  try {
    assert.equal(e.settings().avatar, null);
    assert.deepEqual(e.updateSettings({ avatar: { kind: "char", id: "bear" } }).avatar, { kind: "char", id: "bear" });
    assert.deepEqual(e.settings().avatar, { kind: "char", id: "bear" });
    assert.throws(() => e.updateSettings({ avatar: { kind: "char", id: "nope" } as any }), /doesn't exist/);
    assert.deepEqual(e.settings().avatar, { kind: "char", id: "bear" }, "a refused value changes nothing");
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    const m = e.storeMedia("me.png", png);
    e.updateSettings({ avatar: { kind: "photo", media: m.file } });
    assert.ok(!e.unusedMedia().some((f) => f.path === m.file), "the photo is named by the setting");
    assert.equal(e.updateSettings({ avatar: null }).avatar, null);
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the avatar syncs: a character, an emoji, the initial, a character again", async () => {
  const dir = temp();
  const e = await Etude.open(join(dir, "a.db"), { home: join(dir, "home") });
  const f = await Etude.open(join(dir, "b.db"), { home: join(dir, "home-b") });
  try {
    syncFor(e).setup({ folder: join(dir, "shared") });
    syncFor(f).setup({ folder: join(dir, "shared-b") });
    let n = 0;
    // Copies e's new settings events to f, the way a transport would.
    const carry = () => {
      drain(e.db);
      for (const r of e.db.all<{ id: string; body: string }>("SELECT id, body FROM sync_events WHERE sent=0")) {
        const ev = JSON.parse(r.body) as Change;
        if (ev.table === "settings") receive(f.db, `${r.id}`, ev);
        e.db.run("UPDATE sync_events SET sent=1 WHERE id=?", r.id);
        n++;
      }
      project(f);
    };
    e.updateSettings({ avatar: { kind: "char", id: "fox" } });
    carry();
    assert.deepEqual(f.settings().avatar, { kind: "char", id: "fox" });
    e.updateSettings({ avatar: { kind: "emoji", e: "🦉", bg: "#24304f" } });
    carry();
    assert.deepEqual(f.settings().avatar, { kind: "emoji", e: "🦉", bg: "#24304f" }, "the character's id doesn't linger");
    e.updateSettings({ avatar: null });
    carry();
    assert.equal(f.settings().avatar, null);
    e.updateSettings({ avatar: { kind: "char", id: "omar" } });
    carry();
    assert.deepEqual(f.settings().avatar, { kind: "char", id: "omar" }, "and back to a character after the initial");
    assert.ok(n >= 4);
  } finally {
    e.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: settings avatar get lists the characters; set takes a character, an emoji with --bg, a photo file and initial", async () => {
  const dir = temp();
  const db = join(dir, "etude.db");
  
  const etude = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli", "main.ts"), "--db", db, ...args], { env: { ...process.env, ETUDE_HOME: dir }, encoding: "utf8" }));
  const got = etude("settings", "avatar", "get");
  assert.equal(got.avatar, null);
  assert.equal(got.characters.length, 18);
  assert.deepEqual(etude("settings", "avatar", "set", "fox").to, { kind: "char", id: "fox" });
  assert.deepEqual(etude("settings", "avatar", "set", "emoji:🐸", "--bg", "#3F6B3A").to, { kind: "emoji", e: "🐸", bg: "#3f6b3a" });
  const pic = join(dir, "me.png");
  writeFileSync(pic, Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex"));
  const photo = etude("settings", "avatar", "set", `photo:${pic}`).to;
  assert.equal(photo.kind, "photo");
  assert.match(photo.media, /^files\/[0-9a-f]{64}\.png$/);
  assert.deepEqual(etude("settings", "avatar", "set", "initial").to, null);
  assert.deepEqual(etude("settings", "set", 'avatar={"kind":"char","id":"owl"}').settings.avatar, { kind: "char", id: "owl" });
  assert.equal(etude("settings", "get", "avatar.id").value, "owl");
  rmSync(dir, { recursive: true, force: true });
});
