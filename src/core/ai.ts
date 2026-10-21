// AI grading. A decision model returns the verdict as calibrated probabilities (fast, cheap);
// a language model writes the feedback. Both are plain HTTP and configurable per install.
import type { Verdict } from "./model.ts";

export interface DecisionProvider {
  /** "openrouter-decisions": OpenRouter's typed decisions endpoint (System One request shape). "llm": ask the chat model for JSON. */
  kind: "openrouter-decisions" | "llm";
  url?: string;
  model?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
}

export interface ChatProvider {
  /** Any OpenAI-compatible chat completions endpoint (OpenRouter, OpenAI, a local llama.cpp or vLLM server). */
  kind: "openai-chat";
  url: string;
  model: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  vision?: boolean;
  temperature?: number;
}

export interface AiSettings {
  decision: DecisionProvider | null;
  feedback: ChatProvider | null;
  /** Used for drawings and image answers; defaults to `feedback` when it supports vision. */
  vision: ChatProvider | null;
  /** When to write feedback without being asked: on every AI-graded answer, on wrong answers too, or only on request. */
  autoFeedback: "ai-graded" | "always" | "never";
  language: string;
}

export const DEFAULT_AI: AiSettings = {
  decision: { kind: "openrouter-decisions", url: "https://openrouter.ai/api/alpha/decisions", model: "liquid/d1-ultra", apiKeyEnv: "OPENROUTER_API_KEY", timeoutMs: 8000 },
  feedback: {
    kind: "openai-chat",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "deepseek/deepseek-v4.1-flash-1017",
    apiKeyEnv: "OPENROUTER_API_KEY",
    vision: true,
    timeoutMs: 45000,
    temperature: 0.3,
  },
  vision: null,
  autoFeedback: "ai-graded",
  language: "the language the card is written in",
};

export class AiError extends Error {}

export interface GradingContext {
  /** The card as the learner saw it, and everything the grader may know, as labelled markdown sections. */
  card: { label: string; text: string }[];
  /** Instruction layers, most specific first. */
  instructions: { from: string; text: string }[];
  answerText: string | null;
  answerImage: string | null;
  verdict?: Verdict;
  score?: number | null;
}

export interface AiVerdict {
  verdict: Verdict;
  score: number;
  confidence?: number;
  feedback?: string;
  model: string;
  ms: number;
  cost?: number;
}

function key(envName?: string): string | undefined {
  return envName ? process.env[envName] : undefined;
}

async function post(url: string, body: unknown, apiKeyEnv: string | undefined, timeoutMs: number): Promise<any> {
  const k = key(apiKeyEnv);
  if (apiKeyEnv && !k) throw new AiError(`${apiKeyEnv} is not set`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(k ? { Authorization: `Bearer ${k}` } : {}),
      "X-Title": "Etude",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e) => {
    throw new AiError(e?.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : String(e?.message ?? e));
  });
  const text = await res.text();
  if (!res.ok) throw new AiError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError(`bad JSON from provider: ${text.slice(0, 200)}`);
  }
}

function contextText(ctx: GradingContext, withAnswer = true): string {
  const parts: string[] = [];
  for (const s of ctx.card) parts.push(`## ${s.label}\n${s.text}`);
  if (ctx.instructions.length)
    parts.push(`## Grading instructions (most specific first; earlier ones win on conflict)\n${ctx.instructions.map((i) => `- (${i.from}) ${i.text}`).join("\n")}`);
  if (withAnswer) parts.push(`## Student answer\n${ctx.answerText?.trim() ? ctx.answerText : ctx.answerImage ? "(a drawing, attached)" : "(empty)"}`);
  return parts.join("\n\n");
}

const LEVELS: { verdict: Verdict; label: string }[] = [
  { verdict: "incorrect", label: "incorrect: wrong, missing the key idea, or empty" },
  { verdict: "partial", label: "partially correct: some of what is required is right, but something required is missing or wrong" },
  { verdict: "correct", label: "correct: everything the reference and rubric require is present and right; wording may differ" },
];

/** Verdict from a typed decision model. Text answers only. */
async function decide(p: DecisionProvider, ctx: GradingContext): Promise<AiVerdict> {
  const t0 = Date.now();
  if (!ctx.answerText?.trim()) return { verdict: "incorrect", score: 0, confidence: 1, model: "empty-answer", ms: 0 };
  const reply = await post(
    p.url!,
    {
      model: p.model,
      state: contextText(ctx),
      questions: {
        verdict: {
          type: "score",
          instructions:
            "Grade the student answer against the reference answer and the rubric, following the grading instructions. Judge meaning, not wording or length.",
          criteria: LEVELS.map((l) => l.label),
        },
      },
    },
    p.apiKeyEnv,
    p.timeoutMs ?? 8000,
  );
  const a = reply?.answers?.verdict;
  if (!a || a.type !== "score") throw new AiError(`decision model gave no verdict: ${JSON.stringify(reply).slice(0, 200)}`);
  const probs = [0, 1, 2].map((i) => Number(a.probabilities?.[String(i)] ?? 0));
  const best = probs.indexOf(Math.max(...probs));
  return {
    verdict: LEVELS[best].verdict,
    score: Math.max(0, Math.min(1, Number(a.score) / 2)),
    confidence: a.confidence,
    model: reply.model ?? p.model ?? "decision",
    ms: Date.now() - t0,
    cost: reply.usage?.cost,
  };
}

