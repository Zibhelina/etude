import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";

test("decks: sibling order, subdecks follow their parent", async () => {
  const e = await Etude.open(":memory:");
  for (const n of ["Biology", "Chess", "Networks::Week 1", "Networks::Week 2", "Networks::Week 3", "Zoo"]) e.ensureDeck(n);
  const names = () => e.deckTree().map((d) => d.name);
  // No order yet: by name.
  assert.deepEqual(names(), ["Biology", "Chess", "Networks", "Networks::Week 1", "Networks::Week 2", "Networks::Week 3", "Zoo"]);

  assert.deepEqual(e.reorderDecks("", ["Networks", "Zoo"]), ["Networks", "Zoo", "Biology", "Chess"]);
  assert.deepEqual(names(), ["Networks", "Networks::Week 1", "Networks::Week 2", "Networks::Week 3", "Zoo", "Biology", "Chess"]);

  e.reorderDecks("Networks", ["networks::week 3"]);
  assert.deepEqual(names().slice(0, 4), ["Networks", "Networks::Week 3", "Networks::Week 1", "Networks::Week 2"]);

  // A new deck lands after the ordered ones; renaming keeps a deck's place.
  e.ensureDeck("Algebra");
  assert.deepEqual(names().filter((n) => !n.includes("::")), ["Networks", "Zoo", "Biology", "Chess", "Algebra"]);
  e.renameDeck("Zoo", "Zoology");
  assert.deepEqual(names().filter((n) => !n.includes("::")), ["Networks", "Zoology", "Biology", "Chess", "Algebra"]);
  assert.equal(e.deck("Zoology").position, 1);

  assert.throws(() => e.reorderDecks("", ["Networks::Week 1"]), /isn't a subdeck/);
  assert.throws(() => e.reorderDecks("Nope", []), /unknown deck/);
});

test("decks: move a subdeck to another deck, out to the top level, and back", async () => {
  const e = await Etude.open(":memory:");
  for (const n of ["Biology", "Networks::Week 1", "Networks::Week 2", "Networks::Week 2::Lab", "Games::Chess"]) e.ensureDeck(n);
  e.reorderDecks("", ["Networks", "Games", "Biology"]);
  const names = () => e.deckTree().map((d) => d.name);

  // Out to the top level at a given place, with its own subdeck.
  assert.equal(e.moveDeck("Networks::Week 2", "", 1).name, "Week 2");
  assert.deepEqual(names(), ["Networks", "Networks::Week 1", "Week 2", "Week 2::Lab", "Games", "Games::Chess", "Biology"]);

  // Into another deck; no index means last.
  e.moveDeck("Week 2", "Games");
  assert.deepEqual(names(), ["Networks", "Networks::Week 1", "Games", "Games::Chess", "Games::Week 2", "Games::Week 2::Lab", "Biology"]);
  e.moveDeck("Games::Week 2", "Games", 0);
  assert.deepEqual(names().slice(2, 5), ["Games", "Games::Week 2", "Games::Week 2::Lab"]);

  // A top-level deck becomes a subdeck.
  e.moveDeck("Biology", "Networks", 0);
  assert.deepEqual(names().slice(0, 3), ["Networks", "Networks::Biology", "Networks::Week 1"]);

  // Items and their cards come along.
  e.upsertItem({ id: "x.1", deck: "Games::Week 2::Lab", type: "basic", fields: { front: "q", back: "a" } });
  e.moveDeck("Games::Week 2", "Networks");
  assert.equal(e.item("x.1").deck, "Networks::Week 2::Lab");

  assert.throws(() => e.moveDeck("Networks", "Networks::Week 1"), /inside itself/);
  assert.throws(() => e.moveDeck("Networks", "Networks"), /inside itself/);
  e.ensureDeck("Week 1");
  assert.throws(() => e.moveDeck("Networks::Week 1", ""), /already has a deck called "Week 1"/);
  assert.equal(e.deck("Networks::Week 1").name, "Networks::Week 1");

});
