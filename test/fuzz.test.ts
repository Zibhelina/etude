import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import * as sched from "../src/core/scheduler.ts";
import { DEFAULT_PRESET, type CardRow } from "../src/core/model.ts";

const temp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fuzz-test-"));
const DAY = 86400_000;
const card = (over: Partial<CardRow & { sync_id: string }> = {}): CardRow & { sync_id?: string } => ({
  ...sched.emptyCard(new Date("2027-01-01T00:00:00Z")),
  id: 1,
  item_id: "item-1",
  face: "main",
  suspended: 0,
  buried_until: null,
  ...over,
});
/** The seed ts-fsrs drew this review's fuzz from. */
const seedOf = (row: CardRow, at: Date) => {
  const f = sched.engine({ ...DEFAULT_PRESET, enableFuzz: true });
  f.next(sched.toFsrs(row), at, 3);
  return (f as any)._seed as string;
};

test("the fuzz seed is the card's key and the review's number, with no time or floating point in it", () => {
  const reviewed = card({ state: 2, reps: 3, stability: 12.345678901234567, difficulty: 5.4321, last_review: "2027-01-01T00:00:00.000Z", due: "2027-01-13T00:00:00.000Z" });
  const at = new Date("2027-01-14T09:30:00.123Z");
  assert.equal(seedOf(reviewed, at), '["item-1","main"]:4');
  assert.equal(seedOf({ ...reviewed, sync_id: '["item-0","front"]' } as CardRow, at), '["item-0","front"]:4', "the sync key when there is one");
  assert.equal(sched.cardKey({ item_id: 'quote " and ü', face: "main" }), JSON.stringify(['quote " and ü', "main"]));
  // The last bit of stability or difficulty can differ between JavaScript engines; it doesn't move the seed.
  const bit = (x: number) => { const b = new Float64Array([x]), i = new BigUint64Array(b.buffer); i[0] ^= 1n; return b[0]; };
  assert.notEqual(bit(reviewed.stability), reviewed.stability);
  assert.equal(seedOf({ ...reviewed, stability: bit(reviewed.stability), difficulty: bit(reviewed.difficulty) }, at), '["item-1","main"]:4');
  // Neither does the moment: the rating buttons and the rating a few seconds later draw the same fuzz.
  assert.equal(seedOf(reviewed, new Date(at.getTime() + 4321)), '["item-1","main"]:4');
  assert.equal(seedOf({ ...reviewed, reps: 4 }, at), '["item-1","main"]:5', "the next review draws again");
});

test("the rating buttons show the interval that rating then gives", async () => {
  const dir = temp();
  const e = await Etude.open(join(dir, "a.db"), { home: join(dir, "home") });
  try {
    for (let i = 0; i < 12; i++) e.upsertItem({ id: `item-${i}`, deck: "Fuzz", type: "basic", fields: { front: `q ${i}`, back: "a" } });
    const ids = e.db.all("SELECT id FROM cards").map((r) => r.id as number);
    // Reviewed three weeks ago, so every rating but Again lands on a fuzzed interval of days.
    for (const id of ids) e.rate(id, 4, { at: new Date(Date.now() - 21 * DAY) });
    let fuzzed = 0;
    for (const id of ids) for (const rating of [1, 2, 3, 4] as const) {
      const shown = new Date(e.cardSchedule(id).intervals[rating]).getTime();
      const before = Date.now();
      const due = new Date(e.rate(id, rating).due).getTime();
      // Both count from their own moment, a few milliseconds apart.
      assert.ok(Math.abs(due - shown) <= Date.now() - before + 1000, `card ${id}, rating ${rating}: shown ${new Date(shown).toISOString()}, given ${new Date(due).toISOString()}`);
      if (rating > 1 && Math.round((due - Date.now()) / DAY) > 2) fuzzed++;
      e.undo();
    }
    assert.ok(fuzzed > 20, "the comparison covered fuzzed intervals");
  } finally {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
