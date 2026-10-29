import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude, TYPE_PREFS_MAX_BYTES } from "../src/core/engine.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { receive } from "../src/core/sync/log.ts";
import { run } from "../src/cli/run.ts";

const temp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "type-prefs-"));
const password = "a test Sync password";

test("a type's preferences: set, read, remove, reset, and gone with the type", async () => {
  const dir = temp();
  const e = await Etude.open(join(dir, "a.db"), { home: join(dir, "home") });
  try {
    assert.deepEqual(e.typePrefs("basic"), {});
    e.setTypePref("basic", "hero", "4-stern-elder");
    e.setTypePref("basic", "sound", false);
    e.setTypePref("basic", "layout", { keys: ["a", "b"], level: 3 });
    assert.deepEqual(e.typePrefs("basic"), { hero: "4-stern-elder", sound: false, layout: { keys: ["a", "b"], level: 3 } });
    assert.deepEqual(e.typePrefs("cloze"), {}, "each type keeps its own");
    e.setTypePref("basic", "sound", null);
    assert.deepEqual(Object.keys(e.typePrefs("basic")).sort(), ["hero", "layout"]);
    e.resetTypePrefs("basic");
    assert.deepEqual(e.typePrefs("basic"), {});

    assert.throws(() => e.setTypePref("basic", "bad key!", 1), /preference key/);
    assert.throws(() => e.setTypePref("basic", "", 1), /preference key/);
    assert.throws(() => e.setTypePref("basic", "big", "x".repeat(TYPE_PREFS_MAX_BYTES)), /over 4096 bytes/);
    assert.throws(() => e.setTypePref("no-such-type", "a", 1));

    e.saveType({ ...e.type("basic"), id: "mine", name: "Mine" });
    e.setTypePref("mine", "hero", "monk");
    e.deleteType("mine");
    assert.equal(e.settings().typePrefs.mine, undefined, "deleting a type drops its preferences");
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preferences sync between devices, each key on its own", async () => {
  const dir = temp();
  const es: Etude[] = [];
  try {
    for (let i = 0; i < 2; i++) es.push(await Etude.open(join(dir, `d${i}.db`), { home: join(dir, `h${i}`) }));
    const ss = es.map(syncFor);
    for (const s of ss) {
      s.setup({ folder: join(dir, "shared") });
      await s.unlock({ password });
      await s.now();
    }
    // Each device changes a different key before they meet: both changes survive.
    es[0].setTypePref("basic", "hero", "2-ribbon-sage");
    es[1].setTypePref("basic", "sound", false);
    for (let n = 0; n < 2; n++) for (const s of ss) await s.now();
    for (const e of es) assert.deepEqual(e.typePrefs("basic"), { hero: "2-ribbon-sage", sound: false });
    // A later change on one device wins on the other.
    es[1].setTypePref("basic", "hero", "5-dragon-lord");
    for (let n = 0; n < 2; n++) for (const s of ss) await s.now();
    assert.equal(es[0].typePrefs("basic").hero, "5-dragon-lord");
    // Removing a key, or resetting the type, reaches the other device and doesn't come back.
    es[0].setTypePref("basic", "sound", null);
    for (let n = 0; n < 2; n++) for (const s of ss) await s.now();
    for (const e of es) assert.deepEqual(e.typePrefs("basic"), { hero: "5-dragon-lord" });
    es[1].resetTypePrefs("basic");
    for (let n = 0; n < 2; n++) for (const s of ss) await s.now();
    for (const e of es) assert.deepEqual(e.typePrefs("basic"), {});
  } finally {
    for (const e of es) e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oversized preferences from another device are ignored", async () => {
  const dir = temp();
  const e = await Etude.open(join(dir, "a.db"), { home: join(dir, "home") });
  try {
    syncFor(e).setup({ folder: join(dir, "shared") });
    e.setTypePref("basic", "hero", "monk");
    receive(e.db, "big-1", { v: 1, table: "settings", key: "settings", stamp: [Date.now() + 60000, 0, "zz"], fields: { "/value/typePrefs/basic/junk": "x".repeat(TYPE_PREFS_MAX_BYTES) } });
    const { project } = await import("../src/core/sync/project.ts");
    project(e);
    assert.deepEqual(e.typePrefs("basic"), { hero: "monk" }, "the oversized set is refused, the old one stays");
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("etude type prefs shows, sets and resets", async () => {
  const dir = temp();
  const cli = async (args: string[]) => {
    let out = "";
    const code = await run(args, { stdout: (s) => (out += s), stderr: () => {}, stdin: () => "", isTTY: false, env: { ETUDE_HOME: dir } });
    return { code, json: out ? JSON.parse(out) : null };
  };
  try {
    assert.deepEqual((await cli(["type", "prefs", "basic"])).json, { type: "basic", prefs: {} });
    const set = await cli(["type", "prefs", "basic", "hero=4-stern-elder", "sound=false", "level=3"]);
    assert.equal(set.code, 0);
    assert.deepEqual(set.json.prefs, { hero: "4-stern-elder", sound: false, level: 3 });
    assert.deepEqual((await cli(["type", "prefs", "basic", "level="])).json.prefs, { hero: "4-stern-elder", sound: false });
    const dry = await cli(["type", "prefs", "basic", "--reset", "--dry-run"]);
    assert.equal(dry.code, 0);
    assert.deepEqual((await cli(["type", "prefs", "basic"])).json.prefs, { hero: "4-stern-elder", sound: false }, "a dry run changes nothing");
    assert.deepEqual((await cli(["type", "prefs", "basic", "--reset"])).json.prefs, {});
    assert.notEqual((await cli(["type", "prefs", "basic", "nonsense"])).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
