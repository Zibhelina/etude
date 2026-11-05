import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude, deckIcon } from "../src/core/engine.ts";
import { install } from "../src/core/sync/log.ts";
import { createApp } from "../src/server/app.ts";

test("decks: an icon is art, one emoji or none, and survives a rename", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  e.ensureDeck("Geo::Asia");
  assert.equal(e.deck("Geo").icon, null);
  assert.equal(e.updateDeck("Geo", { icon: "art:world" }).icon, "art:world");
  assert.equal(e.updateDeck("Geo", { description: "maps" }).icon, "art:world");
  e.updateDeck("Geo", { name: "Geography" });
  assert.equal(e.deck("Geography").icon, "art:world");
  assert.equal(e.deckTree().find((d) => d.name === "Geography")!.icon, "art:world");
  assert.equal(e.updateDeck("Geography::Asia", { icon: "emoji:🗾" }).icon, "emoji:🗾");
  assert.equal(e.updateDeck("Geography::Asia", { icon: "none" }).icon, null);
  for (const ok of ["emoji:🇧🇷", "emoji:👩🏽‍💻", "emoji:❤️"]) assert.equal(deckIcon(ok), ok);
  for (const bad of ["world", "art:", "art:../x", "emoji:", "emoji:hi", "emoji:🌍 🌍x", "emoji:" + "🌍".repeat(13)]) assert.throws(() => deckIcon(bad), /deck icon/, bad);
  assert.equal(deckIcon(""), null);
});

test("decks: the icon goes through the API", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  e.ensureDeck("Chess");
  const app = createApp(e);
  const res = await app.request("/api/deck?name=Chess", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ icon: "art:chess" }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).icon, "art:chess");
  const bad = await app.request("/api/deck?name=Chess", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ icon: "<script>" }) });
  assert.equal(bad.status, 400);
  assert.equal(e.deck("Chess").icon, "art:chess");
});

test("decks: an older synced collection gets the icon column and syncs it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "etude-icon-"));
  const path = join(dir, "c.db");
  let e = await Etude.open(path);
  // One cleanup, closing before removing: Windows can't delete a database that is still open.
  t.after(() => {
    e.close();
    rmSync(dir, { recursive: true, force: true });
  });
  e.ensureDeck("Old");
  // A collection from before icons: no column, sync triggers made without it.
  install(e.db);
  for (const op of ["insert", "update", "delete"]) e.db.sql.exec(`DROP TRIGGER sync_decks_${op}`);
  e.db.sql.exec("ALTER TABLE decks DROP COLUMN icon");
  install(e.db);
  e.close();
  e = await Etude.open(path);
  e.db.run("DELETE FROM sync_outbox");
  e.updateDeck("Old", { icon: "art:memory" });
  const out = e.db.all("SELECT value FROM sync_outbox WHERE tbl = 'decks'");
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0].value).icon, "art:memory");
});

test("decks: the archive summary folds subdecks in and predicts recall", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  for (const [id, deck] of [["a", "Course"], ["b", "Course::Unit"], ["c", "Course::Unit"], ["d", "Other"], ["e", "Live::Old"]]) e.upsertItem({ id, deck, type: "basic", fields: { front: id, back: "x" } });
  for (const id of ["a", "b"]) e.rate(e.item(id).cards[0].id, 3);
  e.setDeckArchived("Course", true, { subdecks: true });
  e.ensureDeck("Live");
  e.setDeckArchived("Live::Old", true);
  e.updateDeck("Course", { icon: "art:exams" });
  const s = e.archiveSummary();
  assert.deepEqual(s.map((d) => d.name), ["Course", "Live::Old"]);
  const c = s[0];
  assert.equal(c.icon, "art:exams");
  assert.equal(c.cards, 3);
  assert.equal(c.studied, 2);
  assert.deepEqual(c.subdecks, [{ name: "Course::Unit", cards: 2 }]);
  assert.ok(c.recall! > 0.9 && c.recall! <= 1, String(c.recall));
  assert.ok(c.lastReview);
  assert.equal(c.curve.length, 25);
  const last = c.curve.at(-1)!;
  assert.ok(last.days >= 14 && last.recall < c.recall!, JSON.stringify(last));
  assert.equal(s[1].recall, null);
  assert.deepEqual(s[1].curve, []);
  e.setDeckArchived("Course", false, { subdecks: true });
  assert.deepEqual(e.archiveSummary().map((d) => d.name), ["Live::Old"]);
});
