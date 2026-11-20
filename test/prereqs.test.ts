import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { DEFAULT_PRESET } from "../src/core/model.ts";
import { validateConfig } from "../src/core/scheduler.ts";
import { buildGraph, conceptStat, masteredSince, under } from "../src/core/prereqs.ts";

const HOUR = 3600_000;

/** A deck of basic items: [id, tags]. Prerequisites on unless `off`. */
async function setup(t: { after: (f: () => void) => void }, items: [string, string[]][], config: Record<string, unknown> = {}, off = false) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-prereqs-"));
  const e = await Etude.open(join(dir, "etude.db"));
  t.after(() => (e.close(), rmSync(dir, { recursive: true, force: true })));
  for (const [id, tags] of items) e.upsertItem({ id, type: "basic", deck: "C::Unit", tags, fields: { front: id, back: id } });
  e.updateDeck("C", { config: { ...(off ? {} : { prerequisites: true }), newPerDay: 100, ...config } });
  return e;
}

const card = (e: Etude, item: string) => e.db.get<{ id: number }>("SELECT id FROM cards WHERE item_id = ?", item)!.id;
const newsOf = (e: Etude, deck = "C") => e.queue({ deck }).news.map((c) => c.item_id);
/** Answers Good until the card graduates, starting `hoursAgo` hours back. */
function graduate(e: Etude, item: string, hoursAgo: number, rating: 3 | 4 = 3) {
  const id = card(e, item);
  for (let k = 0; k < 5; k++) {
    const r = e.rate(id, rating, { at: new Date(Date.now() - hoursAgo * HOUR + k * 60_000) });
    if (r.state === 2) return;
  }
  throw new Error(`${item} didn't graduate`);
}

test("settings: off by default, validated", () => {
  assert.equal(DEFAULT_PRESET.prerequisites, false);
  assert.equal(DEFAULT_PRESET.implicitReviews, false);
  assert.deepEqual(validateConfig({ prerequisites: true, masteryStreak: 2, masteryShare: 0.8, conceptsInProgress: 0, implicitReviews: true }), []);
  for (const bad of [{ prerequisites: "yes" }, { masteryStreak: 0 }, { masteryStreak: 1.5 }, { masteryShare: 0 }, { masteryShare: 1.2 }, { conceptsInProgress: -1 }, { implicitReviews: 1 }])
    assert.equal(validateConfig(bad as never).length, 1, JSON.stringify(bad));
});

test("pure helpers: prefix matching, cycles, depth, mastery time", () => {
  assert.ok(under("a::b::c", "a::b"));
  assert.ok(!under("a::bc", "a::b"));
  const g = buildGraph(
    new Map([["i1", ["a"]], ["i2", ["b"]], ["i3", ["c"]], ["i4", ["x"]], ["i5", ["y"]]]),
    new Map([["i2", ["a"]], ["i3", ["b"]], ["i4", ["y"]], ["i5", ["x"]]]),
  );
  assert.deepEqual([g.depth.get("a"), g.depth.get("b"), g.depth.get("c")], [0, 1, 2]);
  assert.deepEqual(g.cycles, [["x", "y"]]);
  assert.equal(g.depth.get("x"), 0);
  assert.equal(masteredSince([{ pass: false, ts: "1" }, { pass: true, ts: "2" }, { pass: true, ts: "3" }, { pass: true, ts: "4" }], 2), "3");
  assert.equal(masteredSince([{ pass: true, ts: "1" }, { pass: false, ts: "2" }], 1), null);
  const s = conceptStat([{ mastered: true, answered: true, since: "5" }, { mastered: true, answered: true, since: "3" }, { mastered: false, answered: true, since: null }], 0.6);
  assert.equal(s.isMastered, true);
  assert.equal(s.masteredAt, "5", "mastered when the second of three cards got there");
  assert.equal(conceptStat([], 1).isMastered, true);
});

test("a dependent card waits until the needed concept's cards graduate", async (t) => {
  const e = await setup(t, [
    ["a1", ["concept::m::a"]],
    ["a2", ["concept::m::a"]],
    ["b1", ["concept::m::b", "needs::m::a"]],
  ]);
  assert.deepEqual(newsOf(e), ["a1", "a2"]);
  const c = e.counts({ deck: "C" });
  assert.equal(c.locked, 1);
  assert.deepEqual(c.unlockWith, ["m::a"]);
  assert.equal(e.next({ deck: "C" }).counts.locked, 1);
  graduate(e, "a1", 3);
  assert.equal(e.counts({ deck: "C" }).locked, 1, "half of a isn't enough at masteryShare 1");
  graduate(e, "a2", 2);
  assert.deepEqual(newsOf(e), ["b1"]);
  assert.equal(e.counts({ deck: "C" }).locked, 0);
  assert.equal(e.counts({ deck: "C" }).unlockWith, undefined);
});

