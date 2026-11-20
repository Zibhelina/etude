// A kanban board: columns of cards, like Trello. The board is a note of its own (kind "kanban") and every card
// is a small page: its body is a document like any page's, so it can hold to-dos, equations, code, a canvas or
// study cards. Pages show a board through a portal (the kanbanEmbed block); the board itself lives here.
import { randomUUID } from "node:crypto";
import { EtudeError } from "./engine.ts";
import type { DocNode } from "./notes.ts";

export const KANBAN_COLORS = ["grey", "red", "orange", "gold", "green", "teal", "blue", "purple", "pink"] as const;
export type KanbanColor = (typeof KANBAN_COLORS)[number];

export interface KanbanLabel {
  id: string;
  name: string;
  color: KanbanColor;
}
export interface KanbanColumn {
  id: string;
  name: string;
  color: KanbanColor;
  /** How many cards it should hold at most (shown, never enforced); null: no limit. */
  limit: number | null;
  /** Cards here count as done (their due dates stop being late). */
  done: boolean;
  cards: string[];
}
export interface KanbanCard {
  id: string;
  title: string;
  labels: string[];
  /** A day, YYYY-MM-DD. */
  due: string | null;
  cover: KanbanColor | null;
  /** The card's page. */
  doc: DocNode;
  created: string;
  updated: string;
}
export interface KanbanBoard {
  type: "kanban";
  version: 1;
  columns: KanbanColumn[];
  cards: Record<string, KanbanCard>;
  labels: KanbanLabel[];
  /** Archived cards, newest first: kept with their pages, out of every column. */
  archived: string[];
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE = 500;
const MAX_CARDS = 5000;
const now = () => new Date().toISOString();
export const kanbanId = () => randomUUID().slice(0, 8);
const emptyDoc = (): DocNode => ({ type: "doc", content: [] });

export const KANBAN_TEMPLATES = {
  basic: ["To do", "Doing", "Done"],
  week: ["Mon", "Tue", "Wed", "Thu", "Fri", "Weekend"],
  empty: [] as string[],
} as const;
export type KanbanTemplate = keyof typeof KANBAN_TEMPLATES;

/** A new board: the usual To do · Doing · Done (the last counts as done), a week, or no columns at all. */
export function emptyBoard(template: KanbanTemplate | string[] = "basic"): KanbanBoard {
  const names = Array.isArray(template) ? template : KANBAN_TEMPLATES[template] ?? KANBAN_TEMPLATES.basic;
  const basic = !Array.isArray(template) && template === "basic";
  const columns: KanbanColumn[] = names.map((name, i) => ({
    id: kanbanId(),
    name,
    color: basic ? (["grey", "gold", "green"] as const)[i] : template === "week" ? (i === 5 ? "purple" : "blue") : KANBAN_COLORS[i % KANBAN_COLORS.length],
    limit: null,
    done: basic && i === 2,
    cards: [],
  }));
  return { type: "kanban", version: 1, columns, cards: {}, labels: [], archived: [] };
}

const color = (c: unknown, fallback: KanbanColor): KanbanColor => (KANBAN_COLORS as readonly string[]).includes(String(c)) ? (c as KanbanColor) : fallback;
const text = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Checks a board from outside (the app, the API, the CLI) and puts it in order: every card sits in exactly one
 * column or in the archive, unknown labels are dropped, dates are days. `checkDoc` checks each card's page.
 */
export function checkBoard(raw: unknown, checkDoc: (d: unknown) => DocNode): KanbanBoard {
  if (!raw || typeof raw !== "object") throw new EtudeError('a board is { type: "kanban", columns: [...], cards: {...} }');
  const b = raw as Record<string, any>;
  if (b.type !== undefined && b.type !== "kanban") throw new EtudeError('a board\'s type is "kanban"');
  if (!Array.isArray(b.columns)) throw new EtudeError("a board's columns are a list");
  const cardsIn = b.cards && typeof b.cards === "object" && !Array.isArray(b.cards) ? (b.cards as Record<string, any>) : {};
  if (Object.keys(cardsIn).length > MAX_CARDS) throw new EtudeError(`a board holds ${MAX_CARDS} cards at most`, 413);
  const labels: KanbanLabel[] = [];
  const seenLabel = new Set<string>();
  for (const l of Array.isArray(b.labels) ? b.labels : []) {
    if (!l || typeof l !== "object" || !ID.test(String(l.id)) || seenLabel.has(l.id)) continue;
    seenLabel.add(l.id);
    labels.push({ id: l.id, name: text(l.name, 60), color: color(l.color, "grey") });
  }
  const cards: Record<string, KanbanCard> = {};
  const card = (id: string): KanbanCard | null => {
    const c = cardsIn[id];
    if (!c || typeof c !== "object") return null;
    const t = now();
    return {
      id,
      title: text(c.title, MAX_TITLE),
      labels: [...new Set((Array.isArray(c.labels) ? c.labels : []).filter((x: unknown) => seenLabel.has(String(x))).map(String))] as string[],
      due: c.due == null || c.due === "" ? null : DAY.test(String(c.due)) && !Number.isNaN(Date.parse(String(c.due))) ? String(c.due) : (() => { throw new EtudeError(`a card's due date is a day, YYYY-MM-DD (got "${c.due}")`); })(),
      cover: c.cover == null || c.cover === "" ? null : color(c.cover, "grey"),
      doc: c.doc === undefined || c.doc === null ? emptyDoc() : checkDoc(c.doc),
      created: typeof c.created === "string" ? c.created : t,
      updated: typeof c.updated === "string" ? c.updated : t,
    };
  };
  const placed = new Set<string>();
  const columns: KanbanColumn[] = [];
  const seenCol = new Set<string>();
  for (const c of b.columns) {
    if (!c || typeof c !== "object") throw new EtudeError("each column is { id, name, cards }");
    const id = ID.test(String(c.id)) && !seenCol.has(c.id) ? String(c.id) : kanbanId();
    seenCol.add(id);
    const lim = c.limit == null || c.limit === "" || Number(c.limit) === 0 ? null : Math.trunc(Number(c.limit));
    if (lim !== null && !(lim >= 1 && lim <= 999)) throw new EtudeError("a column's limit is 1 to 999 cards (or none)");
    const ids: string[] = [];
    for (const k of Array.isArray(c.cards) ? c.cards : []) {
      const kid = String(k);
      if (placed.has(kid)) continue;
      const v = card(kid);
      if (!v) continue;
      placed.add(kid);
      cards[kid] = v;
      ids.push(kid);
    }
    columns.push({ id, name: text(c.name, 120), color: color(c.color, "grey"), limit: lim, done: !!c.done, cards: ids });
  }
  const archived: string[] = [];
  for (const k of Array.isArray(b.archived) ? b.archived : []) {
    const kid = String(k);
    if (placed.has(kid)) continue;
    const v = card(kid);
    if (!v) continue;
    placed.add(kid);
    cards[kid] = v;
    archived.push(kid);
  }
  // A card that's in no column and not archived would be lost: it goes to the archive.
  for (const kid of Object.keys(cardsIn)) {
    if (placed.has(kid) || !ID.test(kid)) continue;
    const v = card(kid);
    if (!v) continue;
    cards[kid] = v;
    archived.push(kid);
  }
  return { type: "kanban", version: 1, columns, cards, labels, archived };
}

/** What search finds in a board: its columns, card titles, labels and the text of every card. */
export function boardText(b: KanbanBoard, docText: (d: DocNode) => string): string {
  const out: string[] = [];
  const label = new Map(b.labels.map((l) => [l.id, l.name]));
  for (const c of b.columns) {
    out.push(c.name);
    for (const k of c.cards) {
      const card = b.cards[k];
      if (!card) continue;
      out.push([card.title, ...card.labels.map((l) => label.get(l) ?? "")].filter(Boolean).join(" "));
      const t = docText(card.doc).trim();
      if (t) out.push(t);
    }
  }
  return out.join("\n");
}

/** Every card's page as one document (for [[links]] and portals inside cards). */
export function boardDocs(b: KanbanBoard): DocNode {
  return { type: "doc", content: Object.values(b.cards).flatMap((c) => c.doc.content ?? []) };
}

// ---------------------------------------------------------------- edits (CLI and agents)

const clone = (b: KanbanBoard): KanbanBoard => JSON.parse(JSON.stringify(b));

/** A column by id, by exact name (any case), or by number (1 = first). */
export function findColumn(b: KanbanBoard, ref: string): KanbanColumn {
  const r = String(ref).trim();
  const hit = b.columns.find((c) => c.id === r) ?? b.columns.filter((c) => c.name.toLowerCase() === r.toLowerCase())[0] ?? (/^\d+$/.test(r) ? b.columns[Number(r) - 1] : undefined);
  if (!hit) throw new EtudeError(`no column "${ref}" on this board (${b.columns.map((c) => c.name).join(", ") || "it has none"})`, 404);
  return hit;
}

/** A card by id, or by exact title when exactly one card has it. */
export function findCard(b: KanbanBoard, ref: string): KanbanCard {
  const r = String(ref).trim();
  if (b.cards[r]) return b.cards[r];
  const hits = Object.values(b.cards).filter((c) => c.title.toLowerCase() === r.toLowerCase());
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new EtudeError(`${hits.length} cards are called "${ref}": use the id`, 409);
  throw new EtudeError(`no card "${ref}" on this board`, 404);
}

export const columnOf = (b: KanbanBoard, cardId: string): KanbanColumn | null => b.columns.find((c) => c.cards.includes(cardId)) ?? null;

function labelIds(b: KanbanBoard, names: string[] | undefined): string[] | undefined {
  if (!names) return undefined;
  return names.map((n) => {
    const [name, col] = String(n).split(":");
    const nm = text(name, 60);
    let l = b.labels.find((x) => x.id === nm || x.name.toLowerCase() === nm.toLowerCase());
    if (!l) {
      l = { id: kanbanId(), name: nm, color: color(col, KANBAN_COLORS[(b.labels.length + 1) % KANBAN_COLORS.length]) };
      b.labels.push(l);
    }
    return l.id;
  });
}

export function addCard(board: KanbanBoard, column: string | undefined, input: { title: string; due?: string | null; labels?: string[]; cover?: string | null; doc?: DocNode; at?: number }): { board: KanbanBoard; card: KanbanCard } {
  const b = clone(board);
  if (!b.columns.length) throw new EtudeError("this board has no columns yet: add one first");
  const col = column === undefined ? b.columns[0] : findColumn(b, column);
  const id = kanbanId();
  const t = now();
  b.cards[id] = { id, title: text(input.title, MAX_TITLE), labels: labelIds(b, input.labels) ?? [], due: input.due ?? null, cover: (input.cover as KanbanColor) ?? null, doc: input.doc ?? emptyDoc(), created: t, updated: t };
  const at = input.at === undefined ? col.cards.length : Math.max(0, Math.min(col.cards.length, Math.trunc(input.at)));
  col.cards.splice(at, 0, id);
  return { board: b, card: b.cards[id] };
}

export function moveCard(board: KanbanBoard, cardRef: string, column: string, at?: number): KanbanBoard {
  const b = clone(board);
  const card = findCard(b, cardRef);
  const to = findColumn(b, column);
  for (const c of b.columns) c.cards = c.cards.filter((k) => k !== card.id);
  b.archived = b.archived.filter((k) => k !== card.id);
  const i = at === undefined ? to.cards.length : Math.max(0, Math.min(to.cards.length, Math.trunc(at)));
  to.cards.splice(i, 0, card.id);
  card.updated = now();
  return b;
}

export function editCard(board: KanbanBoard, cardRef: string, patch: { title?: string; due?: string | null; labels?: string[]; cover?: string | null; doc?: DocNode }): KanbanBoard {
  const b = clone(board);
  const card = findCard(b, cardRef);
  if (patch.title !== undefined) card.title = text(patch.title, MAX_TITLE);
  if (patch.due !== undefined) card.due = patch.due;
  if (patch.cover !== undefined) card.cover = (patch.cover as KanbanColor) || null;
  if (patch.labels !== undefined) card.labels = labelIds(b, patch.labels) ?? [];
  if (patch.doc !== undefined) card.doc = patch.doc;
  card.updated = now();
  return b;
}

export function archiveCard(board: KanbanBoard, cardRef: string, archived = true): KanbanBoard {
  const b = clone(board);
  const card = findCard(b, cardRef);
  if (archived) {
    for (const c of b.columns) c.cards = c.cards.filter((k) => k !== card.id);
    if (!b.archived.includes(card.id)) b.archived.unshift(card.id);
  } else if (b.archived.includes(card.id)) {
    if (!b.columns.length) throw new EtudeError("this board has no columns to bring it back to");
    b.archived = b.archived.filter((k) => k !== card.id);
    b.columns[0].cards.push(card.id);
  }
  return b;
}

/** Adds a column, or changes one: its name, colour, limit, whether its cards count as done; `remove` archives its cards. */
export function editColumn(board: KanbanBoard, ref: string, patch: { name?: string; color?: string; limit?: number | null; done?: boolean; at?: number; remove?: boolean }): KanbanBoard {
  const b = clone(board);
  let col = b.columns.find((c) => c.id === ref || c.name.toLowerCase() === String(ref).trim().toLowerCase());
  if (!col) {
    if (patch.remove) throw new EtudeError(`no column "${ref}" on this board`, 404);
    col = { id: kanbanId(), name: text(ref, 120), color: KANBAN_COLORS[b.columns.length % KANBAN_COLORS.length], limit: null, done: false, cards: [] };
    b.columns.push(col);
  }
  if (patch.remove) {
    b.archived.unshift(...col.cards);
    b.columns = b.columns.filter((c) => c !== col);
    return b;
  }
  if (patch.name !== undefined) col.name = text(patch.name, 120);
  if (patch.color !== undefined) col.color = color(patch.color, col.color);
  if (patch.limit !== undefined) {
    if (patch.limit !== null && !(patch.limit >= 1 && patch.limit <= 999)) throw new EtudeError("a column's limit is 1 to 999 cards (0 for none)");
    col.limit = patch.limit;
  }
  if (patch.done !== undefined) col.done = patch.done;
  if (patch.at !== undefined) {
    b.columns = b.columns.filter((c) => c !== col);
    b.columns.splice(Math.max(0, Math.min(b.columns.length, Math.trunc(patch.at))), 0, col);
  }
  return b;
}

// ---------------------------------------------------------------- Markdown (the Obsidian Kanban plugin's format)

/**
 * The board as Markdown that Obsidian's Kanban plugin opens: a `## heading` per column, a `- [ ]` item per card
 * with its labels as #tags and its due date as @{YYYY-MM-DD}, the card's page indented under it. A done column
 * is marked **Complete** and its cards ticked.
 */
export function boardToMarkdown(b: KanbanBoard, docToMarkdown: (d: DocNode) => string): string {
  const label = new Map(b.labels.map((l) => [l.id, l.name]));
  const tag = (s: string) => "#" + s.replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_/-]/gu, "");
  const out = ["---", "", "kanban-plugin: board", "", "---", ""];
  for (const c of b.columns) {
    out.push(`## ${c.name || "Untitled"}`, "");
    if (c.done) out.push("**Complete**");
    for (const k of c.cards) {
      const card = b.cards[k];
      if (!card) continue;
      const bits = [card.title.replace(/\n/g, " ") || "Untitled", ...card.labels.map((l) => label.get(l)).filter(Boolean).map((n) => tag(n!)), card.due ? `@{${card.due}}` : ""].filter(Boolean);
      out.push(`- [${c.done ? "x" : " "}] ${bits.join(" ")}`);
      const body = docToMarkdown(card.doc).trim();
      if (body) for (const line of body.split("\n")) out.push(line ? `\t${line}` : "");
    }
    out.push("", "");
  }
  if (b.archived.length) {
    out.push("***", "", "## Archive", "");
    for (const k of b.archived) if (b.cards[k]) out.push(`- [ ] ${b.cards[k].title || "Untitled"}`);
    out.push("", "");
  }
  out.push("%% kanban:settings", "```", '{"kanban-plugin":"board"}', "```", "%%");
  return out.join("\n") + "\n";
}
