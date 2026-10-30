// Shapes and validation for the settings page. Mirrors `Settings` in src/core/engine.ts
// and `AiSettings` in src/core/ai.ts.

export interface DecisionProvider {
  kind: "openrouter-decisions" | "llm";
  url?: string;
  model?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
}

export interface OpenAiChatProvider {
  kind: "openai-chat";
  url: string;
  model: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  vision?: boolean;
  temperature?: number;
}

/** The user's ChatGPT plan, through the Responses API. No API key. */
export interface ChatGptProvider {
  kind: "chatgpt";
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  vision?: boolean;
}

export type ChatProvider = OpenAiChatProvider | ChatGptProvider;

export const CHATGPT_DEFAULT_MODEL = "gpt-6.1-sol";

export const isOpenAiChat = (p: ChatProvider | null | undefined): p is OpenAiChatProvider => p?.kind === "openai-chat";
export const isChatGpt = (p: ChatProvider | null | undefined): p is ChatGptProvider => p?.kind === "chatgpt";

export interface AiSettings {
  decision: DecisionProvider | null;
  feedback: ChatProvider | null;
  vision: ChatProvider | null;
  autoFeedback: "ai-graded" | "always" | "never";
  language: string;
  /** The in-app assistant's default model ref (chatgpt:…, openrouter:…, custom:…); null uses the feedback model. */
  agent?: { model: string | null; effort?: string };
}

export interface SettingsDraft {
  ai: AiSettings;
  dayStartHour: number;
  learnAheadMinutes: number;
}

/** First-run setup. `level` only changes what setup itself offers. */
export type OnboardingLevel = "simple" | "standard" | "tinker";
export interface Onboarding {
  done: boolean;
  level: OnboardingLevel;
}

export interface SettingsResponse extends SettingsDraft {
  onboarding?: Onboarding;
  keyStatus: Record<string, boolean>;
  dbPath: string;
  mediaDir: string;
  version?: string;
  defaults?: SettingsDraft;
}

export interface TestResult {
  verdict?: { verdict: string; score: number; confidence?: number; model: string; ms: number; cost?: number };
  verdictError?: string;
  feedback?: { feedback: string; model: string; ms: number; cost?: number };
  feedbackError?: string;
}

export const draftOf = (s: SettingsResponse | SettingsDraft): SettingsDraft => ({
  ai: structuredClone(s.ai),
  dayStartHour: s.dayStartHour,
  learnAheadMinutes: s.learnAheadMinutes,
});

/** The decision provider "llm" grades with the chat model, same as having none. */
export const usesDecisionModel = (ai: AiSettings) => ai.decision?.kind === "openrouter-decisions";

export type PresetId = "openrouter" | "openai" | "chatgpt" | "local";

export function presetAi(id: PresetId, defaults: AiSettings, current: AiSettings): AiSettings {
  const keep = { autoFeedback: current.autoFeedback, language: current.language, agent: current.agent };
  if (id === "openrouter") return { ...structuredClone(defaults), ...keep, vision: null };
  if (id === "chatgpt")
    return {
      ...keep,
      decision: null,
      feedback: { kind: "chatgpt", model: CHATGPT_DEFAULT_MODEL, vision: true, timeoutMs: 60000 },
      vision: null,
    };
  if (id === "openai")
    return {
      ...keep,
      decision: null,
      feedback: { kind: "openai-chat", url: "https://api.openai.com/v1/chat/completions", model: "gpt-6-luna", apiKeyEnv: "OPENAI_API_KEY", vision: true, temperature: 0.3, timeoutMs: 45000 },
      vision: null,
    };
  return {
    ...keep,
    decision: null,
    feedback: { kind: "openai-chat", url: "http://127.0.0.1:8080/v1/chat/completions", model: "", vision: false, temperature: 0.3, timeoutMs: 60000 },
    vision: null,
  };
}

