// Review cards are due by study day, like Anki's: a card in review is due from the start of the study day its
// due date falls in (counted from `dayStartHour`). Learning cards keep their exact time. Stored timestamps are
// unchanged; only the comparison is by day. Times here are local, on dates away from daylight-saving changes.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

async function setup(t: TestContext, clock: Date) {
  t.mock.timers.enable({ apis: ["Date"], now: clock.getTime() });
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  e.updateSettings({ ai: { decision: null, feedback: null, vision: null, autoFeedback: "never", language: "English" } });
  return e;
}

/** Adds a basic card in `deck` and puts it in `state` (2 review, 1 learning, 3 relearning), due at `due`. */
function card(e: Etude, id: string, state: number, due: Date, deck = "D") {
  e.upsertItem({ id, type: "basic", deck, fields: { front: id, back: id.toUpperCase() } });
  const cid = e.db.get("SELECT id FROM cards WHERE item_id = ?", id)!.id as number;
  const last = new Date(due.getTime() - 3 * 86400_000).toISOString();
  e.db.run("UPDATE cards SET state = ?, stability = 3, difficulty = 5, reps = 2, last_review = ?, due = ?, scheduled_days = 3 WHERE id = ?", state, last, due.toISOString(), cid);
  return cid;
}

const reviewIds = (e: Etude, deck = "D") => e.queue({ deck }).reviews.map((c) => c.id).sort((a, b) => a - b);

test("a review card due later today is in the queue from the start of the study day; one due tomorrow isn't", async (t) => {
  const e = await setup(t, at(2026, 3, 20, 9));
  assert.equal(e.settings().dayStartHour, 4);
  const evening = card(e, "evening", 2, at(2026, 3, 20, 18));
  const tomorrow = card(e, "tomorrow", 2, at(2026, 3, 21, 18));
  const late = card(e, "late", 2, at(2026, 3, 15, 12));
  assert.deepEqual(reviewIds(e), [evening, late].sort((a, b) => a - b), "due today (any hour) and overdue, not tomorrow");
  const c = e.counts({ deck: "D" });
  assert.equal(c.review, 2);
  // The next thing coming due is tomorrow's card, when tomorrow's study day starts (4 am), not at 6 pm.
  assert.equal(c.nextDue, at(2026, 3, 21, 4).toISOString());
  // Studying it: it's offered now, nine hours before its timestamp.
  const first = e.next({ deck: "D" }).card!;
  assert.ok([evening, late].includes(first.cardId));
  assert.ok(!reviewIds(e).includes(tomorrow));
});

test("learning cards keep their exact due time, in minutes", async (t) => {
  const e = await setup(t, at(2026, 3, 20, 9));
  const soon = card(e, "soon", 1, at(2026, 3, 20, 9, 10)); // inside the 20-minute learn-ahead
  const later = card(e, "later", 3, at(2026, 3, 20, 15)); // relearning, later today
  const now = card(e, "now", 1, at(2026, 3, 20, 8, 59));
  const q = e.queue({ deck: "D" });
  assert.deepEqual(q.learning.map((c) => c.id), [now, soon], "only learning cards due within learn-ahead, by time");
  assert.equal(q.reviews.length, 0, "a learning card due later today isn't a review due today");
  const c = e.counts({ deck: "D" });
  assert.equal(c.learning, 1, "due right now");
  assert.equal(c.learningSoon, 2);
  assert.equal(c.nextDue, at(2026, 3, 20, 15).toISOString(), "the relearning card comes back at its exact time");
  assert.ok(!e.queue({ deck: "D" }).learning.some((x) => x.id === later));
  t.mock.timers.setTime(at(2026, 3, 20, 15).getTime());
  assert.ok(e.queue({ deck: "D" }).learning.some((x) => x.id === later), "and is due once its time comes");
});

