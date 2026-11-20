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
  /** An external agent asking permission: its own choices. */
  options?: { id: string; name: string; kind: string }[];
  chose?: string;
}

export type Item = { type: "text"; text: string } | ToolItem | { type: "ui"; action: string; path?: string } | { type: "thought"; text: string; ms: number } | { type: "steer"; text: string; attachments?: Attachment[] };

/** How much Ask asks before it acts: before every change, only before what could do harm, or never. */
export type Permission = "ask" | "dangerous" | "allow";

/** How full the context window is; `size` is null when the provider doesn't say how big the window is. */
export interface ContextUse {
  used: number;
  size: number | null;
}

/** One of a chat's pickers besides who it's with: the model, the reasoning effort, the speed. */
export interface ChatControl {
  id: string;
  name: string;
  category?: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

export interface ChatControls {
  controls: ChatControl[];
  usage?: ContextUse;
  live: boolean;
}

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
  /** The server closed before the reply finished: this is as far as it got. */
  cut?: boolean;
  changed: boolean;
  changes?: string[];
  modelRef?: string;
  usage?: ContextUse;
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
  acpSession?: string;
  /** Pinned to the top of the chat list. */
  pinned?: boolean;
  /** The agent profile the chat is with (settings.agentProfiles); older chats are Minimi's. */
  profile: string;
}

export interface ModelGroup {
  provider: "chatgpt" | "openrouter" | "custom" | "agent";
  label: string;
  models: { ref: string; name: string; vision?: boolean }[];
  error?: string;
}

export interface BackgroundTask {
  id: string;
  name: string;
  title: string;
  kind?: string;
  startedAt: number;
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
  | { type: "error"; error: string }
  | { type: "look"; id: string; mode: "text" | "image" }
  | { type: "thought"; delta: string; ms: number }
  | { type: "steer"; text: string; attachments?: Attachment[] }
  | { type: "usage"; usage: ContextUse }
  | { type: "controls"; controls: ChatControls }
  | { type: "tasks"; tasks: BackgroundTask[] };

function headers(json = true): Record<string, string> {
  return json ? { "Content-Type": "application/json" } : {};
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await etudeFetch(path, { method, headers: headers(body !== undefined || method !== "GET"), body: body !== undefined ? JSON.stringify(body) : method !== "GET" ? "{}" : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(data?.error ?? res.statusText), data?.code ? { code: data.code } : {});
  return data as T;
}

export const agentApi = {
  models: (force = false) => call<{ configured: boolean; default: string | null; groups: ModelGroup[] }>("GET", `/api/agent/models${force ? "?force=1" : ""}`),
  list: () => call<{ conversations: Conversation[]; running: string[]; background?: string[] }>("GET", "/api/agent/conversations"),
  get: (id: string) => call<Conversation & { messages: Message[]; running: string | null; tasks?: BackgroundTask[] }>("GET", `/api/agent/conversations/${id}`),
  create: (model: string | null, profile?: string | null) => call<Conversation>("POST", "/api/agent/conversations", { model, ...(profile ? { profile } : {}) }),
  /** `agentSession`: the chat's session in the agent's own history (Hermes), deleted with it or why not. */
  remove: (id: string) => call<{ deleted: string; agentSession?: { id: string; deleted: boolean; error?: string } }>("DELETE", `/api/agent/conversations/${id}`),
  setModel: (id: string, model: string) => call<Conversation>("PATCH", `/api/agent/conversations/${id}`, { model }),
  pin: (id: string, pinned: boolean) => call<Conversation>("PATCH", `/api/agent/conversations/${id}`, { pinned }),
  search: (q: string) => call<{ results: { id: string; snippet: string; role: "title" | "user" | "assistant" }[] }>("GET", `/api/agent/conversations/search?q=${encodeURIComponent(q)}`),
  rename: (id: string, title: string) => call<Conversation>("PATCH", `/api/agent/conversations/${id}`, { title }),
  controls: (conv: string | null, profile: string, warm = false, harness?: string) => call<ChatControls>("GET", `/api/agent/controls?${conv ? `conv=${conv}` : `profile=${encodeURIComponent(profile)}`}${warm ? "&warm=1" : ""}${harness ? `&harness=${encodeURIComponent(harness)}` : ""}`),
  refreshControls: (conv: string | null, profile: string) => call<ChatControls>("POST", `/api/agent/controls/refresh?${conv ? `conv=${conv}` : `profile=${encodeURIComponent(profile)}`}`),
  setControl: (conv: string, id: string, value: string, confirmed = false) => call<ChatControls>("PUT", `/api/agent/conversations/${conv}/controls/${encodeURIComponent(id)}`, { value, ...(confirmed ? { confirmed } : {}) }),
  confirm: (turn: string, callId: string, allow: boolean, optionId?: string) => call("POST", `/api/agent/turns/${turn}/confirm`, { callId, allow, ...(optionId ? { optionId } : {}) }),
  look: (turn: string, callId: string, r: { text?: string; image?: string; width?: number; height?: number; error?: string }) => call("POST", `/api/agent/turns/${turn}/look`, { callId, ...r }),
  stop: (turn: string) => call("POST", `/api/agent/turns/${turn}/stop`, {}),
  /** Words for the reply being written; `steered` is false when its agent can't take them mid-reply. */
  steer: (turn: string, text: string, attachments: string[] = []) => call<{ steered: boolean }>("POST", `/api/agent/turns/${turn}/steer`, { text, attachments }),
  permission: () => call<{ permission: Permission }>("GET", "/api/agent/permission"),
  setPermission: (permission: Permission) => call<{ permission: Permission }>("PUT", "/api/agent/permission", { permission }),
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
  async send(conv: string, body: { text: string; attachments: string[]; model?: string | null; effort?: string; controls?: Record<string, string>; page?: string; view?: { lines: string[]; selection?: string } }, on: (e: AgentEvent) => void): Promise<void> {
    const res = await etudeFetch(`/api/agent/conversations/${conv}/messages`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => null);
      // `ai_consent` (the iPhone app): nothing was sent; `provider` is who the person has to agree to first.
      throw Object.assign(new Error(data?.error ?? res.statusText), data?.code ? { code: data.code, provider: data.provider } : {});
    }
    await readEvents(res.body, on);
  },
  /**
   * Picks up a turn that's still running (the window reloaded mid-reply): `on` gets what it did so far with `replay`
   * true, then the rest live. False when the turn is already over.
   */
  async follow(turn: string, on: (e: AgentEvent, replay: boolean) => void, signal?: AbortSignal): Promise<boolean> {
    const res = await etudeFetch(`/api/agent/turns/${turn}/events`, { headers: headers(false), signal });
    if (res.status === 404) return false;
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error ?? res.statusText);
    }
    await readEvents(res.body, (e) => on(e, !!(e as { replay?: boolean }).replay), signal);
    return true;
  },
  /** Streams live updates to a conversation's background processes until aborted. */
  async watchTasks(convId: string, on: (tasks: BackgroundTask[]) => void, signal?: AbortSignal): Promise<void> {
    const res = await etudeFetch(`/api/agent/conversations/${convId}/tasks/events`, { headers: headers(false), signal });
    if (!res.ok || !res.body) return;
    await readEvents(
      res.body,
      (e) => {
        if (e.type === "tasks" && Array.isArray(e.tasks)) on(e.tasks);
      },
      signal,
    );
  },
};

