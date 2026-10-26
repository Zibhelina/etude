import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { loadTypeDir } from "../src/core/types.ts";

const TYPING = join(import.meta.dirname, "..", "examples", "showcase", "types", "typing");

async function open(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-sched-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const e = await Etude.open(join(dir, "etude.db"));
  t.after(() => e.close());
  return e;
}

/** A perfect run of a typing card at about `wpm` words per minute. */
function typeIt(e: Etude, cardId: number, seed: number, wpm: number) {
  const words = (e.present(cardId, seed).view as { words: string[] }).words;
  const chars = words.join(" ").length;
  const ms = Math.round((chars / 5 / wpm) * 60000);
  return { typed: words, ms, complete: true, keys: { correct: chars, incorrect: 0 } };
}

test("FSRS is still the default and works exactly as before", async (t) => {
  const e = await open(t);
  e.upsertItem({ id: "a", type: "basic", deck: "Facts", fields: { front: "a", back: "A" } });
  assert.equal(e.configFor("Facts").scheduler, "fsrs");
  const card = e.next({ deck: "Facts" }).card!;
  assert.equal(card.scheduler.id, "fsrs");
  assert.equal(card.scheduler.ratings, true);
  e.rate(card.cardId, 3);
  const row = e.db.get("SELECT state, stability, sched_state FROM cards WHERE id = ?", card.cardId)!;
  assert.equal(row.state, 1);
  assert.ok(row.stability > 0);
  assert.equal(row.sched_state, null);
});

test("ships drill and leitner, lists FSRS first", async (t) => {
  const e = await open(t);
  const ids = e.listSchedulers().map((s) => s.id);
  assert.equal(ids[0], "fsrs");
  assert.ok(ids.includes("drill") && ids.includes("leitner"));
  assert.throws(() => e.updateDeck(e.ensureDeck("X"), { config: { scheduler: "nope" } }), /unknown scheduler "nope"/);
});

test("a one-card typing drill: no ratings, comes back every day, keeps every WPM", async (t) => {
  const e = await open(t);
  e.saveType(loadTypeDir(TYPING));
  e.upsertItem({ id: "type", type: "typing", deck: "Typing", fields: { count: 10, target: 60 } });
  e.updateDeck("Typing", { config: { scheduler: "drill", schedulerOptions: { perDay: 2 } } });

  const first = e.next({ deck: "Typing" }).card!;
  assert.equal(first.scheduler.id, "drill");
  assert.equal(first.scheduler.ratings, false);

  // Session 1: perDay is 2, so it stays available.
  const s1 = await e.submit(first.cardId, 7, typeIt(e, first.cardId, 7, 50));
  assert.ok(Math.abs((s1.grade.details as any).wpm - 50) < 2, "the grader measured ~50 wpm");
  const r1 = e.rate(first.cardId, 0, { attemptId: s1.attemptId });
  assert.ok(new Date(r1.due).getTime() <= Date.now(), "still due today");
  assert.equal(e.next({ deck: "Typing" }).card?.cardId, first.cardId);

  // Session 2: done for today, back tomorrow.
  const s2 = await e.submit(first.cardId, 8, typeIt(e, first.cardId, 8, 70));
  const r2 = e.rate(first.cardId, 0, { attemptId: s2.attemptId });
  const tomorrow = e.dayStart();
  tomorrow.setDate(tomorrow.getDate() + 1);
  assert.equal(r2.due, tomorrow.toISOString(), "due when tomorrow starts");
  assert.ok(new Date(r2.due) > new Date(), "not today anymore");
  assert.equal(e.next({ deck: "Typing" }).card, null);
  const state = JSON.parse(e.db.get("SELECT sched_state FROM cards WHERE id = ?", first.cardId)!.sched_state);
  assert.equal(state.sessions, 2);
  assert.equal(e.db.get("SELECT rating FROM reviews WHERE id = ?", r2.reviewId)!.rating, 0);

  // Rating 1-4 on a drill is ignored; nothing breaks.
  const stats = e.stats({ deck: "Typing" });
  assert.equal(stats.scheduler, "drill");
  assert.equal(stats.recall, null, "no FSRS recall for a drill");
  assert.equal(stats.practice.length, 1);
  const wpm = stats.practice[0].metrics.find((m) => m.key === "wpm")!;
  assert.equal(wpm.label, "WPM");
  assert.equal(wpm.points.length, 2);
  assert.ok(wpm.last! > wpm.first!, "progress shows");
  assert.equal(wpm.best, wpm.last);

  // Undo puts the card back exactly.
  e.undo();
  assert.equal(JSON.parse(e.db.get("SELECT sched_state FROM cards WHERE id = ?", first.cardId)!.sched_state).sessions, 1);
  assert.equal(e.next({ deck: "Typing" }).card?.cardId, first.cardId);
});

