import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Etude } from "../src/core/engine.ts";

const dirs: string[] = [];
// Best effort: Windows can't delete a database that is still open.
process.on("exit", () => dirs.forEach((d) => { try { rmSync(d, { recursive: true, force: true }); } catch {} }));
async function fresh() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-anki-io-"));
  dirs.push(dir);
  return { e: await Etude.open(join(dir, "etude.db"), { home: dir }), dir };
}

// Image occlusion notes from Anki (fixtures built by scripts/make-occlusion-fixtures.ts).

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/anki/${name}`, import.meta.url));

test("anki: built-in Image Occlusion notes become occlusion items, one card per cloze", async () => {
  const { e } = await fresh();
  const r = e.importAnki(fixture("io-builtin.apkg"));
  assert.equal(r.items.created, 1);
  assert.equal(r.cards, 3);
  assert.equal(r.reviews, 2, "review history comes across");
  const it = e.item("anki-ioBuiltin1");
  assert.equal(it.type, "occlusion");
  const f = it.fields as any;
  assert.equal(f.image, "/media/anki/heart-io.png");
  assert.match(f.header, /anterior/);
  assert.match(f.extra, /Great vessels/);
  assert.match(f.extra, /Comments/);
  assert.equal(f.mode, "hide-all", "oi=1 is hide all");
  // c1 rect; c2 a rect and an ellipse (its bounding box) asked together; c3 a polygon's bounding box; the text shape is skipped.
  assert.deepEqual(it.cards.map((c) => c.face).sort(), ["c1", "c2", "c3"]);
  assert.deepEqual(f.boxes.find((b: any) => b.id === "c1"), { id: "c1", x: 0.1, y: 0.2, w: 0.25, h: 0.1, label: "" });
  assert.deepEqual(f.boxes.filter((b: any) => b.group === "c2").map((b: any) => [b.x, b.y, b.w, b.h]), [[0.5, 0.2, 0.1, 0.1], [0.7, 0.2, 0.1, 0.1]]);
  assert.deepEqual(f.boxes.find((b: any) => b.id === "c3"), { id: "c3", x: 0.1, y: 0.6, w: 0.2, h: 0.2, label: "" });
  // The reviewed card keeps its schedule.
  const c1 = it.cards.find((c) => c.face === "c1")!;
  assert.equal(c1.reps, 2);
  assert.notEqual(c1.state, 0);
  // No labels in Anki IO: the cards reveal and self-grade.
  const card = e.present(c1.id, 1);
  assert.equal(card.grader, "self");
  assert.equal((await e.grade(c1.id, 1, "")).grade.verdict, "ungraded");
  // Re-importing changes nothing.
  const again = e.importAnki(fixture("io-builtin.apkg"));
  assert.equal(again.items.unchanged, 1);
  assert.equal(again.reviews, 0);
});

test("anki: Image Occlusion Enhanced notes merge into one item per mask; unreadable ones stay plain", async () => {
  const { e } = await fresh();
  const r = e.importAnki(fixture("io-enhanced.apkg"));
  assert.equal(r.items.created, 2);
  assert.equal(r.reviews, 2);
  assert.ok(r.skipped.some((s) => s.what === "occlusion" && /1 note/.test(s.reason)));
  const it = e.item("anki-ioe-u1");
  const f = it.fields as any;
  assert.equal(it.type, "occlusion");
  assert.deepEqual(it.cards.map((c) => c.face).sort(), ["n1", "n2", "n3"]);
  // Normalised by the SVG's 400×300 size; a <g> of rects is one group.
  assert.deepEqual(f.boxes.find((b: any) => b.id === "n1"), { id: "n1", x: 0.1, y: 0.2, w: 0.25, h: 0.1, label: "" });
  assert.deepEqual(f.boxes.filter((b: any) => b.group === "n3").map((b: any) => [b.x, b.y, b.w, b.h]), [[0.1, 0.6667, 0.1, 0.0667], [0.75, 0.6667, 0.1, 0.0667]]);
  assert.match(f.header, /Skull/);
  assert.match(f.extra, /Count the bones/);
  assert.match(f.extra, /Sources/);
  assert.equal(it.cards.find((c) => c.face === "n1")!.reps, 2);
  // The note whose mask is missing keeps the generic import.
  assert.equal(e.item("anki-ioeBroken").type, "anki-image-occlusion-enhanced");
});
