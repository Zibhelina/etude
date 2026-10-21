import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";

const pack = {
  etude: "pack/1",
  presets: [{ id: "exam", name: "Exam", config: { newPerDay: 100, reviewsPerDay: 100 } }],
  decks: [{ name: "Net", preset: "exam" }],
  items: [
    { id: "a", type: "basic", deck: "Net::A", tags: ["net::delay", "exam::core"], fields: { front: "a", back: "a" } },
    { id: "b", type: "basic", deck: "Net::A", tags: ["net::delay::prop"], fields: { front: "b", back: "b" } },
    { id: "c", type: "basic", deck: "Net::B", tags: ["net::layers"], fields: { front: "c", back: "c" } },
    { id: "d", type: "basic", deck: "Net::B", tags: ["exam::core"], fields: { front: "d", back: "d" } },
    { id: "t", type: "typed", deck: "Net::B", fields: { prompt: "PDU at the transport layer?", answers: ["segment"] } },
  ],
};

async function setup() {
  const e = await Etude.open(":memory:");
  e.updateSettings({ ai: { decision: null, feedback: null, vision: null, autoFeedback: "never", language: "English" } });
  e.importPack(pack);
  return e;
}

const cardOf = (e: Etude, item: string) => e.db.get("SELECT id FROM cards WHERE item_id = ?", item)!.id as number;
const daysAgo = (n: number, hour = 12) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
};

test("stats on an empty scope are zeros and nulls, not errors", async () => {
  const e = await setup();
  const s = e.stats({ deck: "Net" });
  assert.equal(s.cards.total, 5);
  assert.equal(s.cards.new, 5);
  assert.equal(s.retention, null);
  assert.deepEqual(s.trueRetention, { days: 30, reviewed: 0, passed: 0, rate: null });
  assert.equal(s.recall, null);
  assert.deepEqual(s.ratings, { again: 0, hard: 0, good: 0, easy: 0 });
  assert.deepEqual(s.verdicts, { correct: 0, partial: 0, incorrect: 0, ungraded: 0 });
  assert.equal(s.streak, 0);
  assert.equal(s.overdue, 0);
  assert.equal(s.today.reviews, 0);
  assert.equal(s.forecast.length, 30);
  assert.ok(s.forecast.every((f) => f.due === 0));
  // Unseen tags still appear in the tree, with no recall.
  const core = s.tagTree.find((t) => t.tag === "exam::core")!;
  assert.equal(core.cards, 2);
  assert.equal(core.seen, 0);
  assert.equal(core.recall, null);
});

test("ratings, today, streak and the activity window", async () => {
  const e = await setup();
  const [a, b, c] = ["a", "b", "c"].map((i) => cardOf(e, i));
  // Three consecutive days ending today, plus one older day outside a 7-day window.
  e.rate(a, 3, { at: daysAgo(20), durationMs: 4000 });
  e.rate(a, 1, { at: daysAgo(2), durationMs: 5000 });
  e.rate(b, 3, { at: daysAgo(1), durationMs: 6000 });
  e.rate(c, 4, { at: new Date(Date.now() - 60_000), durationMs: 2000 });
  e.rate(b, 2, { at: new Date(Date.now() - 30_000), durationMs: 1000, practice: true });

  const s = e.stats({ deck: "Net" }, 7);
  assert.equal(s.window.days, 7);
  // Practice ratings aren't counted; the 20-day-old one is outside the window.
  assert.deepEqual(s.ratings, { again: 1, hard: 0, good: 1, easy: 1 });
  assert.equal(s.days.reduce((n, d) => n + d.reviews, 0), 3);
  assert.equal(s.days.reduce((n, d) => n + d.ms, 0), 13000);
  assert.equal(s.today.reviews, 1);
  assert.equal(s.today.new, 1);
  assert.equal(s.today.ms, 2000);
  assert.equal(s.streak, 3);

  const wide = e.stats({ deck: "Net" }, 182);
  assert.equal(wide.days.reduce((n, d) => n + d.reviews, 0), 4);
  assert.equal(wide.window.days, 182);
  assert.ok(wide.window.from < wide.window.to);
});

test("true retention counts only review-state reviews in the last 30 days", async () => {
  const e = await setup();
  const a = cardOf(e, "a"), b = cardOf(e, "b");
  // Learn both, then review: a passes, b fails, then an old review outside 30 days.
  e.rate(a, 3, { at: daysAgo(60) });
  e.rate(a, 3, { at: daysAgo(59) });
  e.rate(a, 3, { at: daysAgo(40) }); // review state, 40 days ago: outside
  e.rate(b, 3, { at: daysAgo(25) });
  e.rate(b, 3, { at: daysAgo(24) });
  const st = (id: number) => e.db.get("SELECT state FROM cards WHERE id = ?", id)!.state;
  assert.equal(st(a), 2);
  assert.equal(st(b), 2);
  e.rate(a, 3, { at: daysAgo(5) });
  e.rate(b, 1, { at: daysAgo(4) });
  const s = e.stats({ deck: "Net" }, 7);
  assert.equal(s.trueRetention.reviewed, 2);
  assert.equal(s.trueRetention.passed, 1);
  assert.equal(s.trueRetention.rate, 0.5);
  // The window figure follows `days`.
  assert.equal(s.retention, 0.5);
  assert.equal(e.stats({ deck: "Net" }, 3).retention, null);
});

