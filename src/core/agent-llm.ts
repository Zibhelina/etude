// Streaming chat with function tools, for the in-app agent. Two protocols: the Responses API
// (the user's ChatGPT plan) and OpenAI-compatible Chat Completions (OpenRouter, OpenAI, local servers).
import { AiError, type AgentEffort, type ChatProvider } from "./ai.ts";
import { chatGptEndpoints, getChatGptCredentials, failureMessage, ChatGptError, DEFAULT_CHATGPT_MODEL } from "./chatgpt.ts";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text, as the model wrote it. */
  arguments: string;
}

export type LlmMessage =
  | { role: "user"; content: string; images?: string[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LlmRequest {
  provider: ChatProvider;
  /** Where ChatGPT-plan credentials live. */
  home: string;
  system: string;
  messages: LlmMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  /** Reasoning effort; "default" (or unset) leaves it to the model. */
  effort?: AgentEffort;
  /** Let the model ask for several tool calls in one step (default true). */
  parallel?: boolean;
}

export interface LlmResult {
  text: string;
  toolCalls: ToolCall[];
  model: string;
  ms: number;
  cost?: number;
}

/** Reads a server-sent-events body and calls `on` with every parsed `data:` payload. */
async function readSse(body: ReadableStream<Uint8Array>, on: (data: any) => boolean | void, signal?: AbortSignal) {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  const abort = () => reader.cancel().catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + (buffer[cut] === "\r" ? 4 : 2));
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let data: any;
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          if (on(data) === true) return;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (signal?.aborted) throw new AiError("stopped");
  }
}

function aborted(e: unknown, signal?: AbortSignal): AiError {
  if (signal?.aborted) return new AiError("stopped");
  const err = e as Error;
  if (err?.name === "TimeoutError") return new AiError("the model took too long to answer");
  return new AiError(`couldn't reach the model: ${err?.message ?? String(e)}`);
}

// ------------------------------------------------------------- Responses API

function responsesInput(messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const content: unknown[] = [{ type: "input_text", text: m.content }];
      for (const img of m.images ?? []) content.push({ type: "input_image", image_url: img });
      out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      if (m.content) out.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const c of m.toolCalls ?? []) out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments || "{}" });
    } else out.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
  }
  return out;
}

async function responsesTurn(req: LlmRequest, p: Extract<ChatProvider, { kind: "chatgpt" }>): Promise<LlmResult> {
  const t0 = Date.now();
  const ep = chatGptEndpoints(p.baseUrl ? { responses: p.baseUrl } : {});
  let token: string | null;
  try {
    token = (await getChatGptCredentials(req.home, ep)).access_token;
  } catch (e) {
    throw new AiError((e as Error).message);
  }
  const body = {
    model: p.model || DEFAULT_CHATGPT_MODEL,
    instructions: req.system,
    input: responsesInput(req.messages),
    tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
    ...(req.tools.length ? { parallel_tool_calls: req.parallel !== false } : {}),
    ...(req.effort && req.effort !== "default" ? { reasoning: { effort: req.effort } } : {}),
    store: false,
    stream: true,
  } as Record<string, unknown> & { model: string };
  const timeout = AbortSignal.timeout(p.timeoutMs ?? 180_000);
  const post = (b: unknown) =>
    fetch(ep.responses, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(b),
      signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
    }).catch((e) => {
      throw aborted(e, req.signal);
    });
  let res = await post(body);
  // A model that doesn't take a reasoning effort (or parallel calls): ask again without them.
  if (res.status === 400 && (body.reasoning || "parallel_tool_calls" in body)) {
    const text = await res.clone().text().catch(() => "");
    if (/reasoning|effort|parallel_tool_calls/i.test(text)) {
      delete body.reasoning;
      if (/parallel_tool_calls/i.test(text)) delete body.parallel_tool_calls;
      res = await post(body);
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let code: string | undefined, detail: string | undefined, param: string | undefined;
    try {
      const j = JSON.parse(text);
      code = j.error?.code;
      detail = j.error?.message ?? j.detail;
      param = j.error?.param;
    } catch {
      detail = text.slice(0, 300);
    }
    throw new AiError(failureMessage({ code, status: res.status, detail, param }));
  }
  if (!res.body) throw new AiError("the model returned an empty response");
  let text = "";
  let model = body.model as string;
  const calls = new Map<string, ToolCall>();
  let completed = false;
  let failure: Error | null = null;
  try {
    await readSse(
      res.body,
      (ev) => {
        switch (ev?.type) {
          case "response.output_text.delta":
            if (typeof ev.delta === "string") {
              text += ev.delta;
              req.onText?.(ev.delta);
            }
            break;
          case "response.output_item.done": {
            const it = ev.item;
            if (it?.type === "function_call") calls.set(it.call_id, { id: it.call_id, name: it.name, arguments: it.arguments ?? "{}" });
            break;
          }
          case "response.completed": {
            completed = true;
            if (ev.response?.model) model = ev.response.model;
            if (process.env.ETUDE_AGENT_TRACE && ev.response?.usage) process.stderr.write(`[agent] usage ${JSON.stringify(ev.response.usage)}\n`);
            for (const it of ev.response?.output ?? []) {
              if (it?.type === "function_call" && !calls.has(it.call_id)) calls.set(it.call_id, { id: it.call_id, name: it.name, arguments: it.arguments ?? "{}" });
              if (it?.type === "message" && !text)
                text = (it.content ?? []).map((c: any) => (c?.type === "output_text" ? c.text : "")).join("");
            }
            return true;
          }
          case "response.incomplete":
            failure = new AiError(`the model stopped before finishing${ev.response?.incomplete_details?.reason ? ` (${ev.response.incomplete_details.reason})` : ""}`);
            return true;
          case "response.failed": {
            const err = ev.response?.error ?? {};
            failure = new AiError(failureMessage({ code: err.code, detail: err.message, param: err.param }));
            return true;
          }
          case "error":
            failure = new AiError(failureMessage({ code: ev.code, detail: ev.message, param: ev.param }));
            return true;
        }
      },
      req.signal,
    );
  } catch (e) {
    if (e instanceof AiError || e instanceof ChatGptError) throw new AiError(e.message);
    throw aborted(e, req.signal);
  }
  if (failure) throw failure;
  if (!completed) throw new AiError("the model's stream ended without finishing");
  return { text, toolCalls: [...calls.values()], model, ms: Date.now() - t0 };
}

