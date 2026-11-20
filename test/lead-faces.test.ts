import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";

async function open(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-lead-"));
  const e = await Etude.open(join(dir, "etude.db"));
  t.after(() => e.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return e;
}

const lesson = { id: "lesson", name: "Lesson", faces: ["play", "learn", "quiz"], leadFaces: ["learn"], fields: [{ name: "front", kind: "markdown" as const }], template: { html: "{{front}}" }, grader: { kind: "self" as const } };
const faces = (e: Etude, scope: Parameters<Etude["queue"]>[0]) => e.queue(scope).news.map((c) => `${c.item_id}.${c.face}`);

test("leadFaces: an item's other new cards wait while its lead card is new", async (t) => {
  const e = await open(t);
  e.saveType(lesson);
  for (const id of ["a", "b"]) e.upsertItem({ id, type: "lesson", deck: "L", fields: { front: id } });
  e.updateDeck("L", { config: { burySiblings: false } });
  // Only the lessons, though "play" was created first
  assert.deepEqual(faces(e, { deck: "L" }), ["a.learn", "b.learn"]);
  assert.deepEqual(faces(e, { deck: "L", ahead: true }), ["a.learn", "b.learn"]);
  assert.equal(e.next({ deck: "L" }).card!.face, "learn");
  assert.equal(e.counts({ deck: "L" }).new, 2);
  // a's lesson studied: a's other faces come in
  const aLearn = e.queue({ deck: "L" }).news.find((c) => c.item_id === "a")!;
  e.rate(aLearn.id, 3);
  assert.deepEqual(faces(e, { deck: "L" }).sort(), ["a.play", "a.quiz", "b.learn"]);
  // b's lesson suspended: nothing to wait for
  const bLearn = e.queue({ deck: "L" }).news.find((c) => c.item_id === "b" && c.face === "learn")!;
  e.setSuspended([bLearn.id], true);
  assert.deepEqual(faces(e, { deck: "L" }).sort(), ["a.play", "a.quiz", "b.play", "b.quiz"]);
});

test("leadFaces: a buried lead card still holds its siblings; other types are untouched", async (t) => {
  const e = await open(t);
  e.saveType(lesson);
  e.upsertItem({ id: "a", type: "lesson", deck: "L", fields: { front: "a" } });
  e.upsertItem({ id: "x", type: "basic", deck: "L", fields: { front: "x", back: "X" } });
  const learn = e.queue({ deck: "L" }).news.find((c) => c.face === "learn")!;
  e.setBuried([learn.id]);
  const news = faces(e, { deck: "L" });
  assert.ok(!news.includes("a.play") && !news.includes("a.quiz"), news.join(" "));
  assert.ok(news.includes("x.main"), news.join(" "));
});

test("leadFaces: validated against the type's faces, and kept on export", async (t) => {
  const e = await open(t);
  assert.throws(() => e.saveType({ ...lesson, leadFaces: ["lesson"] }), /leadFaces must name faces/);
  assert.throws(() => e.saveType({ ...lesson, leadFaces: "learn" as any }), /leadFaces must be a list/);
  e.saveType(lesson);
  assert.deepEqual(e.type("lesson").leadFaces, ["learn"]);
  e.upsertItem({ id: "a", type: "lesson", deck: "L", fields: { front: "a" } });
  const pack = e.exportPack({ deck: "L" }) as any;
  assert.deepEqual(pack.types.find((x: any) => x.id === "lesson").leadFaces, ["learn"]);
});
