// A small Agent Client Protocol client (agentclientprotocol.com): JSON-RPC 2.0, one message per line, over
// an agent's stdin and stdout. Etude is the client; the agent (Hermes, Gemini CLI, an adapter for Claude
// Code or Codex) is the subprocess. Etude offers no file system or terminal of its own: the agent reaches the
// collection through the `etude mcp` server Etude hands it in session/new.
//
// One process per configured agent, started on first use and kept for later chats; all of them stop when
// the collection closes or this process exits.

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { homedir } from "node:os";
import type { AcpAgentDef } from "./acp-agents.ts";

export const ACP_PROTOCOL_VERSION = 1;

export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export interface AcpInit {
  protocolVersion: number;
  agentInfo?: { name?: string; title?: string; version?: string };
  agentCapabilities?: { loadSession?: boolean; promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }; [k: string]: unknown };
  authMethods?: { id: string; name: string; description?: string }[];
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string; kind?: string; status?: string; rawInput?: unknown; content?: unknown[] };
  options: AcpPermissionOption[];
}

/** What the client answers a permission request with: one of the offered options, or cancelled. */
/** One of the session's pickers (the model, the reasoning effort, the speed), as the agent offers it. */
export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

/** What's known about a session besides its messages: its pickers and how full its context window is. */
export interface AcpSessionInfo {
  options: AcpConfigOption[];
  usage?: { used: number; size: number };
  /** The agent's own slash commands, by name ("steer", "compress"). */
  commands?: string[];
}

/** A tool call still running in the background after its turn ended (or started out of turn). */
export interface AcpBackgroundTask {
  id: string;
  name: string;
  title: string;
  kind?: string;
  startedAt: number;
}

function cleanOptions(raw: unknown): AcpConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpConfigOption[] = [];
  for (const o of raw) {
    if (!o || typeof o.id !== "string" || !Array.isArray(o.options)) continue;
    // Options may come grouped ({ group, name, options }); the groups are flattened.
    const flat = o.options.flatMap((x: any) => (Array.isArray(x?.options) ? x.options : [x]));
    out.push({ id: o.id, name: String(o.name ?? o.id), category: typeof o.category === "string" ? o.category : undefined, currentValue: String(o.currentValue ?? ""), options: flat.filter((x: any) => x && x.value !== undefined).map((x: any) => ({ value: String(x.value), name: String(x.name ?? x.value), ...(x.description ? { description: String(x.description) } : {}) })) });
  }
  return out;
}

export type AcpPermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export interface AcpTurnHandlers {
  onUpdate(update: any): void;
  onPermission(req: AcpPermissionRequest): Promise<AcpPermissionOutcome>;
}

export class AcpError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

export { acpAvailable } from "./acp-agents.ts";

/** The name Etude gives the MCP server it hands an agent. Not plain "etude": the agent may have an Etude server of its own, pointed at another collection. */
export const ACP_MCP_NAME = "etude_app";

/** The `etude mcp` server for an agent, run by this same program on this same collection. */
export function etudeMcpServer(dbPath: string, home: string): AcpMcpServer {
  const bin = fileURLToPath(new URL("../../bin/etude.js", import.meta.url));
  const env: AcpMcpServer["env"] = [
    { name: "ETUDE_DB", value: dbPath },
    { name: "ETUDE_HOME", value: home },
    { name: "NODE_NO_WARNINGS", value: "1" },
  ];
  // Inside the desktop app this program is Electron; it runs scripts as Node with this set.
  if (process.versions.electron) env.push({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
  return { name: ACP_MCP_NAME, command: process.execPath, args: [bin, "mcp"], env };
}

/** The agent's environment: ours, without what only the Etude engine should hold (its API token). */
function agentEnv(def: AcpAgentDef): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(def.env ?? {}) };
  for (const k of ["ETUDE_TOKEN", "ETUDE_SUPERVISED", "ETUDE_APP", "ELECTRON_RUN_AS_NODE"]) if (!def.env?.[k]) delete env[k];
  return env;
}

/**
 * The command that deletes a session from the agent's own history, for agents that keep one Etude can reach:
 * Hermes (`hermes [-p <profile>] sessions delete --yes <id>`, the args before `acp` kept, so the profile and
 * any global flag stay). ACP itself has no way to delete a session, so other agents get null.
 */
