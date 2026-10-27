import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { DEFAULT_PRESET } from "../src/core/model.ts";
import { validateConfig } from "../src/core/scheduler.ts";
import { validateType } from "../src/core/types.ts";
import { initSandbox } from "../src/core/sandbox.ts";
import { checkPack } from "../src/cli/pack-check.ts";
import { fitSkills, levelState, pace, placementState } from "../src/core/learner.ts";

// A sentence type that picks the variant closest to the target when it gets a learner, and a random one otherwise.
const CONTEXT_TYPE = {
  id: "ctx",
  name: "Context",
  faces: ["read", "listen"],
  skills: { read: "reading", listen: "listening" },
  variants: { field: "sentences" },
  fields: [
    { name: "word", kind: "text" as const, required: true },
    { name: "sentences", kind: "json" as const },
  ],
  prepare: `
    const list = fields.sentences;
    let s;
    if (learner) {
      const known = list.filter((x) => x._known >= 1);
      s = (known.length ? known : list).slice().sort((a, b) => Math.abs(a._p - learner.target) - Math.abs(b._p - learner.target) || a._seen - b._seen || a.id.localeCompare(b.id))[0];
    } else s = rng.pick(list);
    return { view: { text: s.de, hasLearner: !!learner, skill: learner ? learner.skill : null, quick: learner ? learner.quickCheck : null }, key: { answer: fields.word, id: s.id }, variant: s.id, reason: learner ? "closest to your level" : undefined };
  `,
  template: { html: "{{text}}" },
  grader: { kind: "script" as const, code: "return { score: String(answer).trim() === key.answer ? 1 : 0 };" },
};

const LEVELS = ["level::1", "level::2", "level::3"];

async function setup(opts: { levels?: boolean; perLevel?: number } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-adaptive-"));
  const e = await Etude.open(join(dir, "etude.db"));
  e.saveType(CONTEXT_TYPE);
  const per = opts.perLevel ?? 2;
  let n = 0;
  for (const [li, tag] of LEVELS.entries())
    for (let k = 0; k < per; k++) {
      n++;
      e.upsertItem({
        id: `w${n}`,
        type: "ctx",
        deck: "Course::Unit",
        tags: opts.levels === false ? [] : [tag],
        fields: {
          word: `w${n}`,
          sentences: [
            { id: "easy", de: `easy ${n}`, difficulty: 0.1, requires: [] },
            { id: "hard", de: `hard ${n}`, difficulty: 0.9, requires: n > 1 ? ["w1"] : [] },
          ],
        },
      });
      void li;
    }
  return { e, dir, done: () => (e.close(), rmSync(dir, { recursive: true, force: true })) };
}

const cardOf = (e: Etude, item: string, face = "read") => e.db.get<{ id: number }>("SELECT id FROM cards WHERE item_id = ? AND face = ?", item, face)!.id;

test("adaptive settings are off by default, validated, and a plain deck behaves as before", async () => {
  await initSandbox();
  for (const k of ["adaptiveChallenge", "adaptivePace"] as const) assert.equal(DEFAULT_PRESET[k], false);
  assert.deepEqual(validateConfig({ adaptivePace: true, targetSuccess: null, newPerDayMin: 3, newPerDayMax: 9, levels: [{ tag: "level::1", check: "check::1" }], levelMix: 0.2 }), []);
  for (const bad of [{ adaptivePace: "yes" }, { targetSuccess: 0.3 }, { newPerDayMin: 9, newPerDayMax: 3 }, { levels: [{ tag: "a" }, { tag: "a" }] }, { levels: "a" }, { levelMix: 2 }])
    assert.equal(validateConfig(bad as never).length, 1, JSON.stringify(bad));
  assert.deepEqual(validateType(CONTEXT_TYPE), []);
  assert.ok(validateType({ ...CONTEXT_TYPE, variants: { field: "word" } }).some((m) => m.includes("variants.field")));
  assert.ok(validateType({ ...CONTEXT_TYPE, skills: { read: 3 } }).some((m) => m.includes("skills")));

  const { e, done } = await setup();
  const c = e.present(cardOf(e, "w1"), 5);
  assert.equal(c.asOf, undefined);
  assert.equal(c.view.hasLearner, false);
  const r = await e.submit(c.cardId, c.seed, "w1");
  assert.equal(r.grade.adaptive, undefined);
  assert.equal(r.grade.score, 1);
  assert.deepEqual(e.learnerSummary("Course"), { deck: "Course", adaptive: false });
  // Previews (type editor, `type preview`) run prepare without a learner.
  const pv = await e.previewType(e.type("ctx"), { word: "x", sentences: [{ id: "a", de: "a" }] }, { face: "read" });
  assert.equal((pv as any).view?.hasLearner, false, JSON.stringify(pv));
  done();
});

