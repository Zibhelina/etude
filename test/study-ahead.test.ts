import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";

test("study ahead: cards that aren't due still come up, soonest first, and rating them is a real review", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-ahead-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const e = await Etude.open(join(dir, "etude.db"));
  t.after(() => e.close());
  e.upsertItem({ id: "a", type: "basic", deck: "D", fields: { front: "a", back: "A" } });
  e.upsertItem({ id: "b", type: "basic", deck: "D", fields: { front: "b", back: "B" } });
  const ids = e.db.all("SELECT c.id FROM cards c JOIN items i ON i.id = c.item_id ORDER BY i.id").map((r: any) => r.id as number);
  // Push both into review, due in 3 and 9 days.
  const soon = new Date(Date.now() + 3 * 864e5).toISOString(), later = new Date(Date.now() + 9 * 864e5).toISOString();
  e.db.run("UPDATE cards SET state = 2, stability = 5, difficulty = 5, reps = 2, last_review = ?, due = ? WHERE id = ?", new Date(Date.now() - 2 * 864e5).toISOString(), later, ids[0]);
  e.db.run("UPDATE cards SET state = 2, stability = 5, difficulty = 5, reps = 2, last_review = ?, due = ? WHERE id = ?", new Date(Date.now() - 2 * 864e5).toISOString(), soon, ids[1]);

  assert.equal(e.next({ deck: "D" }).card, null, "nothing due normally");
  const c = e.counts({ deck: "D", ahead: true });
  assert.equal(c.review, 2);
  const n = e.next({ deck: "D", ahead: true });
  assert.equal(n.card?.cardId, ids[1], "soonest due first");
  const r = e.rate(ids[1], 3);
  assert.ok(r.reviewId, "logged as a review");
  assert.equal(e.db.get("SELECT practice FROM reviews WHERE id = ?", r.reviewId)!.practice, 0);
  const n2 = e.next({ deck: "D", ahead: true }, { exclude: ids[1] });
  assert.equal(n2.card?.cardId, ids[0]);
});
