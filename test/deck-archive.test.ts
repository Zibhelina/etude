import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";

function add(e: Etude, id: string, deck: string) {
  e.upsertItem({ id, deck, type: "basic", fields: { front: id, back: "answer" }, tags: ["test"] });
  return e.item(id).cards[0].id;
}

test("decks: archive and restore a subtree, keeping cards and history out of study while archived", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const card = add(e, "course", "Course");
  add(e, "unit", "Course::Unit");
  add(e, "other", "Other");
  e.rate(card, 3);
  const before = e.item("course");
  const reviews = e.db.all("SELECT * FROM reviews");

  assert.deepEqual(e.setDeckArchived("course", true, { subdecks: true }), { decks: ["Course", "Course::Unit"], archived: true });
  assert.deepEqual(e.deckTree().map((d) => d.name), ["Other"]);
  const archived = e.deckTree({ archived: true }).filter((d) => d.archived);
  assert.deepEqual(archived.map((d) => [d.name, d.cards]), [["Course", 2], ["Course::Unit", 1]]);
  assert.equal(e.counts({ deck: "Course" }).new, 0);
  assert.equal(e.counts({}).new, 1);
  assert.equal(e.next({ deck: "Course", ahead: true }).card, null);
  assert.deepEqual(e.item("course"), before);
  assert.deepEqual(e.db.all("SELECT * FROM reviews"), reviews);

  e.setDeckArchived("Course", false, { subdecks: true });
  assert.equal(e.deckTree().find((d) => d.name === "Course")!.cards, 2);
  assert.equal(e.counts({ deck: "Course" }).new, 1);
  assert.deepEqual(e.item("course"), before);
  assert.deepEqual(e.db.all("SELECT * FROM reviews"), reviews);
  e.setDeckArchived("Course::Unit", true);
  assert.equal(e.deckTree().find((d) => d.name === "Course")!.cards, 1);
  assert.equal(e.deckTree({ archived: true }).find((d) => d.name === "Course")!.cards, 1);
});

test("decks: deleting content is explicit, counts all cards, and cascades only through the chosen subtree", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const card = add(e, "root", "Course%_");
  add(e, "child", "Course%_::Child");
  add(e, "keep", "CourseXX");
  e.saveType({ id: "pair", name: "Pair", fields: [{ name: "q", kind: "text" }], faces: ["forward", "reverse"], template: { html: "{{q}}" }, grader: { kind: "self" } });
  e.upsertItem({ id: "pair", deck: "Course%_::Child", type: "pair", fields: { q: "two faces" } });
  e.rate(card, 3);
  e.setArchived(["child"], true);
  e.setDeckArchived("Course%_::Child", true);
  assert.deepEqual(e.deckUsage("course%_"), { items: 3, cards: 4 });

  assert.throws(() => e.deleteDeck("Course%_"), /holds 3 item/);
  assert.deepEqual(e.deckUsage("Course%_"), { items: 3, cards: 4 });
  e.deleteDeck("Course%_", { items: true });
  assert.throws(() => e.deck("Course%_"), /unknown deck/);
  assert.throws(() => e.deck("Course%_::Child"), /unknown deck/);
  assert.equal(e.item("keep").deck, "CourseXX");
  for (const table of ["items", "cards", "item_tags"]) assert.equal(e.db.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n, 1, table);
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM reviews")!.n, 0);
  assert.deepEqual(e.db.all("PRAGMA foreign_key_check"), []);
  e.ensureDeck("Empty::Child");
  assert.deepEqual(e.deckUsage("Empty"), { items: 0, cards: 0 });
  e.deleteDeck("Empty");
  assert.throws(() => e.deck("Empty::Child"), /unknown deck/);
});

test("decks API: list archives, restore, inspect deletion count and explicitly delete content", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  add(e, "root", "Course::Unit");
  const app = createApp(e);
  const mutate = (path: string, method: string, body: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await mutate("/api/deck/archive?name=Course", "POST", { archived: true, subdecks: true })).status, 200);
  assert.deepEqual(await (await app.request("/api/decks")).json(), []);
  const archived = await (await app.request("/api/decks?archived=1")).json();
  assert.deepEqual(archived.map((d: any) => [d.name, d.archived, d.cards]), [["Course", true, 1], ["Course::Unit", true, 1]]);
  assert.deepEqual(await (await app.request("/api/deck/usage?name=Course")).json(), { items: 1, cards: 1 });
  assert.equal((await mutate("/api/deck?name=Course", "DELETE", {})).status, 400);
  assert.equal((await mutate("/api/deck/archive?name=Course", "POST", { archived: "false" })).status, 400);
  assert.equal(e.deck("Course").archived, true);
  assert.equal((await mutate("/api/deck/archive?name=Course", "POST", { archived: false, subdecks: true })).status, 200);
  assert.equal(e.deckTree().length, 2);
  assert.equal((await mutate("/api/deck?name=Course", "DELETE", { items: true })).status, 200);
  assert.equal(e.deckTree({ archived: true }).length, 0);
});
