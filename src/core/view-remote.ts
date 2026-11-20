// What the Notebook shows, and asks to change it, between the app and anything else on this computer (the CLI,
// `etude mcp`, an agent in Ask). The open app writes its panes to a small state file and reads commands from a
// queue beside it; both live in the Etude home, one folder per collection. Files, so a CLI run or an MCP call
// needs no port or token, and the app's server just relays them to the page.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ViewSide = "left" | "right" | "top" | "bottom";
/** Where `open` puts a note: a pane of its own beside another (a side), a new tab, or in place of the front page. */
export type ViewWhere = ViewSide | "tab" | "replace";

export type SidebarMode = "open" | "rail" | "none";
/** Everything a person can do to the Notebook's layout and the app around it, asked from outside. A tab is a
 *  note id, a chat tab (`chat:…`) or a New tab (`new:…`), as `view show` lists them. A group is its id or name. */
export type ViewCommand =
  /** No note: a New tab (the start page). */
  /** As a tab, `before` puts it in front of that tab (null: at the end); left out, it goes next to the front page. */
  | { action: "open"; note?: string; where: ViewWhere; beside?: ViewTarget; before?: string | null }
  | { action: "close"; target: ViewTarget }
  | { action: "close-others"; tab: string }
  | { action: "focus"; target: ViewTarget }
  | { action: "pin"; tab: string; on: boolean }
  | { action: "icon"; tab: string; icon: string | null }
  /** Into another pane's tabs (before a tab, or at the end), or to a side of a pane as a new pane. */
  | { action: "move"; tab: string; to: ViewTarget; before?: string | null; side?: ViewSide }
  /** Tabs into a group: an existing one, or a new one with this name and colour. */
  | { action: "group"; tabs: string[]; group?: string; name?: string; color?: string }
  | { action: "group-edit"; group: string; name?: string; color?: string; collapsed?: boolean }
  /** A whole group dissolves (its tabs stay), or one tab leaves its group. */
  | { action: "ungroup"; group?: string; tab?: string }
  | { action: "group-close"; group: string }
  | { action: "group-move"; group: string; to: ViewTarget; before?: string | null }
  /** The pane's share of the split it's in, 0.05 to 0.95. */
  | { action: "resize"; target: ViewTarget; size: number }
  /** A pane's own zoom: a step in or out, back to 100% ("reset"), or a size (1.25 is 125%). */
  | { action: "zoom"; target: ViewTarget; zoom: "in" | "out" | "reset" | number }
  | { action: "sidebar"; mode: SidebarMode }
  /** Notes' page tree under the Notes row in the sidebar. */
  | { action: "pages"; open: boolean }
  /** The Ask side panel. */
  | { action: "panel"; open: boolean }
  /** Another screen of the app: /notes, /study?deck=…, /browse, /stats, /settings… */
  | { action: "go"; route: string };
/** A pane by its number (1 first, as `view show` counts them), the pane a note is open in, or the pane with an Ask chat. */
export type ViewTarget = { pane: number } | { note: string } | { chat: true } | { panel: true };

export interface ViewTab {
  id: string;
  kind: string;
  title: string;
  pinned?: boolean;
  icon?: string;
  group?: string;
}
export interface ViewGroup {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
  tabs: string[];
}
export interface ViewPane {
  n: number;
  focused: boolean;
  front: ViewTab | null;
  tabs: ViewTab[];
  groups?: ViewGroup[];
  /** Its share of the area, as fractions. */
  box?: { x: number; y: number; w: number; h: number };
  /** Its own zoom when it isn't 1 (1.25 is 125%). */
  zoom?: number;
}
/** The app around the Notebook. */
export interface ViewShell {
  sidebar: SidebarMode;
  pages: boolean;
  panel: boolean;
}
export interface ViewState {
  /** When the app last said what it shows. */
  at: string;
  route: string;
  panes: ViewPane[];
  shell?: ViewShell;
  /** The last command the app carried out. */
  applied?: number;
  /** A command it couldn't carry out, and why. */
  failed?: { seq: number; error: string };
}

/** An app that hasn't spoken for this long is taken as closed. */
export const VIEW_LIVE_MS = 60_000;
/** A command the app didn't pick up in this time is dropped, so it doesn't fire the next time the app opens. */
export const VIEW_COMMAND_TTL_MS = 30_000;

export function viewDir(home: string, dbPath: string): string {
  const dir = join(home, "view", createHash("sha256").update(dbPath).digest("hex").slice(0, 16));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readViewState(dir: string): (ViewState & { live: boolean }) | null {
  try {
    const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as ViewState;
    return { ...s, live: Date.now() - Date.parse(s.at) < VIEW_LIVE_MS };
  } catch {
    return null;
  }
}

export function writeViewState(dir: string, s: Omit<ViewState, "at">): void {
  const f = join(dir, "state.json");
  writeFileSync(f + ".tmp", JSON.stringify({ ...s, at: new Date().toISOString() }), { mode: 0o600 });
  renameSync(f + ".tmp", f);
}

type Queued = ViewCommand & { seq: number; at: string };

function queued(dir: string): Queued[] {
  const f = join(dir, "commands.jsonl");
  if (!existsSync(f)) return [];
  const out: Queued[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** Puts a command in the queue and returns its number. Old ones are trimmed so the file stays small. */
export function pushViewCommand(dir: string, cmd: ViewCommand): number {
  const f = join(dir, "commands.jsonl");
  const all = queued(dir);
  const seq = (all.at(-1)?.seq ?? 0) + 1;
  const line = JSON.stringify({ ...cmd, seq, at: new Date().toISOString() });
  if (all.length > 200) writeFileSync(f, all.slice(-50).map((c) => JSON.stringify(c) + "\n").join("") + line + "\n", { mode: 0o600 });
  else appendFileSync(f, line + "\n", { mode: 0o600 });
  return seq;
}

/** Commands after `after` that are still fresh, and the newest number. */
export function viewCommandsAfter(dir: string, after: number): { seq: number; commands: Queued[] } {
  const all = queued(dir);
  const now = Date.now();
  return { seq: all.at(-1)?.seq ?? 0, commands: all.filter((c) => c.seq > after && now - Date.parse(c.at) < VIEW_COMMAND_TTL_MS) };
}

/** The queue file's change time, so a waiting request can tell cheaply when something arrived. */
export function viewQueueStamp(dir: string): number {
  try {
    return statSync(join(dir, "commands.jsonl")).mtimeMs;
  } catch {
    return 0;
  }
}
