// External agents Ask Etude can use as its brain, over the Agent Client Protocol (agentclientprotocol.com).
// Only the definitions and their checks live here, so the web app can share the presets; the client that
// runs them is acp.ts. The command an agent runs is set by the user alone (Settings → AI or the CLI):
// agent-guard.ts keeps the assistant itself from changing `ai.agents`.

/** True where Etude can start programs: Node (the server, the desktop app's engine). Not the browser build or the phone apps. */
export function acpAvailable(): boolean {
  const p = (globalThis as { process?: { versions?: { node?: string }; platform?: string } }).process;
  return !!p && typeof p.versions?.node === "string" && p.platform !== "browser";
}

export interface AcpAgentDef {
  /** Short id used in model refs: `agent:<id>`. */
  id: string;
  /** What the panel calls it, unless the agent names itself. */
  name: string;
  command: string;
  args: string[];
  /** Extra environment for the agent's process. */
  env?: Record<string, string>;
  /** The folder the agent works in. Defaults to the home folder. */
  cwd?: string;
  /** The preset it came from, for Settings. */
  preset?: AcpPresetId;
}

export type AcpPresetId = "hermes" | "antigravity" | "gemini" | "claude" | "codex" | "custom";

export interface AcpPreset {
  id: AcpPresetId;
  label: string;
  /** One line for Settings. */
  hint: string;
  /** What has to be installed first, when it isn't the agent itself. */
  needs?: string;
  /** The definition this preset adds. `profile` only applies to Hermes. */
  make(opts?: { profile?: string }): Omit<AcpAgentDef, "id">;
}

const titleCase = (s: string) => s.replace(/(^|[-_ ])(\w)/g, (_, sep, c) => (sep ? " " : "") + c.toUpperCase());

export const ACP_PRESETS: AcpPreset[] = [
  {
    id: "hermes",
    label: "Hermes",
    hint: "Hermes Agent with one of its profiles: `hermes -p <profile> acp`.",
    make: ({ profile } = {}) => {
      const p = (profile ?? "").trim() || "default";
      return { name: p === "default" ? "Hermes" : titleCase(p), command: "hermes", args: ["-p", p, "acp"], preset: "hermes" };
    },
  },
  { id: "antigravity", label: "Antigravity", hint: "Google Antigravity CLI in ACP mode: `agy acp`.", make: () => ({ name: "Antigravity", command: "agy", args: ["acp"], preset: "antigravity" }) },
  { id: "gemini", label: "Gemini CLI", hint: "Google's Gemini CLI in ACP mode: `gemini --acp`.", make: () => ({ name: "Gemini", command: "gemini", args: ["--acp"], preset: "gemini" }) },
  {
    id: "claude",
    label: "Claude Code",
    hint: "Claude Code through Zed's ACP adapter.",
    needs: "npm install -g @agentclientprotocol/claude-agent-acp",
    make: () => ({ name: "Claude Code", command: "claude-agent-acp", args: [], preset: "claude" }),
  },
  {
    id: "codex",
    label: "Codex",
    hint: "OpenAI's Codex CLI through its ACP adapter.",
    needs: "npm install -g @agentclientprotocol/codex-acp",
    make: () => ({ name: "Codex", command: "codex-acp", args: [], preset: "codex" }),
  },
  { id: "custom", label: "Custom command", hint: "Any program that speaks ACP on stdin and stdout.", make: () => ({ name: "Agent", command: "", args: [], preset: "custom" }) },
];

/** A free id for a new agent: the preset's word, then -2, -3… */
export function freeAgentId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const root = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  if (!used.has(root)) return root;
  for (let i = 2; ; i++) if (!used.has(`${root}-${i}`)) return `${root}-${i}`;
}

/** Checks and cleans a list of agents from settings. Throws an Error with a message for the user. */
export function checkAgents(raw: unknown): AcpAgentDef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("ai.agents must be a list of { id, name, command, args }");
  const seen = new Set<string>();
  return raw.map((a: any, i) => {
    const at = `ai.agents[${i}]`;
    if (!a || typeof a !== "object") throw new Error(`${at} must be an object`);
    const id = String(a.id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error(`${at}.id must be 1 to 32 lowercase letters, digits or dashes`);
    if (seen.has(id)) throw new Error(`two agents have the id "${id}"`);
    seen.add(id);
    const name = String(a.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || id;
    const command = String(a.command ?? "").trim();
    if (!command) throw new Error(`${at}.command is empty`);
    if (a.args !== undefined && (!Array.isArray(a.args) || a.args.some((x: unknown) => typeof x !== "string"))) throw new Error(`${at}.args must be a list of strings`);
    const out: AcpAgentDef = { id, name, command, args: [...(a.args ?? [])] };
    if (a.env !== undefined && a.env !== null) {
      if (typeof a.env !== "object" || Array.isArray(a.env) || Object.entries(a.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string")) throw new Error(`${at}.env must map variable names to strings`);
      if (Object.keys(a.env).length) out.env = { ...a.env };
    }
    if (a.cwd !== undefined && a.cwd !== null && a.cwd !== "") {
      if (typeof a.cwd !== "string") throw new Error(`${at}.cwd must be a folder path`);
      out.cwd = a.cwd;
    }
    if (a.preset !== undefined && ACP_PRESETS.some((p) => p.id === a.preset)) out.preset = a.preset;
    return out;
  });
}
