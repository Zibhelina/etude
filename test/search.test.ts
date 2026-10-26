import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { run } from "../src/cli/run.ts";
import { compile } from "../src/core/query.ts";
import type { CardTypeDef } from "../src/core/model.ts";

// Like an upgraded Anki vocabulary type: the word and the meaning are answers (private), and the
// only markdown field is a private note.
const vocab: CardTypeDef = {
  id: "vocab",
  name: "Vocab",
  faces: ["meaning", "word"],
  fields: [
    { name: "word", kind: "text", required: true, private: true },
    { name: "bare", kind: "text" },
    { name: "audio", kind: "text" },
    { name: "meaning", kind: "text", private: true },
    { name: "plural", kind: "text", private: true },
    { name: "tip", kind: "markdown", private: true },
    { name: "layout", kind: "text", default: "mrgp" },
  ],
  template: { html: "<div>{{bare}}</div>" },
  grader: { kind: "self" },
};

// Stored with `layout` first, as an upgrade wrote them.
const words = [
  { id: "junge", fields: { layout: "mrgp", word: "der Junge", bare: "Junge", audio: "/media/anki/Junge.mp3", meaning: "A boy", plural: "Jungen, besonders norddeutsch Jungs" } },
  { id: "viel", fields: { layout: "mrp", word: "viel", bare: "viel", audio: "/media/anki/besonders_viel.mp3", meaning: "much" } },
  { id: "uebung", fields: { layout: "mrp", word: "die Übung", bare: "Übung", meaning: "practice", tip: '<span class="besonders">[sound:besonders.mp3]</span> Übung macht den Meister' } },
  { id: "besonders", fields: { layout: "mrp", word: "besonders", bare: "besonders", audio: "/media/anki/besonders.mp3", meaning: "especially" } },
];

async function setup() {
  const e = await Etude.open(":memory:");
  e.saveType(vocab);
  for (const w of words) e.upsertItem({ id: w.id, type: "vocab", deck: "German", fields: w.fields });
  return e;
}

const titles = (r: { rows: { itemId: string; title: string }[] }) => [...new Map(r.rows.map((x) => [x.itemId, x.title])).values()];
const items = (r: { rows: { itemId: string }[] }) => [...new Set(r.rows.map((x) => x.itemId))];

test("titles follow the type's field order, not the order fields were stored in", async () => {
  const e = await setup();
  assert.deepEqual(titles(e.search("deck:German", { order: "added" })), ["Junge", "viel", "Übung", "besonders"]);
  assert.equal(e.searchItems("id:junge").rows[0].title, "Junge");
});

test("titleField names the item in lists; a private one stays out of the card being studied", async () => {
  const e = await setup();
  e.saveType({ ...vocab, titleField: "word" });
  assert.deepEqual(titles(e.search("deck:German", { order: "added" })), ["der Junge", "viel", "die Übung", "besonders"]);
  const card = e.search("id:junge").rows[0].cardId;
  assert.equal(e.present(card).title, "Junge");
  assert.equal(e.watchList({ query: "id:junge" })[0].title, "Junge");

  assert.throws(() => e.saveType({ ...vocab, titleField: "nope" }), /titleField/);
  assert.throws(() => e.saveType({ ...vocab, fields: [...vocab.fields, { name: "n", kind: "number" }], titleField: "n" }), /titleField/);
  // Dropping it goes back to the automatic title.
  e.saveType(vocab);
  assert.equal(e.searchItems("id:junge").rows[0].title, "Junge");
  // A field with a default is a setting, never a title: without `bare`, lists fall back to the private word.
  e.upsertItem({ id: "ohne", type: "vocab", deck: "German", fields: { layout: "mrp", word: "ohne" } });
  assert.equal(e.searchItems("id:ohne").rows[0].title, "ohne");
  assert.equal(e.present(e.search("id:ohne").rows[0].cardId).title, "");
  e.upsertItem({ id: "heart", type: "occlusion", deck: "Anatomy", fields: { image: "/media/files/heart.png", boxes: [{ id: "a", x: 0, y: 0, w: 0.1, h: 0.1, label: "Aorta" }] } });
  assert.equal(e.searchItems("id:heart").rows[0].title, "");
});

test("free text ignores case in every script, and never matches markup, media file names or field names", async () => {
  const e = await setup();
  for (const q of ["übung", "ÜBUNG", "Übung", "meister"]) assert.deepEqual(items(e.search(q)), ["uebung"], q);
  // In Junge's plural and Besonders' word; not Viel's audio file, Übung's markup or sound tag.
  assert.deepEqual(items(e.search("besonders", { order: "added" })), ["junge", "besonders"]);
  assert.equal(e.search("mp3").total, 0);
  assert.equal(e.search("layout").total, 0);
  assert.deepEqual(items(e.search('"macht den"')), ["uebung"]);
  assert.deepEqual(items(e.search("id:jun*")), ["junge"]);
});