test("a need is met by the concept and everything below it", async (t) => {
  const e = await setup(t, [
    ["leaf", ["concept::a::b::c"]],
    ["other", ["concept::a::bc"]],
    ["dep", ["concept::z", "needs::a::b"]],
  ]);
  assert.ok(!newsOf(e).includes("dep"));
  graduate(e, "leaf", 2);
  assert.ok(newsOf(e).includes("dep"), "a::bc isn't below a::b, so it doesn't hold dep back");
});

test("masteryShare below 1 and masteryStreak 2", async (t) => {
  const e = await setup(t, [["a1", ["concept::a"]], ["a2", ["concept::a"]], ["b", ["concept::b", "needs::a"]]], { masteryShare: 0.5, masteryStreak: 2, conceptsInProgress: 0 });
  graduate(e, "a1", 3, 4); // Easy straight to review: one passing answer
  assert.ok(!newsOf(e).includes("b"), "one pass isn't a streak of 2");
  e.updateDeck("C", { config: { masteryStreak: 1 } });
  assert.ok(newsOf(e).includes("b"), "half of a, one pass each");
  e.updateDeck("C", { config: { masteryStreak: 2 } });
  graduate(e, "a2", 2);
  assert.ok(newsOf(e).includes("b"), "a2 graduated with two Goods");
});

test("a lapse on a prerequisite re-locks new dependent cards; seen ones keep their schedule", async (t) => {
  const e = await setup(t, [["a", ["concept::a"]], ["b1", ["concept::b", "needs::a"]], ["b2", ["concept::b", "needs::a"]]], { conceptsInProgress: 0 });
  graduate(e, "a", 3);
  e.rate(card(e, "b1"), 3, { at: new Date(Date.now() - 2 * HOUR) });
  assert.deepEqual(newsOf(e), ["b2"]);
  e.rate(card(e, "a"), 1, { at: new Date(Date.now() - HOUR) });
  assert.deepEqual(newsOf(e), [], "b2 waits again");
  assert.equal(e.counts({ deck: "C" }).locked, 1);
  const q = e.queue({ deck: "C" });
  assert.ok(q.learning.some((c) => c.item_id === "b1"), "b1 is still in learning");
});

test("in-progress cap: with two concepts started, a third root waits", async (t) => {
  const e = await setup(t, [
    ["p1", ["concept::p"]], ["p2", ["concept::p"]],
    ["q1", ["concept::q"]], ["q2", ["concept::q"]],
    ["r1", ["concept::r"]],
    ["plain", []],
  ]);
  e.rate(card(e, "p1"), 3, { at: new Date(Date.now() - HOUR) });
  assert.deepEqual(newsOf(e).sort(), ["p2", "plain", "q1", "q2", "r1"]);
  e.rate(card(e, "q1"), 3, { at: new Date(Date.now() - HOUR) });
  assert.deepEqual(newsOf(e), ["p2", "q2", "plain"], "in progress first; r waits; untagged items aren't limited");
  e.updateDeck("C", { config: { conceptsInProgress: 0 } });
  assert.ok(newsOf(e).includes("r1"));
});

test("order: in progress first, then the most recently unlocked chain, then depth", async (t) => {
  const e = await setup(t, [
    ["root-new", ["concept::k"]],
    ["v", ["concept::v"]],
    ["w", ["concept::w", "needs::v"]],
    ["a", ["concept::a"]],
    ["d", ["concept::d"]],
    ["x", ["concept::x", "needs::a"]],
    ["y", ["concept::y", "needs::a", "needs::w"]],
    ["e1", ["concept::e", "needs::d"]],
    ["s1", ["concept::s"]], ["s2", ["concept::s"]],
  ], { conceptsInProgress: 0 });
  graduate(e, "v", 10);
  graduate(e, "w", 9);
  graduate(e, "a", 5);
  graduate(e, "d", 3);
  e.rate(card(e, "s1"), 3, { at: new Date(Date.now() - HOUR) });
  // s is in progress; e unlocked last (d at -3h); x and y both unlocked by a at -5h, x shallower; then roots.
  assert.deepEqual(newsOf(e), ["s2", "e1", "x", "y", "root-new"]);
});

