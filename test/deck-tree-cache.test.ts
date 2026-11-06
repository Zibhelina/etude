import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";

// Every page asks for the deck tree; its counts build each deck's study queue, so it's kept while nothing changes.
test("the deck tree is reused while nothing changes, and rebuilt after a review, another connection's write or 30 s", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "deck-tree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "etude.db");
  const e = await Etude.open(file, { home: join(dir, "home") });
  t.after(() => e.close());
  for (let i = 0; i < 3; i++) e.upsertItem({ id: `q${i}`, deck: "Lang::Words", type: "basic", fields: { front: `q${i}`, back: "a" }, tags: [] });
  const words = (tree: ReturnType<Etude["deckTree"]>) => tree.find((d) => d.name === "Lang::Words")!;
  const first = e.deckTree();
  assert.equal(words(first).new, 3);
  assert.equal(e.deckTree(), first, "nothing changed: the same tree");
  assert.notEqual(e.deckTree({ archived: true }), first, "archived decks are a tree of their own");
  // A review here.
  e.rate(e.item("q0").cards[0].id, 3);
  const afterReview = e.deckTree();
  assert.notEqual(afterReview, first);
  assert.equal(words(afterReview).new, 2);
  // A write through another connection (the CLI next to the app).
  const other = await Etude.open(file, { home: join(dir, "home") });
  other.upsertItem({ id: "q9", deck: "Lang::Words", type: "basic", fields: { front: "q9", back: "a" }, tags: [] });
  other.close();
  assert.equal(words(e.deckTree()).new, 3);
  // Time moves on: cards come due without any write.
  const kept = e.deckTree();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 29_000 });
  assert.equal(e.deckTree(), kept);
  t.mock.timers.setTime(Date.now() + 2_000);
  assert.notEqual(e.deckTree(), kept);
});
