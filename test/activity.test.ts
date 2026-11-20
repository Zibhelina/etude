import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";
import { activityFor } from "../src/core/activity.ts";
import { agentRefusal } from "../src/core/agent-guard.ts";
import { COMMANDS } from "../src/cli/registry.ts";
import "../src/cli/commands/index.ts";
import { syncFor } from "../src/core/sync/client.ts";

const home = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-activity-"));
const HOUR = 3_600_000;
const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR;

test("activity: off by default, and nothing is recorded until it's turned on", async () => {
  const dir = home();
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  try {
    const a = activityFor(e);
    assert.deepEqual(a.prefs(), { on: false, keepDays: 365 });
    const entry = { kind: "page", ref: "abc", hour: hourOf(Date.now()), ms: 60_000, typed: 40, pasted: 0, deleted: 2, words: 8 };
    assert.deepEqual(a.record({ entries: [entry] }), { on: false, recorded: 0 });
    assert.equal(a.status().rows, 0);
    a.setPrefs({ on: true });
    assert.equal(a.record({ entries: [entry, entry] }).recorded, 2);
    const s = a.status();
    assert.equal(s.on, true);
    assert.equal(s.rows, 1, "the same hour, kind and note add up in one row");
    const row = e.db.get("SELECT * FROM activity_log")!;
    assert.equal(row.ms, 120_000);
    assert.equal(row.typed, 80);
    assert.equal(row.words, 16);
    // Turning it off stops recording at once; the rows stay unless asked.
    a.setPrefs({ on: false });
    assert.equal(a.record({ entries: [entry] }).recorded, 0);
    assert.equal(a.status().rows, 1);
    a.setPrefs({ on: false, deleteAll: true });
    assert.equal(a.status().rows, 0);
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activity: refuses entries that aren't counts for a known kind, ref and recent hour", async () => {
  const dir = home();
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  try {
    const a = activityFor(e);
    a.setPrefs({ on: true });
    const now = Date.now();
    const ok = { kind: "page", ref: "abc", hour: hourOf(now), ms: 1000, typed: 1, pasted: 0, deleted: 0, words: 1 };
    const bad: [string, unknown][] = [
      ["kind", { ...ok, kind: "keystrokes" }],
      ["screen", { ...ok, kind: "screen", ref: "evil" }],
      ["ref with text", { ...ok, ref: "hello world, this is what I typed" }],
      ["hour not on the hour", { ...ok, hour: hourOf(now) + 5 }],
      ["old hour", { ...ok, hour: hourOf(now - 10 * 86_400_000) }],
      ["future hour", { ...ok, hour: hourOf(now + 5 * HOUR) }],
      ["negative", { ...ok, typed: -4 }],
      ["not a number", { ...ok, ms: "lots" }],
    ];
    for (const [why, entry] of bad) assert.throws(() => a.record({ entries: [entry] }), /./, why);
    assert.throws(() => a.record({ entries: Array.from({ length: 201 }, () => ok) }), /at most 200/);
    assert.throws(() => a.record({ entries: "x" }), /list/);
    // Extra fields (say, text) are dropped, never stored: only the counted columns exist.
    a.record({ entries: [{ ...ok, text: "secret words", title: "My diary" }] });
    assert.equal(JSON.stringify(e.db.all("SELECT * FROM activity_log")).includes("secret"), false);
    // A file on disk and a screen are fine refs; an hour's time can't pass an hour.
    a.record({ entries: [{ ...ok, kind: "file", ref: "fs:abc/notes/x.md", ms: 50 * 60_000 }, { ...ok, kind: "file", ref: "fs:abc/notes/x.md", ms: 50 * 60_000 }, { ...ok, kind: "screen", ref: "study" }] });
    assert.equal(e.db.get("SELECT ms FROM activity_log WHERE kind='file'")!.ms, HOUR);
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activity: the summary adds up days, kinds, hours and the pages you spent most time in, with titles", async () => {
  const dir = home();
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  try {
    const a = activityFor(e);
    a.setPrefs({ on: true });
    const page = e.notes.create({ title: "Dijkstra notes" });
    const gone = e.notes.create({ title: "Scratch" });
    const now = Date.now();
    const h = hourOf(now);
    a.record({
      entries: [
        { kind: "page", ref: page.id, hour: h, ms: 20 * 60_000, typed: 900, pasted: 10, deleted: 30, words: 150 },
        { kind: "page", ref: gone.id, hour: h, ms: 5 * 60_000, typed: 50, pasted: 0, deleted: 0, words: 9 },
        { kind: "pdf", ref: "fs:folder/slides/w9.pdf", hour: h, ms: 30 * 60_000, typed: 0, pasted: 0, deleted: 0, words: 0 },
        { kind: "screen", ref: "study", hour: h, ms: 10 * 60_000, typed: 0, pasted: 0, deleted: 0, words: 0 },
      ],
    });
    e.notes.delete(gone.id);
    const s = a.summary(7);
    assert.equal(s.days.length, 7);
    assert.equal(s.days.at(-1)!.day, s.today);
    assert.equal(s.totals.ms, 65 * 60_000);
    assert.equal(s.totals.words, 159);
    assert.deepEqual(s.top.map((t) => [t.kind, t.title, !!t.missing]), [
      ["pdf", "w9.pdf", true],
      ["page", "Dijkstra notes", false],
      ["page", "Deleted page", true],
    ]);
    assert.deepEqual(s.screens, [{ screen: "study", ms: 10 * 60_000 }]);
    assert.equal(s.hours.reduce((x, y) => x + y.ms, 0), 65 * 60_000);
    assert.equal(s.kinds[0].kind, "pdf");
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activity: hours older than what's kept are dropped", async () => {
  const dir = home();
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  try {
    const a = activityFor(e);
    a.setPrefs({ on: true, keepDays: 30 });
    a.record({ entries: [{ kind: "page", ref: "p", hour: hourOf(Date.now()), ms: 1000, typed: 0, pasted: 0, deleted: 0, words: 0 }] });
    e.db.run("INSERT INTO activity_log (hour, kind, ref, ms) VALUES (?, 'page', 'old', 5000)", hourOf(Date.now() - 40 * 86_400_000));
    assert.equal(a.status().rows, 1);
    assert.throws(() => a.setPrefs({ keepDays: 12 }), /keepDays/);
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activity: the routes record only while it's on, and the CLI matches", async () => {
  const dir = home();
  const db = join(dir, "etude.db");
  const e = await Etude.open(db, { home: dir });
  const app = createApp(e);
  const req = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const entry = { kind: "page", ref: "abc", hour: hourOf(Date.now()), ms: 1000, typed: 3, pasted: 0, deleted: 0, words: 1 };
    assert.deepEqual(await (await req("POST", "/api/activity", { entries: [entry] })).json(), { on: false, recorded: 0 });
    assert.equal((await (await req("PATCH", "/api/activity", { on: true })).json()).on, true);
    assert.equal((await (await req("POST", "/api/activity", { entries: [entry] })).json()).recorded, 1);
    assert.equal((await req("POST", "/api/activity", { entries: [{ ...entry, kind: "x" }] })).status, 400);
    const sum = await (await req("GET", "/api/activity/summary?days=7")).json();
    assert.equal(sum.totals.typed, 3);
    // Another site can't write it: the server refuses cross-origin mutations.
    const cross = await app.request("/api/activity", { method: "PATCH", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ on: true }) });
    assert.equal(cross.status, 403);
    assert.equal((await (await req("DELETE", "/api/activity")).json()).deleted, 1);
  } finally {
    e.close();
  }
  const cli = async (...argv: string[]) => {
    let out = "", err = "";
    const code = await run(["--db", db, ...argv, "--json"], { stdout: (x) => (out += x), stderr: (x) => (err += x), stdin: () => "", isTTY: false, env: { ETUDE_HOME: dir } });
    return { code, json: out.trim() ? JSON.parse(out) : null, err };
  };
  try {
    assert.equal((await cli("activity")).json.on, true);
    assert.equal((await cli("activity", "keep", "forever")).json.keepDays, 0);
    assert.equal((await cli("activity", "keep", "12")).code, 4);
    assert.equal((await cli("activity", "clear")).code, 2, "clear needs --yes");
    assert.equal((await cli("activity", "clear", "--yes")).json.deleted, 0);
    assert.equal((await cli("activity", "off")).json.on, false);
    assert.equal((await cli("activity", "show", "--days", "3")).json.days.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activity: Ask and etude mcp can read it but can't turn it on, keep, or delete it", () => {
  const find = (name: string) => COMMANDS.find((c) => c.name === name)!;
  for (const name of ["activity on", "activity off", "activity keep", "activity clear"]) {
    const why = agentRefusal({ cmd: find(name), values: {}, named: {}, attachmentDir: "/tmp/x" } as any);
    assert.match(String(why), /Activity/, name);
  }
  for (const name of ["activity status", "activity show"]) assert.equal(agentRefusal({ cmd: find(name), values: {}, named: {}, attachmentDir: "/tmp/x" } as any), null, name);
  // Every command in the group that writes is the user's alone, so one added later can't slip past the guard.
  const group = COMMANDS.filter((c) => c.name.startsWith("activity "));
  assert.ok(group.length >= 6);
  for (const c of group) {
    const why = agentRefusal({ cmd: c, values: {}, named: {}, attachmentDir: "/tmp/x" } as any);
    if (c.writes) assert.match(String(why), /Activity/, `${c.name} writes, so Ask must be refused`);
    else assert.equal(why, null, `${c.name} only reads`);
  }
});

test("activity: Sync never carries it, nor the setting, to another device", async () => {
  const dir = home();
  const a = await Etude.open(join(dir, "a.db"), { home: join(dir, "ha") });
  const b = await Etude.open(join(dir, "b.db"), { home: join(dir, "hb") });
  const sa = syncFor(a), sb = syncFor(b);
  const password = "local-password-test";
  try {
    const page = a.notes.create({ title: "Shared page" });
    activityFor(a).setPrefs({ on: true, keepDays: 90 });
    activityFor(a).record({ entries: [{ kind: "page", ref: page.id, hour: hourOf(Date.now()), ms: 600_000, typed: 4321, pasted: 0, deleted: 0, words: 777 }] });
    sa.setup({ folder: join(dir, "shared") });
    const key = (await sa.unlock({ password })).recoveryKey!;
    await sa.now({ waitMedia: true });
    sb.setup({ folder: join(dir, "shared") });
    await sb.unlock({ recovery: key });
    await sb.now({ waitMedia: true });
    activityFor(a).record({ entries: [{ kind: "page", ref: page.id, hour: hourOf(Date.now()), ms: 1000, typed: 1, pasted: 0, deleted: 0, words: 1 }] });
    await sa.now({ waitMedia: true });
    await sb.now({ waitMedia: true });
    assert.equal(b.notes.get(page.id).title, "Shared page", "Sync itself worked");
    assert.deepEqual(activityFor(b).prefs(), { on: false, keepDays: 365 });
    assert.equal(activityFor(b).status().rows, 0);
    // Nothing in what A sent mentions it: the outbox and every file in the shared folder.
    assert.equal(a.db.get("SELECT count(*) n FROM sync_outbox WHERE tbl NOT IN ('notes','settings','presets','decks','types','schedulers','type_folders','type_placement','items','cards','attempts','reviews','tag_meta','type_assets')")!.n, 0);
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    for (const f of walk(join(dir, "shared"))) {
      const text = readFileSync(f, "latin1");
      assert.equal(/activity|4321|777/.test(text) && /activity_log|keepDays/.test(text), false, f);
    }
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
