import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";

const dirs: string[] = [];
// Best effort: Windows can't delete a database that is still open.
process.on("exit", () => dirs.forEach((d) => { try { rmSync(d, { recursive: true, force: true }); } catch {} }));
async function fresh() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-occlusion-"));
  dirs.push(dir);
  return { e: await Etude.open(join(dir, "etude.db"), { home: dir }), dir };
}

const HEART = [
  { id: "b1", x: 0.1, y: 0.1, w: 0.2, h: 0.1, label: "Aorta|aortic arch" },
  { id: "b2", x: 0.5, y: 0.1, w: 0.2, h: 0.1, label: "Pulmonary trunk" },
  { id: "b3", x: 0.1, y: 0.6, w: 0.1, h: 0.1, label: "Right atrium", group: "atria" },
  { id: "b4", x: 0.6, y: 0.6, w: 0.1, h: 0.1, label: "Left atrium", group: "atria" },
  { id: "b5", x: 0.4, y: 0.8, w: 0.1, h: 0.1, label: "Apex" },
];

function add(e: Etude, boxes = HEART, extra: Record<string, unknown> = {}) {
  e.upsertItem({ id: "heart", type: "occlusion", deck: "Anatomy", fields: { image: "/media/heart.png", boxes, extra: "Look at the **great vessels**.", ...extra } });
  return Object.fromEntries(e.db.all<{ id: number; face: string }>("SELECT id, face FROM cards WHERE item_id = 'heart'").map((c) => [c.face, c.id]));
}
const grade = async (e: Etude, card: number, answer: string) => (await e.grade(card, 1, answer)).grade;

test("one card per box, one per group", async () => {
  const { e } = await fresh();
  const cards = add(e);
  assert.deepEqual(Object.keys(cards).sort(), ["atria", "b1", "b2", "b5"]);
});

test("the view never carries labels; the key does", async () => {
  const { e } = await fresh();
  const cards = add(e);
  const card = e.present(cards.b1, 1);
  assert.equal(JSON.stringify(card.view).includes("Aorta"), false);
  assert.equal(JSON.stringify(card.view).includes("atrium"), false);
  const v = card.view as any;
  assert.equal(v.boxes.length, 5);
  assert.deepEqual(v.boxes.filter((b: any) => b.target).map((b: any) => b.id), ["b1"]);
  assert.ok(v.boxes.every((b: any) => b.cover), "hide-all covers every box");
  assert.equal(card.grader, "script");
});

test("hide-one covers only the asked box", async () => {
  const { e } = await fresh();
  const cards = add(e, HEART, { mode: "hide-one" });
  const v = e.present(cards.atria, 1).view as any;
  assert.deepEqual(v.boxes.filter((b: any) => b.cover).map((b: any) => b.id), ["b3", "b4"]);
  assert.equal(v.asked, 2);
});

test("grading: case, accents, punctuation, alternatives", async () => {
  const { e } = await fresh();
  const cards = add(e);
  for (const a of ["Aorta", "aorta", "  AORTA. ", "Aórta", "aortic arch", "Aortic-Arch!"]) assert.equal((await grade(e, cards.b1, a)).score, 1, a);
  assert.equal((await grade(e, cards.b2, "pulmonary trunk")).score, 1);
});

test("grading: typos scale with length", async () => {
  const { e } = await fresh();
  const cards = add(e);
  // "aorta" is 5 letters: one slip is fine, two aren't.
  assert.equal((await grade(e, cards.b1, "aotra")).score, 1, "transposition");
  assert.equal((await grade(e, cards.b1, "aorto")).score, 1);
  assert.equal((await grade(e, cards.b1, "orto")).score, 0);
  // "pulmonary trunk" is long: two slips pass, three don't.
  assert.equal((await grade(e, cards.b2, "pulmonery trnk")).score, 1);
  assert.equal((await grade(e, cards.b2, "pulmonery trnk x")).score, 0);
  const g = await grade(e, cards.b2, "pulmonery trunk");
  assert.match(g.feedback ?? "", /spelled \*\*Pulmonary trunk\*\*/);
  // Short labels must be exact.
  assert.equal((await grade(e, cards.b5, "apex")).score, 1);
  assert.equal((await grade(e, cards.b5, "apx")).score, 0);
});

