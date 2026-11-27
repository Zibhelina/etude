import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Etude } from "../src/core/engine.ts";
import { accountFor } from "../src/core/account.ts";
import { agentFor } from "../src/core/agent.ts";
import { llmTurn } from "../src/core/agent-llm.ts";
import { AiConsentError, AiError, aiEditFields, aiFeedback, aiProviderId, aiProviderName, aiProvidersOf, aiVerdict, type AiSettings, type GradingContext } from "../src/core/ai.ts";
import { DEFAULT_AI } from "../src/core/ai.ts";
import { matchPreset, normalize, presetAi, validate, type AiSettings as WebAiSettings } from "../web/src/components/settings-model.ts";

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "etude-hosted-ai-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sampleCtx(extra: Partial<GradingContext> = {}): GradingContext {
  return {
    card: [
      { label: "prompt", text: "What does HTTP stand for?" },
      { label: "reference", text: "HyperText Transfer Protocol" },
    ],
    instructions: [],
    answerText: "HyperText Transfer Protocol",
    answerImage: null,
    ...extra,
  };
}

function hostedSettings(server: string): AiSettings {
  return {
    ...DEFAULT_AI,
    decision: { kind: "etude-cloud", server, timeoutMs: 5000 },
    feedback: { kind: "etude-cloud", server, vision: true, timeoutMs: 5000 },
    vision: null,
    autoFeedback: "wrong-or-partial",
  };
}