const FEEDBACK_STYLE = (lang: string) =>
  `Write feedback for a student who just answered a practice card. Write in ${lang}. Talk to the student directly, in two to four short sentences of markdown (use $...$ for math). Start with whether the answer is right. Then name exactly what was missing or wrong, and the fix. If it is right, add the one thing that would make it exam-perfect, or say nothing more. No praise filler, no headings, no restating the question.`;

async function chat(p: ChatProvider, system: string, user: string, image: string | null, json: boolean) {
  const t0 = Date.now();
  const content: any = image
    ? [
        { type: "text", text: user },
        { type: "image_url", image_url: { url: image } },
      ]
    : user;
  const reply = await post(
    p.url,
    {
      model: p.model,
      temperature: p.temperature ?? 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
      usage: { include: true },
    },
    p.apiKeyEnv,
    p.timeoutMs ?? 45000,
  );
  const text: string = reply?.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new AiError("language model returned no text");
  return { text: text.trim(), model: reply.model ?? p.model, ms: Date.now() - t0, cost: reply.usage?.cost as number | undefined };
}

function parseJson(text: string): any {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new AiError(`expected JSON, got: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

/** Verdict and feedback in one call from a chat model; used for images and when no decision model is set. */
async function judgeWithLlm(p: ChatProvider, ctx: GradingContext, lang: string): Promise<AiVerdict> {
  const system = `You grade practice answers. Reply with JSON only: {"verdict": "correct" | "partial" | "incorrect", "score": number from 0 to 1, "feedback": string}.
Verdict meanings: ${LEVELS.map((l) => l.label).join("; ")}.
For "feedback": ${FEEDBACK_STYLE(lang)}`;
  const out = await chat(p, system, contextText(ctx), ctx.answerImage, true);
  const j = parseJson(out.text);
  const verdict: Verdict = ["correct", "partial", "incorrect"].includes(j.verdict) ? j.verdict : "incorrect";
  const score = Number.isFinite(Number(j.score)) ? Math.max(0, Math.min(1, Number(j.score))) : verdict === "correct" ? 1 : verdict === "partial" ? 0.5 : 0;
  return { verdict, score, feedback: String(j.feedback ?? "").trim() || undefined, model: out.model, ms: out.ms, cost: out.cost };
}

export async function aiVerdict(settings: AiSettings, ctx: GradingContext, opts: { vision?: boolean } = {}): Promise<AiVerdict> {
  const visionModel = settings.vision ?? (settings.feedback?.vision ? settings.feedback : null);
  if (opts.vision || ctx.answerImage) {
    if (!visionModel) throw new AiError("no vision model configured");
    return judgeWithLlm(visionModel, ctx, settings.language);
  }
  const d = settings.decision;
  if (d?.kind === "openrouter-decisions") {
    try {
      return await decide(d, ctx);
    } catch (e) {
      if (!settings.feedback) throw e;
      const v = await judgeWithLlm(settings.feedback, ctx, settings.language);
      return { ...v, model: `${v.model} (decision model failed: ${(e as Error).message.slice(0, 80)})` };
    }
  }
  if (!settings.feedback) throw new AiError("no AI grader configured");
  return judgeWithLlm(settings.feedback, ctx, settings.language);
}

export async function aiFeedback(settings: AiSettings, ctx: GradingContext): Promise<{ feedback: string; model: string; ms: number; cost?: number }> {
  const p = ctx.answerImage ? (settings.vision ?? (settings.feedback?.vision ? settings.feedback : null)) : settings.feedback;
  if (!p) throw new AiError("no feedback model configured");
  const verdictLine = ctx.verdict && ctx.verdict !== "ungraded" ? `\n\n## Grade already given\n${ctx.verdict}${ctx.score != null ? ` (score ${ctx.score.toFixed(2)})` : ""}. Your feedback must agree with this grade.` : "";
  const out = await chat(p, FEEDBACK_STYLE(settings.language), contextText(ctx) + verdictLine, ctx.answerImage, false);
  return { feedback: out.text, model: out.model, ms: out.ms, cost: out.cost };
}
