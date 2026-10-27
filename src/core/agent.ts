// The in-app agent: a chat that can run any Etude command in-process, with confirmation for
// destructive commands, a snapshot before the first write of each turn, and undo.
// Conversations are stored in the collection (agent_* tables); undo leaves those tables alone,
// so restoring a snapshot never rewinds the chat itself.
import type { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AiError, type AgentEffort, type ChatProvider } from "./ai.ts";
import { cheatSheet } from "./agent-cheatsheet.ts";
import { chatGptStatus, listChatGptModels } from "./chatgpt.ts";
import { llmTurn, type LlmMessage, type ToolCall, type ToolSpec } from "./agent-llm.ts";
import type { Etude } from "./engine.ts";

export const AGENT_MAX_TOOL_CALLS = 25;
export const AGENT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const KEEP_SNAPSHOTS = 10;
const OUTPUT_LIMIT = 6000;
const CHUNK = 12000;
/** Characters of attached text put straight into the user's message. */
const INLINE_BUDGET = 24000;
const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";

/** Commands the agent may never run: they restart or replace things, or touch credentials. */
// `media prune` deletes files, which an undo (a database snapshot) can't bring back.
export const AGENT_DENY = ["serve", "update", "settings chatgpt login", "settings chatgpt logout", "settings chatgpt import", "db restore", "market publish", "media prune", "agent"];

export class AgentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------------ types

export interface AttachmentMeta {
  id: string;
  name: string;
  kind: "image" | "pdf" | "text" | "anki" | "file";
  mime: string;
  bytes: number;
  pages?: number;
  path: string;
  /** For images: the media URL in the collection. */
  url?: string;
}

export type AgentItem =
  | { type: "text"; text: string }
  | {
      type: "tool";
      id: string;
      tool: string;
      /** `etude …` command line, or the tool's arguments for the other tools. */
      label: string;
      argv?: string[];
      status: "running" | "done" | "error" | "denied" | "waiting";
      exit?: number;
      output?: string;
      writes?: boolean;
      preview?: string;
      /** Confirmations: the consequence in plain words, and the name of the action ("Delete deck"). */
      summary?: string;
      action?: string;
      /** The name in the summary to set off (the deck, theme or type). */
      target?: string;
      /** Successful writes: a few words on what changed ("created deck Week 3"), for the Undo button. */
      change?: string;
      /** A look-up (help); the panel doesn't list it. */
      lookup?: boolean;
    }
  | { type: "ui"; action: string; path?: string };

export interface UserContent {
  text: string;
  attachments: Omit<AttachmentMeta, "path">[];
}

export interface AssistantContent {
  text: string;
  items: AgentItem[];
  /** The model-level messages this turn produced (tool calls and their results), replayed on later turns. */
  llm: LlmMessage[];
  model: string;
  ms: number;
  error?: string;
  stopped?: boolean;
  changed: boolean;
  /** What this reply changed, in a few words each. */
  changes?: string[];
  /** The model ref the reply used (`chatgpt:gpt-6.1-sol`), for showing its display name. */
  modelRef?: string;
}

export interface AgentMessage {
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
  /** False once the user named it; auto titles stop then. */
  autoTitle: boolean;
  model: string | null;
  created: string;
  updated: string;
}

export type AgentEvent =
  | { type: "start"; turnId: string; conversation: Conversation; userMessage: AgentMessage }
  | { type: "text"; delta: string }
  | { type: "tool_start"; item: AgentItem & { type: "tool" } }
  | { type: "tool_end"; item: AgentItem & { type: "tool" } }
  | { type: "confirm"; item: AgentItem & { type: "tool" } }
  | { type: "ui"; action: string; path?: string }
  | { type: "changed" }
  | { type: "title"; conversation: Conversation }
  | { type: "done"; message: AgentMessage }
  | { type: "error"; error: string };

export interface ModelChoice {
  ref: string;
  name: string;
  vision?: boolean;
}

export interface ModelGroup {
  provider: "chatgpt" | "openrouter" | "custom";
  label: string;
  models: ModelChoice[];
  error?: string;
}

// ------------------------------------------------------------------ store

const now = () => new Date().toISOString();

class Store {
  readonly sql: DatabaseSync;
  constructor(sql: DatabaseSync) {
    this.sql = sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', model TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL, created TEXT NOT NULL, snapshot TEXT, undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agent_messages_conv ON agent_messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS agent_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const cols = (this.sql.prepare("PRAGMA table_info(agent_conversations)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("auto_title")) this.sql.exec("ALTER TABLE agent_conversations ADD COLUMN auto_title INTEGER NOT NULL DEFAULT 1");
  }
  all(q: string, ...p: any[]) {
    return this.sql.prepare(q).all(...p) as any[];
  }
  get(q: string, ...p: any[]) {
    return this.sql.prepare(q).get(...p) as any;
  }
  run(q: string, ...p: any[]) {
    return this.sql.prepare(q).run(...p);
  }
  kv(key: string): string | null {
    return this.get("SELECT value FROM agent_kv WHERE key = ?", key)?.value ?? null;
  }
  setKv(key: string, value: string | null) {
    if (value === null) this.run("DELETE FROM agent_kv WHERE key = ?", key);
    else this.run("INSERT INTO agent_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
}

// ------------------------------------------------------------------ tools

const TOOLS: ToolSpec[] = [
  {
    name: "etude_help",
    description:
      "Search Etude's command catalog. Without a query, lists the command groups. With a query (words, or an exact command like 'deck move'), returns matching commands with their arguments, flags and examples. Look a command up here before running it.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Words to search for, or a command name." } }, additionalProperties: false },
  },
  {
    name: "etude_run",
    description:
      "Run one Etude CLI command against the open collection and get its JSON output. Pass the words after `etude` as separate argv strings, e.g. [\"deck\",\"create\",\"Spanish::Verbs\"]. Use `-` as a file argument with `stdin` to pass a pack or other JSON inline. Add --dry-run to preview a write. Destructive commands ask the user first.",
    parameters: {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string" }, description: "Command words, arguments and flags, without the leading `etude`." },
        json: { type: "object", description: "JSON given to the command as stdin (for `-` arguments), as an object: a pack for pack import, fields for item add. Prefer this over stdin for JSON.", additionalProperties: true },
        stdin: { type: "string", description: "Plain text given to the command as stdin (for `-` arguments), when it isn't JSON." },
      },
      required: ["argv"],
      additionalProperties: false,
    },
  },
  {
    name: "read_attachment",
    description: "Read a file the user attached, by its id. PDFs are read by page (page: 1, or a range like '2-4'); other text files in chunks of 12000 characters (offset).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        page: { type: "string", description: "PDF page or range, e.g. '1' or '3-5'." },
        offset: { type: "number", description: "Character offset for text files." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "ui",
    description:
      "Change what the user sees in the app. `navigate` opens a path: / (decks), /deck?name=<deck>, /browse?q=<search>, /types, /types/<id>, /market, /stats, /settings, /study?deck=<deck>. `refresh` reloads the current page.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["navigate", "refresh"] }, path: { type: "string" } },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

const ROUTES = ["/", "/deck", "/browse", "/types", "/market", "/stats", "/settings", "/study", "/watch"];

function quote(a: string) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`;
}
export const commandLine = (argv: string[]) => ["etude", ...argv.map(quote)].join(" ");

function truncate(s: string, n = OUTPUT_LIMIT) {
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters cut)` : s;
}

// --------------------------------------------------------- attachments

const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm", ".tex", ".js", ".ts", ".tsx", ".jsx", ".py", ".c", ".h", ".cpp", ".hpp", ".java", ".go", ".rs", ".rb", ".sh", ".css", ".sql", ".m", ".r", ".kt", ".swift", ".lua", ".toml", ".ini", ".srt", ".vtt"]);
const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

export function attachmentKind(name: string, data?: Uint8Array): AttachmentMeta["kind"] {
  const ext = extname(name).toLowerCase();
  if (IMAGE_MIME[ext]) return "image";
  if (ext === ".pdf") return "pdf";
  if (ext === ".apkg" || ext === ".colpkg") return "anki";
  if (TEXT_EXT.has(ext)) return "text";
  if (data && !data.subarray(0, 4096).includes(0)) return "text";
  return "file";
}

async function pdfPages(data: Uint8Array): Promise<string[]> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).map((t) => t.replace(/[ \t]+\n/g, "\n").trim());
}

