import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Etude } from "../src/core/engine.ts";
import { checkPack } from "../src/cli/pack-check.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/anki/${name}`, import.meta.url));

const opened: { e: Etude; dir: string }[] = [];
async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "etude-anki-test-"));
  const e = await Etude.open(join(dir, "etude.db"));
  opened.push({ e, dir });
  return { e, dir };
}
// Best effort: Windows can't delete a database that is still open.
process.on("exit", () => {
  for (const { dir } of opened) try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

const itemWith = (e: Etude, needle: string) => {
  const row = e.db.get<{ id: string }>("SELECT id FROM items WHERE fields LIKE ?", `%${needle}%`);
  assert.ok(row, `no item holding ${needle}`);
  return row.id;
};
const cardOf = (e: Etude, itemId: string, face = "t0") => {
  const row = e.db.get<{ id: number }>("SELECT id FROM cards WHERE item_id = ? AND face = ?", itemId, face);
  assert.ok(row, `no ${face} card for ${itemId}`);
  return row.id;
};
const faces = (e: Etude, itemId: string) => e.db.all<{ face: string }>("SELECT face FROM cards WHERE item_id = ? ORDER BY face", itemId).map((r) => r.face);
const answerOf = async (e: Etude, cardId: number) => (await e.grade(cardId, 1, "")).prep.key as { answerHtml: string; accepted: string[] };

test("imports a current-format .apkg", async () => {
  const { e } = await fresh();
  const report = e.importAnki(fixture("sample.apkg"));
  assert.equal(report.format, "new");
  assert.equal(report.items.created, 10);
  assert.equal(report.cards, 14);
  assert.equal(report.reviews, 16);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 10);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cards")!.n, 14);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviews")!.n, 16);
  assert.equal(report.types.created, 7);
  assert.deepEqual(report.read, { notes: 10, cards: 14, reviews: 16 });
});

test("takes a Buffer, as an upload would", async () => {
  const { e } = await fresh();
  const report = e.importAnki(readFileSync(fixture("sample.apkg")));
  assert.equal(report.items.created, 10);
  assert.equal(report.format, "new");
});

test("imports a legacy .apkg and a .colpkg the same way", async () => {
  for (const [name, format] of [
    ["sample-legacy.apkg", "legacy"],
    ["sample.colpkg", "new"],
  ] as const) {
    const { e } = await fresh();
    const report = e.importAnki(fixture(name));
    assert.equal(report.format, format, name);
    assert.equal(report.items.created, 10, name);
    assert.equal(report.cards, 14, name);
    assert.equal(report.reviews, 16, name);
    assert.equal(itemWith(e, "Ottawa"), itemWith(e, "Ottawa"), name);
    assert.deepEqual(faces(e, itemWith(e, "Ottawa")), ["c1", "c2", "c3"], name);
  }
});

test("keeps the deck tree, drops filtered decks and their cards go home", async () => {
  const { e } = await fresh();
  const report = e.importAnki(fixture("sample.apkg"));
  const names = e.db.all<{ name: string }>("SELECT name FROM decks ORDER BY name").map((d) => d.name);
  assert.deepEqual(names, ["Geo", "Geo::Capitals", "Lang"]);
  assert.ok(!names.includes("Cram"));
  assert.ok(report.skipped.some((s) => s.name === "Cram" && s.what === "deck"));
  // The card that Anki had moved into "Cram" comes back to Geo::Capitals.
  const deck = e.db.get<{ name: string }>("SELECT d.name FROM items i JOIN decks d ON d.id = i.deck_id WHERE i.id = ?", itemWith(e, "Japan"));
  assert.equal(deck!.name, "Geo::Capitals");
  assert.equal(e.deck("Geo::Capitals").description, "Capital <b>cities</b>");
});

test("presets come from Anki deck configs", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"));
  const preset = e.listPresets().find((p) => p.name === "Exam cram")!;
  assert.ok(preset, "no Exam cram preset");
  assert.deepEqual(preset.config.learningSteps, ["2m", "30m", "1d"]);
  assert.deepEqual(preset.config.relearningSteps, ["5m"]);
  assert.equal(preset.config.newPerDay, 33);
  assert.equal(preset.config.reviewsPerDay, 333);
  assert.equal(preset.config.maximumInterval, 365);
  assert.equal(preset.config.desiredRetention, 0.85);
  assert.equal(preset.config.burySiblings, false);
  // Decks on that config use it.
  assert.equal(e.deck("Geo::Capitals").presetId, "anki-exam-cram");
  assert.equal(e.deck("Geo::Capitals").resolved.learningSteps.length, 3);
});