test("leitner moves boxes with ratings and replays from history", async (t) => {
  const e = await open(t);
  e.upsertItem({ id: "w", type: "basic", deck: "Boxes", fields: { front: "w", back: "W" } });
  e.updateDeck("Boxes", { config: { scheduler: "leitner", schedulerOptions: { boxes: "1, 3, 7" } } });
  const card = e.next({ deck: "Boxes" }).card!;
  assert.equal(card.scheduler.ratings, true);
  const day = (n: number) => {
    const d = e.dayStart();
    d.setDate(d.getDate() + n);
    return d.toISOString();
  };
  assert.equal(card.intervals[3], day(1), "good from nothing: box 1, one day");
  assert.equal(card.intervals[4], day(3), "easy: box 2");
  e.rate(card.cardId, 3);
  e.rate(card.cardId, 3, { at: new Date(Date.now() + 1000) });
  let row = e.db.get("SELECT due, sched_state FROM cards WHERE id = ?", card.cardId)!;
  assert.deepEqual(JSON.parse(row.sched_state), { box: 2 });
  assert.equal(row.due, day(3));
  e.rate(card.cardId, 1, { at: new Date(Date.now() + 2000) });
  row = e.db.get("SELECT due, sched_state, lapses FROM cards WHERE id = ?", card.cardId)!;
  assert.deepEqual(JSON.parse(row.sched_state), { box: 1 });
  assert.equal(row.lapses, 1);

  // Change the boxes and replay: same answers, new gaps.
  e.updateDeck("Boxes", { config: { scheduler: "leitner", schedulerOptions: { boxes: "2, 5" } } });
  e.reschedule({ deck: "Boxes" });
  row = e.db.get("SELECT due, sched_state, reps FROM cards WHERE id = ?", card.cardId)!;
  assert.deepEqual(JSON.parse(row.sched_state), { box: 1 });
  assert.equal(row.reps, 3);
  assert.equal(row.due, day(2));

  // Back to FSRS: the history replays through FSRS.
  e.updateDeck("Boxes", { config: {} });
  e.reschedule({ deck: "Boxes" });
  row = e.db.get("SELECT state, stability, sched_state FROM cards WHERE id = ?", card.cardId)!;
  assert.ok(row.stability > 0);
  assert.equal(row.sched_state, null);
});

test("a user-written scheduler: saved, validated, used, protected from deletion while in use", async (t) => {
  const e = await open(t);
  assert.throws(() => e.saveScheduler({ id: "bad", name: "Bad", schedule: "return {" }), /invalid scheduler/);
  assert.throws(() => e.saveScheduler({ id: "fsrs", name: "Mine", schedule: "return {}" }), /built-in/);
  const r = e.saveScheduler({
    id: "mondays",
    name: "Every Monday",
    ratings: false,
    schedule: "const i = ctx.day.findIndex((d, n) => n > 0 && new Date(d).getDay() === 1); return { due: ctx.day[i], state: { n: (card.state?.n ?? 0) + 1 } };",
  });
  assert.equal(r.result, "created");
  e.upsertItem({ id: "m", type: "basic", deck: "Weekly", fields: { front: "m", back: "M" } });
  e.updateDeck("Weekly", { config: { scheduler: "mondays" } });
  const card = e.next({ deck: "Weekly" }).card!;
  const out = e.rate(card.cardId, 0);
  const due = new Date(out.due);
  assert.equal(due.getDay(), 1);
  assert.ok(due > new Date());
  assert.throws(() => e.deleteScheduler("mondays"), /used by deck Weekly/);
  e.updateDeck("Weekly", { config: {} });
  e.deleteScheduler("mondays");
  assert.ok(!e.listSchedulers().some((s) => s.id === "mondays"));
});

