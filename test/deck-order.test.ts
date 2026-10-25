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
