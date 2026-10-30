// Client for the in-app assistant: conversations, attachments, and the streamed turn.
import { apiToken, etudeFetch } from "./transport";

export interface Attachment {
  id: string;
  name: string;
  kind: "image" | "pdf" | "text" | "anki" | "file";
  mime: string;
  bytes: number;
  pages?: number;
  url?: string;
}

export interface ToolItem {
  type: "tool";
  id: string;
  tool: string;
  label: string;
  argv?: string[];
  status: "running" | "done" | "error" | "denied" | "waiting";
  exit?: number;
  output?: string;
  writes?: boolean;
  preview?: string;
  summary?: string;
  action?: string;
  target?: string;
  change?: string;
  lookup?: boolean;
}

export type Item = { type: "text"; text: string } | ToolItem | { type: "ui"; action: string; path?: string };

export interface UserContent {
  text: string;
  attachments: Attachment[];
}

export interface AssistantContent {
  text: string;
  items: Item[];
  model: string;
  ms: number;
  error?: string;
  stopped?: boolean;
  changed: boolean;
  changes?: string[];
  modelRef?: string;
}

export interface Message {
  id: number;
  conversationId: string;
  role: "user" | "assistant";
  content: UserContent | AssistantContent;
  created: string;
  snapshot: string | null;
  undone: boolean;
  canUndo: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  autoTitle?: boolean;
  model: string | null;
  created: string;
  updated: string;
}

export interface ModelGroup {
  provider: "chatgpt" | "openrouter" | "custom";
  label: string;
  models: { ref: string; name: string; vision?: boolean }[];
  error?: string;
}

export type AgentEvent =
  | { type: "start"; turnId: string; conversation: Conversation; userMessage: Message }
  | { type: "text"; delta: string }
  | { type: "tool_start"; item: ToolItem }
  | { type: "tool_end"; item: ToolItem }
  | { type: "confirm"; item: ToolItem }
  | { type: "ui"; action: string; path?: string }
  | { type: "changed" }
  | { type: "title"; conversation: Conversation }
  | { type: "done"; message: Message }
  | { type: "error"; error: string };

function headers(json = true): Record<string, string> {
  return json ? { "Content-Type": "application/json" } : {};
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await etudeFetch(path, { method, headers: headers(body !== undefined || method !== "GET"), body: body !== undefined ? JSON.stringify(body) : method !== "GET" ? "{}" : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data as T;
}

export const agentApi = {
  models: (force = false) => call<{ configured: boolean; default: string | null; groups: ModelGroup[] }>("GET", `/api/agent/models${force ? "?force=1" : ""}`),
  list: () => call<{ conversations: Conversation[]; running: string[] }>("GET", "/api/agent/conversations"),
  get: (id: string) => call<Conversation & { messages: Message[]; running: string | null }>("GET", `/api/agent/conversations/${id}`),
  create: (model: string | null) => call<Conversation>("POST", "/api/agent/conversations", { model }),
  remove: (id: string) => call<{ deleted: string }>("DELETE", `/api/agent/conversations/${id}`),
  setModel: (id: string, model: string) => call<Conversation>("PATCH", `/api/agent/conversations/${id}`, { model }),
  rename: (id: string, title: string) => call<Conversation>("PATCH", `/api/agent/conversations/${id}`, { title }),
  confirm: (turn: string, callId: string, allow: boolean) => call("POST", `/api/agent/turns/${turn}/confirm`, { callId, allow }),
  stop: (turn: string) => call("POST", `/api/agent/turns/${turn}/stop`, {}),
  undo: (id: string, messageId: number) => call<{ restored: string; undone: number[] }>("POST", `/api/agent/conversations/${id}/undo`, { messageId }),
  attachmentUrl: (conv: string, id: string) => `/api/agent/conversations/${conv}/attachments/${id}${apiToken() ? `?token=${encodeURIComponent(apiToken()!)}` : ""}`,
  async upload(conv: string, file: File): Promise<Attachment> {
    const res = await etudeFetch(`/api/agent/conversations/${conv}/attachments?name=${encodeURIComponent(file.name || "pasted.png")}`, {
      method: "POST",
      headers: { ...headers(false), "Content-Type": "application/octet-stream" },
      body: file,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? res.statusText);
    return data as Attachment;
  },
  /** Posts a message and calls `on` for every streamed event. Resolves when the stream ends. */
  async send(conv: string, body: { text: string; attachments: string[]; model?: string | null; page?: string }, on: (e: AgentEvent) => void): Promise<void> {
    const res = await etudeFetch(`/api/agent/conversations/${conv}/messages`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error ?? res.statusText);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) {
          try {
            on(JSON.parse(data));
          } catch {}
        }
      }
    }
  },
};

/** Fired after the assistant changed the collection, so pages can reload. */
export const DATA_EVENT = "etude:data-changed";