test("adaptive challenge gives prepare a learner, annotates variants and records the choice", async () => {
  const { e, done } = await setup({ levels: false });
  e.updateDeck("Course", { config: { adaptiveChallenge: true } });
  const id = cardOf(e, "w2");
  const c = e.present(id, 7);
  assert.ok(c.asOf);
  assert.equal(c.view.hasLearner, true);
  assert.equal(c.view.skill, "reading");
  assert.equal(e.present(cardOf(e, "w2", "listen"), 7).view.skill, "listening");

  const prep = e.prepare("w2", "read", 7, e.adaptContext(id, c.asOf!));
  const [easy, hard] = prep.fields.sentences as any[];
  for (const k of ["_p", "_known", "_seen", "_difficulty"]) assert.equal(typeof easy[k], "number", k);
  assert.ok(easy._p > hard._p, "an easier variant is predicted to go better");
  assert.equal(hard._known, 0, "w1 isn't known yet");

  const r = await e.submit(id, c.seed, "w2", { asOf: c.asOf });
  assert.equal(r.grade.adaptive?.variant, (r.key as Record<string, unknown>).id);
  assert.equal(r.grade.adaptive?.reason, "closest to your level");
  assert.equal(r.grade.adaptive?.skill, "reading");
  const stored = JSON.parse(e.db.get<{ grade: string }>("SELECT grade FROM attempts WHERE id = ?", r.attemptId)!.grade);
  assert.equal(stored.adaptive.variant, (r.key as Record<string, unknown>).id);

  // Generators get the learner too.
  e.upsertItem({ id: "gen", type: "basic", deck: "Course", fields: { front: "x", back: "y", generator: "return { front: learner ? 'adaptive ' + learner.skill : 'plain' };" } });
  const g = e.db.get<{ id: number }>("SELECT id FROM cards WHERE item_id = 'gen'")!.id;
  assert.equal(e.present(g, 1).view.front, "adaptive general");
  e.updateDeck("Course", { config: { adaptiveChallenge: false, adaptivePace: true } });
  assert.equal(e.present(g, 1).view.front, "plain", "pace alone doesn't hand the learner to scripts");
  done();
});

test("grading with asOf reproduces the variant shown, even after other answers moved the estimates", async () => {
  const { e, done } = await setup({ levels: false, perLevel: 3 });
  e.updateDeck("Course", { config: { adaptiveChallenge: true } });
  const target = cardOf(e, "w5");
  const shown = e.present(target, 11);
  const key = e.prepare("w5", "read", 11, e.adaptContext(target, shown.asOf!)).key;
  // Several other answers in between, all wrong and rated: the learner's estimates drop.
  for (const item of ["w2", "w3", "w4"]) {
    const c = e.present(cardOf(e, item), 3);
    const r = await e.submit(c.cardId, c.seed, "nope", { asOf: c.asOf });
    e.rate(c.cardId, 1, { attemptId: r.attemptId! });
  }
  const r = await e.submit(target, 11, "w5", { asOf: shown.asOf });
  assert.deepEqual(r.key, key);
  done();
});