test("a broken scheduler script fails the rating without losing the card", async (t) => {
  const e = await open(t);
  e.saveScheduler({ id: "boom", name: "Boom", ratings: false, schedule: "throw new Error('nope')" });
  e.upsertItem({ id: "b", type: "basic", deck: "B", fields: { front: "b", back: "B" } });
  e.updateDeck("B", { config: { scheduler: "boom" } });
  const card = e.next({ deck: "B" }).card!;
  assert.throws(() => e.rate(card.cardId, 0), /scheduler "boom"/);
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM reviews")!.n, 0);
  assert.equal(e.next({ deck: "B" }).card?.cardId, card.cardId);
});

test("the FSRS optimizer skips decks on another scheduler", async (t) => {
  const e = await open(t);
  e.savePreset({ id: "p", name: "P", config: {} });
  e.ensureDeck("Drill");
  e.updateDeck("Drill", { presetId: "p", config: { scheduler: "drill" } });
  await assert.rejects(() => e.optimizeWeights({ preset: "p" }), /no FSRS deck takes its weights/);
});

test("the docs' every-monday example works, and packs carry custom schedulers both ways", async (t) => {
  const e = await open(t);
  const schedule = `let n = 0, seen = 0;
for (let i = 1; i < ctx.day.length; i++) {
  if (new Date(ctx.day[i]).getDay() === 1 && ++seen === options.weeks) { n = i; break; }
}
return { due: ctx.day[n], state: { runs: (card.state?.runs ?? 0) + 1 } };`;
  const pack = {
    etude: "pack/1",
    schedulers: [{ id: "every-monday", name: "Every Monday", ratings: false, options: [{ name: "weeks", kind: "number", default: 1, min: 1, max: 52 }], schedule }],
    decks: [{ name: "Weekly", config: { scheduler: "every-monday", schedulerOptions: { weeks: 2 } } }],
    items: [{ id: "wk", type: "basic", deck: "Weekly", fields: { front: "w", back: "W" } }],
  };
  const r = e.importPack(pack);
  assert.equal(r.schedulers.created, 1);
  const card = e.next({ deck: "Weekly" }).card!;
  const due = new Date(e.rate(card.cardId, 0).due);
  assert.equal(due.getDay(), 1);
  const days = (due.getTime() - Date.now()) / 864e5;
  assert.ok(days > 7 && days <= 14, `second Monday out, got ${days.toFixed(1)} days`);
  const out = e.exportPack({ deck: "Weekly" }) as any;
  assert.equal(out.schedulers?.[0]?.id, "every-monday");
  assert.equal(e.importPack(out).schedulers.unchanged, 1);
});

test("showVerdict: false reaches the study card and survives a save", async (t) => {
  const e = await open(t);
  const def = loadTypeDir(TYPING);
  assert.equal(def.showVerdict, false);
  e.saveType(def);
  assert.equal(e.type("typing").showVerdict, false);
  e.upsertItem({ id: "ty", type: "typing", deck: "T", fields: {} });
  assert.equal(e.next({ deck: "T" }).card!.showVerdict, false);
  e.upsertItem({ id: "b", type: "basic", deck: "B", fields: { front: "b", back: "B" } });
  assert.equal(e.next({ deck: "B" }).card!.showVerdict, true);
  assert.throws(() => e.saveType({ ...def, showVerdict: "no" as any }), /showVerdict/);
});