// ------------------------------------------------------------------ agent

interface PendingConfirm {
  item: AgentItem & { type: "tool" };
  resolve(allow: boolean): void;
}

interface Turn {
  id: string;
  conversationId: string;
  abort: AbortController;
  pending: Map<string, PendingConfirm>;
}

export interface SendInput {
  text: string;
  attachments?: string[];
  model?: string | null;
  /** Context from the app: the page the user is on. */
  page?: string;
  /** Approve every confirmation without asking (CLI --yes). */
  autoConfirm?: boolean | "deny";
}

const agents = new WeakMap<Etude, Agent>();

export function agentFor(etude: Etude): Agent {
  let a = agents.get(etude);
  if (!a) {
    a = new Agent(etude);
    agents.set(etude, a);
  }
  return a;
}

export class Agent {
  readonly etude: Etude;
  readonly store: Store;
  readonly snapshotDir: string;
  readonly attachmentDir: string;
  private turns = new Map<string, Turn>();
  private modelCache: { at: number; groups: ModelGroup[] } | null = null;
  /** For tests: replaces OpenRouter's model list URL. */
  openRouterModelsUrl = "https://openrouter.ai/api/v1/models";

  constructor(etude: Etude) {
    this.etude = etude;
    this.store = new Store(etude.db.sql);
    this.snapshotDir = join(etude.home, "agent-snapshots");
    this.attachmentDir = join(etude.home, "agent-attachments");
  }

  // ------------------------------------------------------------ conversations

  private conv(row: any): Conversation {
    return { id: row.id, title: row.title, autoTitle: row.auto_title !== 0, model: row.model ?? null, created: row.created, updated: row.updated };
  }

  listConversations(): Conversation[] {
    return this.store.all("SELECT * FROM agent_conversations ORDER BY updated DESC").map((r) => this.conv(r));
  }

  conversation(id: string): Conversation & { messages: AgentMessage[] } {
    const row = this.store.get("SELECT * FROM agent_conversations WHERE id = ?", id);
    if (!row) throw new AgentError(`no conversation "${id}"`, 404);
    return { ...this.conv(row), messages: this.messages(id) };
  }

  createConversation(model?: string | null): Conversation {
    const id = randomUUID().slice(0, 8);
    const t = now();
    this.store.run("INSERT INTO agent_conversations (id, title, model, created, updated) VALUES (?, '', ?, ?, ?)", id, model ?? this.defaultModel(), t, t);
    return this.conversation(id);
  }

  deleteConversation(id: string): { deleted: string } {
    this.conversation(id);
    this.store.run("DELETE FROM agent_conversations WHERE id = ?", id);
    rmSync(join(this.attachmentDir, id), { recursive: true, force: true });
    return { deleted: id };
  }