test("learner math: Elo-style skills, pace, placement bisection and levels", () => {
  const right = fitSkills(Array.from({ length: 20 }, () => ({ cardId: 1, key: "k", skills: ["reading"], score: 1 })));
  const wrong = fitSkills(Array.from({ length: 20 }, () => ({ cardId: 1, key: "k", skills: ["reading"], score: 0 })));
  assert.ok(right.ability.reading > 0 && wrong.ability.reading < 0);
  assert.ok(right.difficulty.get("k")! < 0 && wrong.difficulty.get("k")! > 0);
  assert.equal(right.answers.reading, 20);
  assert.equal(right.success.reading, 1);

  const cfg = { ...DEFAULT_PRESET, newPerDay: 10, newPerDayMin: 5, newPerDayMax: 25, desiredRetention: 0.9, minutesPerDay: 20 };
  assert.equal(pace(cfg, { activeDays: 1, young: { reviews: 5, passed: 5 }, minutes: 5, newCards: 10 }).value, 10, "too little data: the configured limit");
  const fast = pace(cfg, { activeDays: 7, young: { reviews: 100, passed: 97 }, minutes: 70, newCards: 70 });
  const slow = pace(cfg, { activeDays: 7, young: { reviews: 100, passed: 70 }, minutes: 210, newCards: 70 });
  assert.ok(fast.value > 10 && fast.value <= 25, JSON.stringify(fast));
  assert.ok(slow.value < 10 && slow.value >= 5, JSON.stringify(slow));
  const busy = pace(cfg, { activeDays: 7, young: { reviews: 100, passed: 97 }, minutes: 210, newCards: 70 });
  assert.ok(busy.value < 10, `cards holding well doesn't outweigh being over the time budget: ${JSON.stringify(busy)}`);
  const steady = pace(cfg, { activeDays: 7, young: { reviews: 100, passed: 90 }, minutes: 20, newCards: 70 });
  assert.equal(steady.value, 10, "holding at the desired retention on budget: keep the pace");

  assert.deepEqual(placementState(6, []), { bands: 6, probes: 0, frontier: 0, next: 2 });
  assert.equal(placementState(6, [{ band: 2, score: 1 }, { band: 2, score: 1 }]).frontier, 0, "two answers aren't enough to pass a band");
  const passLow = placementState(6, [{ band: 2, score: 1 }, { band: 2, score: 1 }, { band: 2, score: 1 }]);
  assert.equal(passLow.frontier, 3);
  assert.equal(passLow.next, 4);
  const settled = placementState(6, [2, 2, 2, 4, 4, 4, 3, 3, 3].map((band) => ({ band, score: band >= 4 ? 0 : 1 })));
  assert.equal(settled.frontier, 4);
  assert.equal(settled.next, null);
  void settled;

  const levels = [{ tag: "l1" }, { tag: "l2", check: "check::2" }, { tag: "l3" }];
  const counts = [{ total: 10, stable: 9, checks: 0, checksPassed: 0 }, { total: 10, stable: 9, checks: 2, checksPassed: 1 }, { total: 10, stable: 0, checks: 0, checksPassed: 0 }];
  const st = levelState(levels, counts, cfg);
  assert.equal(st.tag, "l2", "l2 is stable enough but its check isn't passed");
  assert.equal(st.nextOpen, true);
  assert.equal(levelState(levels, counts, cfg, 2).tag, "l3", "a placement lifts the floor");
});

test("levels: new cards come from the learner's level, and the next opens once it's mostly stable", async () => {
  const { e, done } = await setup({ perLevel: 3 });
  e.updateDeck("Course", { config: { adaptiveChallenge: true, levels: LEVELS.map((tag) => ({ tag })), levelMix: 0.5, burySiblings: false } });
  const levelOf = (item: string) => LEVELS[Math.floor((Number(item.slice(1)) - 1) / 3)];
  const news = () => e.queue({ deck: "Course" }).news.map((c) => levelOf(c.item_id));
  assert.deepEqual([...new Set(news())], ["level::1"]);
  // Level 1 becomes stable on both faces: level 2 opens and is mixed in; level 3 still waits.
  e.db.run("UPDATE cards SET state = 2, stability = 30, last_review = ? WHERE item_id IN ('w1', 'w2', 'w3')", new Date().toISOString());
  const after = news();
  assert.ok(after.includes("level::2") && !after.includes("level::3"), after.join(","));
  const s = e.learnerSummary("Course");
  assert.equal(s.adaptive, true);
  if (s.adaptive) assert.equal(s.skills.find((x) => x.skill === "reading")?.level?.tag, "level::2");
  done();
});