test("a cloze note only gets cards for the clozes it has", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"));
  assert.deepEqual(faces(e, itemWith(e, "Ottawa")), ["c1", "c2", "c3"]);
  assert.deepEqual(faces(e, itemWith(e, "nasce no leste")), ["c1"]);
  // The type itself offers every cloze the collection uses (3), the item picks its own.
  assert.deepEqual(e.type("anki-cloze").faces, ["c1", "c2", "c3"]);
});

test("an optional reverse only makes a second card when its field is filled", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"));
  assert.deepEqual(faces(e, itemWith(e, "cão")), ["t0", "t1"]);
  assert.deepEqual(faces(e, itemWith(e, "peixe")), ["t0"]);
});

test("a template gated on a field that holds only an image still makes its card", async () => {
  const { e } = await fresh();
  const report = e.importAnki(fixture("media-gate.apkg"));
  assert.equal(report.cards, 3);
  assert.deepEqual(faces(e, itemWith(e, "Atlantis")), ["t0", "t1"]);
  assert.deepEqual(faces(e, itemWith(e, "Lemuria")), ["t0"]);
});

test("suspended and buried cards keep that state", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"));
  const note = itemWith(e, "gato");
  const suspended = e.db.get<any>("SELECT * FROM cards WHERE item_id = ? AND suspended = 1", note)!;
  assert.ok(suspended, "no suspended card");
  const buried = e.db.get<any>("SELECT * FROM cards WHERE item_id = ? AND buried_until IS NOT NULL", note)!;
  assert.ok(buried, "no buried card");
  assert.ok(new Date(buried.buried_until) > new Date(), "buried until the future");
  // Buried cards stay out of the queue until then.
  const queue = e.queue({ deck: "Lang" });
  assert.ok(!queue.learning.concat(queue.reviews, queue.news).some((c: any) => c.itemId === note && c.face === buried.face));
});

test("media is copied and referenced through /media/anki", async () => {
  const { e, dir } = await fresh();
  const report = e.importAnki(fixture("sample.apkg"));
  assert.equal(report.media.files, 3);
  assert.ok(existsSync(join(e.mediaDir, "anki", "dot.png")));
  assert.ok(existsSync(join(e.mediaDir, "anki", "_myfont.ttf")));
  assert.ok(readFileSync(join(e.mediaDir, "anki", "dot.png")).length > 0);
  assert.ok(readdirSync(dir).length);
  const country = e.present(cardOf(e, itemWith(e, "France"))).view.html as string;
  assert.match(country, /src="\/media\/anki\/dot\.png"/);
  assert.doesNotMatch(country, /src="dot\.png"/);
  const css = e.type("anki-country-fancy").template.css ?? "";
  assert.match(css, /url\('\/media\/anki\/_myfont\.ttf'\)/);
  const math = (await answerOf(e, cardOf(e, itemWith(e, "e^{i")))).answerHtml;
  assert.match(math, /<audio controls[^>]*src="\/media\/anki\/beep\.mp3"/);
  assert.doesNotMatch(math, /\[sound:/);
});

test("renders Anki templates: conditionals, special fields, hint, text, math", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"));
  const country = cardOf(e, itemWith(e, "France"));
  const front = e.present(country).view.html as string;
  assert.match(front, /<div class=q>France<\/div>/, "field HTML is kept as HTML");
  assert.match(front, /<div><img/);
  assert.doesNotMatch(front, /no flag/, "the {{^F}} branch is dropped when the field is filled");
  assert.match(front, /geo::europe/);
  assert.match(front, /Geo::Capitals/);
  assert.match(front, /Capitals/, "{{Subdeck}} is the leaf");
  assert.match(front, /Card 1/, "{{Card}}");
  assert.match(front, /Country \(fancy\)/, "{{Type}}");
  const back = (await answerOf(e, country)).answerHtml;
  assert.match(back, /<b>Paris<\/b>/);
  assert.match(back, /<hr id=answer>/);
  assert.match(back, /anki-hint/, "{{hint:}}");
  assert.match(back, /<b>Paris<\/b><br>/, "{{text:}} strips tags");
  // A field with only an image still counts as filled, so the other branch shows.
  const japan = e.present(cardOf(e, itemWith(e, "Japan"))).view.html as string;
  assert.match(japan, /no flag/);
  // MathJax delimiters are left for the frame to typeset.
  const math = e.present(cardOf(e, itemWith(e, "e^{i"))).view.html as string;
  assert.match(math, /\\\(e\^\{i\\pi\}\\\)/);
});

