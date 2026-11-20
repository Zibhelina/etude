import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { DEFAULT_AI, aiProviderId, aiProvidersOf } from "../src/core/ai.ts";
import { safeSettings } from "../src/core/sync/log.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";
import { agentFor, type AssistantContent } from "../src/core/agent.ts";

/** A chat model at ask.example.test (not this machine, so it needs an OK), answering every request with one reply. */
function askProvider(t: TestContext) {
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    sent.push(String(url));
    const body = `data: ${JSON.stringify({ model: "m", choices: [{ delta: { content: "Hello from the model." } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  return sent;
}
const ASK_URL = "https://ask.example.test/v1/chat/completions";

/** An engine as the iPhone app opens it (requireAiConsent), unless `ios` is false. */
async function setup(t: TestContext, feedback: Record<string, unknown> = { kind: "openai-chat", model: "m", url: "https://api.example.com/v1/chat" }, ios = true) {
  const home = mkdtempSync(join(tmpdir(), "etude-ai-consent-"));
  const e = await Etude.open(join(home, "etude.db"), { home, requireAiConsent: ios });
  t.after(() => {
    e.close();
    rmSync(home, { recursive: true, force: true });
  });
  e.updateSettings({ ai: { ...e.settings().ai, decision: null, feedback: feedback as any, autoFeedback: "never" } });
  e.upsertItem({ id: "q.1", type: "free", deck: "D", fields: { prompt: "What does HTTP stand for?", reference: "HyperText Transfer Protocol" } });
  return { e, home, cardId: e.item("q.1").cards[0].id };
}

/** Every request the providers get. */
function provider(t: TestContext) {
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    sent.push(String(url));
    return new Response(JSON.stringify({ model: "m", choices: [{ message: { content: JSON.stringify({ verdict: "correct", score: 1, feedback: "Right." }) } }] }), { headers: { "content-type": "application/json" } });
  });
  return sent;
}

test("providers are named by where they send: chatgpt, a host, or nothing for this machine", () => {
  assert.equal(aiProviderId({ kind: "openai-chat", url: "https://openrouter.ai/api/v1/chat/completions" }), "openrouter.ai");
  assert.equal(aiProviderId({ kind: "openai-chat", url: "https://API.openai.com/v1/chat/completions" }), "api.openai.com");
  assert.equal(aiProviderId({ kind: "chatgpt" }), "chatgpt");
  for (const url of ["http://127.0.0.1:8080/v1/chat/completions", "http://localhost:11434/v1", "http://[::1]:8080/v1"]) assert.equal(aiProviderId({ kind: "openai-chat", url }), null, url);
  assert.equal(aiProviderId({ kind: "llm" }), null, "the llm decision kind asks the chat model");
  assert.deepEqual(aiProvidersOf(DEFAULT_AI), ["openrouter.ai"], "the default decision and feedback models are one provider");
});

test("everywhere but the iPhone app, grading sends as before, with or without an OK", async (t) => {
  const { e, cardId } = await setup(t, undefined, false);
  const sent = provider(t);
  assert.equal(e.requireAiConsent, false);
  assert.equal(e.aiConsentStatus().required, false);
  assert.equal((await e.submit(cardId, 1, "hypertext transfer protocol")).grade.verdict, "correct");
  assert.ok((await e.testAi()).verdict);
  assert.deepEqual(sent, ["https://api.example.com/v1/chat", "https://api.example.com/v1/chat", "https://api.example.com/v1/chat"], "the answer, then the test's verdict and feedback");
  // A plain open (desktop server, CLI, MCP) is the same.
  const plain = await Etude.open(":memory:");
  try {
    assert.equal(plain.requireAiConsent, false);
  } finally {
    plain.close();
  }
  // The iPhone app's worker turns it on from the page's first message.
  const worker = readFileSync(new URL("../src/browser/worker-core.ts", import.meta.url), "utf8");
  assert.match(worker, /const ios = ev\.data\.hello\.platform === "ios";\n\s*hostReady = ready\.then\(\(\) => void \(etude\.requireAiConsent = ios\)\);/);
  assert.match(readFileSync(new URL("../src/browser/app-main.ts", import.meta.url), "utf8"), /const platform = native && \(capPlatform === "ios" \|\| capPlatform === "android"\) \? capPlatform : "web";/);
});

test("in the iPhone app, grading sends nothing to a provider until you agree, then it does", async (t) => {
  const { e, cardId } = await setup(t);
  const sent = provider(t);
  const r = await e.submit(cardId, 1, "hypertext transfer protocol");
  assert.equal(r.grade.verdict, "ungraded", "the learner rates themselves instead");
  assert.match(r.grade.grader.error ?? "", /needs your OK before it sends cards and answers to api\.example\.com/);
  const test1 = await e.testAi();
  assert.match(String(test1.verdictError), /needs your OK/);
  assert.match(String(test1.feedbackError), /needs your OK/);
  await assert.rejects(e.suggestItemEdit("q.1", "shorter"), /needs your OK/);
  assert.deepEqual(sent, [], "not one request");
  assert.deepEqual(e.aiConsentStatus().providers, [{ id: "api.example.com", name: "api.example.com", for: ["grading"], ready: true, agreed: null }]);

  e.agreeToAi("api.example.com");
  const ok = await e.submit(cardId, 2, "hypertext transfer protocol");
  assert.equal(ok.grade.verdict, "correct");
  assert.equal(sent.length, 1);
  assert.ok(e.aiConsentStatus().providers[0].agreed);

  // Withdrawn: nothing goes again.
  e.withdrawAiConsent("api.example.com");
  assert.equal((await e.submit(cardId, 3, "x")).grade.verdict, "ungraded");
  assert.equal(sent.length, 1);
});

test("the ChatGPT plan is asked for too, before its credentials are even read; a local model needs no OK", async (t) => {
  const sent = provider(t);
  const gpt = await setup(t, { kind: "chatgpt", model: "gpt-6.1-sol" });
  assert.match(String((await gpt.e.testAi()).verdictError), /ChatGPT \(OpenAI\)/);
  const local = await setup(t, { kind: "openai-chat", model: "m", url: "http://127.0.0.1:9/v1/chat/completions" });
  assert.deepEqual(local.e.aiConsentStatus().providers, []);
  assert.equal((await local.e.submit(local.cardId, 1, "hypertext transfer protocol")).grade.verdict, "correct");
  assert.deepEqual(sent, ["http://127.0.0.1:9/v1/chat/completions"]);
});

test("consent is checked, stays on this device, and only the user gives it", async (t) => {
  const { e, home } = await setup(t);
  assert.throws(() => e.agreeToAi("not a host!"), /isn't a provider/);
  assert.throws(() => e.updateSettings({ aiConsent: { "x y": "now" } as any }), /isn't a provider/);
  e.agreeToAi("OpenRouter.ai");
  assert.ok(e.settings().aiConsent["openrouter.ai"]);
  assert.equal("aiConsent" in safeSettings(e.settings()), false, "Sync doesn't carry it");

  const app = createApp(e);
  const post = (path: string, b: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  assert.equal(((await (await post("/api/ai/consent", { provider: "api.example.com" })).json()) as any).providers[0].agreed !== null, true);
  assert.equal(((await (await app.request("/api/ai/consent")).json()) as any).agreed["api.example.com"] !== undefined, true);
  assert.equal(((await (await post("/api/ai/consent/withdraw", { provider: "api.example.com" })).json()) as any).providers[0].agreed, null);

  const db = join(home, "etude.db");
  const io = (out: string[]) => ({ stdout: (s: string) => void out.push(s), stderr: (s: string) => void out.push(s), stdin: () => "", isTTY: false, env: { ETUDE_HOME: home } });
  const out: string[] = [];
  for (const opts of [{ agent: true }, { mcp: true }]) {
    assert.notEqual(await run(["--db", db, "settings", "consent", "agree", "api.example.com"], io(out), { ...opts, etude: e }), 0);
    assert.notEqual(await run(["--db", db, "settings", "set", 'aiConsent={"api.example.com":"now"}'], io(out), { ...opts, etude: e }), 0);
  }
  assert.match(out.join(""), /only the user/);
  assert.equal(e.settings().aiConsent["api.example.com"], undefined);
  const mine: string[] = [];
  assert.equal(await run(["--db", db, "settings", "consent", "agree", "api.example.com"], io(mine), { etude: e }), 0);
  assert.ok(JSON.parse(mine.join("")).agreed["api.example.com"]);
});

test("the iPhone app asks once per provider before the first answer goes (first-run setup's own buttons, then key saves, ChatGPT sign-in, the test); nothing shows anywhere else", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const ai = read("web/src/components/settings-ai.tsx");
  assert.match(ai, /consent\.confirm\(providersForKey\(ai, name\)/);
  assert.match(ai, /consent\.confirm\(aiProvidersOf\(saved\.ai\)/);
  assert.match(ai, /<AiConsentBlocks savedAi=\{saved\.ai\} \/>/);
  assert.match(read("web/src/components/settings-chatgpt.tsx"), /consent\.confirm\(\["chatgpt"\], \(\) => void signIn\(\)\)/);
  // First-run setup asks in the step itself: the connect buttons say they agree and record the OK, with no dialog.
  const onboarding = read("web/src/components/onboarding.tsx");
  assert.doesNotMatch(onboarding, /consent\.confirm\(|consent\.dialog/);
  assert.equal(onboarding.match(/consent\.agree\(/g)?.length, 4, "ChatGPT sign-in, Agree and test after an earlier sign-in, a pasted key, a server elsewhere");
  for (const label of ["Agree and continue with ChatGPT", "Agree and test"]) assert.ok(onboarding.includes(label), label);
  assert.match(onboarding, /\{value === true && asksAiConsent\(\) && \(/, "the AI step says what AI sees, in the iPhone app");
  // Skipping AI ("No AI", Later) goes on without recording anything.
  assert.match(onboarding, /if \(wantsAi\) go\("accounts"\);\n\s*else afterAi\("off"\);/);
  const consent = read("web/src/components/ai-consent.tsx");
  assert.ok(consent.includes('export const WHAT_IS_SENT = "your cards and answers, your messages to the assistant and what it reads in Etude (open pages, the card on screen, selected text, pictures of the screen)";'));
  assert.ok(consent.includes("`Etude sends ${WHAT_IS_SENT} from this device to ${names(ids)}.`"));
  assert.match(consent, />I agree</);
  // Off the iPhone: no dialog (the action runs at once), no list in Settings, no request for the status.
  assert.match(consent, /export const asksAiConsent = \(\) => isIOSApp\(\);/);
  assert.match(consent, /if \(!asks\) return action\(\);/);
  assert.match(consent, /return asksAiConsent\(\) \? <ConsentList \{\.\.\.props\} \/> : null;/);
  // Ask: a message the engine held back asks, I agree sends the same message, Not now keeps the draft.
  const panel = read("web/src/components/agent-panel.tsx");
  assert.match(panel, /const provider = asksAiConsent\(\) \? consentProvider\(e\) : null;/);
  assert.match(panel, /setAtts\(done\);\n\s*consent\.confirm\(\[provider\], \(\) => void deliver\(msg, done\), true\);/);
  assert.match(read("web/src/components/minimi-chat.tsx"), /\{chat\.consentDialog\}/);
  assert.match(panel, /\{chat\.consentDialog\}/);
});

test("Ask in the iPhone app: nothing goes to a provider until you agree; the same OK as grading, then it sends", async (t) => {
  const sent = askProvider(t);
  const { e } = await setup(t, { kind: "openai-chat", model: "m", url: ASK_URL });
  const a = agentFor(e);
  const conv = a.createConversation("custom:m");
  assert.deepEqual(a.consentNeeded(conv.id), { provider: "ask.example.test", name: "ask.example.test", message: "Etude needs your OK before it sends your messages to ask.example.test. Agree when the app asks, or in Settings → AI grading." });
  await assert.rejects(a.send(conv.id, { text: "hi" }), (err: any) => err.code === "ai_consent" && err.provider === "ask.example.test" && err.status === 409);
  assert.deepEqual(a.conversation(conv.id).messages, [], "the message isn't kept: the app keeps it as a draft");

  // Through the API: a 409 with the provider, before any stream starts.
  const app = createApp(e);
  const res = await app.request(`/api/agent/conversations/${conv.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "Etude needs your OK before it sends your messages to ask.example.test. Agree when the app asks, or in Settings → AI grading.", code: "ai_consent", provider: "ask.example.test" });
  assert.deepEqual(sent, [], "not one request to the provider");

  // Settings lists the provider for both, and one OK (given for grading) lets Ask send too.
  const st = (await (await app.request("/api/ai/consent")).json()) as any;
  assert.deepEqual(st.providers.map((p: any) => [p.id, p.for]), [["ask.example.test", ["grading", "assistant"]]]);
  e.agreeToAi("ask.example.test");
  assert.equal(a.consentNeeded(conv.id), null);
  const msg = await a.send(conv.id, { text: "hi" });
  assert.equal((msg.content as AssistantContent).text, "Hello from the model.");
  assert.equal(sent.filter((u) => u === ASK_URL).length, 1, "one request to the provider (the system prompt also reads the Market's catalog)");

  // An Ask provider grading doesn't use is listed for the assistant alone; a model on this machine needs nothing.
  e.withdrawAiConsent("ask.example.test");
  e.updateSettings({ ai: { ...e.settings().ai, feedback: { kind: "openai-chat", model: "m", url: "http://127.0.0.1:9/v1/chat/completions" } } });
  assert.equal(a.consentNeeded(a.createConversation("custom:m").id), null);
  e.updateSettings({ ai: { ...e.settings().ai, agent: { model: "chatgpt:gpt-6.1-sol" } } });
  assert.deepEqual(e.aiConsentStatus([a.askProvider()]).providers.map((p) => [p.id, p.for]), [["chatgpt", ["assistant"]]]);
});