  /** Names a conversation by hand; automatic titles stop for it. */
  renameConversation(id: string, title: string): Conversation {
    this.conversation(id);
    const t = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!t) throw new AgentError("the title is empty");
    this.store.run("UPDATE agent_conversations SET title = ?, auto_title = 0 WHERE id = ?", t, id);
    return this.conv(this.store.get("SELECT * FROM agent_conversations WHERE id = ?", id));
  }

  setConversationModel(id: string, model: string) {
    this.conversation(id);
    this.store.run("UPDATE agent_conversations SET model = ? WHERE id = ?", model, id);
    this.store.setKv("lastModel", model);
    this.store.setKv("lastModelBase", JSON.stringify(this.etude.settings().ai.agent?.model ?? null));
  }

  private messages(convId: string): AgentMessage[] {
    const rows = this.store.all("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY id", convId);
    return rows.map((r) => this.message(r));
  }

  private message(r: any): AgentMessage {
    const content = JSON.parse(r.content);
    const snap = r.snapshot as string | null;
    return {
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role,
      content,
      created: r.created,
      snapshot: snap ? basename(snap) : null,
      undone: !!r.undone,
      canUndo: r.role === "assistant" && !r.undone && !!snap && existsSync(snap),
    };
  }

  // ------------------------------------------------------------------ models

  /** The model ref a new conversation starts with. */
  defaultModel(): string | null {
    const setting = this.etude.settings().ai.agent?.model ?? null;
    // The last pick wins until the setting itself changes.
    if (this.store.kv("lastModelBase") === JSON.stringify(setting)) return this.store.kv("lastModel") ?? setting;
    return setting;
  }

  clearLastModel() {
    this.store.setKv("lastModel", null);
  }

  /** A model ref as a provider. Refs: `chatgpt:<slug>`, `openrouter:<id>`, `custom:<id>`; null means the feedback provider. */
  resolveModel(ref: string | null | undefined): ChatProvider {
    const ai = this.etude.settings().ai;
    const fb = ai.feedback;
    const r = ref ?? ai.agent?.model ?? null;
    if (!r) {
      if (!fb) throw new AgentError("no AI provider is set up; choose one in Settings → AI grading", 409);
      return fb;
    }
    const i = r.indexOf(":");
    const kind = i < 0 ? "" : r.slice(0, i);
    const model = r.slice(i + 1);
    if (kind === "chatgpt") return { kind: "chatgpt", model, vision: true, ...(fb?.kind === "chatgpt" && fb.baseUrl ? { baseUrl: fb.baseUrl } : {}), timeoutMs: 180_000 };
    if (kind === "openrouter") {
      const env = fb?.kind === "openai-chat" && /openrouter\.ai/.test(fb.url) ? fb.apiKeyEnv : "OPENROUTER_API_KEY";
      const url = fb?.kind === "openai-chat" && /openrouter/.test(fb.url) ? fb.url : OPENROUTER_CHAT;
      return { kind: "openai-chat", url, model, apiKeyEnv: env ?? "OPENROUTER_API_KEY", vision: this.visionOf(r), timeoutMs: 180_000 };
    }
    if (kind === "custom") {
      if (fb?.kind !== "openai-chat") throw new AgentError("no custom endpoint is configured", 409);
      return { ...fb, model, timeoutMs: Math.max(fb.timeoutMs ?? 0, 180_000) };
    }
    throw new AgentError(`unknown model "${r}" (use chatgpt:<model>, openrouter:<model> or custom:<model>)`);
  }

  private visionOf(ref: string): boolean {
    for (const g of this.modelCache?.groups ?? []) for (const m of g.models) if (m.ref === ref) return !!m.vision;
    return true;
  }

  /** The ref of the feedback provider, for display. */
  feedbackRef(): string | null {
    const fb = this.etude.settings().ai.feedback;
    if (!fb) return null;
    if (fb.kind === "chatgpt") return `chatgpt:${fb.model}`;
    return /openrouter\.ai/.test(fb.url) ? `openrouter:${fb.model}` : `custom:${fb.model}`;
  }

  /** Models the user can pick, from every configured provider. */
  async models(force = false): Promise<{ configured: boolean; default: string | null; groups: ModelGroup[] }> {
    const ai = this.etude.settings().ai;
    const fb = ai.feedback;
    if (!force && this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return { configured: this.configured(), default: this.defaultModel() ?? this.feedbackRef(), groups: this.modelCache.groups };
    const groups: ModelGroup[] = [];
    const st = chatGptStatus(this.etude.home);
    if (st.signedIn) {
      const g: ModelGroup = { provider: "chatgpt", label: "ChatGPT", models: [] };
      try {
        g.models = (await listChatGptModels(this.etude.home, fb?.kind === "chatgpt" && fb.baseUrl ? {} : {})).map((m) => ({ ref: `chatgpt:${m.slug}`, name: m.displayName, vision: true }));
      } catch (e) {
        g.error = (e as Error).message;
        if (fb?.kind === "chatgpt") g.models = [{ ref: `chatgpt:${fb.model}`, name: fb.model, vision: true }];
      }
      groups.push(g);
    }
    const orEnv = fb?.kind === "openai-chat" && /openrouter\.ai/.test(fb.url) ? fb.apiKeyEnv : "OPENROUTER_API_KEY";
    if (orEnv && process.env[orEnv]) {
      const g: ModelGroup = { provider: "openrouter", label: "OpenRouter", models: [] };
      try {
        const res = await fetch(this.openRouterModelsUrl, { signal: AbortSignal.timeout(15_000) });
        const body = (await res.json()) as { data?: any[] };
        g.models = (body.data ?? [])
          .filter((m) => Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"))
          .map((m) => ({ ref: `openrouter:${m.id}`, name: m.name ?? m.id, vision: Array.isArray(m.architecture?.input_modalities) && m.architecture.input_modalities.includes("image") }));
      } catch (e) {
        g.error = `couldn't load OpenRouter's models: ${(e as Error).message}`;
      }
      groups.push(g);
    }
    if (fb?.kind === "openai-chat" && !/openrouter\.ai/.test(fb.url)) groups.push({ provider: "custom", label: new URL(fb.url).host, models: [{ ref: `custom:${fb.model}`, name: fb.model, vision: !!fb.vision }] });
    this.modelCache = { at: Date.now(), groups };
    return { configured: this.configured(), default: this.defaultModel() ?? this.feedbackRef(), groups };
  }

  configured(): boolean {
    const ai = this.etude.settings().ai;
    if (ai.feedback || ai.agent?.model) return true;
    return chatGptStatus(this.etude.home).signedIn || !!process.env.OPENROUTER_API_KEY;
  }

  // ------------------------------------------------------------ attachments

  addAttachment(convId: string, name: string, data: Uint8Array): Omit<AttachmentMeta, "path"> {
    this.conversation(convId);
    if (!data.byteLength) throw new AgentError("the file is empty");
    if (data.byteLength > AGENT_MAX_ATTACHMENT_BYTES) throw new AgentError("attachments must be 50 MB or smaller", 413);
    const safe = basename(name).replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "file";
    const id = `a${randomUUID().slice(0, 6)}`;
    const dir = join(this.attachmentDir, convId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}-${safe}`);
    writeFileSync(path, data);
    const kind = attachmentKind(safe, data);
    const ext = extname(safe).toLowerCase();
    const meta: AttachmentMeta = { id, name: safe, kind, mime: IMAGE_MIME[ext] ?? (kind === "pdf" ? "application/pdf" : kind === "text" ? "text/plain" : "application/octet-stream"), bytes: data.byteLength, path };
    if (kind === "image") {
      try {
        meta.url = this.etude.storeMedia(safe, data).url;
      } catch {}
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(meta));
    return this.publicMeta(meta);
  }

  /** Extracts PDF text once, in the background of the first read. */
  private async pages(meta: AttachmentMeta): Promise<string[]> {
    const cache = join(dirname(meta.path), `${meta.id}.pages.json`);
    if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
    const pages = await pdfPages(readFileSync(meta.path));
    writeFileSync(cache, JSON.stringify(pages));
    return pages;
  }

  async addAttachmentFile(convId: string, file: string) {
    if (!existsSync(file) || !statSync(file).isFile()) throw new AgentError(`no such file: ${file}`, 404);
    if (statSync(file).size > AGENT_MAX_ATTACHMENT_BYTES) throw new AgentError("attachments must be 50 MB or smaller", 413);
    return this.prepareAttachment(convId, this.addAttachment(convId, basename(file), readFileSync(file)).id);
  }

  /** Counts PDF pages right after upload, so the chip can show them. */
  async prepareAttachment(convId: string, id: string): Promise<Omit<AttachmentMeta, "path">> {
    const meta = this.attachment(convId, id);
    if (meta.kind === "pdf" && meta.pages === undefined) {
      try {
        meta.pages = (await this.pages(meta)).length;
      } catch (e) {
        throw new AgentError(`couldn't read the PDF: ${(e as Error).message}`);
      }
      writeFileSync(join(dirname(meta.path), `${id}.json`), JSON.stringify(meta));
    }
    return this.publicMeta(meta);
  }

  private publicMeta(m: AttachmentMeta): Omit<AttachmentMeta, "path"> {
    const { path: _p, ...rest } = m;
    return rest;
  }

  attachment(convId: string, id: string): AttachmentMeta {
    if (!/^a[\w-]+$/.test(id)) throw new AgentError(`no attachment "${id}"`, 404);
    const f = join(this.attachmentDir, convId, `${id}.json`);
    if (!existsSync(f)) throw new AgentError(`no attachment "${id}"`, 404);
    return JSON.parse(readFileSync(f, "utf8"));
  }

  attachmentFile(convId: string, id: string): string {
    return this.attachment(convId, id).path;
  }

  private async readAttachment(convId: string, args: { id: string; page?: string; offset?: number }): Promise<string> {
    const m = this.attachment(convId, String(args.id ?? ""));
    if (m.kind === "image") return `Image ${m.name} (${m.mime}). It is in the collection's media as ${m.url ?? "(not stored)"}; put it on a card with <img src="${m.url}">. The original file is ${m.path}.`;
    if (m.kind === "anki") return `Anki package ${m.name} at ${m.path}. Import it with etude_run ["anki","import","${m.path}"] (add --dry-run first to see what it contains).`;
    if (m.kind === "pdf") {
      const pages = await this.pages(m);
      const spec = String(args.page ?? "1");
      const mm = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(spec.trim());
      if (!mm) return `page must be a number or a range like 2-4; the PDF has ${pages.length} pages`;
      const a = Math.max(1, Number(mm[1]));
      const b = Math.min(pages.length, Number(mm[2] ?? mm[1]));
      if (a > pages.length) return `the PDF has ${pages.length} pages`;
      const out = [];
      for (let p = a; p <= b; p++) out.push(`--- page ${p} of ${pages.length} ---\n${pages[p - 1] || "(no text on this page; it may be a scan)"}`);
      return truncate(out.join("\n\n"), CHUNK * 2);
    }
    if (m.kind === "text") {
      const text = readFileSync(m.path, "utf8");
      const off = Math.max(0, Math.trunc(Number(args.offset ?? 0)) || 0);
      const chunk = text.slice(off, off + CHUNK);
      return off + CHUNK < text.length ? `${chunk}\n… (characters ${off}-${off + CHUNK} of ${text.length}; read more with offset ${off + CHUNK})` : chunk || "(end of file)";
    }
    return `${m.name} is a binary file (${m.bytes} bytes) at ${m.path}; it can't be read as text.`;
  }

  // ------------------------------------------------------------ snapshots

  private snapshot(convId: string): string {
    mkdirSync(this.snapshotDir, { recursive: true });
    const file = join(this.snapshotDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${convId}-${randomUUID().slice(0, 4)}.db`);
    this.etude.db.sql.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const all = readdirSync(this.snapshotDir)
      .filter((f) => f.endsWith(".db"))
      .sort();
    for (const f of all.slice(0, Math.max(0, all.length - KEEP_SNAPSHOTS))) rmSync(join(this.snapshotDir, f), { force: true });
    return file;
  }

  /** Copies every table back from a snapshot, on the open connection. */
  private restore(file: string) {
    const db = this.etude.db.sql;
    db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS snap`);
    try {
      const mainTables = (db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
      const snapTables = new Set((db.prepare("SELECT name FROM snap.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name));
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const t of mainTables) {
          if (t.startsWith("agent_")) continue;
          db.exec(`DELETE FROM main."${t}"`);
          if (!snapTables.has(t)) continue;
          const cols = (db.prepare(`PRAGMA snap.table_info("${t}")`).all() as { name: string }[]).map((c) => `"${c.name}"`);
          const mainCols = new Set((db.prepare(`PRAGMA main.table_info("${t}")`).all() as { name: string }[]).map((c) => `"${c.name}"`));
          const shared = cols.filter((c) => mainCols.has(c)).join(", ");
          db.exec(`INSERT INTO main."${t}" (${shared}) SELECT ${shared} FROM snap."${t}"`);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
    } finally {
      db.exec("DETACH DATABASE snap");
    }
    this.etude.invalidateCaches();
  }

  /** Puts the collection back as it was before an assistant turn. Later turns' changes go too. */
  undo(convId: string, messageId?: number): { restored: string; undone: number[] } {
    this.conversation(convId);
    const row = messageId
      ? this.store.get("SELECT * FROM agent_messages WHERE id = ? AND conversation_id = ?", messageId, convId)
      : this.store.get("SELECT * FROM agent_messages WHERE conversation_id = ? AND role = 'assistant' AND snapshot IS NOT NULL AND undone = 0 ORDER BY id DESC LIMIT 1", convId);
    if (!row) throw new AgentError(messageId ? `no message ${messageId} in this conversation` : "nothing to undo in this conversation", 404);
    if (row.undone) throw new AgentError("those changes were already undone", 409);
    if (!row.snapshot) throw new AgentError("that reply didn't change anything", 409);
    if (!existsSync(row.snapshot)) throw new AgentError("that snapshot is gone (only the last 10 are kept)", 410);
    if ([...this.turns.values()].length) throw new AgentError("wait for the agent to finish (or stop it) before undoing", 409);
    this.restore(row.snapshot);
    const later = this.store.all("SELECT id FROM agent_messages WHERE role = 'assistant' AND snapshot IS NOT NULL AND undone = 0 AND id >= ?", row.id).map((r) => r.id as number);
    for (const id of later) this.store.run("UPDATE agent_messages SET undone = 1 WHERE id = ?", id);
    return { restored: basename(row.snapshot), undone: later };
  }

  // ------------------------------------------------------------------ turns

  runningTurn(convId: string): string | null {
    for (const t of this.turns.values()) if (t.conversationId === convId) return t.id;
    return null;
  }

  stop(turnId: string): boolean {
    const t = this.turns.get(turnId);
    if (!t) return false;
    t.abort.abort();
    for (const p of t.pending.values()) p.resolve(false);
    return true;
  }

  confirm(turnId: string, callId: string, allow: boolean): boolean {
    const p = this.turns.get(turnId)?.pending.get(callId);
    if (!p) return false;
    p.resolve(allow);
    return true;
  }

  /** Market theme ids, from the market index when it answers quickly (cached for a minute). */
  private async marketThemes(): Promise<string[]> {
    try {
      const { fetchIndex, marketSettings } = await import("./market.ts");
      const idx = await Promise.race([fetchIndex(marketSettings(this.etude).url), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
      return idx ? idx.entries.filter((x) => x.kind === "theme").map((x) => x.id) : [];
    } catch {
      return [];
    }
  }

  private async systemPrompt(page?: string): Promise<string> {
    const e = this.etude;
    const types = e
      .listTypes()
      .map((t) => `- ${t.id}: ${t.name}${t.description ? `. ${t.description.replace(/\s+/g, " ").slice(0, 90)}` : ""}`)
      .join("\n");
    const decks = (e.db.all("SELECT name FROM decks WHERE archived = 0 ORDER BY name") as { name: string }[]).map((r) => r.name);
    const deckList = decks.length ? decks.slice(0, 80).join(", ") + (decks.length > 80 ? `, and ${decks.length - 80} more` : "") : "(none yet)";
    const themes = e.listThemes();
    const installed = new Set(themes.map((t) => t.id));
    const market = (await this.marketThemes()).filter((id) => !installed.has(id));
    // Stable text first, so providers can cache the prefix across turns.
    return `You are the assistant inside Etude, a spaced-repetition practice app. You change the user's collection by running Etude CLI commands with etude_run, in-process, on the open collection.

How Etude works: an item is one piece of content (fields) of a card type; each item makes one or more cards, scheduled by FSRS (or another scheduler per deck). Card types define fields, a template and a grader. Decks form a tree written A::B::C. Themes color the app; the Market has more themes, decks and card types.

${await cheatSheet(e)}

Work fast:
- Prefer the fewest steps. Call several tools in one step when they don't depend on each other (e.g. several deck creates).
- After pack import the app opens the deck by itself. For other writes, finish in the same step when you can: your short reply AND ui navigate to the deck it touched, in one step; that ends the turn.
- Use the cheat-sheet's syntax directly. Don't call etude_help or --help for commands listed there.
- Run writes directly. Use --dry-run only when you're unsure what a bulk change would touch. Every reply's changes can be undone by the user.
- To make cards from material, write one pack and import it in one etude_run call. Pick existing card types that fit (basic for facts; typed, mcq or cloze when they fit better); don't create card types unless asked.
- Themes: \`theme set <id>\` for an installed theme; for a market theme, \`market install <id> --use\` directly.
- Use only facts from the user's material or words; don't invent content. If the material is thin, say so.
- Destructive commands ask the user to confirm; if they deny, don't work around it.
- Reply in the user's language. After acting, say briefly what changed (one to three short lines, markdown, no ids). Open the affected deck with ui navigate when it helps.

Card types:
${types}

Themes installed: ${themes.map((t) => t.id).join(", ")}${market.length ? `\nThemes in the market (not installed): ${market.join(", ")}` : ""}
Selected theme: ${e.currentTheme().id}
Decks: ${deckList}
Today: ${new Date().toISOString().slice(0, 10)}${page ? `\nThe user is looking at: ${page}` : ""}`;
  }

  /** Model-level history: earlier turns as text plus their tool exchanges. */
  private history(convId: string): LlmMessage[] {
    const out: LlmMessage[] = [];
    for (const m of this.messages(convId)) {
      if (m.role === "user") {
        const c = m.content as UserContent;
        out.push({ role: "user", content: this.userText(c, convId) });
      } else {
        const c = m.content as AssistantContent;
        out.push(...(c.llm ?? []));
        out.push({ role: "assistant", content: c.text || (c.error ? `(error: ${c.error})` : c.stopped ? "(stopped)" : "") + (m.undone ? "\n\n(The user undid the changes made in this reply.)" : "") });
      }
    }
    return out;
  }

  /** The user's message for the model. Small text files and short PDFs go inline, so no read step is needed. */
  private userText(c: UserContent, convId?: string): string {
    if (!c.attachments?.length) return c.text;
    let budget = INLINE_BUDGET;
    const lines: string[] = [];
    const inline: string[] = [];
    for (const a of c.attachments) {
      lines.push(`- ${a.id}: ${a.name} (${a.kind}${a.pages ? `, ${a.pages} pages` : ""}, ${a.bytes} bytes)${a.url ? `, media URL ${a.url}` : ""}`);
      if (!convId || (a.kind !== "text" && a.kind !== "pdf")) continue;
      try {
        const m = this.attachment(convId, a.id);
        let text: string | null = null;
        if (m.kind === "text" && m.bytes <= budget * 4) text = readFileSync(m.path, "utf8");
        else if (m.kind === "pdf") {
          const cache = join(dirname(m.path), `${m.id}.pages.json`);
          if (existsSync(cache)) text = (JSON.parse(readFileSync(cache, "utf8")) as string[]).map((t, i) => `--- page ${i + 1} ---\n${t}`).join("\n\n");
        }
        if (text !== null && text.length <= budget) {
          inline.push(`<file id="${a.id}" name="${a.name}">\n${text}\n</file>`);
          budget -= text.length;
        }
      } catch {}
    }
    const rest = lines.length - inline.length;
    return `${c.text}\n\nAttached files${rest ? " (read the ones not shown below with read_attachment)" : ""}:\n${lines.join("\n")}${inline.length ? `\n\n${inline.join("\n\n")}` : ""}`;
  }

  /** Names the conversation from everything said so far: a short noun phrase, same model, no tools. */
  async retitle(convId: string, provider: ChatProvider, messages: LlmMessage[], emit: (e: AgentEvent) => void = () => {}): Promise<string | null> {
    const transcript = messages
      .filter((m) => m.role !== "tool")
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.replace(/<file[\s\S]*?<\/file>/g, "[file]").slice(0, 600)}`)
      .filter((l) => !/^Assistant: $/.test(l))
      .join("\n")
      .slice(-4000);
    try {
      const r = await llmTurn({
        provider,
        home: this.etude.home,
        system: "You name chat conversations. Reply with only a short noun phrase of at most 6 words that sums up the whole conversation, in the conversation's language. No quotes, no final period.",
        messages: [{ role: "user", content: transcript }],
        tools: [],
        effort: "minimal",
      });
      const title = r.text
        .replace(/^["'“”‘’\s#*]+|["'“”‘’\s.]+$/g, "")
        .split(/\s+/)
        .slice(0, 6)
        .join(" ")
        .slice(0, 60);
      if (!title) return null;
      const row = this.store.get("SELECT auto_title FROM agent_conversations WHERE id = ?", convId);
      if (!row || row.auto_title === 0) return null;
      this.store.run("UPDATE agent_conversations SET title = ? WHERE id = ?", title, convId);
      emit({ type: "title", conversation: this.conv(this.store.get("SELECT * FROM agent_conversations WHERE id = ?", convId)) });
      return title;
    } catch {
      return null;
    }
  }

  /** Runs one user turn to the end. Events go to `emit`; the returned promise resolves with the saved reply. */
  async send(convId: string, input: SendInput, emit: (e: AgentEvent) => void = () => {}): Promise<AgentMessage> {
    const conv = this.conversation(convId);
    if (this.runningTurn(convId)) throw new AgentError("the agent is still working on this conversation", 409);
    const text = String(input.text ?? "").trim();
    if (!text && !input.attachments?.length) throw new AgentError("write a message");
    const atts = (input.attachments ?? []).map((id) => this.attachment(convId, id));
    for (const a of atts) if (a.kind === "pdf" && a.pages === undefined) await this.prepareAttachment(convId, a.id);
    const metas = (input.attachments ?? []).map((id) => this.publicMeta(this.attachment(convId, id)));
    const model = input.model ?? conv.model ?? this.defaultModel();
    if (input.model && input.model !== conv.model) this.setConversationModel(convId, input.model);
    const provider = this.resolveModel(model);

    const history = this.history(convId);
    const userContent: UserContent = { text, attachments: metas };
    const t = now();
    const uid = Number(this.store.run("INSERT INTO agent_messages (conversation_id, role, content, created) VALUES (?, 'user', ?, ?)", convId, JSON.stringify(userContent), t).lastInsertRowid);
    if (!conv.title) this.store.run("UPDATE agent_conversations SET title = ? WHERE id = ?", (text || metas[0]?.name || "New chat").replace(/\s+/g, " ").slice(0, 60), convId);
    this.store.run("UPDATE agent_conversations SET updated = ? WHERE id = ?", t, convId);

    const turn: Turn = { id: randomUUID().slice(0, 12), conversationId: convId, abort: new AbortController(), pending: new Map() };
    this.turns.set(turn.id, turn);
    emit({ type: "start", turnId: turn.id, conversation: this.conv(this.store.get("SELECT * FROM agent_conversations WHERE id = ?", convId)), userMessage: this.message(this.store.get("SELECT * FROM agent_messages WHERE id = ?", uid)) });

    const images = provider.vision === false ? [] : atts.filter((a) => a.kind === "image").map((a) => `data:${a.mime};base64,${readFileSync(a.path).toString("base64")}`);
    const messages: LlmMessage[] = [...history, { role: "user", content: this.userText(userContent, convId), ...(images.length ? { images } : {}) }];
    const startLen = messages.length;
    const items: AgentItem[] = [];
    let snapshot: string | null = null;
    let changed = false;
    let modelName = "";
    let finalText = "";
    let error: string | undefined;
    let stopped = false;
    const t0 = Date.now();
    let calls = 0;
    const system = await this.systemPrompt(input.page);
    const effort: AgentEffort = this.etude.settings().ai.agent?.effort ?? "low";
    const changes: string[] = [];
    // Retitle from the whole conversation after the 2nd and 4th message, alongside the turn.
    const userCount = (this.store.get("SELECT COUNT(*) AS n FROM agent_messages WHERE conversation_id = ? AND role = 'user'", convId)?.n ?? 0) as number;
    const titleText = [text, ...atts.map((a) => `[attached ${a.name}${a.kind === "text" ? `: ${readFileSync(a.path, "utf8").slice(0, 400)}` : ""}]`)].join("\n");
    const titling = conv.autoTitle && (userCount === 2 || userCount === 4) ? this.retitle(convId, provider, [...history, { role: "user", content: titleText }], emit) : null;

    try {
      for (let round = 0; round < AGENT_MAX_TOOL_CALLS + 2; round++) {
        let textItem: { type: "text"; text: string } | null = null;
        const res = await llmTurn({
          provider,
          home: this.etude.home,
          system,
          messages,
          tools: calls >= AGENT_MAX_TOOL_CALLS ? [] : TOOLS,
          signal: turn.abort.signal,
          effort,
          onText: (d) => {
            if (!textItem) {
              textItem = { type: "text", text: "" };
              items.push(textItem);
            }
            textItem.text += d;
            emit({ type: "text", delta: d });
          },
        });
        modelName = res.model;
        if (process.env.ETUDE_AGENT_TRACE) process.stderr.write(`[agent] step ${round + 1}: ${res.ms} ms, ${res.toolCalls.length} call(s), ${res.text.length} chars\n`);
        if (res.text && !textItem) items.push({ type: "text", text: res.text });
        if (!res.toolCalls.length) {
          finalText = res.text;
          break;
        }
        messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
        // Calls in one step run together when none of them writes or asks the user; otherwise in order.
        const runOne = async (call: ToolCall): Promise<string> => {
          if (turn.abort.signal.aborted) throw new AiError("stopped");
          calls++;
          if (calls > AGENT_MAX_TOOL_CALLS) return `Tool-call limit (${AGENT_MAX_TOOL_CALLS}) reached for this message. Stop and tell the user what is done and what is left.`;
          const r = await this.execute(call, convId, turn, input, items, emit, () => {
            if (!snapshot) snapshot = this.snapshot(convId);
          });
          if (r.change && !changes.includes(r.change)) changes.push(r.change);
          if (r.wrote) {
            changed = true;
            emit({ type: "changed" });
          }
          return r.output;
        };
        // A step that is the reply plus only ui calls (open the deck) ends the turn: there's nothing left for the model to read.
        const uiOnly = res.text.trim().length > 0 && res.toolCalls.every((c) => c.name === "ui");
        const readOnly = await Promise.all(res.toolCalls.map((c) => this.isReadOnly(c)));
        let outputs: string[];
        if (res.toolCalls.length > 1 && readOnly.every(Boolean)) outputs = await Promise.all(res.toolCalls.map(runOne));
        else {
          outputs = [];
          for (const call of res.toolCalls) outputs.push(await runOne(call));
        }
        res.toolCalls.forEach((call, i) => messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: outputs[i] }));
        if (uiOnly && outputs.every((o) => o === "ok")) {
          finalText = res.text;
          break;
        }
      }
    } catch (e) {
      if (turn.abort.signal.aborted) stopped = true;
      else error = (e as Error).message;
    } finally {
      this.turns.delete(turn.id);
    }
    for (const it of items) if (it.type === "tool" && (it.status === "running" || it.status === "waiting")) it.status = "error";

    const content: AssistantContent = {
      text: finalText || items.filter((i) => i.type === "text").map((i) => (i as { text: string }).text).join("\n\n"),
      items,
      llm: messages.slice(startLen).map((m) => (m.role === "tool" ? { ...m, content: truncate(m.content, 2000) } : m)),
      model: modelName || ("model" in provider ? provider.model : ""),
      ms: Date.now() - t0,
      changed: changed && !!snapshot,
      modelRef: model ?? this.feedbackRef() ?? undefined,
      ...(changes.length ? { changes } : {}),
      ...(error ? { error } : {}),
      ...(stopped ? { stopped: true } : {}),
    };
    const aid = Number(
      this.store.run("INSERT INTO agent_messages (conversation_id, role, content, created, snapshot) VALUES (?, 'assistant', ?, ?, ?)", convId, JSON.stringify(content), now(), changed ? snapshot : null)
        .lastInsertRowid,
    );
    this.store.run("UPDATE agent_conversations SET updated = ? WHERE id = ?", now(), convId);
    const saved = this.message(this.store.get("SELECT * FROM agent_messages WHERE id = ?", aid));
    // A title still being written gets a few more seconds, so it reaches this stream.
    if (titling) await Promise.race([titling, new Promise((r) => setTimeout(r, 4000))]);
    if (error) emit({ type: "error", error });
    emit({ type: "done", message: saved });
    return saved;
  }

  /** True for a call that only reads (help, attachments, read-only commands, dry runs). */
  private async isReadOnly(call: ToolCall): Promise<boolean> {
    if (call.name === "etude_help" || call.name === "read_attachment") return true;
    if (call.name !== "etude_run") return false;
    try {
      const args = JSON.parse(call.arguments || "{}");
      const argv: string[] = Array.isArray(args.argv) ? args.argv.map(String) : typeof args.argv === "string" ? splitArgs(args.argv) : [];
      const { resolveCommand } = await import("../cli/run.ts");
      const cmd = resolveCommand(argv[0] === "etude" ? argv.slice(1) : argv);
      return !!cmd && (!cmd.writes || argv.includes("--dry-run") || argv.includes("--help")) && !cmd.confirm;
    } catch {
      return false;
    }
  }

  private async execute(
    call: ToolCall,
    convId: string,
    turn: Turn,
    input: SendInput,
    items: AgentItem[],
    emit: (e: AgentEvent) => void,
    beforeWrite: () => void,
  ): Promise<{ output: string; wrote: boolean; change?: string }> {
    let args: any;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return { output: `arguments were not valid JSON: ${call.arguments.slice(0, 200)}`, wrote: false };
    }
    if (call.name === "etude_help") {
      const q = typeof args.query === "string" ? args.query : "";
      const item: AgentItem & { type: "tool" } = { type: "tool", id: call.id, tool: "etude_help", label: q ? `help ${q}` : "help", status: "done", lookup: true };
      const out = await helpText(q);
      item.output = truncate(out, 3000);
      items.push(item);
      emit({ type: "tool_start", item });
      emit({ type: "tool_end", item });
      return { output: out, wrote: false };
    }
    if (call.name === "read_attachment") {
      const item: AgentItem & { type: "tool" } = { type: "tool", id: call.id, tool: "read_attachment", label: `read ${args.id}${args.page ? ` p.${args.page}` : ""}`, status: "running" };
      try {
        const name = this.attachment(convId, String(args.id ?? "")).name;
        item.label = `read ${name}${args.page ? `, page ${args.page}` : args.offset ? ` from ${args.offset}` : ""}`;
      } catch {}
      items.push(item);
      emit({ type: "tool_start", item });
      let out: string;
      try {
        out = await this.readAttachment(convId, args);
        item.status = "done";
      } catch (e) {
        out = (e as Error).message;
        item.status = "error";
      }
      item.output = truncate(out, 1500);
      emit({ type: "tool_end", item });
      return { output: out, wrote: false };
    }
    if (call.name === "ui") {
      const action = String(args.action ?? "");
      const path = typeof args.path === "string" ? args.path : undefined;
      if (action === "navigate") {
        if (!path || !path.startsWith("/") || !ROUTES.includes(path.split("?")[0].replace(/^\/types\/.+/, "/types"))) return { output: `unknown path "${path}"`, wrote: false };
      } else if (action !== "refresh") return { output: `unknown ui action "${action}"`, wrote: false };
      const it: AgentItem = { type: "ui", action, ...(path ? { path } : {}) };
      items.push(it);
      emit({ type: "ui", action, ...(path ? { path } : {}) });
      return { output: "ok", wrote: false };
    }
    if (call.name !== "etude_run") return { output: `unknown tool "${call.name}"`, wrote: false };

    let argv: string[] = Array.isArray(args.argv) ? args.argv.map((a: unknown) => String(a)) : typeof args.argv === "string" ? splitArgs(args.argv) : [];
    if (argv[0] === "etude") argv = argv.slice(1);
    const stdin = args.json !== undefined && args.json !== null ? (typeof args.json === "string" ? args.json : JSON.stringify(args.json)) : typeof args.stdin === "string" ? args.stdin : "";
    const item: AgentItem & { type: "tool" } = { type: "tool", id: call.id, tool: "etude_run", label: commandLine(argv), argv, status: "running" };
    items.push(item);

    const { resolveCommand, run } = await import("../cli/run.ts");
    const cmd = resolveCommand(argv);
    const denied = cmd && AGENT_DENY.some((d) => cmd.name === d || cmd.name.startsWith(d + " "));
    if (argv.some((a) => a === "--db" || a.startsWith("--db="))) {
      item.status = "error";
      item.output = "--db can't be used here: the agent works on the open collection.";
      emit({ type: "tool_start", item });
      emit({ type: "tool_end", item });
      return { output: item.output, wrote: false };
    }
    if (denied) {
      item.status = "denied";
      item.output = `\`etude ${cmd!.name}\` isn't available to the assistant. Ask the user to do it themselves.`;
      emit({ type: "tool_start", item });
      emit({ type: "tool_end", item });
      return { output: item.output, wrote: false };
    }
    const isHelp = argv.includes("--help") || argv.includes("-h");
    const dry = argv.includes("--dry-run");
    const writes = !!cmd?.writes && !dry && !isHelp;
    item.writes = writes;
    if (isHelp || cmd?.name === "commands") item.lookup = true;

    const exec = async (a: string[]) => {
      let out = "",
        err = "";
      const code = await run(a, { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => stdin, isTTY: false, env: process.env }, { etude: this.etude });
      return { code, out, err };
    };

    if (cmd?.confirm && !dry && !isHelp) {
      const clean = argv.filter((a) => a !== "--yes" && a !== "-y");
      if (cmd.dryRun) {
        const p = await exec([...clean, "--dry-run"]);
        item.preview = truncate((p.out || p.err).trim(), 3000);
        let parsed: any = null;
        try {
          parsed = JSON.parse(p.out);
        } catch {}
        // A dry run that fails would fail for real too: tell the model, don't ask the user.
        if (p.code !== 0) {
          item.status = "error";
          item.exit = p.code;
          item.output = truncate((p.out || p.err).trim(), 4000);
          emit({ type: "tool_start", item });
          emit({ type: "tool_end", item });
          return { output: `exit ${p.code} (checked with --dry-run, nothing was changed and the user wasn't asked)\n${truncate((p.out || p.err).trim())}`, wrote: false };
        }
        const c = consequence(this.etude, cmd.name, clean, parsed, null);
        item.summary = c.summary;
        item.action = c.action;
        if (c.target) item.target = c.target;
      }
      let allow: boolean;
      if (input.autoConfirm === true) allow = true;
      else if (input.autoConfirm === "deny") allow = false;
      else {
        item.status = "waiting";
        emit({ type: "confirm", item });
        allow = await new Promise<boolean>((resolve) => turn.pending.set(call.id, { item, resolve }));
        turn.pending.delete(call.id);
      }
      if (!allow) {
        item.status = "denied";
        item.output = "The user denied this command.";
        emit({ type: "tool_end", item });
        return { output: "The user denied this command. Don't run it or work around it; tell them it was not done.", wrote: false };
      }
      argv = [...clean, "--yes"];
      item.argv = argv;
      item.label = commandLine(argv);
      item.status = "running";
    }
    emit({ type: "tool_start", item });
    if (writes) beforeWrite();
    const target = writes && cmd!.name === "pack import" ? packDeck(stdin) : "";
    const targetExisted = !!target && !!this.etude.db.get("SELECT 1 FROM decks WHERE name = ?", target);
    const r = await exec(argv);
    const output = (r.out + (r.err ? (r.out ? "\n" : "") + r.err : "")).trim() || "(no output)";
    item.status = r.code === 0 ? "done" : "error";
    item.exit = r.code;
    item.output = truncate(output, 4000);
    if (writes && r.code === 0) {
      let parsed: any = null;
      try {
        parsed = JSON.parse(r.out);
      } catch {}
      item.change = (target && !targetExisted ? `created deck ${lastPart(target).slice(0, 40)}` : changeLabel(cmd!.name, argv, parsed, stdin)) ?? undefined;
    }
    emit({ type: "tool_end", item });
    // A pack that put new cards in one deck: open that deck for the user right away, so the model needn't.
    let opened = "";
    if (writes && r.code === 0 && cmd!.name === "pack import") {
      const deck = packDeck(stdin);
      if (deck && this.etude.db.get("SELECT 1 FROM decks WHERE name = ?", deck)) {
        const path = `/deck?name=${encodeURIComponent(deck)}`;
        items.push({ type: "ui", action: "navigate", path });
        emit({ type: "ui", action: "navigate", path });
        opened = `\nThe app has opened the deck "${deck}" for the user; don't navigate to it again.`;
      }
    }
    return { output: `exit ${r.code}\n${truncate(output)}${opened}`, wrote: writes && r.code === 0, change: item.change };
  }
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
  return out;
}

/** The catalog search behind etude_help. */
export async function helpText(query: string): Promise<string> {
  const { COMMANDS, GROUPS, flagsOf } = await import("../cli/registry.ts");
  await import("../cli/commands/index.ts");
  const visible = COMMANDS.filter((c) => !c.legacy && !AGENT_DENY.some((d) => c.name === d || c.name.startsWith(d + " ")));
  const q = query.trim().toLowerCase().replace(/^etude\s+/, "");
  if (!q) {
    return [
      "Command groups (run etude_help with a group or words to see commands):",
      ...GROUPS.filter((g) => g.name !== "agent").map((g) => `- ${g.name}: ${g.summary}. Commands: ${visible.filter((c) => c.name.startsWith(g.name + " ")).map((c) => c.name.slice(g.name.length + 1)).join(", ")}`),
      `Other: ${visible.filter((c) => !c.name.includes(" ")).map((c) => c.name).join(", ")}`,
    ].join("\n");
  }
  const spec = (c: (typeof COMMANDS)[number], full: boolean) => {
    const args = (c.args ?? []).map((a) => (a.required ? `<${a.name}${a.variadic ? "..." : ""}>` : `[${a.name}${a.variadic ? "..." : ""}]`)).join(" ");
    const lines = [`## etude ${c.name} ${args}`.trim(), c.summary];
    if (full && c.description) lines.push(c.description);
    for (const a of c.args ?? []) lines.push(`  <${a.name}>: ${a.description}`);
    for (const f of flagsOf(c)) lines.push(`  --${f.name}${f.short ? ` (-${f.short})` : ""} ${f.type}${f.multiple ? "[]" : ""}${f.values ? ` {${f.values.join("|")}}` : ""}: ${full ? f.description : f.description.slice(0, 140)}`);
    const tags = [c.writes && "writes", c.dryRun && "supports --dry-run", c.confirm && "asks the user to confirm"].filter(Boolean);
    if (tags.length) lines.push(`  (${tags.join(", ")})`);
    if (c.output) lines.push(`  output: ${c.output}`);
    for (const ex of (c.examples ?? []).slice(0, full ? 4 : 2)) lines.push(`  e.g. ${ex}`);
    return lines.join("\n");
  };
  const exact = visible.find((c) => c.name === q);
  if (exact) return spec(exact, true);
  const group = GROUPS.find((g) => g.name === q);
  if (group) return [`${group.name}: ${group.summary}`, ...visible.filter((c) => c.name.startsWith(q + " ")).map((c) => spec(c, false))].join("\n\n");
  const words = q.split(/\s+/).filter(Boolean);
  const scored = visible
    .map((c) => {
      const name = c.name.toLowerCase();
      const hay = `${c.summary} ${c.description ?? ""} ${flagsOf(c).map((f) => f.name).join(" ")}`.toLowerCase();
      let s = 0;
      for (const w of words) {
        if (name.split(" ").includes(w)) s += 5;
        else if (name.includes(w)) s += 3;
        if (hay.includes(w)) s += 1;
      }
      return { c, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 8);
  if (!scored.length) return `No command matches "${query}". Run etude_help with no query to see the groups.`;
  return scored.map((x, i) => spec(x.c, i === 0 && scored.length < 3)).join("\n\n");
}

export function copyAttachment(src: string, dest: string) {
  copyFileSync(src, dest);
}

// ------------------------------------------------------------ plain words

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const positional = (argv: string[], words: number, i = 0) => argv.slice(words).filter((a) => !a.startsWith("-"))[i];
const lastPart = (deck: string) => deck.split("::").pop() ?? deck;
const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Items, cards and reviews in a set of items (`where` filters `items i`). */
function itemCounts(e: Etude, where: string, ...params: (string | number)[]) {
  const ids = (e.db.all(`SELECT i.id FROM items i WHERE ${where}`, ...params) as { id: string }[]).map((r) => r.id);
  if (!ids.length) return { items: 0, cards: 0, reviews: 0 };
  const ph = ids.map(() => "?").join(",");
  const cards = (e.db.get(`SELECT COUNT(*) AS n FROM cards WHERE item_id IN (${ph})`, ...ids) as { n: number }).n;
  const reviews = (e.db.get(`SELECT COUNT(*) AS n FROM reviews r JOIN cards c ON c.id = r.card_id WHERE c.item_id IN (${ph})`, ...ids) as { n: number }).n;
  return { items: ids.length, cards, reviews };
}

/** The consequence of a destructive command in plain words, and a name for its button. */
export function consequence(e: Etude, name: string, argv: string[], dry: any, failure: string | null): { summary: string; action: string; target?: string } {
  const words = name.split(" ").length;
  const arg = positional(argv, words) ?? "";
  try {
    if (failure) {
      let msg = failure;
      try {
        msg = JSON.parse(failure).error ?? failure;
      } catch {}
      return { summary: `This will fail: ${String(msg).replace(/^error:\s*/i, "")}`, action: "Run anyway" };
    }
    switch (name) {
      case "deck delete": {
        const deleted: string[] = Array.isArray(dry?.deleted) ? dry.deleted : [arg];
        const deck = deleted[0] ?? arg;
        const like = deck.replace(/[\\%_]/g, "\\$&") + "::%";
        const c = itemCounts(e, "i.deck_id IN (SELECT id FROM decks WHERE name = ? OR name LIKE ? ESCAPE '\\')", deck, like);
        const subs = Math.max(0, deleted.length - 1);
        return { summary: `Deletes deck ${deck}: ${plural(c.cards, "card")}, ${plural(subs, "subdeck")}, ${plural(c.reviews, "review")}.`, action: "Delete deck", target: deck };
      }
      case "item delete": {
        const ids: string[] = Array.isArray(dry?.ids) ? dry.ids : [];
        if (!ids.length) return { summary: "Deletes nothing: no item matches.", action: "Delete items" };
        const c = itemCounts(e, `i.id IN (${ids.map(() => "?").join(",")})`, ...ids);
        return {
          summary: `Deletes ${plural(ids.length, "item")} for good, with ${plural(c.cards, "card")} and ${plural(c.reviews, "review")} of history.`,
          action: ids.length === 1 ? "Delete item" : `Delete ${ids.length} items`,
        };
      }
      case "theme delete": {
        const t = e.listThemes().find((x) => x.id === arg);
        return { summary: `Deletes the custom theme ${t?.name ?? arg}${t?.selected ? ". It's in use, so the app goes back to Midnight" : ""}.`, action: "Delete theme", target: t?.name ?? arg };
      }
      case "type delete": {
        let n = arg;
        try {
          n = e.type(arg).name;
        } catch {}
        if (argv.includes("--items")) {
          const u = e.typeUsage(arg);
          if (u.items)
            return {
              summary: `Deletes the card type ${n} and its ${plural(u.items, "item")}${u.archived ? ` (${u.archived} archived)` : ""}, with ${plural(u.cards, "card")} and ${plural(u.reviews, "review")} of history.`,
              action: "Delete type and items",
              target: n,
            };
        }
        return { summary: `Deletes the card type ${n}. No items use it.`, action: "Delete type", target: n };
      }
      case "type reset":
        return { summary: `Puts the built-in type ${arg} back to the shipped version; your edits to it are lost.`, action: "Reset type" };
      case "type folder delete": {
        const moved = Array.isArray(dry?.moved) ? dry.moved.length : 0;
        return { summary: `Deletes the folder ${arg}${moved ? `; its ${plural(moved, "type")} move up a level` : ""}. Types aren't deleted.`, action: "Delete folder" };
      }
      case "preset delete":
        return { summary: `Deletes the preset ${arg}. No deck uses it.`, action: "Delete preset" };
      case "scheduler delete":
        return { summary: `Deletes the scheduler ${arg}. No deck or preset uses it.`, action: "Delete scheduler" };
      case "scheduler reset":
        return { summary: `Puts the built-in scheduler ${arg} back to the shipped version; your edits to it are lost.`, action: "Reset scheduler" };
      case "card prune": {
        const n = Number(dry?.cards ?? 0);
        if (!n) return { summary: "Deletes nothing: no card is on a face its type no longer makes.", action: "Delete cards" };
        return { summary: `Deletes ${plural(n, "card")} on faces their types no longer make, with ${plural(Number(dry?.reviews ?? 0), "review")} of history.`, action: n === 1 ? "Delete card" : `Delete ${n} cards` };
      }
    }
  } catch {}
  const verb = name.split(" ").pop() ?? "run";
  return { summary: `Runs etude ${name}${arg ? ` on ${arg}` : ""}.`, action: verb[0].toUpperCase() + verb.slice(1) };
}

/** A few words on what a successful write changed, for "Undo: …". */
export function changeLabel(name: string, argv: string[], out: any, stdin = ""): string | null {
  const words = name.split(" ").length;
  const a0 = positional(argv, words, 0) ?? "";
  const flag = (f: string) => {
    const i = argv.indexOf(`--${f}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  switch (name) {
    case "theme set":
    case "theme create":
    case "theme edit":
    case "theme import":
      return "theme change";
    case "market install": {
      const kind = out?.entry?.kind;
      const n = short(out?.entry?.name ?? a0);
      return kind === "theme" ? "theme change" : kind === "deck" ? `installed deck ${n}` : kind === "type" ? `installed type ${n}` : `installed ${n}`;
    }
    case "deck create":
      return `created deck ${short(lastPart(a0))}`;
    case "deck rename":
      return `renamed ${short(lastPart(a0))}`;
    case "deck move":
      return `moved ${short(lastPart(a0))}`;
    case "deck delete":
      return `deleted deck ${short(lastPart(a0))}`;
    case "deck archive":
      return `archived ${short(lastPart(a0))}`;
    case "deck unarchive":
      return `unarchived ${short(lastPart(a0))}`;
    case "pack import":
    case "anki import": {
      const reports: any[] = Array.isArray(out) ? out : out ? [out] : [];
      const created = reports.reduce((n, r) => n + (r?.items?.created ?? 0), 0);
      const updated = reports.reduce((n, r) => n + (r?.items?.updated ?? 0), 0);
      const deck = packDeck(stdin);
      if (deck && created && !updated) return `added ${plural(created, "card")} to ${short(lastPart(deck))}`;
      if (created && !updated) return `created ${plural(created, "card")}`;
      if (updated && !created) return `updated ${plural(updated, "card")}`;
      return created || updated ? `added ${created}, updated ${updated} cards` : "imported a pack";
    }
    case "item add":
      return `added a card${flag("deck") ? ` to ${short(lastPart(flag("deck")!))}` : ""}`;
    case "item edit":
      return `edited a card`;
    case "item move":
      return `moved ${plural(out?.count ?? 0, "item")}`;
    case "item delete":
      return `deleted ${plural(out?.count ?? 0, "item")}`;
    case "item tag":
      return `tagged ${plural(out?.count ?? 0, "item")}`;
    case "item untag":
      return `untagged ${plural(out?.count ?? 0, "item")}`;
    case "tag rename":
      return `renamed tag ${short(a0, 24)}`;
    case "media add":
      return "added media";
  }
  const [g, v] = name.split(" ");
  return v ? `${v} ${g}` : name;
}

/** The deck a pack's items go to: the one deck, or the deepest deck they share. Empty when none. */
export function packDeck(stdin: string): string {
  try {
    const pack = stdin ? JSON.parse(stdin) : null;
    const names: string[] = [...new Set<string>((pack?.items ?? []).map((i: any) => String(i?.deck ?? "")).filter(Boolean))];
    if (names.length === 1) return names[0];
    if (!names.length) return "";
    const parts = names.map((n) => n.split("::"));
    const common: string[] = [];
    for (let k = 0; parts.every((p) => p[k] !== undefined && p[k] === parts[0][k]); k++) common.push(parts[0][k]);
    return common.join("::");
  } catch {
    return "";
  }
}