test("forecast buckets by study day and counts overdue cards today", async () => {
  const e = await setup();
  const a = cardOf(e, "a"), b = cardOf(e, "b"), c = cardOf(e, "c");
  e.rate(a, 3);
  e.rate(b, 3);
  e.rate(c, 3);
  const day = (n: number) => {
    const d = e.dayStart();
    d.setDate(d.getDate() + n);
    d.setHours(d.getHours() + 6);
    return d.toISOString();
  };
  e.db.run("UPDATE cards SET due = ? WHERE id = ?", new Date(Date.now() - 3 * 86400_000).toISOString(), a);
  e.db.run("UPDATE cards SET due = ? WHERE id = ?", day(3), b);
  e.db.run("UPDATE cards SET due = ? WHERE id = ?", day(45), c);
  const s = e.stats({ deck: "Net" });
  assert.equal(s.overdue, 1);
  assert.equal(s.forecast[0].due, 1);
  assert.equal(s.forecast[3].due, 1);
  assert.equal(s.forecast.reduce((n, f) => n + f.due, 0), 2);
  // Days are consecutive dates.
  for (let i = 1; i < 30; i++) {
    const prev = new Date(s.forecast[i - 1].day + "T12:00:00Z").getTime();
    const cur = new Date(s.forecast[i].day + "T12:00:00Z").getTime();
    assert.equal(cur - prev, 86400_000);
  }
});

test("tag tree rolls children into parents without double counting", async () => {
  const e = await setup();
  for (const id of ["a", "b", "c"]) e.rate(cardOf(e, id), 3, { at: daysAgo(3) });
  const s = e.stats({ deck: "Net" });
  const node = (t: string) => s.tagTree.find((x) => x.tag === t)!;
  // a: net::delay, b: net::delay::prop, c: net::layers.
  assert.equal(node("net").cards, 3);
  assert.equal(node("net").seen, 3);
  assert.equal(node("net").direct, false);
  assert.equal(node("net::delay").cards, 2);
  assert.equal(node("net::delay").direct, true);
  assert.equal(node("net::delay::prop").depth, 2);
  assert.equal(node("exam").cards, 2);
  assert.equal(node("exam").seen, 1);
  for (const t of s.tagTree) if (t.recall != null) assert.ok(t.recall > 0 && t.recall <= 1);
  // Flat per-tag list stays as before: seen cards only, exact tags only.
  assert.deepEqual(s.tags.map((t) => t.tag), ["exam::core", "net::delay", "net::delay::prop", "net::layers"]);
});

test("verdicts come from graded attempts", async () => {
  const e = await setup();
  const t = cardOf(e, "t");
  await e.submit(t, 1, "segment");
  await e.submit(t, 1, "packet");
  await e.submit(t, 1, "Segment", { practice: true });
  const s = e.stats({ deck: "Net" });
  assert.equal(s.verdicts.correct, 2);
  assert.equal(s.verdicts.incorrect, 1);
  assert.equal(s.verdicts.partial, 0);
  // Scope applies: another deck has none.
  assert.equal(e.stats({ deck: "Net::A" }).verdicts.correct, 0);
});

test("deck scope reports the deck's deadline", async () => {
  const e = await setup();
  e.updateDeck("Net", { config: { deadline: "2030-01-01T09:00:00Z", deadlineMargin: 6 } });
  assert.equal(e.stats({ deck: "Net::A" }).deadline, "2030-01-01T09:00:00Z");
  assert.equal(e.stats({ deck: "Net::A" }).deadlineMargin, 6);
  assert.equal(e.stats({}).deadline, null);
});

test("deletePreset refuses while decks use it", async () => {
  const e = await setup();
  assert.throws(() => e.deletePreset("exam"), /used by 1 deck/);
  e.updateDeck("Net", { presetId: null });
  e.deletePreset("exam");
  assert.equal(e.listPresets().length, 0);
  assert.throws(() => e.deletePreset("exam"), /unknown preset/);
  // Archived decks still count as users.
  e.savePreset({ id: "p2", name: "P2", config: {} });
  e.updateDeck("Net::A", { presetId: "p2", archived: true });
  assert.throws(() => e.deletePreset("p2"), /used by 1 deck/);
});