test("cloze cards hide only their own cloze", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"));
  const note = itemWith(e, "Ottawa");
  const q1 = e.present(cardOf(e, note, "c1")).view.html as string;
  assert.match(q1, /^<span class="cloze">\[\.\.\.\]<\/span> is the capital of Canada/);
  const q2 = e.present(cardOf(e, note, "c2")).view.html as string;
  assert.match(q2, /\[country\]/, "the cloze hint shows on the question");
  assert.match(q2, /^Ottawa is the capital of/);
  const a2 = (await answerOf(e, cardOf(e, note, "c2"))).answerHtml;
  assert.match(a2, /<span class="cloze">Canada<\/span>/);
});

test("typed answers are graded against the field", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"));
  const typed = cardOf(e, itemWith(e, "Portuguese for"));
  assert.match(e.present(typed).view.html as string, /<input[^>]+class="e-input anki-type"/);
  assert.equal((await e.grade(typed, 1, { typed: "casa" })).grade.score, 1);
  assert.equal((await e.grade(typed, 1, { typed: " Casa " })).grade.score, 1, "case and padding ignored");
  assert.equal((await e.grade(typed, 1, { typed: "caza" })).grade.score, 0);
  assert.equal((await e.grade(typed, 1, { typed: "" })).grade.score, null, "blank stays ungraded");
  // {{type:cloze:Text}} compares against the active cloze.
  const clozeTyped = cardOf(e, itemWith(e, "nasce no leste"), "c1");
  assert.equal((await e.grade(clozeTyped, 1, { typed: "sol" })).grade.score, 1);
  assert.equal((await e.grade(clozeTyped, 1, { typed: "lua" })).grade.score, 0);
  const clozeKey = (await e.grade(clozeTyped, 1, "")).prep.key as { answerHtml: string; accepted: string[] };
  assert.deepEqual(clozeKey.accepted, ["sol"]);
  assert.match(clozeKey.answerHtml, /<span class="cloze">sol<\/span>/);
});

test("scheduling history, FSRS state and due dates come across", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"));
  const rows = e.db.all<any>("SELECT * FROM reviews ORDER BY ts");
  assert.equal(rows.length, 16);
  assert.deepEqual([...new Set(rows.map((r) => r.rating))].sort(), [1, 2, 3, 4]);
  const review = e.db.get<any>("SELECT * FROM cards WHERE item_id = ?", itemWith(e, "Japan"))!;
  assert.equal(review.state, 2);
  assert.ok(review.stability > 0 && review.difficulty > 0, "FSRS memory state");
  assert.ok(review.last_review, "last review time");
  const due = new Date(review.due).getTime();
  const createdAt = 1792494000 * 1000;
  assert.ok(due > createdAt && due - Date.now() < 400 * 86_400_000, "due is a real date");
});

test("--no-scheduling imports content only", async () => {
  const { e } = await fresh();
  const report = e.importAnki(fixture("sample-nosched.apkg"), { scheduling: false });
  assert.equal(report.reviews, 0);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviews")!.n, 0);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cards WHERE state != 0 OR suspended != 0 OR buried_until IS NOT NULL")!.n, 0);
  assert.equal(report.cards, 14);
  assert.equal((await answerOf(e, cardOf(e, itemWith(e, "Ottawa"), "c1"))).answerHtml.includes("Ottawa"), true);
});