test("implicit reviews: a passing dependent answer after the due date stands in for the review", async (t) => {
  const e = await setup(t, [["a", ["concept::a"]], ["b", ["concept::b", "needs::a"]]], { implicitReviews: true, conceptsInProgress: 0 });
  const day = 86400_000;
  const due = new Date(Date.now() - 2 * day).toISOString();
  e.db.run("UPDATE cards SET state = 2, stability = 5, difficulty = 5, reps = 3, last_review = ?, due = ? WHERE id = ?", new Date(Date.now() - 7 * day).toISOString(), due, card(e, "a"));
  e.rate(card(e, "b"), 3, { at: new Date(Date.now() - 3 * day) });
  let c = e.counts({ deck: "C" });
  assert.equal(c.review, 1, "b's answer came before a was due");
  assert.equal(c.credited, 0);
  e.rate(card(e, "b"), 3, { at: new Date(Date.now() - day) });
  c = e.counts({ deck: "C" });
  assert.equal(c.credited, 1);
  assert.ok(!e.queue({ deck: "C" }).reviews.some((r) => r.item_id === "a"));
  e.rate(card(e, "b"), 1, { at: new Date(Date.now() - 1000) });
  assert.equal(e.counts({ deck: "C" }).credited, 1, "the earlier pass still counts; a lapse just isn't a pass");
  e.updateDeck("C", { config: { implicitReviews: false } });
  assert.equal(e.counts({ deck: "C" }).review, 1);
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM reviews WHERE card_id = ?", card(e, "a"))!.n, 0, "nothing written");
});

test("a cycle doesn't lock its concepts and is reported", async (t) => {
  const e = await setup(t, [["x", ["concept::x", "needs::y"]], ["y", ["concept::y", "needs::x"]], ["z", ["concept::z", "needs::nowhere"]]], { conceptsInProgress: 0 });
  assert.deepEqual(newsOf(e).sort(), ["x", "y", "z"]);
  const m = e.conceptMap("C");
  assert.deepEqual(m.cycles, [["x", "y"]]);
  assert.deepEqual(m.danglingNeeds, ["nowhere"]);
  assert.ok(m.concepts.every((c) => c.state === "unlocked"));
});

test("concept map: topological order, states and missing needs", async (t) => {
  const e = await setup(t, [["a", ["concept::m::a"]], ["b", ["concept::m::b", "needs::m::a"]], ["c", ["concept::m::c-three", "needs::m::b"]]]);
  graduate(e, "a", 2);
  e.rate(card(e, "b"), 3, { at: new Date(Date.now() - HOUR) });
  const m = e.conceptMap("C");
  assert.deepEqual(m.concepts.map((c) => [c.concept, c.depth, c.state, c.mastered, c.cards]), [
    ["m::a", 0, "mastered", 1, 1],
    ["m::b", 1, "in-progress", 0, 1],
    ["m::c-three", 2, "locked", 0, 1],
  ]);
  assert.deepEqual(m.concepts[2].missing, ["m::b"]);
  assert.equal(m.prerequisites, true);
});

test("study ahead and custom study gate new cards too", async (t) => {
  const e = await setup(t, [["a", ["concept::a"]], ["b", ["concept::b", "needs::a"]]]);
  assert.deepEqual(e.queue({ deck: "C", ahead: true }).news.map((c) => c.item_id), ["a"]);
  assert.deepEqual(e.queue({ deck: "C", query: "tag:concept" }).news.map((c) => c.item_id), ["a"]);
  assert.equal(e.counts({ query: "" }).locked, 1, "a search outside the deck still respects its setting");
});

test("off by default: a deck without prerequisites behaves as before", async (t) => {
  const e = await setup(t, [["a", ["concept::a"]], ["b", ["concept::b", "needs::a"]], ["c", []]], {}, true);
  assert.deepEqual(newsOf(e), ["a", "b", "c"]);
  const c = e.counts({ deck: "C" });
  assert.equal(c.locked, 0);
  assert.equal(c.credited, 0);
  assert.equal(c.new, 3);
  assert.equal(e.conceptMap("C").prerequisites, false);
});

test("pack check warns on needs nothing teaches and on cycles", async () => {
  const { checkPack } = await import("../src/cli/pack-check.ts");
  const item = (id: string, tags: string[]) => ({ id, type: "basic", deck: "T", tags, fields: { front: id, back: id } });
  const r = checkPack({ etude: "pack/1", decks: [{ name: "T" }], items: [item("a", ["concept::x::one", "needs::y"]), item("b", ["concept::y", "needs::x"]), item("c", ["concept::z", "needs::far::away"])] }, "p");
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes("needs::far::away") && w.includes("collection")));
  assert.ok(!r.warnings.some((w) => w.includes("needs::x has")), "x is met by x::one");
  assert.ok(r.warnings.some((w) => w.includes("x::one ↔ y")));
});