test("the study day boundary follows dayStartHour (4 am)", async (t) => {
  // 2 am on the 21st is still the study day of the 20th.
  const e = await setup(t, at(2026, 3, 21, 2));
  const beforeFour = card(e, "before-four", 2, at(2026, 3, 21, 3, 30));
  const afterFour = card(e, "after-four", 2, at(2026, 3, 21, 4, 30));
  assert.deepEqual(reviewIds(e), [beforeFour], "3:30 am belongs to the day that started at 4 am yesterday");
  assert.equal(e.counts({ deck: "D" }).nextDue, at(2026, 3, 21, 4).toISOString());
  t.mock.timers.setTime(at(2026, 3, 21, 3, 59).getTime());
  assert.deepEqual(reviewIds(e), [beforeFour]);
  t.mock.timers.setTime(at(2026, 3, 21, 4).getTime());
  assert.deepEqual(reviewIds(e), [beforeFour, afterFour], "the new study day starts at 4 am sharp");
  // With the day starting at midnight, 3:30 am on the 21st is tomorrow when it's 11 pm on the 20th.
  t.mock.timers.setTime(at(2026, 3, 20, 23).getTime());
  assert.deepEqual(reviewIds(e), [beforeFour]);
  e.updateSettings({ dayStartHour: 0 });
  assert.deepEqual(reviewIds(e), []);
  assert.equal(e.counts({ deck: "D" }).nextDue, at(2026, 3, 21, 0).toISOString());
});

test("deck list, search, stats and the scheduler summary count due reviews as the queue does", async (t) => {
  const e = await setup(t, at(2026, 3, 20, 9));
  card(e, "evening", 2, at(2026, 3, 20, 18), "D::A");
  card(e, "late", 2, at(2026, 3, 18, 12), "D::B");
  card(e, "tomorrow", 2, at(2026, 3, 21, 18), "D::A");
  card(e, "learn-later", 1, at(2026, 3, 20, 15), "D::B");
  card(e, "learn-now", 1, at(2026, 3, 20, 8), "D::B");
  const tree = new Map(e.deckTree().map((d) => [d.name, d]));
  assert.equal(tree.get("D")!.review, 2);
  assert.equal(tree.get("D::A")!.review, 1);
  assert.equal(tree.get("D::B")!.review, 1);
  assert.equal(tree.get("D")!.review, e.counts({ deck: "D" }).review, "the tree agrees with the deck's own queue");
  assert.equal(tree.get("D")!.learning, 1);
  // is:due: today's reviews (by day) and learning cards due now (by time).
  const due = e.search("is:due").rows.map((r) => r.itemId).sort();
  assert.deepEqual(due, ["evening", "late", "learn-now"]);
  const s = e.stats({ deck: "D" });
  assert.equal(s.overdue, 1, "overdue means due on an earlier day");
  assert.equal(s.forecast[0].due, 4, "today: two reviews, both learning cards");
  assert.equal(s.forecast[1].due, 1);
  const fsrs = s.schedulers.find((x) => x.id === "fsrs")!;
  assert.equal(fsrs.due, 3, "two reviews today plus the learning card due now");
});

test("a drill keeps the exact time its script returned", async (t) => {
  const e = await setup(t, at(2026, 3, 20, 9));
  e.saveScheduler({ id: "hourly", name: "Hourly", ratings: false, schedule: "return { due: new Date(Date.parse(ctx.now) + 3600_000).toISOString() }" });
  e.upsertItem({ id: "drill", type: "basic", deck: "Drills", fields: { front: "x", back: "X" } });
  e.updateDeck("Drills", { config: { scheduler: "hourly" } });
  const cid = e.db.get("SELECT id FROM cards WHERE item_id = 'drill'")!.id as number;
  e.rate(cid, 0);
  assert.equal(e.db.get("SELECT state FROM cards WHERE id = ?", cid)!.state, 2);
  assert.equal(e.counts({ deck: "Drills" }).review, 0, "not ready for an hour, though it's due today");
  t.mock.timers.setTime(at(2026, 3, 20, 10, 1).getTime());
  assert.equal(e.counts({ deck: "Drills" }).review, 1);
});