test("placement finds the level with real reviews; earlier cards become quick checks that suggest Easy", async () => {
  const { e, done } = await setup({ perLevel: 10 });
  e.updateDeck("Course", { config: { adaptiveChallenge: true, levels: LEVELS.map((tag) => ({ tag })), burySiblings: false } });
  const level = (item: string) => Math.floor((Number(item.slice(1)) - 1) / 10);
  let probes = 0;
  for (let i = 0; i < 40; i++) {
    const { card } = e.next({ deck: "Course", placement: true });
    if (!card) break;
    assert.equal(card.placement, "1", "an unnamed session");
    probes++;
    // Knows levels 1 and 2, not 3.
    const r = await e.submit(card.cardId, card.seed, level(card.itemId) < 2 ? card.itemId : "?", { asOf: card.asOf, placement: true });
    assert.equal(r.grade.adaptive?.placement, "1");
    e.rate(card.cardId, r.grade.suggested!, { attemptId: r.attemptId! });
  }
  assert.ok(probes >= 4 && probes < 40, `${probes} probes`);
  const s = e.learnerSummary("Course");
  assert.ok(s.adaptive);
  if (s.adaptive) for (const k of s.skills) assert.equal(k.placement?.frontier, "level::3", JSON.stringify(k));

  // Untested level 1 and 2 cards are quick checks, ahead of new cards and on top of newPerDay.
  e.updateDeck("Course", { config: { adaptiveChallenge: true, levels: LEVELS.map((tag) => ({ tag })), burySiblings: false, newPerDay: 1 } });
  const q = e.queue({ deck: "Course" }).news;
  const quick = q.filter((c) => level(c.item_id) < 2);
  assert.ok(quick.length > 1, "more quick checks than the one new card a day");
  const c = e.present(quick[0].id, 2);
  assert.equal(c.quickCheck, true);
  assert.equal(c.view.quick, true);
  const r = await e.submit(c.cardId, c.seed, c.itemId, { asOf: c.asOf });
  assert.equal(r.grade.suggested, 4, "known on first sight: Easy");

  // A new session redoes the placement from scratch, and the latest session is the one that counts.
  assert.equal(e.next({ deck: "Course", placement: true }).card, null, "the first session is done");
  let redo = 0;
  for (let i = 0; i < 40; i++) {
    const { card } = e.next({ deck: "Course", placement: "again" });
    if (!card) break;
    assert.equal(card.placement, "again");
    redo++;
    const rr = await e.submit(card.cardId, card.seed, "?", { asOf: card.asOf, placement: card.placement });
    e.rate(card.cardId, 1, { attemptId: rr.attemptId! });
  }
  assert.ok(redo >= 3, `${redo} probes in the second session`);
  const s2 = e.learnerSummary("Course");
  if (s2.adaptive) for (const k of s2.skills) assert.equal(k.placement?.frontier, "level::1", JSON.stringify(k));
  done();
});

test("pack check runs prepare without a learner and with sample learners", async () => {
  await initSandbox();
  const fragile = { ...CONTEXT_TYPE, id: "fragile", prepare: "const t = learner.target; return { view: { t }, key: {} };" };
  const pack = { etude: "pack/1", types: [fragile, CONTEXT_TYPE], items: [
    { id: "f1", type: "fragile", deck: "D", fields: { word: "x", sentences: [{ id: "a", de: "a" }] } },
    { id: "c1", type: "ctx", deck: "D", fields: { word: "x", sentences: [{ id: "a", de: "a", requires: ["elsewhere"] }] } },
  ] };
  const r = checkPack(pack);
  assert.ok(r.errors.some((m) => m.includes("f1") && m.includes("without a learner")), r.errors.join("\n"));
  assert.ok(!r.errors.some((m) => m.includes("c1")), r.errors.join("\n"));
  assert.ok(r.warnings.some((m) => m.includes("c1") && m.includes("elsewhere")), r.warnings.join("\n"));
  const brokenGen = { etude: "pack/1", items: [{ id: "g", type: "basic", deck: "D", fields: { front: "f", back: "b", generator: "if (learner) throw new Error('boom'); return { front: String(rng.int(1, 99)) };" } }] };
  assert.ok(checkPack(brokenGen, "p", { seeds: 20 }).errors.some((m) => m.includes("generator fails for")));
});

test("adaptive pace sets the day's new-card limit within its bounds", async () => {
  const { e, done } = await setup({ levels: false, perLevel: 10 });
  e.updateDeck("Course", { config: { adaptivePace: true, newPerDay: 40, newPerDayMin: 2, newPerDayMax: 6, burySiblings: false } });
  // No week of answers yet: the configured limit, clamped to the bounds.
  assert.equal(e.queue({ deck: "Course" }).news.length, 6);
  const s = e.learnerSummary("Course");
  assert.ok(s.adaptive && s.pace?.value === 6 && /not enough/.test(s.pace.reason));
  e.updateDeck("Course", { config: { newPerDay: 40 } });
  assert.equal(e.queue({ deck: "Course" }).news.length, 40, "off again: newPerDay as set");
  done();
});