export function matchPreset(ai: AiSettings, defaults: AiSettings | undefined): PresetId | null {
  if (!usesDecisionModel(ai) && ai.feedback?.kind === "chatgpt") return "chatgpt";
  const url = isOpenAiChat(ai.feedback) ? ai.feedback.url : "";
  if (defaults && usesDecisionModel(ai) && url === (isOpenAiChat(defaults.feedback) ? defaults.feedback.url : "")) return "openrouter";
  if (!usesDecisionModel(ai) && url.startsWith("https://api.openai.com/")) return "openai";
  if (!usesDecisionModel(ai) && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return "local";
  return null;
}

/** Every environment variable the draft would read a key from. */
export function keyVars(ai: AiSettings): { name: string; usedBy: string[] }[] {
  const out = new Map<string, string[]>();
  const add = (name: string | undefined, by: string) => {
    if (!name) return;
    out.set(name, [...(out.get(name) ?? []), by]);
  };
  if (usesDecisionModel(ai)) add(ai.decision?.apiKeyEnv, "verdicts");
  add(isOpenAiChat(ai.feedback) ? ai.feedback.apiKeyEnv : undefined, usesDecisionModel(ai) ? "feedback" : "verdicts and feedback");
  add(isOpenAiChat(ai.vision) ? ai.vision.apiKeyEnv : undefined, "drawings");
  return [...out].map(([name, usedBy]) => ({ name, usedBy }));
}

// --------------------------------------------------------------- validation

export type Errors = Record<string, string>;

const isUrl = (s: string | undefined) => {
  try {
    const u = new URL(s ?? "");
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkChat(p: OpenAiChatProvider, prefix: string, e: Errors) {
  if (!isUrl(p.url)) e[`${prefix}.url`] = "Enter a full http(s) URL";
  if (!p.model?.trim()) e[`${prefix}.model`] = "Enter the model name your endpoint serves";
  if (p.apiKeyEnv && !ENV_NAME.test(p.apiKeyEnv)) e[`${prefix}.apiKeyEnv`] = "Letters, digits and underscores only";
  if (p.temperature != null && !(p.temperature >= 0 && p.temperature <= 2)) e[`${prefix}.temperature`] = "Between 0 and 2";
  if (p.timeoutMs != null && !(p.timeoutMs >= 1000 && p.timeoutMs <= 600_000)) e[`${prefix}.timeoutMs`] = "Between 1 and 600 seconds";
}

function checkChatGpt(p: ChatGptProvider, prefix: string, e: Errors) {
  if (!p.model?.trim()) e[`${prefix}.model`] = "Pick a model your ChatGPT plan offers";
  if (p.baseUrl && !isUrl(p.baseUrl)) e[`${prefix}.baseUrl`] = "Enter a full http(s) URL";
  if (p.timeoutMs != null && !(p.timeoutMs >= 1000 && p.timeoutMs <= 600_000)) e[`${prefix}.timeoutMs`] = "Between 1 and 600 seconds";
}

function checkProvider(p: ChatProvider, prefix: string, e: Errors) {
  if (isChatGpt(p)) checkChatGpt(p, prefix, e);
  else checkChat(p, prefix, e);
}

export function validate(d: SettingsDraft): Errors {
  const e: Errors = {};
  const dec = d.ai.decision;
  if (dec && dec.kind === "openrouter-decisions") {
    if (!isUrl(dec.url)) e["decision.url"] = "Enter a full http(s) URL";
    if (!dec.model?.trim()) e["decision.model"] = "Enter a model id";
    if (dec.apiKeyEnv && !ENV_NAME.test(dec.apiKeyEnv)) e["decision.apiKeyEnv"] = "Letters, digits and underscores only";
    if (dec.timeoutMs != null && !(dec.timeoutMs >= 1000 && dec.timeoutMs <= 600_000)) e["decision.timeoutMs"] = "Between 1 and 600 seconds";
  }
  if (d.ai.feedback) checkProvider(d.ai.feedback, "feedback", e);
  if (d.ai.vision) checkProvider(d.ai.vision, "vision", e);
  if (!d.ai.language.trim()) e.language = "Say which language feedback should use";
  if (!(Number.isInteger(d.dayStartHour) && d.dayStartHour >= 0 && d.dayStartHour <= 23)) e.dayStartHour = "A whole hour from 0 to 23";
  if (!(Number.isInteger(d.learnAheadMinutes) && d.learnAheadMinutes >= 0 && d.learnAheadMinutes <= 1440)) e.learnAheadMinutes = "Whole minutes from 0 to 1440";
  return e;
}

/** Drops empty optional strings so the saved JSON stays clean. */
export function normalize(d: SettingsDraft): SettingsDraft {
  const clean = <T extends object>(p: T | null): T | null => {
    if (!p) return p;
    const o = { ...p } as Record<string, unknown>;
    for (const k of Object.keys(o)) if (o[k] === "" && k !== "model" && k !== "url") delete o[k];
    if (typeof o.url === "string") o.url = o.url.trim();
    if (typeof o.model === "string") o.model = o.model.trim();
    return o as T;
  };
  return {
    ...d,
    ai: {
      ...d.ai,
      decision: d.ai.decision?.kind === "openrouter-decisions" ? clean(d.ai.decision) : null,
      feedback: clean(d.ai.feedback),
      vision: clean(d.ai.vision),
      language: d.ai.language.trim(),
    },
  };
}
