import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { buildIndex, buildSubmission, entryJson, entryPath } from "../src/core/market.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";
import { COMMANDS } from "../src/cli/registry.ts";
import "../src/cli/commands/index.ts";

const temp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-hidden-"));

test("hiding an author: one entry per name whatever its case, undone by showing them, checked", async () => {
  const e = await Etude.open(":memory:");
  try {
    assert.deepEqual(e.hiddenAuthors(), []);
    assert.deepEqual(e.hideAuthor("  Jane   Doe ").hiddenAuthors, ["Jane Doe"]);
    assert.deepEqual(e.hideAuthor("jane doe").hiddenAuthors, ["Jane Doe"], "the same author again changes nothing");
    assert.deepEqual(e.hideAuthor("bob").hiddenAuthors, ["Jane Doe", "bob"]);
    assert.ok(e.hiddenAuthors()[0].since <= e.hiddenAuthors()[1].since);
    assert.deepEqual(e.showAuthor("JANE DOE"), { author: "JANE DOE", hidden: false, hiddenAuthors: ["bob"] });
    assert.deepEqual(e.showAuthor("nobody").hiddenAuthors, ["bob"], "showing someone not hidden is fine");
    assert.throws(() => e.hideAuthor(""), /1 to 100 characters/);
    assert.throws(() => e.hideAuthor("x".repeat(101)), /1 to 100 characters/);
    assert.throws(() => e.updateSettings({ hiddenAuthors: ["bob"] as any }), /hiddenAuthors must be an object/);
  } finally {
    e.close();
  }
});

test("hidden authors sync between devices, each author on its own", async () => {
  const dir = temp();
  const es: Etude[] = [];
  try {
    for (let i = 0; i < 2; i++) es.push(await Etude.open(join(dir, `d${i}.db`), { home: join(dir, `h${i}`) }));
    const ss = es.map(syncFor);
    for (const s of ss) {
      s.setup({ folder: join(dir, "shared") });
      await s.unlock({ password: "a test Sync password" });
      await s.now({ waitMedia: true });
    }
    es[0].hideAuthor("ana");
    es[1].hideAuthor("bob");
    for (let n = 0; n < 2; n++) for (const s of ss) await s.now({ waitMedia: true });
    for (const e of es) assert.deepEqual(e.hiddenAuthors().map((h) => h.author).sort(), ["ana", "bob"]);
    es[1].showAuthor("ana");
    for (let n = 0; n < 2; n++) for (const s of ss) await s.now({ waitMedia: true });
    for (const e of es) assert.deepEqual(e.hiddenAuthors().map((h) => h.author), ["bob"]);
  } finally {
    for (const e of es) e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("market list, the API and the CLI leave out authors you hid", async () => {
  const dir = temp();
  try {
    // A market folder with one theme by ana and one by bob.
    const src = await Etude.open(":memory:");
    src.saveTheme({ id: "sea", name: "Sea", scheme: "dark", vars: {} });
    src.saveTheme({ id: "sand", name: "Sand", scheme: "light", vars: {} });
    const files = [buildSubmission(src, { kind: "theme", ref: "sea", author: "ana" }), buildSubmission(src, { kind: "theme", ref: "sand", author: "Bob" })];
    src.close();
    const root = join(dir, "market");
    mkdirSync(join(root, "entries", "themes"), { recursive: true });
    for (const f of files) writeFileSync(join(root, entryPath(f.kind, f.id)), entryJson(f));
    const { index } = await buildIndex(root, { dryRunInto: () => Etude.open(":memory:") });
    writeFileSync(join(root, "index.json"), JSON.stringify(index));

    const home = join(dir, "home");
    const db = join(dir, "etude.db");
    const cli = async (...args: string[]) => {
      let out = "";
      const code = await run(["--db", db, ...args], { stdout: (s) => (out += s), stderr: () => {}, stdin: () => "", isTTY: false, env: { ETUDE_HOME: home } });
      return { code, json: out ? JSON.parse(out) : null };
    };
    assert.equal((await cli("settings", "set", `market.url=${root}`)).code, 0);
    assert.deepEqual((await cli("market", "list", "--refresh")).json.map((x: any) => x.author).sort(), ["Bob", "ana"]);
    const hid = await cli("market", "hide-author", "bob");
    assert.equal(hid.code, 0);
    assert.deepEqual(hid.json, { author: "bob", hidden: true, hiddenAuthors: ["bob"] });
    assert.deepEqual((await cli("market", "list")).json.map((x: any) => x.author), ["ana"]);
    assert.deepEqual((await cli("market", "list", "--all")).json.map((x: any) => x.author).sort(), ["Bob", "ana"]);
    assert.deepEqual((await cli("market", "hidden-authors")).json.hiddenAuthors.map((h: any) => h.author), ["bob"]);

    // The app gets every entry and the hidden names: its lists leave them out, Yours and a direct link still reach them.
    const e = await Etude.open(db, { home });
    try {
      const app = createApp(e);
      const m = (await (await app.request("/api/market")).json()) as any;
      assert.equal(m.entries.length, 2);
      assert.deepEqual(m.hiddenAuthors, ["bob"]);
      const post = (path: string, author: string) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author }) });
      assert.deepEqual(((await (await post("/api/market/hide-author", "Ana")).json()) as any).hiddenAuthors, ["bob", "Ana"]);
      assert.deepEqual(((await (await post("/api/market/show-author", "BOB")).json()) as any).hiddenAuthors, ["Ana"]);
      assert.deepEqual(((await (await app.request("/api/market/hidden-authors")).json()) as any).hiddenAuthors.map((h: any) => h.author), ["Ana"]);
      assert.equal((await post("/api/market/hide-author", "")).status, 400);
    } finally {
      e.close();
    }
    assert.deepEqual((await cli("market", "show-author", "ana")).json.hiddenAuthors, []);
    assert.ok(COMMANDS.some((c) => c.name === "market hide-author") && COMMANDS.some((c) => c.name === "market show-author"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