test("stats keep each scheduler's numbers apart: FSRS memory, Leitner boxes, drills ready", async (t) => {
  const e = await open(t);
  e.saveType(loadTypeDir(TYPING));
  for (const id of ["f1", "f2"]) e.upsertItem({ id, type: "basic", deck: "Facts", fields: { front: id, back: id } });
  for (const id of ["b1", "b2", "b3"]) e.upsertItem({ id, type: "basic", deck: "Boxes", fields: { front: id, back: id } });
  e.upsertItem({ id: "type", type: "typing", deck: "Typing", fields: { count: 10, target: 60 } });
  e.updateDeck("Boxes", { config: { scheduler: "leitner", schedulerOptions: { boxes: "1, 3, 7" } } });
  e.updateDeck("Typing", { config: { scheduler: "drill", schedulerOptions: { perDay: 0 } } });

  const f = e.next({ deck: "Facts" }).card!;
  e.rate(f.cardId, 3);
  const boxes = e.db.all("SELECT c.id FROM cards c JOIN items i ON i.id = c.item_id WHERE i.deck_id = (SELECT id FROM decks WHERE name = 'Boxes') ORDER BY i.id").map((r) => r.id as number);
  e.rate(boxes[0], 3);
  e.rate(boxes[0], 3, { at: new Date(Date.now() + 1000) }); // box 2
  e.rate(boxes[1], 1); // box 1, a miss
  const d = e.next({ deck: "Typing" }).card!;
  for (const seed of [1, 2, 3]) {
    const s = await e.submit(d.cardId, seed, typeIt(e, d.cardId, seed, 60));
    e.rate(d.cardId, 0, { attemptId: s.attemptId });
  }

  const all = e.stats({});
  // Card states are FSRS's: 2 cards, not 6.
  assert.deepEqual(all.cards, { total: 2, new: 1, learning: 1, review: 0, mature: 0 });
  // The forecast leaves the always-ready drill out; only FSRS + Leitner cards with reviews are in it.
  const dueSoon = all.forecast.reduce((a, x) => a + x.due, 0);
  assert.equal(dueSoon, 3, "1 FSRS card + 2 Leitner cards, no drill");
  assert.equal(all.overdue, 0, "the drill isn't overdue forever");
  // Drill runs aren't reviews.
  assert.equal(all.today.reviews, 4);
  assert.equal(all.today.runs, 3);
  assert.equal(all.days.at(-1)!.runs, 3);
  // Retention is FSRS-only.
  assert.equal(all.trueRetention.reviewed, 0);

  const by = Object.fromEntries(all.schedulers.map((x) => [x.id, x]));
  assert.deepEqual(all.schedulers.map((x) => x.id), ["fsrs", "leitner", "drill"]);
  assert.equal(by.fsrs.cards, 2);
  assert.equal(by.leitner.kind, "rated");
  assert.equal(by.leitner.cards, 3);
  assert.equal(by.leitner.new, 1);
  assert.equal(by.leitner.rated, 3);
  assert.equal(by.leitner.passed, 2);
  assert.ok(Math.abs(by.leitner.passRate! - 2 / 3) < 1e-9);
  assert.deepEqual(by.leitner.groups, { label: "Box", bins: [{ key: "1", cards: 1 }, { key: "2", cards: 1 }], other: 0 });
  assert.equal(by.drill.kind, "drill");
  assert.equal(by.drill.due, 1, "ready now");
  assert.equal(by.drill.answers, 3);
  assert.equal(by.drill.rated, 0);
  assert.equal(by.drill.passRate, null);
  assert.deepEqual(by.drill.decks, ["Typing"]);

  // A deck page sees only its own scheduler.
  const leitner = e.stats({ deck: "Boxes" });
  assert.equal(leitner.scheduler, "leitner");
  assert.deepEqual(leitner.schedulers.map((x) => x.id), ["leitner"]);
  assert.equal(leitner.cards.total, 0);
  assert.equal(leitner.recall, null);
  assert.equal(leitner.ratings.good, 2);
  assert.equal(leitner.ratings.again, 1);
});

test("a user scheduler can declare what Stats groups its cards by", async (t) => {
  const e = await open(t);
  assert.throws(() => e.saveScheduler({ id: "lv", name: "Levels", stats: { groupBy: "no spaces" }, schedule: "return { due: ctx.now }" } as any), /stats.groupBy/);
  e.saveScheduler({ id: "lv", name: "Levels", stats: { groupBy: "rank.level", label: "Level" }, schedule: "return { due: ctx.day[1], state: { rank: { level: attempt.rating } } }" });
  for (const id of ["a", "b"]) e.upsertItem({ id, type: "basic", deck: "L", fields: { front: id, back: id } });
  e.updateDeck("L", { config: { scheduler: "lv" } });
  const ids = e.db.all("SELECT id FROM cards ORDER BY id").map((r) => r.id as number);
  e.rate(ids[0], 2);
  e.rate(ids[1], 4);
  const s = e.stats({ deck: "L" }).schedulers[0];
  assert.deepEqual(s.groups, { label: "Level", bins: [{ key: "2", cards: 1 }, { key: "3", cards: 0 }, { key: "4", cards: 1 }], other: 0 });
  assert.equal(e.listSchedulers().find((x) => x.id === "lv")!.stats!.label, "Level");
});
