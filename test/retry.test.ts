import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";

// Recall a term from its meaning. Another valid term gets another try (asked of the AI); a plural
// gets one from the script. The define face never asks for another try.
const TERM = {
  id: "term",
  name: "Term",
  faces: ["recall", "define"],
  fields: [
    { name: "term", kind: "text" as const, required: true, private: true },
    { name: "meaning", kind: "text" as const, required: true },
    { name: "hint", kind: "text" as const, private: true },
  ],
  prepare: `
    if (face === "define") return { view: { term: fields.term }, key: { meaning: fields.meaning } };
    return {
      view: { meaning: fields.meaning, hint: fields.hint || "" },
      key: { term: fields.term },
      retry: { when: "the answer is a different term with the same meaning", conceal: [fields.term], format: "{hint} It starts with " + fields.term.slice(0, 2) + "…", hintField: "hint" },
    };
  `,
  template: { html: "{{meaning}}" },
  grader: {
    kind: "hybrid" as const,
    code: `
      if (key.meaning) return { defer: true };
      const a = String(answer).trim().toLowerCase();
      if (a === key.term) return { score: 1 };
      if (a === key.term + "s") return { retry: "Right term, in the singular." };
      return { defer: true };
    `,
  },
};

async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "etude-retry-"));
  const e = await Etude.open(join(home, "etude.db"), { home });
  t.after(() => {
    e.close();
    rmSync(home, { recursive: true, force: true });
  });
  e.saveType(TERM);
  e.updateSettings({ ai: { ...e.settings().ai, feedback: { kind: "openai-chat", model: "retry-test", url: "http://provider.test/chat" }, autoFeedback: "always" } });
  e.upsertItem({ id: "w.cafe", type: "term", deck: "Words", tags: ["food"], source: "test", notes: "Keep this", fields: { term: "café", meaning: "a small place that serves coffee" } });
  const cardId = e.item("w.cafe").cards.find((c) => c.face === "recall")!.id;
  e.rate(cardId, 3);
  const history = () => ({ cards: e.db.all("SELECT * FROM cards ORDER BY id"), reviews: e.db.all("SELECT * FROM reviews ORDER BY id"), attempts: e.db.all("SELECT * FROM attempts ORDER BY id") });
  return { e, home, cardId, history };
}

function provider(t: TestContext, reply: unknown = { verdict: "retry", hint: "Smaller than a restaurant, and French." }) {
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ model: "retry-test", choices: [{ message: { content: JSON.stringify(reply) } }] }), { headers: { "content-type": "application/json" } });
  });
  return requests;
}

test("an AI grader asks for another try when prepare says when: nothing is recorded and the hint is saved", async (t) => {
  const { e, cardId, history } = await setup(t);
  const requests = provider(t);
  const before = history(), item = e.item("w.cafe");
  const r = await e.submit(cardId, 7, "coffee shop");
  assert.equal(r.attemptId, null);
  assert.deepEqual(r.key, {});
  assert.equal(r.grade.verdict, "ungraded");
  assert.equal(r.grade.score, null);
  assert.equal(r.grade.suggested, null);
  assert.equal(r.wantsFeedback, false);
  assert.equal(r.retry!.hint, "Smaller than a restaurant, and French. It starts with ca…");
  assert.doesNotMatch(JSON.stringify(r), /café/);
  assert.deepEqual(history(), before);
  const after = e.item("w.cafe");
  assert.deepEqual(after.fields, { ...item.fields, hint: r.retry!.hint });
  for (const k of ["tags", "source", "notes", "archived", "created"] as const) assert.deepEqual(after[k], item[k]);
  assert.equal(r.retry!.view.hint, r.retry!.hint);
  assert.equal(e.present(cardId, 8).view.hint, r.retry!.hint);
  assert.match(requests[0].messages[0].content, /another try, but only in this case: the answer is a different term with the same meaning/);

  const final = await e.submit(cardId, 7, "café");
  assert.equal(final.retry, null);
  assert.equal(final.grade.score, 1);
  assert.equal(final.key.term, "café");
  assert.ok(final.attemptId);
  e.rate(cardId, 3, { attemptId: final.attemptId });
  assert.equal(history().attempts.length, 1);
  assert.equal(history().reviews.length, before.reviews.length + 1);
  assert.equal(requests.length, 1, "the exact term needs no AI");
});