test("grading: another box's label is never accepted, and feedback names it", async () => {
  const { e } = await fresh();
  const cards = add(e);
  const g = await grade(e, cards.b1, "pulmonary trunk");
  assert.equal(g.score, 0);
  assert.match(g.feedback ?? "", /That's \*\*Pulmonary trunk\*\*.*This one is \*\*Aorta\*\*/);
  // A near-miss that is closer to another box's name counts as that box.
  const labels = [
    { id: "a", x: 0, y: 0, w: 0.1, h: 0.1, label: "Ilium" },
    { id: "b", x: 0.5, y: 0, w: 0.1, h: 0.1, label: "Ileum" },
  ];
  const c = add(e, labels);
  assert.equal((await grade(e, c.a, "Ileum")).score, 0);
  assert.equal((await grade(e, c.a, "Ilium")).score, 1);
});

test("grading: groups take one answer, any of their labels", async () => {
  const { e } = await fresh();
  const cards = add(e);
  assert.equal((await grade(e, cards.atria, "right atrium")).score, 1);
  assert.equal((await grade(e, cards.atria, "left atrium")).score, 1);
  assert.equal((await grade(e, cards.atria, "apex")).score, 0);
});

test("an empty answer means show me: score 0 with the name", async () => {
  const { e } = await fresh();
  const cards = add(e);
  const g = await grade(e, cards.b1, "");
  assert.equal(g.score, 0);
  assert.equal(g.verdict, "incorrect");
  assert.match(g.feedback ?? "", /Aorta/);
});

test("an unlabeled box is shown and self-graded", async () => {
  const { e } = await fresh();
  const cards = add(e, [
    { id: "b1", x: 0.1, y: 0.1, w: 0.2, h: 0.1, label: "" },
    { id: "b2", x: 0.5, y: 0.1, w: 0.2, h: 0.1, label: "Pulmonary trunk" },
  ] as any);
  const card = e.present(cards.b1, 1);
  assert.equal(card.grader, "self");
  assert.equal((card.view as any).selfGraded, true);
  const g = await grade(e, cards.b1, "anything");
  assert.equal(g.verdict, "ungraded");
  assert.equal(g.grader.kind, "self");
  // The labelled one next to it still grades by script.
  assert.equal(e.present(cards.b2, 1).grader, "script");
  assert.equal((await grade(e, cards.b2, "pulmonary trunk")).score, 1);
});

test("adding a box adds a card and keeps the old ones with their history", async () => {
  const { e } = await fresh();
  const before = add(e, HEART.slice(0, 2));
  const s = await e.submit(before.b1, 1, "aorta");
  e.rate(before.b1, 3, { attemptId: s.attemptId });
  const after = add(e, [...HEART.slice(0, 2), { id: "b9", x: 0.8, y: 0.8, w: 0.1, h: 0.1, label: "Vena cava" }]);
  assert.deepEqual(Object.keys(after).sort(), ["b1", "b2", "b9"]);
  assert.equal(after.b1, before.b1, "same card row");
  assert.equal(e.item("heart").reviews.length, 1);
  // Removing a box keeps its card too (never deleted), so history isn't lost.
  const removed = add(e, HEART.slice(1, 2));
  assert.ok(removed.b1);
});

test("watch: the demo answer grades correct", async () => {
  const { e } = await fresh();
  const cards = add(e);
  for (const id of Object.values(cards)) {
    const { card, demo } = e.watchCard(id);
    const g = await e.watchGrade(id, card.seed, demo.answer);
    assert.equal(g.grade.verdict, "correct");
  }
});

test("boxes must be set", async () => {
  const { e } = await fresh();
  assert.throws(() => e.upsertItem({ id: "x", type: "occlusion", deck: "A", fields: { image: "/media/a.png" } }), /boxes/);
});

// ---------------------------------------------------------------- CLI

import { run } from "../src/cli/run.ts";
import { writeFileSync } from "node:fs";

async function cli(home: string, argv: string[]) {
  let out = "", err = "";
  const code = await run(argv, { env: { ETUDE_HOME: home }, stdout: (s: string) => (out += s), stderr: (s: string) => (err += s), stdin: () => "", isTTY: false } as any);
  return { code, out: out ? JSON.parse(out) : null, err };
}
const PNG_800x500 = () => {
  // A PNG header is enough for the size reader; the rest isn't parsed.
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(800, 16);
  b.writeUInt32BE(500, 20);
  return b;
};

test("cli: occlusion add copies the image, converts pixels and makes one card per box or group", async () => {
  const { dir } = await fresh();
  const img = join(dir, "heart.png");
  writeFileSync(img, PNG_800x500());
  const args = ["occlusion", "add", img, "--deck", "Anatomy::Heart", "--px", "--box", "100,100,200,100=Aorta|aortic arch", "--box", "400,100,100,50@atria=Right atrium", "--box", "520,100,100,50@atria=Left atrium", "--box", "10,400,50,50"];
  const dry = await cli(dir, [...args, "--dry-run"]);
  assert.equal(dry.code, 0, dry.err);
  assert.equal(dry.out.dryRun, true);
  const r = await cli(dir, args);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.result, "created");
  assert.match(r.out.image, /^\/media\/files\/[0-9a-f]{64}\.png$/);
  assert.deepEqual(r.out.boxes[0], { id: "b1", x: 0.125, y: 0.2, w: 0.25, h: 0.2, label: "Aorta|aortic arch" });
  assert.deepEqual(r.out.cards.map((c: any) => c.face), ["b1", "atria", "b4"]);
  assert.deepEqual(r.out.selfGraded, ["b4"]);
  // Same command again changes nothing.
  assert.equal((await cli(dir, args)).out.result, "unchanged");
  // Out-of-range fractions are refused with a pointer to --px.
  const bad = await cli(dir, ["occlusion", "add", img, "--deck", "A", "--box", "0.9,0.9,0.3,0.3=X"]);
  assert.equal(bad.code, 4);
  assert.match(bad.err + JSON.stringify(bad.out), /--px/);
});

test("cli: item add/edit with fields JSON works for occlusion items", async () => {
  const { dir } = await fresh();
  const boxes = JSON.stringify([{ id: "b1", x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: "Femur" }]);
  const a = await cli(dir, ["item", "add", "--type", "occlusion", "--deck", "Bones", "--id", "leg", "--fields", JSON.stringify({ image: "/media/leg.png", boxes: JSON.parse(boxes) })]);
  assert.equal(a.code, 0, a.err);
  const more = JSON.stringify([...JSON.parse(boxes), { id: "b2", x: 0.5, y: 0.5, w: 0.1, h: 0.1, label: "Tibia" }]);
  const b = await cli(dir, ["item", "edit", "leg", "--set", `boxes=${more}`]);
  assert.equal(b.code, 0, b.err);
  assert.deepEqual(b.out.item.cards.map((c: any) => c.face), ["b1", "b2"]);
});
