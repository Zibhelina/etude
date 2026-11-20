// Who AI grading sends cards and answers to. In the iPhone app nothing goes to a provider until the person agrees to
// it (App Store guideline 5.1.2(i); the engine's requireAiConsent, agreements in settings.aiConsent). No imports: the
// web app uses this too.

type ProviderLike = { kind: string; url?: string } | null | undefined;

const NAMES: Record<string, string> = { "openrouter.ai": "OpenRouter", "api.openai.com": "OpenAI", chatgpt: "ChatGPT (OpenAI)" };

/** "chatgpt", the host a provider posts to ("openrouter.ai"), or null when nothing leaves this machine. */
export function aiProviderId(p: ProviderLike): string | null {
  if (!p) return null;
  if (p.kind === "chatgpt") return "chatgpt";
  // The "llm" decision kind has no URL of its own: it asks the chat model.
  if (!p.url) return null;
  let host: string;
  try {
    host = new URL(p.url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
  if (!host || host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1") return null;
  return host;
}

/** The name people know a provider by: OpenRouter, OpenAI, or its host. */
export const aiProviderName = (id: string) => NAMES[id] ?? id;

/** Every provider these AI settings would send to, each once. */
export function aiProvidersOf(ai: { decision?: ProviderLike; feedback?: ProviderLike; vision?: ProviderLike } | null | undefined): string[] {
  if (!ai) return [];
  const decision = ai.decision?.kind === "openrouter-decisions" ? ai.decision : null;
  return [...new Set([decision, ai.feedback, ai.vision].map(aiProviderId).filter((x): x is string => !!x))];
}

/** A provider id as aiProviderId makes them: "chatgpt" or a host name. */
export const AI_PROVIDER_ID = /^[a-z0-9][a-z0-9.:-]{0,252}$/;