async function startMockCloud(handler: (method: string, url: string, headers: Record<string, string | string[] | undefined>, body: any) => { status?: number; headers?: Record<string, string>; body: any; raw?: string }) {
  const seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any }[] = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      seen.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body: parsed });
      const out = handler(req.method ?? "GET", req.url ?? "/", req.headers, parsed);
      res.writeHead(out.status ?? 200, { "Content-Type": out.raw !== undefined ? "text/event-stream" : "application/json", ...out.headers });
      res.end(out.raw !== undefined ? out.raw : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    seen,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

describe("hosted Etude AI & tiered Sync plans", () => {
  it("recognizes etude-cloud in aiProviderId, aiProviderName, and aiProvidersOf", () => {
    assert.equal(aiProviderId({ kind: "etude-cloud" }), "etude-cloud");
    assert.equal(aiProviderName("etude-cloud"), "Etude AI (hosted)");
    assert.deepEqual(
      aiProvidersOf({
        decision: { kind: "etude-cloud" },
        feedback: { kind: "etude-cloud" },
        vision: null,
      }),
      ["etude-cloud"],
    );
  });

  it("grades verdicts, feedback, drawings, retries, and card edits through Etude hosted AI proxy", async () => {
    const mock = await startMockCloud((_method, url, _headers, body) => {
      if (url === "/v1/ai/decisions") {
        return {
          body: {
            model: "liquid/d1-ultra",
            answers: { verdict: { type: "score", score: 2, confidence: 0.96, probabilities: { "0": 0.01, "1": 0.03, "2": 0.96 } } },
            etudeCredits: { charged: 1, remaining: 999 },
          },
        };
      }
      if (url === "/v1/ai/chat/completions") {
        if (body.purpose === "drawing") {
          return { body: { model: "deepseek/deepseek-v4.1-flash-1017", choices: [{ message: { content: JSON.stringify({ verdict: "partial", score: 0.5, feedback: "Good start, label the axis." }) } }], etudeCredits: { charged: 5, remaining: 994 } } };
        }
        if (body.purpose === "retry") {
          return { body: { model: "deepseek/deepseek-v4.1-flash-1017", choices: [{ message: { content: JSON.stringify({ verdict: "retry", hint: "Spell out each letter." }) } }], etudeCredits: { charged: 3, remaining: 991 } } };
        }
        if (body.purpose === "chat") {
          return { body: { model: "deepseek/deepseek-v4.1-flash-1017", choices: [{ message: { content: JSON.stringify({ changes: { prompt: "Define HTTP." } }) } }], etudeCredits: { charged: 2, remaining: 989 } } };
        }
        return { body: { model: "deepseek/deepseek-v4.1-flash-1017", choices: [{ message: { content: "Spot on!" } }], etudeCredits: { charged: 3, remaining: 996 } } };
      }
      return { status: 404, body: { error: { code: "not_found", message: "not found" } } };
    });

    const { dir, cleanup } = tempHome();
    try {
      writeFileSync(join(dir, "account.json"), JSON.stringify({ server: mock.url, token: "tok_test_123", deviceKey: "dev_abc" }));
      const ai = hostedSettings(mock.url);

      // Consent check enforced when consent map lacks etude-cloud
      await assert.rejects(() => aiVerdict(ai, sampleCtx(), { home: dir, consent: {} }), AiConsentError);

      // Verdict via /v1/ai/decisions
      const v = await aiVerdict(ai, sampleCtx(), { home: dir, consent: { "etude-cloud": "2026-11-27T00:00:00Z" } });
      assert.equal(v.verdict, "correct");
      assert.equal(v.score, 1);
      assert.equal(v.cost, 0.0001);
      assert.equal(mock.seen[0].headers.authorization, "Bearer tok_test_123");
      assert.equal(mock.seen[0].headers["x-etude-device-key"], "dev_abc");

      // Feedback via /v1/ai/chat/completions with purpose: "feedback"
      const fb = await aiFeedback(ai, { ...sampleCtx(), verdict: "incorrect", score: 0 }, { home: dir });
      assert.equal(fb.feedback, "Spot on!");
      assert.equal(mock.seen[1].body.purpose, "feedback");

      // Drawing via /v1/ai/chat/completions with purpose: "drawing"
      const draw = await aiVerdict(ai, sampleCtx({ answerText: null, answerImage: "data:image/png;base64,AAAA" }), { home: dir });
      assert.equal(draw.verdict, "partial");
      assert.equal(mock.seen[2].body.purpose, "drawing");

      // Retry via /v1/ai/chat/completions with purpose: "retry"
      const ret = await aiVerdict(ai, sampleCtx({ retryWhen: "if abbreviated" }), { home: dir });
      assert.equal(ret.retry?.hint, "Spell out each letter.");
      assert.equal(mock.seen[3].body.purpose, "retry");

      // Card edit via /v1/ai/chat/completions with purpose: "chat"
      const edit = await aiEditFields(ai, { id: "basic", name: "Basic", fields: [{ name: "prompt", type: "text" }] } as any, { prompt: "What is HTTP?" }, "Shorten", { home: dir });
      assert.deepEqual(edit.changes, { prompt: "Define HTTP." });
      assert.equal(mock.seen[4].body.purpose, "chat");
    } finally {
      cleanup();
      await mock.close();
    }
  });

  it("surfaces clear AiError on 402 insufficient_credits without double-calling", async () => {
    const mock = await startMockCloud(() => ({
      status: 402,
      body: { error: { code: "insufficient_credits", message: "Out of AI credits." } },
    }));
    const { dir, cleanup } = tempHome();
    try {
      writeFileSync(join(dir, "account.json"), JSON.stringify({ server: mock.url, token: "tok_empty" }));
      await assert.rejects(
        () => aiVerdict(hostedSettings(mock.url), sampleCtx(), { home: dir }),
        (e: unknown) => e instanceof AiError && /Out of Etude AI credits/i.test(e.message),
      );
      assert.equal(mock.seen.length, 1);
    } finally {
      cleanup();
      await mock.close();
    }
  });

  it("streams Ask Etude chat via etude-cloud and lists curated models", async () => {
    const mock = await startMockCloud((_method, url) => {
      if (url === "/v1/ai/status") {
        return {
          body: {
            enabled: true,
            creditUnitUsd: 0.0001,
            autoFeedbackPolicy: "wrong_or_partial",
            wallet: { plan: "basic", monthlyQuota: 5000, monthlyUsed: 100, monthlyRemaining: 4900, purchasedBalance: 0, totalRemaining: 4900, periodStart: "2026-11-01", periodEnd: "2026-12-01", warning80: false, welcomeClaimed: true, welcomeCredits: 1000 },
            models: {
              decision: "liquid/d1-ultra",
              feedback: "deepseek/deepseek-v4.1-flash-1017",
              chat: [
                { id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", vision: true },
                { id: "openai/gpt-6-luna", name: "GPT-6 Luna", vision: true },
              ],
            },
          },
        };
      }
      if (url === "/v1/ai/chat/completions") {
        return {
          raw: [
            `data: ${JSON.stringify({ model: "openai/gpt-6-luna", choices: [{ delta: { content: "Hello " } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: "learner!" } }], usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.0002 } })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
          body: null,
        };
      }
      return { status: 404, body: {} };
    });
    const { dir, cleanup } = tempHome();
    const etude = await Etude.open(":memory:", { home: dir });
    try {
      writeFileSync(join(dir, "account.json"), JSON.stringify({ server: mock.url, token: "tok_chat", deviceKey: "dev_chat" }));
      const ag = agentFor(etude);
      const listed = await ag.models(true);
      const etudeGroup = listed.groups.find((g) => g.provider === "etude");
      assert.ok(etudeGroup);
      assert.equal(etudeGroup.models.length, 2);
      assert.equal(etudeGroup.models[1].ref, "etude:openai/gpt-6-luna");

      const provider = ag.resolveModel("etude:openai/gpt-6-luna");
      assert.equal(provider.kind, "etude-cloud");
      assert.equal(provider.model, "openai/gpt-6-luna");

      let streamed = "";
      const res = await llmTurn({
        provider,
        home: dir,
        system: "Be brief.",
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
        onText: (d) => {
          streamed += d;
        },
      });
      assert.equal(streamed, "Hello learner!");
      assert.equal(res.text, "Hello learner!");
      assert.equal(res.model, "openai/gpt-6-luna");
      const chatReq = mock.seen.find((r) => r.url === "/v1/ai/chat/completions");
      assert.equal(chatReq?.body.purpose, "chat");
      assert.equal(chatReq?.body.model, "openai/gpt-6-luna");
    } finally {
      etude.close();
      cleanup();
      await mock.close();
    }
  });

  it("enforces wrong-or-partial automatic feedback for hosted AI and explicit wrong-or-partial setting", async () => {
    let nextVerdict = 2; // 2 = correct, 0 = incorrect
    const mock = await startMockCloud((_method, url) => {
      if (url === "/v1/ai/decisions") {
        return {
          body: {
            model: "liquid/d1-ultra",
            answers: {
              verdict: {
                type: "score",
                score: nextVerdict,
                confidence: 0.95,
                probabilities: { "0": nextVerdict === 0 ? 0.95 : 0.02, "1": 0.03, "2": nextVerdict === 2 ? 0.95 : 0.02 },
              },
            },
          },
        };
      }
      return { status: 404, body: {} };
    });
    const { dir, cleanup } = tempHome();
    const etude = await Etude.open(":memory:", { home: dir });
    try {
      writeFileSync(join(dir, "account.json"), JSON.stringify({ server: mock.url, token: "tok_auto" }));
      // Even when autoFeedback stays "ai-graded", hosted AI suppresses auto-feedback on correct answers.
      etude.updateSettings({ ai: { ...hostedSettings(mock.url), autoFeedback: "ai-graded" } });
      etude.upsertItem({ id: "t.france", type: "free", deck: "Test", fields: { prompt: "Capital of France?", reference: "Paris" } });
      const cards = etude.db.all("SELECT id FROM cards WHERE item_id = ?", "t.france") as { id: number }[];
      assert.equal(cards.length, 1);

      nextVerdict = 2;
      const right = await etude.submit(cards[0].id, 1, "Paris");
      assert.equal(right.grade.verdict, "correct");
      assert.equal(right.wantsFeedback, false);

      nextVerdict = 0;
      const wrong = await etude.submit(cards[0].id, 2, "Lyon");
      assert.equal(wrong.grade.verdict, "incorrect");
      assert.equal(wrong.wantsFeedback, true);
    } finally {
      etude.close();
      cleanup();
      await mock.close();
    }
  });

  it("sends tier & credit pack requests from AccountClient and persists deviceKey", async () => {
    const mock = await startMockCloud((method, url, _headers, body) => {
      if (method === "POST" && url === "/v1/billing/sync/checkout") return { body: { url: "https://polar.sh/c/1", id: "c1", plan: body.plan, tier: body.tier } };
      if (method === "POST" && url === "/v1/billing/credits/checkout") return { body: { url: "https://polar.sh/c/2", id: "c2", pack: body.pack, credits: 10000 } };
      if (method === "POST" && url === "/v1/billing/google/credits") return { body: { ok: true, result: "credited", consume: true, pack: "pack_10k", credits: 10000 } };
      if (method === "GET" && url === "/v1/ai/status") return { body: { enabled: true, wallet: { totalRemaining: 1000 } } };
      if (method === "GET" && url.startsWith("/v1/ai/history")) return { body: { entries: [] } };
      return { status: 404, body: {} };
    });
    const { dir, cleanup } = tempHome();
    const etude = await Etude.open(":memory:", { home: dir });
    try {
      writeFileSync(join(dir, "account.json"), JSON.stringify({ server: mock.url, token: "tok_acct" }));
      const acct = accountFor(etude);

      const sub = await acct.syncCheckout("yearly", "plus");
      assert.equal(sub.tier, "plus");
      assert.equal(sub.plan, "yearly");

      const pack = await acct.creditsCheckout("pack_10k");
      assert.equal(pack.pack, "pack_10k");

      const gp = await acct.googleCredits("etude_credits_10k", "tok_gp_1");
      assert.equal(gp.consume, true);

      const st = await acct.aiStatus();
      assert.equal(st.enabled, true);
      const dk1 = acct.deviceKey();
      const dk2 = acct.deviceKey();
      assert.equal(dk1, dk2);
      const aiStatusReq = mock.seen.find((r) => r.url === "/v1/ai/status");
      assert.equal(aiStatusReq?.headers["x-etude-device-key"], dk1);

      const hist = await acct.aiHistory({ limit: 10 });
      assert.deepEqual(hist.entries, []);
    } finally {
      etude.close();
      cleanup();
      await mock.close();
    }
  });

  it("handles the etude preset in settings-model validation and normalization", () => {
    const base = DEFAULT_AI as unknown as WebAiSettings;
    const picked = presetAi("etude", base, base);
    assert.equal(picked.decision?.kind, "etude-cloud");
    assert.equal(picked.feedback?.kind, "etude-cloud");
    assert.equal(picked.autoFeedback, "wrong-or-partial");
    assert.equal(matchPreset(picked, base), "etude");
    const draft = { ai: picked, dayStartHour: 4, learnAheadMinutes: 20 };
    assert.deepEqual(validate(draft), {});
    const norm = normalize(draft);
    assert.equal(norm.ai.decision?.kind, "etude-cloud");
    assert.equal(norm.ai.feedback?.kind, "etude-cloud");
  });
});
