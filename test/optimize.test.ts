import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { run } from "../src/cli/run.ts";

const dirs: string[] = [];
process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Weights that badly underestimate memory, so a fit to any real-looking history beats them. */
const POOR = [0.05, 0.08, 0.12, 0.2, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A simulated learner: each card gets a first rating, then reviews spaced by its true stability. */
function history(e: Etude, deck: string, prefix: string, cards: number, seed: number) {
  const r = rng(seed);
  let n = 0;
  for (let k = 0; k < cards; k++) {
    const id = `${prefix}.${k}`;
    e.upsertItem({ id, type: "basic", deck, fields: { front: `q${k}`, back: `a${k}` } });
    const cardId = e.db.get<{ id: number }>("SELECT id FROM cards WHERE item_id = ?", id)!.id;
    let t = Date.UTC(2025, 0, 1, 15) + k * 3600_000;
    let rating = [1, 2, 3, 3, 4][Math.floor(r() * 5)];
    let stability = { 1: 0.5, 2: 1.5, 3: 4, 4: 12 }[rating]!;
    let state = 0;
    for (let step = 0; step < 6; step++) {
      e.db.run("INSERT INTO reviews (card_id, ts, rating, state, card_before, due_after, duration_ms, practice) VALUES (?, ?, ?, ?, '{}', ?, 4000, 0)", cardId, new Date(t).toISOString(), rating, state, new Date(t).toISOString());
      n++;
      const days = Math.max(1, Math.round(stability * (0.5 + r() * 2)));
      t += days * 86400_000;
      const recalled = r() < Math.pow(0.9, days / stability);
      state = recalled ? 2 : 3;
      rating = recalled ? (r() < 0.15 ? 4 : 3) : 1;
      stability = recalled ? stability * 2.5 : Math.max(0.5, stability * 0.3);
    }
  }
  return n;
}

async function collection() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-optimize-"));
  dirs.push(dir);
  const e = await Etude.open(join(dir, "etude.db"));
  e.savePreset({ id: "lang", name: "Languages", config: { weights: POOR } });
  e.ensureDeck("Lang::Verbs");
  e.ensureDeck("Lang::Own");
  e.ensureDeck("Loose");
  e.updateDeck("Lang", { presetId: "lang" });
  e.updateDeck("Lang::Own", { config: { weights: POOR } });
  const reviews = history(e, "Lang", "lang", 80, 1) + history(e, "Lang::Verbs", "verbs", 80, 2);
  history(e, "Lang::Own", "own", 20, 3);
  const someCard = e.db.get<{ id: number }>("SELECT id FROM cards WHERE item_id = 'lang.0'")!.id;
  e.db.run("INSERT INTO reviews (card_id, ts, rating, state, card_before, due_after, practice) VALUES (?, ?, 1, 2, '{}', ?, 1)", someCard, "2025-06-01T12:00:00.000Z", "2025-06-01T12:00:00.000Z");
  return { e, dir, reviews };
}

test("decks share the weights of the preset or deck that sets them last", async () => {
  const { e } = await collection();
  assert.deepEqual(e.weightsSource("Lang"), { kind: "preset", id: "lang" });
  assert.deepEqual(e.weightsSource("Lang::Verbs"), { kind: "preset", id: "lang" });
  assert.deepEqual(e.weightsSource("Lang::Own"), { kind: "deck", name: "Lang::Own" });
  assert.deepEqual(e.weightsSource("Loose"), { kind: "defaults" });
});

test("optimizing fits the history of every deck sharing the weights and applies a better fit", async () => {
  const { e, reviews } = await collection();
  const r = await e.optimizeWeights({ preset: "lang" });
  assert.deepEqual(r.source, { kind: "preset", id: "lang" });
  assert.deepEqual(r.decks, ["Lang", "Lang::Verbs"], "the deck that overrides its weights is left out");
  assert.equal(r.reviews, reviews, "practice reviews don't count");
  assert.equal(r.cards, 160);
  assert.equal(r.items, 800, "every review after a card's first, on a later day, is a training sample");
  assert.equal(r.weights.length, 21);
  assert.ok(r.weights.every(Number.isFinite));
  assert.ok(r.better && r.after.rmse < r.before.rmse && r.after.logLoss < r.before.logLoss);
  assert.equal(r.applied, false);
  assert.deepEqual(e.preset("lang").config.weights, POOR, "nothing is saved without apply");

  const dueBefore = e.db.get<{ due: string }>("SELECT due FROM cards WHERE item_id = 'verbs.3'")!.due;
  const applied = await e.optimizeWeights({ deck: "Lang::Verbs" }, { apply: true, reschedule: true });
  assert.equal(applied.applied, true);
  assert.deepEqual(e.preset("lang").config.weights, applied.weights);
  assert.equal(applied.rescheduled, 160);
  assert.notEqual(e.db.get<{ due: string }>("SELECT due FROM cards WHERE item_id = 'verbs.3'")!.due, dueBefore);
  assert.deepEqual(e.deck("Lang::Own").config.weights, POOR);
});

test("a deck that overrides its weights is optimized on its own and saves them to itself", async () => {
  const { e } = await collection();
  history(e, "Lang::Own", "own2", 80, 4);
  const r = await e.optimizeWeights({ deck: "Lang::Own" }, { apply: true });
  assert.deepEqual(r.source, { kind: "deck", name: "Lang::Own" });
  assert.deepEqual(r.decks, ["Lang::Own"]);
  assert.equal(r.applied, true);
  assert.deepEqual(e.deck("Lang::Own").config.weights, r.weights);
  assert.deepEqual(e.preset("lang").config.weights, POOR);
});

test("optimizing needs a preset and enough reviews", async () => {
  const { e } = await collection();
  await assert.rejects(e.optimizeWeights({ deck: "Loose" }), /attach a preset/);
  e.savePreset({ id: "small", name: "Small", config: {} });
  e.ensureDeck("Tiny");
  e.updateDeck("Tiny", { presetId: "small" });
  history(e, "Tiny", "tiny", 5, 5);
  await assert.rejects(e.optimizeWeights({ preset: "small" }), /at least 400 reviews; this deck has 30/);
});

test("preset optimize reports without saving, and --dry-run never applies", async () => {
  const { dir } = await collection();
  const cli = async (args: string[]) => {
    let out = "", err = "";
    const code = await run(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => "", isTTY: false, env: { ETUDE_HOME: dir } });
    return { code, json: out ? JSON.parse(out) : null, err };
  };
  const plain = await cli(["preset", "optimize", "lang"]);
  assert.equal(plain.code, 0, plain.err);
  assert.equal(plain.json.better, true);
  assert.equal(plain.json.applied, false);
  const dry = await cli(["preset", "optimize", "lang", "--apply", "--dry-run"]);
  assert.equal(dry.json.dryRun, true);
  assert.equal(dry.json.applied, false);
  const bad = await cli(["deck", "optimize", "Lang", "--reschedule"]);
  assert.equal(bad.code, 2);
  const show = await cli(["preset", "show", "lang"]);
  assert.deepEqual(show.json.config.weights, POOR);
});
