import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli/run.ts";
import { consequence } from "../src/core/agent.ts";

test("listTypes marks shipped, edited and custom types", async () => {
  const e = await Etude.open(":memory:");
  const find = (id: string) => e.listTypes().find((t) => t.id === id)!;

  const fresh = find("numeric");
  assert.equal(fresh.builtin, true);
  assert.equal(fresh.shipped, true);
  assert.equal(fresh.edited, false);

  const def = e.type("numeric");
  e.saveType({ ...def, template: { ...def.template, css: def.template.css + "\n.parts { gap: 2rem; }" } });
  const edited = find("numeric");
  assert.equal(edited.builtin, false);
  assert.equal(edited.shipped, true);
  assert.equal(edited.edited, true);

  e.resetType("numeric");
  assert.equal(find("numeric").edited, false);
  assert.equal(find("numeric").builtin, true);

  e.saveType({ id: "tf", name: "True or false", fields: [{ name: "claim", kind: "markdown" }], template: { html: "{{claim}}" }, grader: { kind: "self" } });
  const custom = find("tf");
  assert.equal(custom.builtin, false);
  assert.equal(custom.shipped, false);
  assert.equal(custom.edited, false);
  e.close();
});

test("archived items keep a type from being deleted, and the list counts them apart", async () => {
  const e = await Etude.open(":memory:");
  const app = createApp(e, { webDist: null });
  e.saveType({ id: "tf", name: "True or false", fields: [{ name: "claim", kind: "markdown" }], template: { html: "{{claim}}" }, grader: { kind: "self" } });
  e.upsertItem({ id: "a", type: "tf", deck: "D", fields: { claim: "x" } });
  e.setArchived(["a"], true);
  const t = e.listTypes().find((x) => x.id === "tf")!;
  assert.deepEqual([t.items, t.archived], [0, 1]);
  assert.throws(() => e.deleteType("tf"), /used by 1 item\(s\), all archived/);

  e.deleteItems(["a"]);
  // Changes must be JSON, so the web client sends {} with a DELETE.
  assert.equal((await app.request("/api/types/tf", { method: "DELETE" })).status, 415);
  assert.equal((await app.request("/api/types/tf", { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  assert.ok(!e.listTypes().some((x) => x.id === "tf"));
  e.close();
});

test("deleting a type with --items takes its items, archived ones too, with their cards and history", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-types-"));
  const e = await Etude.open(join(dir, "etude.db"));
  const app = createApp(e, { webDist: null });
  const tf = (id: string) => ({ id, name: id, faces: ["a", "b"], fields: [{ name: "claim", kind: "markdown" as const }], template: { html: "{{claim}}" }, grader: { kind: "self" as const } });
  e.saveType(tf("old"));
  e.saveType(tf("keep"));
  for (const id of ["o1", "o2", "o3"]) e.upsertItem({ id, type: "old", deck: "D", fields: { claim: id } });
  e.upsertItem({ id: "k1", type: "keep", deck: "D", fields: { claim: "k" } });
  e.setArchived(["o2", "o3"], true);
  const card = e.db.get<{ id: number }>("SELECT id FROM cards WHERE item_id = 'o2' AND face = 'a'")!.id;
  e.db.run("INSERT INTO reviews (card_id, ts, rating, state, card_before, due_after) VALUES (?, ?, 3, 0, '{}', ?)", card, new Date().toISOString(), new Date().toISOString());

  assert.deepEqual(e.typeUsage("old"), { items: 3, archived: 2, cards: 6, reviews: 1 });
  assert.deepEqual(await (await app.request("/api/types/old/usage")).json(), { items: 3, archived: 2, cards: 6, reviews: 1 });
  assert.throws(() => e.deleteType("old"), /used by 3 item\(s\), 2 of them archived/);
  assert.throws(() => e.deleteType("basic", { items: true }), /built-in/);

  const cli = async (...args: string[]) => {
    let out = "";
    const code = await run(["--db", e.path, ...args], { stdout: (s) => (out += s), stderr: () => {}, stdin: () => "", isTTY: false, env: { ETUDE_HOME: dir } });
    return { code, json: out ? JSON.parse(out) : null };
  };
  assert.equal((await cli("type", "delete", "old", "--yes")).code, 5);
  assert.deepEqual((await cli("type", "delete", "old", "--items", "--dry-run")).json, { deleted: "old", items: 3, cards: 6, reviews: 1, dryRun: true });
  assert.equal(e.typeUsage("old").items, 3, "a dry run deletes nothing");
  assert.match(consequence(e, "type delete", ["type", "delete", "old", "--items"], null, null).summary, /and its 3 items \(2 archived\), with 6 cards and 1 review of history/);

  const del = await app.request("/api/types/old", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: true }) });
  assert.deepEqual(await del.json(), { ok: true, items: 3, cards: 6, reviews: 1 });
  assert.ok(!e.listTypes().some((t) => t.id === "old"));
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM items WHERE type = 'old'")!.n, 0);
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM reviews")!.n, 0);
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM cards WHERE item_id = 'k1'")!.n, 2, "other types' items are untouched");
  e.close();
  rmSync(dir, { recursive: true, force: true });
});
