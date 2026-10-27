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

/** Why the agent may not change this settings key, or null when it may. */
export function agentSettingRefusal(key: string): string | null {
  if (AGENT_SETTINGS.includes(key)) return null;
  return `the assistant can't change "${key}". Provider URLs, API key names, the Market catalog and theme definitions can only be changed by the user, in Settings or with the etude CLI.`;
}

/** Account commands the assistant may run: read-only views. */
const AGENT_ACCOUNT_READS = new Set(["account status", "account library", "account market", "account listings", "account sales", "account devices", "account passkeys", "account creator"]);

/** Commands that write files somewhere even without an output flag. */
const DEFAULT_WRITERS: Record<string, (values: Record<string, any>) => boolean> = {
  "type new": () => true,
  "type-export": () => true,
  "type export": (v) => !v.json,
  "scheduler export": (v) => !v.json,
  "market index": (v) => !v.check,
};

/** Flags and arguments that name a file to read. */
const READ_FLAGS = new Set(["file", "from", "boxes", "attach"]);
const READ_ARGS = new Set(["file", "files", "source", "image", "dir"]);
/** Flags and arguments that name a file or folder to write. */
const WRITE_FLAGS = new Set(["out"]);
const WRITE_ARGS = new Set(["dest"]);
/** Commands whose `file` argument is an output. */
const WRITE_FILE_ARG = new Set(["pack new"]);

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

export interface GuardInput {
  cmd: CommandSpec;
  values: Record<string, any>;
  named: Record<string, any>;
  /** The agent's attachment folder: the only place it may read files from. */
  attachmentDir: string;
}

/** A refusal message when the agent may not run this invocation as given, or null when it may. */
export function agentRefusal({ cmd, values, named, attachmentDir }: GuardInput): string | null {
  const name = cmd.name;
  const user = `Ask the user to run it themselves if they want it.`;

  // Another catalog or feed: the configured Market is the only one the agent reads.
  if (typeof values.url === "string" && values.url && name.startsWith("market ")) return `the assistant can't point the Market at another catalog (--url). ${user}`;

  // The account holds money, devices and deletion; the assistant may only look.
  if (name.startsWith("account ") && !AGENT_ACCOUNT_READS.has(name)) return `the assistant can't change the Etude account, buy, sell or sign in. ${user}`;

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
    else if (READ_FLAGS.has(k) || k.endsWith("-file")) reads.push(...list);
  }
  for (const [k, v] of Object.entries(named)) {
    if (v === undefined || v === null) continue;
    const list = (Array.isArray(v) ? v : [v]).map(String);
    if (WRITE_ARGS.has(k) || (k === "file" && WRITE_FILE_ARG.has(name))) writes.push(...list);
    else if (READ_ARGS.has(k)) reads.push(...list);
  }

  if (writes.some((w) => w !== "-") || DEFAULT_WRITERS[name]?.(values)) return `the assistant can't write files on this computer (\`etude ${name}\` with an output path). ${user}`;

  const root = real(attachmentDir);
  for (const r of reads) {
    if (!pathLike(r)) continue;
    if (!inside(real(r), root)) return `the assistant can only read files the user attached to this chat; "${r}" isn't one. ${user}`;
  }
  return null;
}
