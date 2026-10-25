import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude, EtudeError } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";

async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "etude-ai-edit-"));
  const path = join(dir, "etude.db");
  const e = await Etude.open(path, { home: dir });
  t.after(() => { e.close(); rmSync(dir, { recursive: true, force: true }); });
  e.updateSettings({ ai: { ...e.settings().ai, feedback: { kind: "openai-chat", model: "edit-test", url: "http://provider.test/chat" } } });
  e.upsertItem({ id: "q.1", type: "basic", deck: "D", tags: ["original"], source: "A book", notes: "Private notes", fields: { front: "What is a router?", back: "A network-layer packet switch." } });
  const cardId = e.item("q.1").cards[0].id;
  e.rate(cardId, 3);
  const snapshot = () => ({
    item: e.db.get("SELECT * FROM items WHERE id = ?", "q.1"),
    cards: e.db.all("SELECT * FROM cards WHERE item_id = ? ORDER BY id", "q.1"),
    reviews: e.db.all("SELECT * FROM reviews ORDER BY id"),
  });
  return { e, dir, path, snapshot };
}

function provider(t: TestContext, content: unknown = { changes: { back: "A router forwards packets between networks." } }, status = 200) {
  const requests: { url: string; body: any }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ model: "edit-test", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { cost: 0.002 } }), { status, headers: { "content-type": "application/json" } });
  });
  return requests;
}

test("AI edits propose validated content without changing the item, cards or history", async (t) => {
  const { e, snapshot } = await setup(t);
  const requests = provider(t);
  const before = snapshot();
  const r = await e.suggestItemEdit("q.1", "  Make the answer clearer  ");
  assert.deepEqual(r.fields, { front: "What is a router?", back: "A router forwards packets between networks." });
  assert.deepEqual(r.changed, ["back"]);
  assert.equal(r.itemId, "q.1");
  assert.equal(r.model, "edit-test");
  assert.equal(r.cost, 0.002);
  assert.deepEqual(snapshot(), before);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://provider.test/chat");
  const prompt = JSON.parse(requests[0].body.messages[1].content);
  assert.equal(prompt.instruction, "Make the answer clearer");
  assert.deepEqual(prompt.fields, e.item("q.1").fields);
  assert.ok(prompt.type.fields.some((f: any) => f.name === "back" && f.private));
  assert.equal("reviews" in prompt, false);
  assert.equal("notes" in prompt, false);
});

test("AI edits use a snapshot of unsaved fields and preserve unrelated content", async (t) => {
  const { e } = await setup(t);
  const requests = provider(t);
  const fields = { front: "My unsaved question", back: "My unsaved answer", legacy: { keep: true } };
  const pending = e.suggestItemEdit("q.1", "Clarify the answer", { fields });
  fields.front = "Changed after the request";
  const r = await pending;
  assert.equal(r.fields.front, "My unsaved question");
  assert.deepEqual(r.fields.legacy, { keep: true });
  assert.equal(JSON.parse(requests[0].body.messages[1].content).fields.back, "My unsaved answer");
  assert.equal(e.item("q.1").fields.front, "What is a router?");
});

test("AI edits can remove optional fields and return an unchanged proposal", async (t) => {
  const { e } = await setup(t);
  await t.test("remove a field, including a stored null", async (t) => {
    provider(t, { changes: { extra: null } });
    const r = await e.suggestItemEdit("q.1", "Remove the extra field", { fields: { ...e.item("q.1").fields, extra: null } });
    assert.equal(Object.hasOwn(r.fields, "extra"), false);
    assert.deepEqual(r.changed, ["extra"]);
  });
  await t.test("no changes", async (t) => {
    provider(t, { changes: {} });
    const r = await e.suggestItemEdit("q.1", "Keep it as it is");
    assert.deepEqual(r.changed, []);
    assert.deepEqual(r.fields, e.item("q.1").fields);
  });
});

