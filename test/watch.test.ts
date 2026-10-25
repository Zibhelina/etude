import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Etude } from "../src/core/engine.ts";

const showcase = JSON.parse(readFileSync(new URL("../examples/showcase.pack.json", import.meta.url), "utf8"));

async function fresh() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-watch-"));
  const e = await Etude.open(join(dir, "etude.db"), { home: dir });
  e.importPack(showcase);
  return e;
}

test("the showcase is a watch deck with one card for every card type", async () => {
  const e = await fresh();
  const list = e.watchList({ deck: "Etude Showcase" });
  const types = new Set(list.map((c) => c.type));
  assert.equal(list.length, types.size, "one card per type");
  assert.equal(types.size, e.listTypes().length, "every type is in the tour");
  assert.equal(e.configFor("Etude Showcase::5 Play and listen").mode, "watch");
});

test("watch decks stay out of study queues and counts", async () => {
  const e = await fresh();
  assert.equal(e.next({ deck: "Etude Showcase" }).card, null);
  assert.equal(e.counts({}).new, 0);
  // Switching the deck back to study puts its cards in the queue.
  e.updateDeck("Etude Showcase", { config: { mode: "study" } });
  assert.ok(e.next({ deck: "Etude Showcase" }).card);
});

test("every example answer grades as the item intends, across variants", async () => {
  const e = await fresh();
  for (const c of e.watchList({ deck: "Etude Showcase" })) {
    for (let k = 0; k < 4; k++) {
      const { card, demo } = e.watchCard(c.cardId);
      // Example answers never reach the card itself.
      assert.equal("demo" in card.view || "demoGrade" in card.view, false, `${c.itemId}: demo leaked into the view`);
      if (demo.grade) {
        assert.ok(demo.grade.grader.example, `${c.itemId}: a shipped grade is marked as an example`);
        continue;
      }
      const g = await e.watchGrade(c.cardId, card.seed, demo.answer);
      if (card.grader === "self") assert.equal(g.grade.verdict, "ungraded");
      else assert.equal(g.grade.verdict, "correct", `${c.itemId} seed ${card.seed}: ${g.grade.feedback ?? ""}`);
    }
  }
});

test("watching records nothing", async () => {
  const e = await fresh();
  const [c] = e.watchList({ deck: "Etude Showcase" });
  const { card, demo } = e.watchCard(c.cardId);
  await e.watchGrade(c.cardId, card.seed, demo.answer);
  assert.equal(e.stats({ deck: "Etude Showcase" }).cards.new, e.watchList({ deck: "Etude Showcase" }).length);
  assert.equal(e.item(c.itemId).attempts.length, 0);
  assert.equal(e.item(c.itemId).reviews.length, 0);
});

test("a type's demo script must parse", async () => {
  const e = await fresh();
  const def = { ...e.type("typed"), id: "typed-x", demo: "return (" };
  assert.throws(() => e.saveType(def), /demo/);
});