export function sessionDeleteCommand(def: AcpAgentDef, sessionId: string): { command: string; args: string[] } | null {
  const at = def.args.indexOf("acp");
  const hermes = def.preset === "hermes" || /^hermes(\.exe|\.cmd)?$/i.test(basename(def.command));
  if (!hermes || at < 0 || !sessionId || sessionId.startsWith("-") || !/^[A-Za-z0-9._:@/-]{1,128}$/.test(sessionId)) return null;
  return { command: def.command, args: [...def.args.slice(0, at), "sessions", "delete", "--yes", sessionId] };
}

/** Deletes a chat's session from the agent's history (see sessionDeleteCommand). Never throws. */
export function deleteAgentSession(def: AcpAgentDef, sessionId: string, timeoutMs = 30_000): Promise<{ deleted: boolean; error?: string }> {
  const cmd = sessionDeleteCommand(def, sessionId);
  if (!cmd) return Promise.resolve({ deleted: false, error: "this agent can't delete its sessions" });
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const end = (r: { deleted: boolean; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawn(cmd.command, cmd.args, { cwd: def.cwd || homedir(), env: agentEnv(def), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      return end({ deleted: false, error: (e as Error).message });
    }
    const timer = setTimeout(() => (child.kill(), end({ deleted: false, error: "the agent didn't answer in time" })), timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (s: string) => (out = (out + s).slice(-2000)));
    child.stderr!.on("data", (s: string) => (out = (out + s).slice(-2000)));
    child.once("error", (e) => end({ deleted: false, error: e.message }));
    child.once("close", (code) => {
      // A session the agent no longer has is as good as deleted.
      if (code === 0 || /^No session '|no such session|unknown session/im.test(out)) end({ deleted: true });
      else end({ deleted: false, error: out.trim().split("\n").pop() || `exit ${code}` });
    });
  });
}

type Pending = { resolve(v: any): void; reject(e: Error): void; method: string };

export class AcpConnection {
  readonly def: AcpAgentDef;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private started: Promise<AcpInit> | null = null;
  private turns = new Map<string, { handlers: AcpTurnHandlers; chained: Promise<{ stopReason?: string }>[] }>();
  /** True when the agent steers a running turn via a second concurrent `session/prompt` (Antigravity `agy acp`). */
  private promptSteer = false;
  /** Who answers a permission request that comes while a pick is being made (no turn running): Hermes asks before a
   * switch it thinks costs something (a large context re-read on the new model). Without one, the ask is cancelled. */
  private picking = new Map<string, (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome>>();
  /** Steers on their way to a session's running turn: the agent's one-line answer to each isn't part of the reply. */
  private steering = new Map<string, { n: number; said: string }>();
  /** Sessions whose history is being replayed by session/load: their updates aren't a live turn. */
  private loading = new Set<string>();
  /** Sessions this process created or loaded, so a chat can keep using its own. */
  readonly sessions = new Set<string>();
  /** Each open session's pickers and context use, kept current from what the agent sends. */
  readonly sessionInfo = new Map<string, AcpSessionInfo>();
  /** In-flight tool calls per session; ones still running after a turn ends become visible background tasks. */
  private activeTools = new Map<string, Map<string, AcpBackgroundTask & { status: "pending" | "in_progress"; background: boolean }>>();
  private taskListeners = new Set<(sessionId: string, tasks: AcpBackgroundTask[]) => void>();
  private stderrTail = "";
  private exited: string | null = null;
  info: AcpInit | null = null;
  /** For tests and the panel's error text. */
  get pid() {
    return this.child?.pid;
  }
  get alive() {
    return !!this.child && this.exited === null;
  }

  constructor(def: AcpAgentDef) {
    this.def = def;
  }

  /** Starts the agent and runs `initialize` once; later calls share the result. */
  start(): Promise<AcpInit> {
    if (this.started && this.alive) return this.started;
    this.started = this.boot();
    this.started.catch(() => this.close());
    return this.started;
  }

  private async boot(): Promise<AcpInit> {
    const def = this.def;
    this.exited = null;
    this.stderrTail = "";
    const child = spawn(def.command, def.args, {
      cwd: def.cwd || homedir(),
      env: agentEnv(def),
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so stopping it also stops what it started (its MCP servers, shells).
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;
    track(this);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (s: string) => (this.stderrTail = (this.stderrTail + s).slice(-4000)));
    child.stdin!.on("error", () => {});
    const failed = new Promise<never>((_, reject) => {
      child.once("error", (e: NodeJS.ErrnoException) => {
        this.exited = e.message;
        reject(new AcpError(e.code === "ENOENT" ? `couldn't start "${def.command}": it isn't installed or isn't on the PATH` : `couldn't start "${def.command}": ${e.message}`));
      });
    });
    child.once("exit", (code, signal) => {
      this.exited = `exit ${code ?? signal}`;
      untrack(this);
      this.clearAllTasks();
      const why = this.lastError() ?? `${def.name} stopped (${code !== null ? `exit code ${code}` : signal})`;
      for (const p of this.pending.values()) p.reject(new AcpError(why));
      this.pending.clear();
    });
    const init = (await Promise.race([
      this.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "etude", title: "Etude", version: "1" },
      }, 60_000),
      failed,
    ])) as AcpInit;
    this.info = init ?? { protocolVersion: ACP_PROTOCOL_VERSION };
    this.promptSteer =
      Boolean((this.info.agentCapabilities as any)?._meta?.antigravity) ||
      this.def.preset === "antigravity" ||
      /^agy(\.exe|\.cmd)?$/i.test(basename(this.def.command));
    return this.info;
  }

  /** The agent's last stderr line that looks like an error, for messages. */
  private lastError(): string | null {
    const lines = this.stderrTail.split("\n").map((l) => l.trim()).filter(Boolean);
    const err = [...lines].reverse().find((l) => /error|not found|denied|fail/i.test(l));
    return err ? `${this.def.name}: ${err.slice(0, 300)}` : null;
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue; // a stray log line on stdout
      }
      this.onMessage(m);
    }
  }

  private onMessage(m: any) {
    if (m.method === undefined && m.id !== undefined) {
      const p = this.pending.get(Number(m.id));
      if (!p) return;
      this.pending.delete(Number(m.id));
      if (m.error) p.reject(new AcpError(String(m.error.message ?? "the agent answered with an error") + (m.error.data?.details ? `: ${m.error.data.details}` : ""), m.error.code));
      else p.resolve(m.result ?? null);
      return;
    }
    const params = m.params ?? {};
    if (m.method === "session/update") {
      // Pickers and context use are the session's state, whether or not a turn is running.
      const u = params.update ?? {};
      if (u.sessionUpdate === "usage_update" || u.sessionUpdate === "config_option_update") {
        const info = this.sessionInfo.get(params.sessionId) ?? { options: [] };
        if (u.sessionUpdate === "usage_update" && Number(u.size) > 0) info.usage = { used: Math.max(0, Number(u.used) || 0), size: Number(u.size) };
        if (u.sessionUpdate === "config_option_update") info.options = cleanOptions(u.configOptions);
        this.sessionInfo.set(params.sessionId, info);
      }
      if (u.sessionUpdate === "available_commands_update") {
        const info = this.sessionInfo.get(params.sessionId) ?? { options: [] };
        info.commands = (Array.isArray(u.availableCommands) ? u.availableCommands : []).map((c: any) => String(c?.name ?? "").replace(/^\//, "")).filter(Boolean);
        this.sessionInfo.set(params.sessionId, info);
        return;
      }
      if (this.loading.has(params.sessionId)) return;
      if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        this.trackToolUpdate(String(params.sessionId ?? ""), u);
      }
      // What the agent says back to a /steer ("queued for the active turn") comes as a message of its own, outside
      // the reply being written (whose pieces carry the reply's messageId).
      const st = this.steering.get(params.sessionId);
      if (st && u.sessionUpdate === "agent_message_chunk" && u.messageId === undefined) {
        if (u.content?.type === "text") st.said += String(u.content.text ?? "");
        return;
      }
      this.turns.get(params.sessionId)?.handlers.onUpdate(params.update ?? {});
      return;
    }
    if (m.id === undefined) return; // other notifications
    if (m.method === "session/request_permission") {
      const h = this.turns.get(params.sessionId)?.handlers.onPermission ?? this.picking.get(params.sessionId);
      const answer = h ? h(params as AcpPermissionRequest) : Promise.resolve<AcpPermissionOutcome>({ outcome: "cancelled" });
      answer.then(
        (outcome) => this.write({ jsonrpc: "2.0", id: m.id, result: { outcome } }),
        () => this.write({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "cancelled" } } }),
      );
      return;
    }
    // Etude offers no file system, terminal or anything else to the agent.
    this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Etude doesn't offer ${m.method}` } });
  }

  private write(m: unknown) {
    if (!this.alive) return;
    this.child!.stdin!.write(JSON.stringify(m) + "\n");
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    if (!this.child || this.exited !== null) return Promise.reject(new AcpError(`${this.def.name} isn't running`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      this.pending.set(id, {
        method,
        resolve: (v) => (timer && clearTimeout(timer), resolve(v)),
        reject: (e) => (timer && clearTimeout(timer), reject(e)),
      });
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpError(`${this.def.name} didn't answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async newSession(cwd: string, mcpServers: AcpMcpServer[]): Promise<string> {
    const r = await this.request<{ sessionId: string; configOptions?: unknown }>("session/new", { cwd, mcpServers }, 120_000);
    if (!r?.sessionId) throw new AcpError(`${this.def.name} didn't return a session`);
    this.sessions.add(r.sessionId);
    this.sessionInfo.set(r.sessionId, { ...this.sessionInfo.get(r.sessionId), options: cleanOptions(r.configOptions) });
    return r.sessionId;
  }

  /** Reopens an earlier session. The history the agent replays is dropped: the chat already shows it. */
  async loadSession(sessionId: string, cwd: string, mcpServers: AcpMcpServer[]): Promise<void> {
    this.loading.add(sessionId);
    try {
      const r = await this.request<{ configOptions?: unknown } | null>("session/load", { sessionId, cwd, mcpServers }, 120_000);
      this.sessions.add(sessionId);
      this.sessionInfo.set(sessionId, { ...this.sessionInfo.get(sessionId), options: cleanOptions(r?.configOptions) });
    } finally {
      this.loading.delete(sessionId);
    }
  }

  /** Background tasks currently running in a session. */
  backgroundTasks(sessionId: string): AcpBackgroundTask[] {
    const m = this.activeTools.get(sessionId);
    if (!m) return [];
    const out: AcpBackgroundTask[] = [];
    for (const t of m.values()) {
      if (t.background) out.push({ id: t.id, name: t.name, title: t.title, ...(t.kind ? { kind: t.kind } : {}), startedAt: t.startedAt });
    }
    return out;
  }

  /** Subscribes to changes in any session's background tasks. */
  onBackgroundTasks(fn: (sessionId: string, tasks: AcpBackgroundTask[]) => void): () => void {
    this.taskListeners.add(fn);
    return () => void this.taskListeners.delete(fn);
  }

  private notifyTasks(sessionId: string) {
    if (!this.taskListeners.size) return;
    const list = this.backgroundTasks(sessionId);
    for (const fn of this.taskListeners) {
      try {
        fn(sessionId, list);
      } catch {}
    }
  }

  private clearAllTasks() {
    const had: string[] = [];
    for (const [sid, m] of this.activeTools) {
      if ([...m.values()].some((t) => t.background)) had.push(sid);
    }
    this.activeTools.clear();
    for (const sid of had) this.notifyTasks(sid);
  }

  private trackToolUpdate(sessionId: string, u: any) {
    if (!sessionId) return;
    const id = typeof u.toolCallId === "string" && u.toolCallId ? u.toolCallId : "";
    if (!id) return;
    const st = typeof u.status === "string" ? u.status : "";
    const rawTitle = u.args?.toolSummary || u.rawInput?.toolSummary || u.title || u.name || u.kind || "Background process";
    const title = String(rawTitle).replace(/\s+/g, " ").trim().slice(0, 120) || "Background process";
    const name = String(u.name ?? u.kind ?? "tool").slice(0, 60);
    const kind = typeof u.kind === "string" ? u.kind : undefined;
    if (st === "in_progress" || st === "pending") {
      let m = this.activeTools.get(sessionId);
      if (!m) {
        m = new Map();
        this.activeTools.set(sessionId, m);
      }
      const prev = m.get(id);
      const outOfTurn = !this.turns.has(sessionId);
      const background = prev ? prev.background || (outOfTurn && st === "in_progress") : outOfTurn && st === "in_progress";
      m.set(id, { id, name, title, ...(kind ? { kind } : prev?.kind ? { kind: prev.kind } : {}), startedAt: prev?.startedAt ?? Date.now(), status: st, background });
      if (background) this.notifyTasks(sessionId);
    } else if (st === "completed" || st === "failed" || st === "cancelled") {
      const m = this.activeTools.get(sessionId);
      const prev = m?.get(id);
      if (!prev) return;
      m!.delete(id);
      if (m!.size === 0) this.activeTools.delete(sessionId);
      if (prev.background) this.notifyTasks(sessionId);
    }
  }

  /** One prompt turn. Updates and permission requests for the session go to `handlers` until it ends (including chained prompt-steers). */
  async prompt(sessionId: string, prompt: unknown[], handlers: AcpTurnHandlers): Promise<{ stopReason: string }> {
    const entry = { handlers, chained: [] as Promise<{ stopReason?: string }>[] };
    this.turns.set(sessionId, entry);
    let settled = false;
    try {
      let cur = this.request<{ stopReason?: string }>("session/prompt", { sessionId, prompt });
      for (;;) {
        const r = await cur;
        const next = entry.chained.shift();
        if (!next) {
          settled = true;
          return { stopReason: r?.stopReason ?? "end_turn" };
        }
        cur = next;
      }
    } finally {
      this.turns.delete(sessionId);
      const m = this.activeTools.get(sessionId);
      if (m) {
        let changed = false;
        for (const [id, t] of [...m]) {
          if (settled && t.status === "in_progress") {
            if (!t.background) {
              t.background = true;
              changed = true;
            }
          } else if (!t.background) {
            m.delete(id);
          }
        }
        if (m.size === 0) this.activeTools.delete(sessionId);
        if (changed) this.notifyTasks(sessionId);
      }
    }
  }

  /** Picks a value in one of the session's pickers. Agents refuse while a turn is running. `onPermission` answers
   * what the agent asks before applying the pick (Hermes' warning before a costly model switch). */
  async setOption(sessionId: string, id: string, value: string, onPermission?: (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome>): Promise<AcpSessionInfo> {
    if (onPermission) this.picking.set(sessionId, onPermission);
    let r: { configOptions?: unknown } | null;
    try {
      r = await this.request<{ configOptions?: unknown } | null>("session/set_config_option", { sessionId, configId: id, value }, 60_000);
    } finally {
      if (onPermission && this.picking.get(sessionId) === onPermission) this.picking.delete(sessionId);
    }
    const info = this.sessionInfo.get(sessionId) ?? { options: [] };
    const next = cleanOptions(r?.configOptions);
    // An agent that answers with no list keeps its list; only the pick moved.
    info.options = next.length ? next : info.options.map((o) => (o.id === id ? { ...o, currentValue: value } : o));
    this.sessionInfo.set(sessionId, info);
    return info;
  }

  /** True when words can reach this session's running turn (Hermes `/steer` command or Antigravity concurrent `session/prompt`). */
  canSteer(sessionId: string): boolean {
    return this.turns.has(sessionId) && (!!this.sessionInfo.get(sessionId)?.commands?.includes("steer") || this.promptSteer);
  }

  /**
   * Hands the user's words to the turn that's running: through `/steer` when the agent advertises that
   * command (Hermes), or through a second concurrent `session/prompt` when the agent supports prompt-steering
   * (Antigravity `agy acp`, which ends the prior prompt and continues streaming under the new one).
   */
  async steer(sessionId: string, text: string): Promise<boolean> {
    if (!this.canSteer(sessionId)) return false;
    const hasSlashSteer = !!this.sessionInfo.get(sessionId)?.commands?.includes("steer");
    if (!hasSlashSteer && this.promptSteer) {
      const turn = this.turns.get(sessionId);
      if (!turn) return false;
      const next = this.request<{ stopReason?: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      let rejected = false;
      next.catch(() => {
        rejected = true;
      });
      turn.chained.push(next);
      // Give the agent a short beat to reject immediately (e.g. while waiting on a permission request).
      const early = await Promise.race([
        next.then(() => "ok" as const, () => "err" as const),
        new Promise<"pending">((r) => setTimeout(() => r("pending"), 150)),
      ]);
      if (early === "err" || rejected) {
        const idx = turn.chained.indexOf(next);
        if (idx >= 0) turn.chained.splice(idx, 1);
        return false;
      }
      return true;
    }
    const st = this.steering.get(sessionId) ?? { n: 0, said: "" };
    st.n++;
    this.steering.set(sessionId, st);
    try {
      // A second session/prompt while the first runs; it answers at once and isn't a turn of its own.
      await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text: `/steer ${text}` }] }, 30_000);
      // Its answer quotes the words back, so only how the answer opens says whether it took them.
      return !/^\s*(no active turn|⚠|usage:)/i.test(st.said);
    } catch {
      return false;
    } finally {
      if (--st.n <= 0) this.steering.delete(sessionId);
    }
  }

  cancel(sessionId: string) {
    this.notify("session/cancel", { sessionId });
  }

  /** Stops the agent and everything it started. */
  close() {
    const child = this.child;
    this.child = null;
    this.started = null;
    this.sessions.clear();
    this.sessionInfo.clear();
    this.clearAllTasks();
    untrack(this);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin?.end();
    } catch {}
    killGroup(child, "SIGTERM");
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killGroup(child, "SIGKILL");
    }, 3000);
    t.unref?.();
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