test("estimates over 50,000 attempts stay fast and are cached until something changes", async () => {
  const { e, done } = await setup({ levels: false, perLevel: 10 });
  e.updateDeck("Course", { config: { adaptiveChallenge: true } });
  const cards = e.db.all<{ id: number }>("SELECT id FROM cards").map((r) => r.id);
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  e.db.run("BEGIN");
  for (let i = 0; i < 50_000; i++) {
    const grade = JSON.stringify({ score: i % 7 ? 1 : 0, verdict: "correct", suggested: 3, grader: { kind: "script" }, adaptive: { asOf: "x", skill: "reading", variant: i % 2 ? "easy" : "hard" } });
    e.db.run("INSERT INTO attempts (card_id, ts, seed, view, answer, grade, review_id) VALUES (?, ?, 1, '{}', '\"a\"', ?, ?)", cards[i % cards.length], new Date(t0 + i * 60_000).toISOString(), grade, i + 1);
  }
  e.db.run("COMMIT");
  let t = performance.now();
  const c = e.present(cards[0], 1);
  const first = performance.now() - t;
  t = performance.now();
  e.present(cards[1], 1);
  const cached = performance.now() - t;
  assert.ok(c.view.hasLearner);
  assert.ok(first < 3000, `first estimate took ${Math.round(first)} ms`);
  assert.ok(cached < 100, `a cached one took ${Math.round(cached)} ms`);
  done();
});

test("undo and bury discard the graded answer, and only rated answers count", async () => {
  const { e, done } = await setup({ levels: false });
  e.updateDeck("Course", { config: { adaptiveChallenge: true } });
  const answers = () => (e.learnerSummary("Course") as any).skills.find((k: any) => k.skill === "reading").answers;
  const attempts = (item: string) => e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE card_id = ?", cardOf(e, item))!.n;
  const answer = async (item: string) => {
    const c = e.present(cardOf(e, item), 1);
    return (await e.submit(c.cardId, c.seed, "wrong", { asOf: c.asOf })).attemptId!;
  };
  await answer("w1");
  assert.equal(answers(), 0, "answered but not rated yet");
  e.setBuried([cardOf(e, "w1")]);
  assert.equal(attempts("w1"), 0, "burying instead of rating discards the answer");
  // A card in review, so its answer measures memory (a new card's first showing teaches and isn't counted).
  e.db.run("UPDATE cards SET state = 2, stability = 10, difficulty = 5, last_review = ?, reps = 1 WHERE id = ?", new Date(Date.now() - 5 * 86400_000).toISOString(), cardOf(e, "w2"));
  const id = await answer("w2");
  e.rate(cardOf(e, "w2"), 1, { attemptId: id });
  assert.equal(answers(), 1);
  e.setBuried([cardOf(e, "w2")]);
  assert.equal(attempts("w2"), 1, "a rated answer survives a later bury");
  e.undo();
  assert.equal(attempts("w2"), 0, "undo discards the review and its answer");
  assert.equal(answers(), 0);
  assert.equal(e.db.get<{ state: number }>("SELECT state FROM cards WHERE id = ?", cardOf(e, "w2"))!.state, 2, "back in review, as before");
  done();
});

test("goals: a first showing teaches, reviews and placement measure, drill decks practise", async () => {
  const { e, done } = await setup({ levels: false });
  e.updateDeck("Course", { config: { adaptiveChallenge: true } });
  const ctx = (item: string, opts = {}) => e.adaptContext(cardOf(e, item), new Date().toISOString(), opts)!;
  assert.equal(ctx("w1").learner.goal, "teach", "new card");
  assert.equal(ctx("w1", { placement: "p" }).learner.goal, "measure", "placement probe");
  const c = e.present(cardOf(e, "w1"), 1);
  const r = await e.submit(c.cardId, c.seed, "nope", { asOf: c.asOf });
  e.rate(c.cardId, 1, { attemptId: r.attemptId! });
  assert.equal(r.grade.adaptive?.goal, "teach");
  const reading = () => (e.learnerSummary("Course") as any).skills.find((k: any) => k.skill === "reading").answers;
  assert.equal(reading(), 0, "teaching answers don't feed the skill estimates");
  // Unless rated Easy: the learner already knew the word.
  const k = e.present(cardOf(e, "w4"), 1);
  const rk = await e.submit(k.cardId, k.seed, "w4", { asOf: k.asOf });
  e.rate(k.cardId, 4, { attemptId: rk.attemptId! });
  assert.equal(reading(), 1, "a first showing rated Easy counts");
  assert.equal(ctx("w1").learner.goal, "measure", "learning");
  // Variants carry their offset from the item's usual difficulty.
  const f = e.prepare("w2", "read", 1, ctx("w2")).fields.sentences as any[];
  assert.ok(f[0]._offset < 0 && f[1]._offset > 0, JSON.stringify(f.map((x) => x._offset)));
  e.updateDeck("Course", { config: { adaptiveChallenge: true, scheduler: "drill" } });
  assert.equal(ctx("w3").learner.goal, "practice", "no memory model");
  assert.equal(ctx("w3").learner.target, 0.9, "the target follows the desired retention");
  done();
});