test("Ask everywhere but the iPhone app sends as before, with or without an OK", async (t) => {
  const sent = askProvider(t);
  const { e } = await setup(t, { kind: "openai-chat", model: "m", url: ASK_URL }, false);
  const a = agentFor(e);
  const conv = a.createConversation("custom:m");
  assert.equal(a.consentNeeded(conv.id), null);
  const msg = await a.send(conv.id, { text: "hi" });
  assert.equal((msg.content as AssistantContent).text, "Hello from the model.");
  assert.ok(sent.includes(ASK_URL));
  const res = await createApp(e).request(`/api/agent/conversations/${conv.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "again" }) });
  assert.equal(res.status, 200);
  await res.text();
});

test("at launch the iPhone app asks only about providers that are set up, not agreed to, and not put off before", async (t) => {
  const { launchAsks, putOffList } = await import("../web/src/lib/consent-launch.ts");
  const p = (id: string, ready: boolean, agreed: string | null) => ({ id, name: id, for: ["grading" as const], ready, agreed });
  const st = { providers: [p("openrouter.ai", true, null), p("api.openai.com", false, null), p("chatgpt", true, "2026-11-12"), p("ask.example.test", true, null)] };
  assert.deepEqual(launchAsks(st, []), ["openrouter.ai", "ask.example.test"]);
  assert.deepEqual(launchAsks(st, putOffList(JSON.stringify(["ask.example.test"]))), ["openrouter.ai"], "Not now at launch is remembered per provider");
  assert.deepEqual(putOffList("not json"), []);
  assert.deepEqual(putOffList(JSON.stringify({ a: 1 })), []);

  // `ready` comes from the engine: a key that's set (or no key needed), or ChatGPT signed in.
  const key = "ETUDE_TEST_CONSENT_KEY";
  const { e } = await setup(t, { kind: "openai-chat", model: "m", url: "https://api.example.com/v1/chat", apiKeyEnv: key });
  const before = process.env[key];
  delete process.env[key];
  t.after(() => void (before === undefined ? delete process.env[key] : (process.env[key] = before)));
  assert.equal(e.aiConsentStatus().providers[0].ready, false, "a setup with no key isn't asked about at launch");
  process.env[key] = "sk-test";
  assert.equal(e.aiConsentStatus().providers[0].ready, true);
  assert.deepEqual(launchAsks(e.aiConsentStatus(), []), ["api.example.com"]);
  e.agreeToAi("api.example.com");
  assert.deepEqual(launchAsks(e.aiConsentStatus(), []), []);
  const gpt = await setup(t, { kind: "chatgpt", model: "gpt-6.1-sol" });
  assert.equal(gpt.e.aiConsentStatus().providers[0].ready, false, "ChatGPT not signed in");

  // The app shows it once the collection said whether setup shows, never during or right after setup, and only on the iPhone.
  const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  assert.match(read("web/src/App.tsx"), /<AiConsentAtLaunch enabled=\{onboardingChecked && !onboarding && !sawOnboarding\.current && path !== "\/embed"\} \/>/);
  const consent = read("web/src/components/ai-consent.tsx");
  assert.match(consent, /if \(!enabled \|\| checked\.current \|\| !asksAiConsent\(\)\) return;/);
  assert.match(consent, /onCancel=\{\(\) => \(keepLater\(ids\), setIds\(null\)\)\}/);
});