/** Reads a server-sent event stream, calling `on` with each event's JSON. */
async function readEvents(body: ReadableStream<Uint8Array>, on: (e: AgentEvent) => void, signal?: AbortSignal) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    if (signal?.aborted) {
      void reader.cancel().catch(() => {});
      return;
    }
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
      if (data && !signal?.aborted) {
        try {
          on(JSON.parse(data));
        } catch {}
      }
    }
  }
}

// How much Ask asks before acting is one setting for every chat, so every open chat shows the same pick.
let permission: Permission = "dangerous";
let permissionAsked = false;
const permissionSubs = new Set<() => void>();
const setPermissionLocal = (p: Permission) => {
  permission = p;
  for (const f of permissionSubs) f();
};
export const permissionStore = {
  get: () => permission,
  subscribe(f: () => void) {
    permissionSubs.add(f);
    if (!permissionAsked) permissionStore.refresh();
    return () => void permissionSubs.delete(f);
  },
  /** Reads it again from the server (it may have been set from the CLI or another window). */
  refresh() {
    permissionAsked = true;
    agentApi.permission().then((r) => setPermissionLocal(r.permission), () => (permissionAsked = false));
  },
  async set(p: Permission) {
    const before = permission;
    setPermissionLocal(p);
    try {
      setPermissionLocal((await agentApi.setPermission(p)).permission);
    } catch (e) {
      setPermissionLocal(before);
      throw e;
    }
  },
};

/** Fired after the assistant changed the collection, so pages can reload. */
export const DATA_EVENT = "etude:data-changed";

/** After a chat is deleted: says so when the agent kept its copy of the chat. */
export function agentKeptSession(r: { agentSession?: { deleted: boolean; error?: string } }): string | null {
  return r.agentSession && !r.agentSession.deleted ? `The chat is gone here, but the agent kept it in its own history${r.agentSession.error ? `: ${r.agentSession.error}` : "."}` : null;
}