test("AI edits reject invalid provider output without saving it", async (t) => {
  const { e, snapshot } = await setup(t);
  const before = snapshot();
  const cases: [string, unknown, RegExp][] = [
    ["malformed JSON", "not JSON", /invalid JSON/],
    ["missing changes", { fields: { back: "wrong envelope" } }, /no field changes object/],
    ["array changes", { changes: [] }, /no field changes object/],
    ["unknown field", { changes: { deck: "Elsewhere" } }, /unknown field/],
    ["wrong field kind", { changes: { back: ["not a string"] } }, /should be markdown/],
    ["wrong generator kind", { changes: { generator: 42 } }, /generator should be code/],
    ["required field removed", { changes: { back: null } }, /missing field/],
    ["non-finite number", '{"changes":{"extra":1e309}}', /non-finite number/],
  ];
  for (const [name, content, message] of cases) await t.test(name, async (t) => {
    provider(t, content);
    await assert.rejects(e.suggestItemEdit("q.1", "Change the answer"), (err: unknown) => err instanceof EtudeError && err.status === 502 && message.test(err.message));
    assert.deepEqual(snapshot(), before);
  });
});

test("AI edits validate generator output before returning a proposal", async (t) => {
  const { e } = await setup(t);
  e.upsertItem({ id: "q.gen", type: "basic", deck: "D", fields: { generator: 'return { front: "What is " + rng.int(1, 3) + "?", back: "A number" };' } });
  provider(t, { changes: { generator: 'return { front: "Missing its answer" };' } });
  await assert.rejects(e.suggestItemEdit("q.gen", "Update the generator"), /generator output.*missing field/);
  assert.match(String(e.item("q.gen").fields.generator), /A number/);
});

test("AI edit input errors and a missing model do not call the provider", async (t) => {
  const { e } = await setup(t);
  const calls = provider(t);
  await assert.rejects(e.suggestItemEdit("q.1", "  "), /describe how/);
  await assert.rejects(e.suggestItemEdit("missing", "Edit it"), /unknown item/);
  for (const fields of [null, [], "text"]) await assert.rejects(e.suggestItemEdit("q.1", "Edit it", { fields: fields as any }), /fields must be an object/);
  e.updateSettings({ ai: { ...e.settings().ai, feedback: null } });
  await assert.rejects(e.suggestItemEdit("q.1", "Edit it"), /no language model configured/);
  assert.equal(calls.length, 0);
});

test("the AI edit API returns proposals and reports validation and provider failures", async (t) => {
  const { e, snapshot } = await setup(t);
  const before = snapshot();
  const app = createApp(e, { webDist: null });
  const post = (body: unknown) => app.request("/api/items/q.1/ai-edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await t.test("proposal from the current draft", async (t) => {
    provider(t);
    const response = await post({ instruction: "Clarify", fields: { front: "Unsaved question", back: "Answer" } });
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.equal(result.fields.front, "Unsaved question");
    assert.deepEqual(result.changed, ["back"]);
  });
  await t.test("invalid request", async () => {
    assert.equal((await post({ instruction: "" })).status, 400);
    assert.equal((await post({ instruction: "Edit it", fields: [] })).status, 400);
  });
  await t.test("provider failed", async (t) => {
    provider(t, "unavailable", 503);
    const response = await post({ instruction: "Edit it" });
    assert.equal(response.status, 502);
    assert.match((await response.json() as any).error, /HTTP 503/);
  });
  assert.deepEqual(snapshot(), before);
});

test("item ai-edit exposes the same read-only proposal through the CLI", async (t) => {
  const { e, dir, path, snapshot } = await setup(t);
  const before = snapshot();
  const requests = provider(t);
  const instructionFile = join(dir, "change.txt");
  writeFileSync(instructionFile, "Make it clearer");
  let stdout = "", stderr = "";
  const code = await run(["--db", path, "item", "ai-edit", "q.1", "--instruction-file", instructionFile, "--fields", JSON.stringify({ front: "Unsaved question", back: "Answer" })], {
    stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, stdin: () => "", isTTY: false, env: { ETUDE_HOME: dir },
  });
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  const r = JSON.parse(stdout);
  assert.equal(r.fields.front, "Unsaved question");
  assert.deepEqual(r.changed, ["back"]);
  assert.equal(JSON.parse(requests[0].body.messages[1].content).instruction, "Make it clearer");
  assert.deepEqual(snapshot(), before);
  assert.equal(e.item("q.1").fields.front, "What is a router?");
});
