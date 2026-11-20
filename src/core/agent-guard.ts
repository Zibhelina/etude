// What Ask Etude may touch outside the collection. Text the agent reads (attachments, deck and card
// content, Market entries) can carry instructions, so commands that reach files, URLs or AI provider
// settings are limited here, before they run. The user's own CLI and Settings page are not affected.

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandSpec } from "../cli/registry.ts";

/** Settings keys the agent may set or reset. Everything else (provider URLs, key env names, the Market catalog, themes) is the user's to change. */
export const AGENT_SETTINGS = [
  "dayStartHour",
  "learnAheadMinutes",
  "theme",
  "ai.autoFeedback",
  "ai.language",
  "ai.agent.model",
  "ai.agent.effort",
  "ai.feedback.model",
  "ai.vision.model",
  "ai.decision.model",
];

/**
 * The external agents (`ai.agents`) are commands Etude runs, so a key that holds them (or the whole `ai`
 * object) is the user's alone: an assistant that could set one, from instructions hidden in an attachment,
 * could run any program. Checked for Ask Etude and for `etude mcp`, whatever the provider.
 */
export function agentsSettingRefusal(key: string): string | null {
  const k = key.trim();
  if (k === "" || k === "ai" || k === "ai.agents" || k.startsWith("ai.agents.") || k.startsWith("ai.agents["))
    return `the assistant can't change "${k || key}": the external agents Etude runs (ai.agents) can only be set by the user, in Settings → AI or with the etude CLI.`;
  if (PROFILE_KEYS.some((p) => k === p || k.startsWith(`${p}.`) || k.startsWith(`${p}[`)))
    return `the assistant can't change "${k}": who you talk to in Ask (agent profiles, their personality and pictures) can only be changed by the user, in Settings → AI → Agents or with \`etude agents\`.`;
  // Whether cards may go to an AI provider is the user's OK to give (App Store 5.1.2(i)).
  if (k === "aiConsent" || k.startsWith("aiConsent.") || k.startsWith("aiConsent["))
    return `the assistant can't change "${k}": only the user agrees to send cards to an AI provider, in Settings → AI grading or with \`etude settings consent\`.`;
  return null;
}

/** Settings that say who the user talks to: the profiles, the default one, and Minimi's personality. */
const PROFILE_KEYS = ["agentProfiles", "agentProfile", "minimi"];
/** `etude agents` verbs that change profiles. Only the user runs them; Ask Etude and `etude mcp` are refused. */
export const PROFILE_WRITES = new Set(["agents add", "agents edit", "agents duplicate", "agents remove", "agents default", "agents permission"]);
export const profileCommandRefusal = (name: string): string | null =>
  name === "agents permission"
    ? "the assistant can't change how much it asks before acting: only the user sets that, in the chat's message box or with the etude CLI."
    : PROFILE_WRITES.has(name) ? `the assistant can't run \`etude ${name}\`: who you talk to in Ask can only be changed by the user, in Settings → AI → Agents or with the etude CLI.` : null;

/** Why the agent may not change this settings key, or null when it may. */
export function agentSettingRefusal(key: string): string | null {
  const agents = agentsSettingRefusal(key);
  if (agents) return agents;
  if (AGENT_SETTINGS.includes(key)) return null;
  return `the assistant can't change "${key}". Provider URLs, API key names, the Market catalog and theme definitions can only be changed by the user, in Settings or with the etude CLI.`;
}

/** Account commands the assistant may run: read-only views. */
const AGENT_ACCOUNT_READS = new Set(["account status", "account library", "account market", "account listings", "account sales", "account devices", "account passkeys", "account creator"]);
/** Market commands that speak for the user in public; reading stats and comments stays open. */
const AGENT_MARKET_SOCIAL_WRITES = new Set(["market vote", "market comment", "market comment-edit", "market comment-delete", "market report", "market block", "market unblock"]);

/** Opening and closing a folder from this computer, and what it shows (dot-names, its trash): only the user. */
const FOLDER_USER_ONLY = new Set(["folder open", "folder close", "folder edit"]);

/** Activity (src/core/activity.ts) records what the person does in the app: only they turn it on, keep or delete it. */
export const ACTIVITY_USER_ONLY = new Set(["activity on", "activity off", "activity keep", "activity clear"]);

/** Plugins run code and hold granted permissions: only the user installs, enables, changes permissions or removes them. */
export const PLUGIN_USER_ONLY = new Set(["plugin install", "plugin enable", "plugin disable", "plugin permissions", "plugin uninstall", "plugin new"]);