test("a script grader asks for another try itself, and faces without retry.when grade as usual", async (t) => {
  const { e, cardId, history } = await setup(t);
  const requests = provider(t);
  const before = history();
  const r = await e.submit(cardId, 1, "cafés");
  assert.equal(r.retry!.hint, "Right term, in the singular. It starts with ca…");
  assert.equal(r.grade.grader.kind, "script");
  assert.deepEqual(history(), before);
  assert.equal(requests.length, 0);
  assert.equal((await e.previewType(e.type("term"), { term: "café", meaning: "m" }, { answer: "cafés" })).grade?.retry?.hint, r.retry!.hint);

  // The define face has no retry: a retry reply from the provider grades as incorrect.
  const define = e.item("w.cafe").cards.find((c) => c.face === "define")!.id;
  assert.equal(e.prepare("w.cafe", "define", 1).retry, undefined);
  const d = await e.submit(define, 1, "a bar");
  assert.equal(d.retry, null);
  assert.equal(d.grade.verdict, "incorrect");
  assert.ok(d.attemptId);
  assert.doesNotMatch(requests[0].messages[0].content, /another try/);
});

test("hints conceal the answer in any case or accents; a malformed hint is an ungraded answer", async (t) => {
  const { e, cardId, history } = await setup(t);
  provider(t, { verdict: "retry", hint: "The word CAFE (café) fits here." });
  const r = await e.submit(cardId, 1, "coffee shop");
  assert.equal(r.retry!.hint, "The word … (…) fits here. It starts with ca…");
  const before = e.item("w.cafe").fields;
  t.mock.restoreAll();
  provider(t, { verdict: "retry", hint: { term: "café" } });
  const bad = await e.submit(cardId, 1, "coffee shop");
  assert.equal(bad.retry, null);
  assert.equal(bad.grade.verdict, "ungraded");
  assert.match(bad.grade.grader.error!, /invalid retry hint/);
  assert.deepEqual(e.item("w.cafe").fields, before);
  assert.equal(history().reviews.length, 1);
});

test("grading without submitting saves no hint, and an edit while grading rejects the retry", async (t) => {
  const { e, cardId, history } = await setup(t);
  provider(t);
  const before = history(), fields = e.item("w.cafe").fields;
  assert.ok((await e.grade(cardId, 1, "coffee shop")).grade.retry);
  assert.deepEqual(e.item("w.cafe").fields, fields);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => {
    const item = e.item("w.cafe");
    e.upsertItem({ ...item, fields: { ...item.fields, term: "bistro" } });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: "retry", hint: "French." }) } }] }));
  });
  await assert.rejects(e.submit(cardId, 1, "coffee shop"), /card changed while grading/);
  assert.equal(e.item("w.cafe").fields.hint, undefined);
  assert.deepEqual(history(), before);
});

test("prepare's retry is checked", async (t) => {
  const { e } = await setup(t);
  const bad = (retry: string, why: RegExp) => {
    e.saveType({ ...TERM, id: "term-bad", prepare: `return { view: {}, key: {}, retry: ${retry} };` });
    e.upsertItem({ id: "w.bad", type: "term-bad", deck: "Words", fields: { term: "x", meaning: "y" } });
    assert.throws(() => e.prepare("w.bad", "recall", 1), why);
  };
  bad(`{ hintField: "meaning" }`, /hintField must name an optional text field/);
  bad(`{ format: "no placeholder" }`, /format must be text containing \{hint\}/);
  bad(`{ conceal: [1] }`, /conceal must be text/);
  bad(`"yes"`, /retry must be an object/);
});

test("API and CLI return retries; explicit ratings and feedback flags neither rate nor reveal", async (t) => {
  const { e, home, cardId, history } = await setup(t);
  const requests = provider(t);
  const before = history();
  const app = createApp(e);
  const response = await app.request("/api/study/submit", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ cardId, seed: 1, answer: "coffee shop" }) });
  assert.equal(response.status, 200);
  const data = (await response.json()) as any;
  assert.equal(data.attemptId, null);
  assert.deepEqual(data.key, {});
  assert.match(data.retry.view.hint, /ca…/);
  for (const args of [
    ["type", "test-grade", "--item", "w.cafe", "--face", "recall", "--seed", "1", "--answer", "coffee shop", "--ai"],
    ["study", "submit", String(cardId), "--seed", "1", "--answer", "coffee shop", "--feedback"],
    ["study", "answer", String(cardId), "--seed", "1", "--answer", "coffee shop", "--rate", "easy"],
  ]) {
    let out = "", err = "";
    const code = await run(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => "", isTTY: false, env: { ETUDE_HOME: home } });
    assert.equal(code, 0, err);
    const result = JSON.parse(out);
    if (args[0] === "type") assert.ok(result.grade.retry);
    else {
      assert.equal(result.attemptId, null);
      assert.ok(result.retry);
      assert.deepEqual(result.key, {});
    }
    assert.equal(result.rated ?? null, null);
    assert.equal(result.feedback, undefined);
  }
  assert.deepEqual(history(), before);
  assert.equal(requests.length, 4, "no separate feedback call");
});
