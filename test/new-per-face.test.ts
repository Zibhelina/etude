import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { resolveConfig, validateConfig } from "../src/core/scheduler.ts";
import { run } from "../src/cli/run.ts";

test("face limits merge face by face, and null drops an inherited one", () => {
  assert.deepEqual(resolveConfig({ newPerFace: { t1: 5, t2: 3 } }, { newPerFace: { t2: 1 } }).newPerFace, { t1: 5, t2: 1 });
  assert.deepEqual(resolveConfig({ newPerFace: { t1: 5 } }, { newPerFace: { t1: null } }).newPerFace, {});
  assert.deepEqual(resolveConfig({}).newPerFace, {});
  assert.deepEqual(validateConfig({ newPerFace: { t1: 0, t2: null } }), []);
  for (const bad of [{ t1: -1 }, { t1: "5" }, { "a b": 1 }, [], null]) assert.equal(validateConfig({ newPerFace: bad as never }).length, 1, JSON.stringify(bad));
});

async function setup() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-faces-"));
  const e = await Etude.open(join(dir, "etude.db"));
  e.saveType({
    id: "vocab",
    name: "Vocab",
    faces: ["t0", "t1"],
    fields: [{ name: "word", kind: "text", required: true }],
    template: { html: "{{word}}" },
    grader: { kind: "self" },
  });
  for (let i = 1; i <= 6; i++) e.upsertItem({ id: `w${i}`, type: "vocab", deck: "Lang::German", fields: { word: `w${i}` } });
  return { e, dir };
}

const news = (e: Etude, deck: string) => e.queue({ deck }).news.map((c) => `${c.item_id}/${c.face}`);

test("the queue gives each limited face its share of today's new cards, in the usual order", async () => {
  const { e, dir } = await setup();
  e.updateDeck("Lang", { config: { newPerDay: 6, newPerFace: { t1: 2 } } });
  assert.deepEqual(news(e, "Lang"), ["w1/t0", "w1/t1", "w2/t0", "w2/t1", "w3/t0", "w4/t0"]);

  // A t1 card introduced today counts against the t1 limit and the overall one.
  const card = e.db.get<{ id: number }>("SELECT id FROM cards WHERE item_id = 'w1' AND face = 't1'")!.id;
  e.db.run("INSERT INTO reviews (card_id, ts, rating, state, card_before, due_after) VALUES (?, ?, 3, 0, '{}', ?)", card, new Date().toISOString(), new Date().toISOString());
  e.db.run("UPDATE cards SET state = 1 WHERE id = ?", card);
  assert.deepEqual(news(e, "Lang"), ["w1/t0", "w2/t0", "w2/t1", "w3/t0", "w4/t0"]);

  // 0 holds a face back entirely; the others still fill the day.
  e.updateDeck("Lang", { config: { newPerDay: 6, newPerFace: { t1: 0 } } });
  assert.deepEqual(news(e, "Lang"), ["w1/t0", "w2/t0", "w3/t0", "w4/t0", "w5/t0"]);
  assert.equal(e.counts({ deck: "Lang" }).new, 5);

  // A subdeck can drop the parent's limit; studying the parent still applies it.
  e.updateDeck("Lang::German", { config: { newPerFace: { t1: null } } });
  assert.deepEqual(e.deck("Lang::German").resolved.newPerFace, {});
  assert.deepEqual(news(e, "Lang::German"), ["w1/t0", "w2/t0", "w2/t1", "w3/t0", "w3/t1"]);
  assert.equal(news(e, "Lang").filter((c) => c.endsWith("t1")).length, 0);
  e.close();
  rmSync(dir, { recursive: true, force: true });
});

test("deckFaces and the CLI: list the faces, set and clear a face's limit", async () => {
  const { e, dir } = await setup();
  e.setArchived(["w6"], true);
  e.setSuspended([e.db.get<{ id: number }>("SELECT id FROM cards WHERE item_id = 'w5' AND face = 't1'")!.id], true);
  assert.deepEqual(e.deckFaces("Lang"), [
    { face: "t0", types: [{ id: "vocab", name: "Vocab" }], cards: 5, new: 5 },
    { face: "t1", types: [{ id: "vocab", name: "Vocab" }], cards: 5, new: 4 },
  ]);
  e.close();

  const cli = async (...args: string[]) => {
    let out = "";
    const code = await run(["--db", join(dir, "etude.db"), ...args], { stdout: (s) => (out += s), stderr: () => {}, stdin: () => "", isTTY: false, env: { ETUDE_HOME: dir } });
    return { code, json: out ? JSON.parse(out) : null };
  };
  assert.deepEqual((await cli("deck", "faces", "Lang")).json.map((f: { face: string }) => f.face), ["t0", "t1"]);
  const set = await cli("deck", "set", "Lang", "newPerFace.t1=3", "newPerFace.t0=10");
  assert.deepEqual(set.json.config.newPerFace, { t1: 3, t0: 10 });
  assert.deepEqual(set.json.changed.newPerFace, { from: {}, to: { t1: 3, t0: 10 } });
  assert.deepEqual((await cli("deck", "set", "Lang::German", "newPerFace.t1=null")).json.config.newPerFace, { t1: null });
  assert.deepEqual((await cli("deck", "show", "Lang::German")).json.resolved.newPerFace, { t0: 10 });
  assert.equal((await cli("deck", "set", "Lang", "newPerFace.t1=-1")).code, 4);
  assert.equal((await cli("deck", "set", "Lang", "newPerDay.t1=3")).code, 4);
  rmSync(dir, { recursive: true, force: true });
});