// ------------------------------------------------------------- every running agent, for shutdown

const running = new Set<AcpConnection>();
let hooked = false;

function track(c: AcpConnection) {
  running.add(c);
  if (hooked) return;
  hooked = true;
  // On exit only synchronous work runs: signal each group once.
  process.on("exit", () => {
    for (const r of running) r.close();
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    // Listening replaces Node's default (exit), so exit ourselves unless someone else handles it.
    const others = process.listenerCount(sig);
    process.once(sig, () => {
      for (const r of [...running]) r.close();
      if (others === 0 && process.listenerCount(sig) === 0) process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const)[sig]);
    });
  }
}

function untrack(c: AcpConnection) {
  running.delete(c);
}

/** Agents running now, for tests. */
export function runningAgents(): AcpConnection[] {
  return [...running];
}

// ------------------------------------------------------------- one pool per collection

export class AcpPool {
  private conns = new Map<string, { key: string; conn: AcpConnection }>();
  private taskListeners = new Set<(agentId: string, sessionId: string, tasks: AcpBackgroundTask[]) => void>();

  /** Subscribes to background task updates across every connection in this pool. */
  onBackgroundTasks(fn: (agentId: string, sessionId: string, tasks: AcpBackgroundTask[]) => void): () => void {
    this.taskListeners.add(fn);
    return () => void this.taskListeners.delete(fn);
  }