test("relevance puts the item titled with the word first", async () => {
  const e = await setup();
  assert.deepEqual(items(e.search("besonders")), ["besonders", "junge"]);
  assert.deepEqual(e.searchItems("besonders").rows.map((r) => r.id), ["besonders", "junge"]);
  // A word that starts the title beats one inside another field; without free text it's the order added.
  e.upsertItem({ id: "jung", type: "vocab", deck: "German", fields: { word: "jung", bare: "jung", meaning: "young", tip: "not der Junge" } });
  assert.deepEqual(items(e.search("junge")), ["junge", "jung"]);
  assert.deepEqual(items(e.search("deck:German")), ["junge", "viel", "uebung", "besonders", "jung"]);
  // Equally good matches: the shorter title first, whatever was added first.
  e.upsertItem({ id: "gen", type: "vocab", deck: "German", fields: { word: "x", bare: 'Genitive of "dieser Hund"' } });
  e.upsertItem({ id: "hund", type: "vocab", deck: "German", fields: { word: "der Hund", bare: "ein Hund" } });
  assert.deepEqual(items(e.search("hund")), ["hund", "gen"]);
  // Only words that must match rank.
  assert.deepEqual(compile("-viel -(besonders OR x) bar").rank, compile("bar").rank);
  assert.equal(compile("-viel deck:German").rank, null);
});

test("field search: one field by name, case-insensitive, empty for missing", async () => {
  const e = await setup();
  assert.deepEqual(items(e.search("bare:junge")), ["junge"]);
  assert.deepEqual(items(e.search("MEANING:boy")), ["junge"]);
  assert.deepEqual(items(e.search("meaning:boy OR meaning:much", { order: "added" })), ["junge", "viel"]);
  assert.deepEqual(items(e.search("plural:", { order: "added" })), ["viel", "uebung", "besonders"]);
  assert.deepEqual(items(e.search("deck:German -plural:", { order: "added" })), ["junge"]);
  assert.deepEqual(items(e.search("-bare:junge", { order: "added" })), ["viel", "uebung", "besonders"]);
  assert.equal(e.search("audio:besonders").total, 0);
  assert.equal(e.search("tip:übung").total, 2);
  assert.throws(() => e.search("nofield:x"), /unknown search key "nofield:"/);
  // Fields of built-in types work too.
  e.upsertItem({ id: "b1", type: "basic", deck: "Other", fields: { front: "What is a router?", back: "A packet switch." } });
  assert.deepEqual(items(e.search("front:router")), ["b1"]);
  assert.equal(e.search("back:router").total, 0);
});

test("stored titles and search text are rebuilt when a collection is opened by a version that derives them differently", async () => {
  const path = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-search-")), "etude.db");
  let e = await Etude.open(path);
  e.saveType(vocab);
  for (const w of words) e.upsertItem({ id: w.id, type: "vocab", deck: "German", fields: w.fields });
  // What a collection looks like right after the columns were added.
  e.db.run("UPDATE items SET title = '', search = ''");
  e.db.run("DELETE FROM meta WHERE key = 'item_index'");
  e.close();
  e = await Etude.open(path);
  assert.equal(e.searchItems("besonders").rows[0].title, "besonders");
  assert.deepEqual(items(e.search("übung")), ["uebung"]);
  // An item an older version saved meanwhile (it doesn't know the columns) is filled in on the next open.
  e.db.run("UPDATE items SET title = '', search = '' WHERE id = 'viel'");
  e.close();
  e = await Etude.open(path);
  assert.deepEqual(e.searchItems("viel").rows.map((r) => [r.id, r.title]), [["viel", "viel"]]);
  e.close();
});

test("CLI: item list and --query use field search and relevance", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-search-cli-"));
  const e = await Etude.open(join(dir, "etude.db"));
  e.saveType(vocab);
  for (const w of words) e.upsertItem({ id: w.id, type: "vocab", deck: "German", fields: w.fields });
  e.close();
  const cli = async (args: string[]) => {
    let out = "";
    const code = await run(args, { stdout: (s) => (out += s), stderr: () => {}, stdin: () => "", isTTY: false, env: { ETUDE_HOME: dir } });
    return { code, out };
  };
  assert.equal((await cli(["item", "list", "besonders", "--ids"])).out.trim(), "besonders\njunge");
  assert.equal((await cli(["item", "tag", "--query", "bare:junge", "-t", "noun"])).code, 0);
  assert.deepEqual(JSON.parse((await cli(["item", "list", "tag:noun"])).out).rows.map((r: { id: string }) => r.id), ["junge"]);
  assert.equal((await cli(["search", "nofield:x"])).code, 4);
});
