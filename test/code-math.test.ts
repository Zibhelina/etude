import { test } from "node:test";
import assert from "node:assert/strict";
import { Etude } from "../src/core/engine.ts";
import { checkPack } from "../src/cli/pack-check.ts";
import { initSandbox } from "../src/core/sandbox.ts";
import math from "../runtime/mathexpr.js";

test("math answers compare by value, not by spelling", () => {
  const same: [string, string][] = [
    ["\\frac{1}{2}", "0.5"], ["\\frac12", "1/2"], ["(x+1)^2", "x^2+2x+1"], ["\\sin^2 x + \\cos^2 x", "1"],
    ["\\sqrt{x^2}", "|x|"], ["\\log_2 8", "3"], ["\\sqrt[3]{-8}", "-2"], ["y = 2x+1", "2x - y + 1 = 0"],
    ["x = 3", "3"], ["\\{1, 2, 3\\}", "3, 2, 1"], ["\\tan^{-1} 1", "\\pi/4"], ["5!", "120"], ["\\theta", "θ"],
    ["\\left(\\frac{a}{b}\\right)^{-1}", "b/a"], ["\\frac{n(n+1)(2n+1)}{6}", "n^3/3+n^2/2+n/6"],
  ];
  for (const [a, b] of same) assert.equal(math.equivalent(a, b).equal, true, `${a} ~ ${b}`);
  const different: [string, string][] = [["\\sqrt{x^2}", "x"], ["x^2", "x^3"], ["(1, 2)", "(2, 1)"], ["3.14", "\\pi"]];
  for (const [a, b] of different) assert.equal(math.equivalent(a, b).equal, false, `${a} !~ ${b}`);
  assert.throws(() => math.parse("\\frac{1}{"), math.MathSyntaxError);
});

test("math grading forms: exact, same and partial lists", () => {
  assert.equal(math.check("-0.87", ["-\\frac{\\sqrt3}{2}"], { form: "exact" }).score, 0.5);
  assert.equal(math.check("-0.8", ["-\\frac{\\sqrt3}{2}"]).score, 0);
  assert.equal(math.check("(x-3)(x-2)", ["(x-2)(x-3)"], { form: "same" }).score, 1);
  assert.equal(math.check("(2-x)(3-x)", ["(x-2)(x-3)"], { form: "same" }).score, 1);
  assert.equal(math.check("x^2-5x+6", ["(x-2)(x-3)"], { form: "same" }).score, 0.5);
  assert.equal(math.check("3", ["\\{3, -1\\}"]).score, 0.5);
  assert.equal(math.toLatex(math.parse("sqrt(3)/2")), "\\frac{\\sqrt{3}}{2}");
});

const pack = {
  etude: "pack/1",
  items: [
    { id: "t.math", type: "math", deck: "T", fields: { prompt: "Factor $x^2-1$", answers: ["(x-1)(x+1)"], form: "same" } },
    {
      id: "t.code",
      type: "code",
      deck: "T",
      fields: {
        prompt: "add",
        language: "javascript",
        reference: "function add(a, b) { return a + b; }",
        tests: [["add(1, 2)", 3], ["add(-1, 1)", 0], ["add('a', 'b')", "ab"]],
      },
    },
  ],
};

test("the math and code types grade through the engine", async () => {
  const e = await Etude.open(":memory:");
  e.updateSettings({ ai: { decision: null, feedback: null, vision: null, autoFeedback: "never", language: "English" } });
  e.importPack(pack);
  const card = (item: string) => e.db.get("SELECT id FROM cards WHERE item_id = ?", item)!.id as number;
  assert.equal((await e.grade(card("t.math"), 1, "(x+1)(x-1)")).grade.score, 1);
  assert.equal((await e.grade(card("t.math"), 1, "x^2-1")).grade.score, 0.5);
  const right = await e.grade(card("t.code"), 1, "function add(a, b) { return a + b; }");
  assert.equal(right.grade.score, 1);
  const wrong = await e.grade(card("t.code"), 1, "function add(a, b) { return Number(a) + Number(b); }");
  assert.ok(Math.abs((wrong.grade.score ?? 0) - 2 / 3) < 1e-9);
  assert.equal((wrong.grade.details as { tests: { ok: boolean }[] }).tests.filter((t) => !t.ok).length, 1);
  // A runaway answer times out and leaves the attempt ungraded instead of hanging.
  const loop = await e.grade(card("t.code"), 1, "while (true) {}");
  assert.equal(loop.grade.score, null);
});

test("pack check runs code references against their tests and reads math answers", async () => {
  await initSandbox();
  assert.equal(checkPack(pack).ok, true);
  const broken = structuredClone(pack);
  (broken.items[1].fields as { reference: string }).reference = "function add(a, b) { return a - b; }";
  (broken.items[0].fields as { answers: string[] }).answers = ["(x-1)(x+"];
  const r = checkPack(broken);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes("reference fails its tests")));
  assert.ok(r.errors.some((m) => m.includes("can't be read")));
});