/** Sharing exposes private notes to other people: only the user creates, invites, changes roles, accepts, declines, leaves or stops shares. */
export const SHARE_USER_ONLY = new Set(["share create", "share invite", "share role", "share remove", "share accept", "share decline", "share leave", "share stop"]);

/** Sync configuration and credentials belong to the user alone (`sync status` and `sync now` stay allowed). */
export const SYNC_USER_ONLY = new Set(["sync setup", "sync signin", "sync verify", "sync second-factor", "sync unlock", "sync protect", "sync unprotect", "sync off"]);

/** Commands that write files somewhere even without an output flag. */
const DEFAULT_WRITERS: Record<string, (values: Record<string, any>) => boolean> = {
  "type new": () => true,
  "type-export": () => true,
  "type export": (v) => !v.json,
  "scheduler export": (v) => !v.json,
  "market index": (v) => !v.check,
};

/** Flags and arguments that name a file to read. */
const READ_FLAGS = new Set(["file", "from", "boxes", "attach", "pdf"]);
const READ_ARGS = new Set(["file", "files", "source", "image", "dir", "paths"]);
/** Flags and arguments that name a file or folder to write. */
const WRITE_FLAGS = new Set(["out"]);
const WRITE_ARGS = new Set(["dest"]);
/** Commands whose `file` argument is an output. */
const WRITE_FILE_ARG = new Set(["pack new"]);
const COVER_PRESETS = new Set(["sky", "teal", "plum", "mustard", "brick", "moss", "rose", "night", "dawn", "sea", "paper", "ink", "none", ""]);

