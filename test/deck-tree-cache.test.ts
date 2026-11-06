import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";

// Every page asks for the deck tree; its counts build each deck's study queue, so it's kept while nothing changes.
test("the deck tree is reused while nothing changes, and rebuilt after a review, another connection's write or 30 s", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "deck-tree-"));
  const file = join(dir, "etude.db");
  const e = await Etude.open(file, { home: join(dir, "home") });
  // Closed before the folder goes: Windows won't remove an open file.
  t.after(() => (e.close(), rmSync(dir, { recursive: true, force: true })));
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

// The deck tree reads every card once and builds each deck's queue from its share; the counts must be the ones
// each deck's own queue gives.
test("the deck tree's counts match each deck's own queue", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "deck-tree-counts-"));
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  t.after(() => (e.close(), rmSync(dir, { recursive: true, force: true })));
  // Subdecks, one whose name differs only in case (SQLite's LIKE matches it as a subdeck), a tour, an adaptive deck.
  const decks = ["Lang", "Lang::Words", "Lang::Words::Hard", "LANG::Upper", "Langs::Other", "Tour", "Course", "Course::Unit 1"];
  let n = 0;
  for (const deck of decks) for (let i = 0; i < 6; i++) e.upsertItem({ id: `c${n++}`, deck, type: "basic", fields: { front: `${deck} ${i}`, back: "a" }, tags: [] });
  e.updateDeck("Tour", { config: { mode: "watch" } });
  e.updateDeck("Course", { config: { adaptivePace: true } });
  e.updateDeck("Lang", { config: { newPerDay: 4, reviewsPerDay: 2 } });
  e.updateDeck("Lang::Words", { config: { newPerFace: { front: 1 } } });
  // Today's answers count against the limits; some cards are due again, buried or suspended.
  const card = (id: string) => e.item(id).cards[0].id;
  const reviewed = ["c0", "c1", "c6", "c7", "c9", "c10", "c18", "c42"];
  for (const id of reviewed) e.rate(card(id), 4, { at: new Date(Date.now() - 3 * 86400_000) });
  e.setDue(reviewed.map(card), new Date(Date.now() - 3600_000));
  for (const id of ["c0", "c6"]) e.rate(card(id), 1);
  e.setBuried([card("c2"), card("c8")]);
  e.setSuspended([card("c3"), card("c19")], true);
  const keys = ["new", "learning", "learningSoon", "review", "doneToday", "nextDue"] as const;
  for (const d of [...e.deckTree(), ...e.deckTree({ archived: true })]) {
    if (!d.cards) continue;
    const own = e.counts({ deck: d.name });
    for (const k of keys) assert.deepEqual(d[k], own[k], `${d.name}: ${k}`);
  }
  const tree = e.deckTree();
  assert.ok(tree.some((d) => d.review > 0) && tree.some((d) => d.new > 0) && tree.some((d) => d.learningSoon > 0), "the fixture has reviews, new cards and relearning");
  assert.equal(tree.find((d) => d.name === "Lang")!.review, 0, "Lang's two reviews a day are used up");
});