  /** Background tasks currently running for an agent's session, without starting the agent. */
  backgroundTasks(agentId: string, sessionId: string): AcpBackgroundTask[] {
    return this.peek(agentId)?.backgroundTasks(sessionId) ?? [];
  }

  /** The running connection for an agent, started if needed; restarted when its definition changed. */
  get(def: AcpAgentDef): AcpConnection {
    const key = JSON.stringify([def.command, def.args, def.env ?? {}, def.cwd ?? ""]);
    const have = this.conns.get(def.id);
    if (have && have.key === key && (have.conn.alive || !have.conn.info)) {
      (have.conn as { def: AcpAgentDef }).def = def;
      return have.conn;
    }
    have?.conn.close();
    const conn = new AcpConnection(def);
    conn.onBackgroundTasks((sessionId, tasks) => {
      for (const fn of this.taskListeners) {
        try {
          fn(def.id, sessionId, tasks);
        } catch {}
      }
    });
    this.conns.set(def.id, { key, conn });
    return conn;
  }

  /** The connection for an agent if it's running; nothing is started. */
  peek(id: string): AcpConnection | null {
    const c = this.conns.get(id)?.conn;
    return c?.alive ? c : null;
  }

  /** What an agent told us about itself, once it has started. */
  info(id: string): AcpInit | null {
    return this.conns.get(id)?.conn.info ?? null;
  }

  /** Stops one agent; the next use starts it again. */
  forget(id: string) {
    this.conns.get(id)?.conn.close();
    this.conns.delete(id);
  }

  closeAll() {
    for (const { conn } of this.conns.values()) conn.close();
    this.conns.clear();
  }
}