// ---------------------------------------------------------- Chat Completions

function chatMessages(system: string, messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: m.images?.length ? [{ type: "text", text: m.content }, ...m.images.map((url) => ({ type: "image_url", image_url: { url } }))] : m.content,
      });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })) } : {}),
      });
    } else out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

async function chatTurn(req: LlmRequest, p: Extract<ChatProvider, { kind: "openai-chat" }>): Promise<LlmResult> {
  const t0 = Date.now();
  const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
  if (p.apiKeyEnv && !key) throw new AiError(`${p.apiKeyEnv} is not set`);
  const timeout = AbortSignal.timeout(p.timeoutMs && p.timeoutMs > 120_000 ? p.timeoutMs : 180_000);
  const openrouter = /openrouter\.ai/.test(p.url);
  const body: Record<string, unknown> = {
    model: p.model,
    messages: chatMessages(req.system, req.messages),
    ...(req.tools.length
      ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })), parallel_tool_calls: req.parallel !== false }
      : {}),
    stream: true,
    stream_options: { include_usage: true },
    ...(openrouter ? { usage: { include: true } } : {}),
    ...(openrouter && req.effort && req.effort !== "default" ? { reasoning: { effort: req.effort === "minimal" ? "low" : req.effort } } : {}),
    temperature: p.temperature ?? 0.3,
  };
  const post = () =>
    fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), "X-Title": "Etude", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
    }).catch((e) => {
      throw aborted(e, req.signal);
    });
  let res = await post();
  if (res.status === 400 && (body.reasoning || "parallel_tool_calls" in body)) {
    const text = await res.clone().text().catch(() => "");
    if (/reasoning|effort|parallel_tool_calls/i.test(text)) {
      delete body.reasoning;
      delete body.parallel_tool_calls;
      res = await post();
    }
  }
  if (!res.ok) throw new AiError(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  if (!res.body) throw new AiError("the model returned an empty response");
  let text = "";
  let model = p.model;
  let cost: number | undefined;
  const parts: { id: string; name: string; args: string }[] = [];
  let failure: Error | null = null;
  try {
    await readSse(
      res.body,
      (ev) => {
        if (ev?.error) {
          failure = new AiError(String(ev.error.message ?? JSON.stringify(ev.error)).slice(0, 300));
          return true;
        }
        if (ev?.model) model = ev.model;
        if (ev?.usage?.cost != null) cost = Number(ev.usage.cost);
        const d = ev?.choices?.[0]?.delta;
        if (!d) return;
        if (typeof d.content === "string" && d.content) {
          text += d.content;
          req.onText?.(d.content);
        }
        for (const tc of d.tool_calls ?? []) {
          const i = typeof tc.index === "number" ? tc.index : parts.length;
          parts[i] ??= { id: "", name: "", args: "" };
          if (tc.id) parts[i].id = tc.id;
          if (tc.function?.name) parts[i].name += tc.function.name;
          if (tc.function?.arguments) parts[i].args += tc.function.arguments;
        }
      },
      req.signal,
    );
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw aborted(e, req.signal);
  }
  if (failure) throw failure;
  const toolCalls = parts.filter(Boolean).map((c, i) => ({ id: c.id || `call_${i}_${Date.now()}`, name: c.name, arguments: c.args || "{}" }));
  return { text, toolCalls, model, ms: Date.now() - t0, cost };
}

/** One model turn: streams text through `onText` and returns the text and any tool calls. */
export function llmTurn(req: LlmRequest): Promise<LlmResult> {
  const p = req.provider;
  return p.kind === "chatgpt" ? responsesTurn(req, p) : chatTurn(req, p);
}
