// Read-only inspection of live background subagents and terminal processes owned by a Hermes ACP session.
// Hermes's delegate_task (async) and terminal (background) return immediately as completed tool calls,
// keeping live state in <hermesDir>/state.db (async_delegations + sessions) and <hermesDir>/processes.json.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AcpAgentDef } from "./acp-agents.ts";
import type { AcpBackgroundTask } from "./acp.ts";

const require = createRequire(import.meta.url);
const HERMES_PROFILE = /^[A-Za-z0-9._-]{1,64}$/;

export function isHermesAgent(def: AcpAgentDef): boolean {
  return def.preset === "hermes" || /^hermes(\.exe|\.cmd)?$/i.test(basename(def.command));
}

/** Resolves the Hermes profile directory for an ACP agent definition, matching Agent.hermes(). */
export function hermesProfileDir(def: AcpAgentDef): string {
  let base = def.env?.HERMES_HOME || process.env.HERMES_HOME || join(homedir(), ".hermes");
  if (basename(dirname(base)) === "profiles") return base;
  let profile = "";
  const args = def.args ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "-p" || a === "--profile") && i + 1 < args.length) {
      profile = args[i + 1];
      break;
    }
    if (a.startsWith("--profile=")) {
      profile = a.slice("--profile=".length);
      break;
    }
  }
  if (profile && profile !== "default" && HERMES_PROFILE.test(profile)) return join(base, "profiles", profile);
  return base;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

function cleanTitle(raw: unknown, fallback: string): string {
  const s = String(raw ?? "")
    .replace(/^Subagent:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return (s || fallback).slice(0, 120);
}

/** Returns live background subagents and processes belonging to a Hermes ACP session (read-only, never throws). */
export function hermesBackgroundTasks(def: AcpAgentDef, sessionId: string): AcpBackgroundTask[] {
  if (!sessionId || !isHermesAgent(def)) return [];
  const dir = hermesProfileDir(def);
  const out: AcpBackgroundTask[] = [];
  const seen = new Set<string>();

  // 1. Live async_delegations (and their still-open child subagent sessions) in state.db
  const dbPath = join(dir, "state.db");
  if (existsSync(dbPath)) {
    let db: any = null;
    try {
      const { DatabaseSync } = require("node:sqlite");
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT delegation_id, dispatched_at, owner_pid, task_json
           FROM async_delegations
           WHERE state IN ('running', 'finalizing')
             AND (parent_session_id = ? OR origin_session_id = ? OR origin_session LIKE ?)
           ORDER BY dispatched_at ASC`,
        )
        .all(sessionId, sessionId, `%${sessionId}%`) as {
        delegation_id: string;
        dispatched_at: number;
        owner_pid: number | null;
        task_json: string | null;
      }[];

      for (const row of rows) {
        if (row.owner_pid && !isPidAlive(Number(row.owner_pid))) continue;
        let task: { goal?: string; goals?: string[] } = {};
        try {
          if (row.task_json) task = JSON.parse(row.task_json);
        } catch {}
        const goals = Array.isArray(task.goals) ? task.goals : [];
        let children: { id: string; title: string | null; started_at: number | null }[] = [];
        try {
          children = db
            .prepare(
              `SELECT id, title, started_at
               FROM sessions
               WHERE parent_session_id = ? AND ended_at IS NULL AND started_at >= ?
               ORDER BY started_at ASC`,
            )
            .all(sessionId, Number(row.dispatched_at) - 5) as typeof children;
        } catch {}

        if (children.length > 0) {
          children.forEach((ch, idx) => {
            if (seen.has(ch.id)) return;
            seen.add(ch.id);
            const fallback = goals[idx] || task.goal || "Subagent";
            out.push({
              id: ch.id,
              name: "delegate_task",
              kind: "subagent",
              title: cleanTitle(ch.title || fallback, "Subagent"),
              startedAt: Math.round(Number(ch.started_at || row.dispatched_at) * 1000),
            });
          });
        } else if (!seen.has(row.delegation_id)) {
          seen.add(row.delegation_id);
          out.push({
            id: row.delegation_id,
            name: "delegate_task",
            kind: "subagent",
            title: cleanTitle(task.goal || goals[0], "Subagent"),
            startedAt: Math.round(Number(row.dispatched_at) * 1000),
          });
        }
      }
    } catch {
      // Missing tables, older Hermes schema, or busy/inaccessible db: stay silent.
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  // 2. Live background terminal processes in processes.json
  const procPath = join(dir, "processes.json");
  if (existsSync(procPath)) {
    try {
      const list = JSON.parse(readFileSync(procPath, "utf8"));
      if (Array.isArray(list)) {
        for (const p of list) {
          if (!p || typeof p !== "object") continue;
          const matches = p.parent_session_id === sessionId || String(p.session_key ?? "").includes(sessionId);
          if (!matches) continue;
          if (p.pid && !isPidAlive(Number(p.pid))) continue;
          const id = String(p.task_id || (p.pid ? `proc:${p.pid}` : ""));
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push({
            id,
            name: "terminal",
            kind: "execute",
            title: cleanTitle(p.command, "Background process"),
            startedAt: p.started_at ? Math.round(Number(p.started_at) * 1000) : Date.now(),
          });
        }
      }
    } catch {}
  }

  return out;
}