/** True when a value names something on disk (as opposed to stdin, a /media URL, inline JSON or a stored id). */
function pathLike(v: string): boolean {
  if (v === "-" || v === "") return false;
  if (v.startsWith("/media/")) return false;
  if (/^\s*[[{]/.test(v)) return false;
  if (v.startsWith("file:")) return true;
  if (/^[a-z]+:\/\//i.test(v)) return false;
  return isAbsolute(v) || /[/\\~]/.test(v) || v.startsWith(".") || existsSync(resolve(v));
}

function real(p: string): string {
  const abs = resolve(p.startsWith("file:") ? fileURLToPath(p) : p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** True when `p` resolves inside the agent's attachment directory (after following symlinks). */
export function isInsideAttachmentDir(p: string, attachmentDir: string | undefined): boolean {
  if (!attachmentDir) return false;
  return inside(real(p), real(attachmentDir));
}

export interface GuardInput {
  cmd: CommandSpec;
  values: Record<string, any>;
  named: Record<string, any>;
  /** Dynamic `--<field>-file` flags parsed alongside known flags. */
  extra?: [string, string][];
  /** The agent's attachment folder: the only place it may read files from. */
  attachmentDir: string;
}

/** Shared user-only command refusal enforced for both Ask Etude and `etude mcp`. */
function sharedUserOnlyRefusal(name: string): string | null {
  const user = `Ask the user to run it themselves if they want it.`;
  const profile = profileCommandRefusal(name);
  if (profile) return profile;
  if (FOLDER_USER_ONLY.has(name)) return `the assistant can't choose which folders on this computer are open in the Notebook (\`etude ${name}\`). ${user}`;
  if (ACTIVITY_USER_ONLY.has(name)) return `the assistant can't turn Activity on or off, change how long it's kept or delete it (\`etude ${name}\`): that's the user's choice, in Settings → Privacy or with the etude CLI.`;
  if (PLUGIN_USER_ONLY.has(name)) return `the assistant can't install, enable, disable, uninstall or change permissions for plugins (\`etude ${name}\`): that's the user's choice, in Settings → Plugins or with the etude CLI.`;
  if (SHARE_USER_ONLY.has(name)) return `the assistant can't share notes, invite people or change share membership (\`etude ${name}\`). ${user}`;
  if (SYNC_USER_ONLY.has(name)) return `the assistant can't change Sync settings or credentials (\`etude ${name}\`). ${user}`;
  if (name.startsWith("folder sync ") && name !== "folder sync list") return `the assistant can't choose which folders Sync carries to other devices (\`etude ${name}\`). ${user}`;
  if (name.startsWith("account ") && !AGENT_ACCOUNT_READS.has(name)) return `the assistant can't change the Etude account, buy, sell or sign in. ${user}`;
  if (AGENT_MARKET_SOCIAL_WRITES.has(name)) return `the assistant can't vote, comment, report or block on the Market in your name. ${user}`;
  return null;
}

/** Why `etude mcp` may not run this invocation, or null when it may. */
export function mcpRefusal(cmd: CommandSpec, values: Record<string, any> = {}, named: Record<string, any> = {}): string | null {
  const name = cmd.name;
  const shared = sharedUserOnlyRefusal(name);
  if (shared) return shared;
  if (name === "settings chatgpt import" || name === "media prune") return `\`etude ${name}\` isn't available over MCP. Ask the user to run it themselves.`;
  if (typeof values.url === "string" && values.url && name.startsWith("market ")) return `the assistant can't point the Market at another catalog (--url).`;
  if (name === "settings set" || name === "settings unset") {
    const keys: string[] = name === "settings set" ? (named.pairs ?? []).map((p: string) => String(p).split("=")[0].trim()) : (named.keys ?? []).map(String);
    for (const k of keys) {
      const why = agentsSettingRefusal(k);
      if (why) return why;
    }
  }
  return null;
}

/** A refusal message when the agent may not run this invocation as given, or null when it may. */
export function agentRefusal({ cmd, values, named, extra = [], attachmentDir }: GuardInput): string | null {
  const name = cmd.name;
  const user = `Ask the user to run it themselves if they want it.`;

  const shared = sharedUserOnlyRefusal(name);
  if (shared) return shared;

  const folder = name === "folder" || name.startsWith("folder ");

  // Another catalog or feed: the configured Market is the only one the agent reads.
  if (typeof values.url === "string" && values.url && name.startsWith("market ")) return `the assistant can't point the Market at another catalog (--url). ${user}`;

  if (name === "settings set" || name === "settings unset") {
    const keys: string[] = name === "settings set" ? (named.pairs ?? []).map((p: string) => String(p).split("=")[0].trim()) : (named.keys ?? []).map(String);
    for (const k of keys) {
      const why = agentSettingRefusal(k);
      if (why) return why;
    }
  }

  const writes: string[] = [];
  const reads: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || typeof v === "boolean") continue;
    const list = (Array.isArray(v) ? v : [v]).map(String);
    if (WRITE_FLAGS.has(k)) writes.push(...list);
    else if (k === "set-file") {
      // `--set-file field=path`: extract the path part after `=`.
      for (const pair of list) {
        const eq = pair.indexOf("=");
        reads.push(eq >= 0 ? pair.slice(eq + 1) : pair);
      }
    } else if (k === "cover") {
      for (const cv of list) {
        if (!COVER_PRESETS.has(cv) && !cv.startsWith("image:")) reads.push(cv);
      }
    } else if (READ_FLAGS.has(k) || k.endsWith("-file")) reads.push(...list);
  }
  for (const [k, v] of extra) {
    if (k.endsWith("-file")) reads.push(String(v));
  }
  for (const [k, v] of Object.entries(named)) {
    if (v === undefined || v === null) continue;
    const list = (Array.isArray(v) ? v : [v]).map(String);
    // A `folder` command's own arguments name files inside an open folder; the command keeps them there. A file it
    // is told to copy text from (--content-file) is still checked below.
    if (folder) continue;
    if (WRITE_ARGS.has(k) || (k === "file" && WRITE_FILE_ARG.has(name))) writes.push(...list);
    else if (READ_ARGS.has(k)) reads.push(...list);
  }
  // `settings avatar set photo:<path>` and `settings banner set image:<path>` import local image files.
  if (name === "settings avatar set" && typeof named.value === "string") {
    const raw = named.value.trim();
    if (raw.startsWith("photo:") && !/^photo:(media:)?files\//.test(raw)) reads.push(raw.slice(6));
  }
  if (name === "settings banner set" && typeof named.value === "string") {
    const raw = named.value.trim();
    if (raw.startsWith("image:") && !/^image:(media:)?files\//.test(raw)) reads.push(raw.slice(6));
  }

  if (writes.some((w) => w !== "-") || DEFAULT_WRITERS[name]?.(values)) return `the assistant can't write files on this computer (\`etude ${name}\` with an output path). ${user}`;

  const root = real(attachmentDir);
  for (const r of reads) {
    if (!pathLike(r)) continue;
    if (!inside(real(r), root)) return `the assistant can only read files the user attached to this chat; "${r}" isn't one. ${user}`;
  }
  return null;
}