test("re-importing updates instead of duplicating", async () => {
  const { e } = await fresh();
  const first = e.importAnki(fixture("sample.apkg"));
  assert.equal(first.items.created, 10);
  assert.equal(first.presets.created > 0, true);
  const second = e.importAnki(fixture("sample.apkg"));
  assert.equal(second.items.created, 0);
  assert.equal(second.items.unchanged, 10);
  assert.deepEqual(second.presets, { created: 0, updated: 0, unchanged: first.presets.created });
  assert.equal(second.types.updated + second.types.created, 0);
  assert.equal(second.cards, 14);
  assert.equal(second.reviews, 0);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 10);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cards")!.n, 14);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviews")!.n, 16);
  // Studying between imports isn't undone, and the review isn't imported twice.
  const card = cardOf(e, itemWith(e, "France"));
  e.rate(card, 3);
  e.importAnki(fixture("sample.apkg"));
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviews")!.n, 17);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviews WHERE card_id = ?", card)!.n, 2);
});

test("a dry run writes nothing", async () => {
  const { e } = await fresh();
  const before = e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n;
  const report = e.importAnki(fixture("sample.apkg"), { dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.items.created, 10);
  assert.equal(report.cards, 14);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, before);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cards")!.n, 0);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM types WHERE builtin = 0")!.n, 0);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM decks WHERE name LIKE 'Geo%'")!.n, 0);
  assert.ok(!existsSync(join(e.mediaDir, "anki")), "no media written");
});

test("a deck prefix nests the import under one deck", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"), { deckPrefix: "Anki" });
  const names = e.db.all<{ name: string }>("SELECT name FROM decks WHERE name NOT LIKE 'Anki::%' ORDER BY name").map((d) => d.name);
  assert.deepEqual(names, ["Anki"]);
  assert.equal(e.deck("Anki::Geo::Capitals").resolved.learningSteps.length, 3);
});

test("rejects files that aren't Anki packages", async () => {
  const { e } = await fresh();
  assert.throws(() => e.importAnki(Buffer.from("not a zip")), /not an Anki package/);
  assert.throws(() => e.importAnki(Buffer.alloc(0)), /empty/);
});

test("tags keep their :: hierarchy", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"));
  const item = e.item(itemWith(e, "France"));
  assert.deepEqual(item.tags.sort(), ["capitals", "geo::europe"]);
  assert.ok(e.listTags().some((t) => t.tag === "geo::europe"));
});

test("changing an imported item's type moves its cards onto the new faces with their history", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"));
  const single = itemWith(e, "peixe");
  const card = cardOf(e, single);
  const reviews = e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviews WHERE card_id = ?", card)!.n;
  e.upsertItem({ id: single, type: "typed", deck: e.item(single).deck, fields: { prompt: "peixe", answers: ["fish"] } });
  assert.deepEqual(faces(e, single), ["main"]);
  assert.equal(cardOf(e, single, "main"), card);
  assert.equal(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviews WHERE card_id = ?", card)!.n, reviews);

  const both = itemWith(e, "cão");
  const [t0, t1] = [cardOf(e, both, "t0"), cardOf(e, both, "t1")];
  e.upsertItem({ id: both, type: "free", deck: e.item(both).deck, fields: { prompt: "cão", reference: "dog" } });
  assert.deepEqual(faces(e, both), ["main", "t1"], "only as many cards move as the new type has faces");
  assert.equal(cardOf(e, both, "main"), t0);
  assert.equal(cardOf(e, both, "t1"), t1);
});

test("a pack exported from an Anki import passes pack check", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"));
  const pack = e.exportPack();
  assert.ok(pack.items.every((i: { id: string }) => i.id.startsWith("anki-")));
  const r = checkPack(pack);
  assert.deepEqual(r.errors, []);
  pack.items[0].id = "has spaces";
  assert.ok(checkPack(pack).errors.some((m) => m.includes("has spaces") && m.includes("id must")));
});

test("editing a cloze note adds the faces it gained and keeps the ones it lost", async () => {
  const { e } = await fresh();
  e.importAnki(fixture("sample.apkg"));
  const item = e.item(itemWith(e, "Ottawa"));
  e.upsertItem({ id: item.id, type: item.type, deck: item.deck, fields: { ...item.fields, Text: "{{c1::Ottawa}} {{c4::new}}" }, tags: item.tags });
  assert.deepEqual(faces(e, item.id), ["c1", "c2", "c3", "c4"]);
  e.upsertItem({ id: item.id, type: item.type, deck: item.deck, fields: { ...item.fields, Text: "{{c1::Ottawa}} {{c2::Canada}}" }, tags: item.tags });
  assert.deepEqual(faces(e, item.id), ["c1", "c2", "c3", "c4"], "a card that already exists is kept, along with its history");
});
