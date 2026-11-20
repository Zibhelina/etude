// Prerequisites: which new cards a deck may introduce, and in what order, from `concept::` and
// `needs::` tags on items. FSRS (or the deck's scheduler) still decides when a card comes back; this
// only gates and orders new cards, and can leave out a review that a dependent answer just exercised.
// Nothing here is stored: it's all read from tags, card states and the review log.
import type { Db } from "./db.ts";
import type { PresetConfig } from "./model.ts";
import * as learn from "./learner.ts";
import { deckParts } from "./util.ts";

export const CONCEPT = "concept::";
export const NEEDS = "needs::";

/** `path` is `need` or below it: `needs::a::b` is met by `concept::a::b` and `concept::a::b::c`. */
export const under = (path: string, need: string) => path === need || path.startsWith(need + "::");
/** Either path is at or below the other. */
export const related = (a: string, b: string) => under(a, b) || under(b, a);
/** A concept as people read it: the last segment, dashes as spaces. */
export const conceptLabel = (path: string) => (path.split("::").pop() ?? path).replace(/[-_]+/g, " ");

export interface Graph {
  nodes: string[];
  /** C → concepts C needs (nodes at or below each of its items' needs). */
  edges: Map<string, Set<string>>;
  /** Strongly connected component of each node; cyclic ones are listed in `cycles`. */
  scc: Map<string, number>;
  cyclic: Set<number>;
  cycles: string[][];
  depth: Map<string, number>;
}

/** Concept graph from each item's concept and needs tags. Cycles are found (Tarjan) and their edges ignored for depth. */
export function buildGraph(itemConcepts: Map<string, string[]>, itemNeeds: Map<string, string[]>): Graph {
  const nodes = [...new Set([...itemConcepts.values()].flat())].sort();
  const edges = new Map<string, Set<string>>(nodes.map((n) => [n, new Set<string>()]));
  for (const [item, concepts] of itemConcepts)
    for (const need of itemNeeds.get(item) ?? []) {
      const targets = nodes.filter((n) => under(n, need));
      for (const c of concepts) for (const t of targets) edges.get(c)!.add(t);
    }
  // Tarjan's strongly connected components.
  const scc = new Map<string, number>();
  const index = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], on = new Set<string>();
  let next = 0, comp = 0;
  const comps: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next), low.set(v, next), next++;
    stack.push(v), on.add(v);
    for (const w of edges.get(v)!) {
      if (!index.has(w)) visit(w), low.set(v, Math.min(low.get(v)!, low.get(w)!));
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const members: string[] = [];
      let w: string;
      do (w = stack.pop()!), on.delete(w), scc.set(w, comp), members.push(w);
      while (w !== v);
      comps.push(members.sort());
      comp++;
    }
  };
  for (const n of nodes) if (!index.has(n)) visit(n);
  const cyclic = new Set<number>();
  const cycles: string[][] = [];
  comps.forEach((m, i) => {
    if (m.length > 1 || edges.get(m[0])!.has(m[0])) cyclic.add(i), cycles.push(m);
  });
  // Longest chain of needs below each concept; edges inside a cycle don't count.
  const depth = new Map<string, number>();
  const depthOf = (v: string): number => {
    const known = depth.get(v);
    if (known !== undefined) return known;
    let d = 0;
    for (const w of edges.get(v)!) if (!(scc.get(v) === scc.get(w) && cyclic.has(scc.get(v)!))) d = Math.max(d, depthOf(w) + 1);
    depth.set(v, d);
    return d;
  };
  for (const n of nodes) depthOf(n);
  return { nodes, edges, scc, cyclic, cycles, depth };
}

/** The edge C → D lies inside a cycle, so it's treated as met. */
export const inCycle = (g: Graph, c: string, d: string) => g.scc.has(c) && g.scc.get(c) === g.scc.get(d) && g.cyclic.has(g.scc.get(c)!);

export interface MasteryParams {
  streak: number;
  share: number;
  target: number;
}

export const masteryParams = (cfg: PresetConfig): MasteryParams => ({ streak: Math.max(1, Math.round(cfg.masteryStreak)), share: cfg.masteryShare, target: learn.targetOf(cfg) });

/** A card is mastered once it's in review and its last `streak` answers all passed. */
export function cardMastered(state: number, answers: boolean[], streak: number): boolean {
  return state === 2 && answers.length >= streak && answers.slice(-streak).every(Boolean);
}

/** When a mastered card's current run of passes first reached `streak`: later passes don't move it. */
export function masteredSince(answers: { pass: boolean; ts: string }[], streak: number): string | null {
  let run = 0;
  while (run < answers.length && answers[answers.length - 1 - run].pass) run++;
  return run >= streak ? answers[answers.length - run + streak - 1].ts : null;
}

export interface ConceptStat {
  cards: number;
  mastered: number;
  answered: number;
  isMastered: boolean;
  inProgress: boolean;
  /** When it became mastered: when enough of its cards had been mastered (each card's `masteredSince`). */
  masteredAt: string | null;
}

/** A concept's state from its active cards. A concept with no active cards counts as mastered (nothing to wait for). */
export function conceptStat(cards: { mastered: boolean; answered: boolean; since: string | null }[], share: number): ConceptStat {
  const mastered = cards.filter((c) => c.mastered).length;
  const answered = cards.filter((c) => c.answered).length;
  const need = Math.max(1, Math.ceil(share * cards.length - 1e-9));
  const isMastered = cards.length === 0 || mastered >= need;
  const times = cards.filter((c) => c.mastered && c.since).map((c) => c.since!).sort();
  const masteredAt = cards.length && isMastered ? (times[need - 1] ?? times[times.length - 1] ?? null) : null;
  return { cards: cards.length, mastered, answered, isMastered, inProgress: !isMastered && answered > 0, masteredAt };
}

interface IndexCard {
  item: string;
  mastered: boolean;
  answered: boolean;
  since: string | null;
}

export interface Index {
  itemConcepts: Map<string, string[]>;
  itemNeeds: Map<string, string[]>;
  graph: Graph;
  stat(path: string): ConceptStat;
  /** Whether one need of an item is met, and if not, nothing else to say. */
  needMet(item: string, need: string): boolean;
  depthOfItem(item: string): number;
  /** Latest time one of the item's needs was mastered; null without needs. */
  unlockOf(item: string): string | null;
  inProgressItem(item: string): boolean;
}

/** The new-card side of the queue, for a deck tree with prerequisites on. */
export interface QueuePlan {
  /** Card ids whose item needs a concept that isn't mastered yet. */
  locked: Set<number>;
  /** Unmet needs, most cards locked first. */
  lockedBy: string[];
  /** Card ids held back because enough concepts are already in progress. */
  held: Set<number>;
  /** Sort key for the remaining new cards (lower first). */
  sortNew<T extends { id: number; item_id: string; ord: number }>(news: T[]): T[];
}

export interface PrereqHost {
  db: Db;
  configFor(deck: string): PresetConfig;
  deckExists(name: string): boolean;
}

const hasTags = "EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND (t.tag LIKE 'concept::%' OR t.tag LIKE 'needs::%'))";

export class Prereqs {
  private readonly host: PrereqHost;
  private cache = new Map<string, { version: string; index: Index }>();

  constructor(host: PrereqHost) {
    this.host = host;
  }

  /** The highest deck at or above `deck` with prerequisites on: the in-progress cap counts concepts across it. */
  root(deck: string): string | null {
    const parts = deckParts(deck);
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join("::");
      if (this.host.deckExists(name) && this.host.configFor(name).prerequisites) return name;
    }
    return null;
  }

  /** Concepts, needs, card mastery and the graph across the collection, cached until anything they read changes. */
  index(p: MasteryParams): Index {
    const db = this.host.db;
    const v = db.get(
      "SELECT (SELECT MAX(id) FROM reviews) AS r, (SELECT COUNT(*) || ':' || TOTAL(state) || ':' || TOTAL(suspended) || ':' || TOTAL(reps) FROM cards) AS c, (SELECT MAX(updated) || ':' || COUNT(*) || ':' || TOTAL(archived) FROM items) AS i, (SELECT COUNT(*) || ':' || MAX(rowid) FROM item_tags) AS t, (SELECT group_concat(archived, '') FROM decks) AS d",
    )!;
    const version = JSON.stringify([v.r, v.c, v.i, v.t, v.d]);
    const key = `${p.streak}:${p.share}:${p.target}`;
    const hit = this.cache.get(key);
    if (hit?.version === version) return hit.index;

    const itemConcepts = new Map<string, string[]>(), itemNeeds = new Map<string, string[]>();
    for (const r of db.all<{ item_id: string; tag: string }>(
      "SELECT t.item_id, t.tag FROM item_tags t JOIN items i ON i.id = t.item_id JOIN decks d ON d.id = i.deck_id WHERE i.archived = 0 AND d.archived = 0 AND (t.tag LIKE 'concept::%' OR t.tag LIKE 'needs::%') ORDER BY t.tag",
    )) {
      const concept = r.tag.startsWith(CONCEPT);
      const path = r.tag.slice(concept ? CONCEPT.length : NEEDS.length);
      if (!path) continue;
      const m = concept ? itemConcepts : itemNeeds;
      (m.get(r.item_id) ?? m.set(r.item_id, []).get(r.item_id)!).push(path);
    }
    // Answers of cards on concept items, oldest first: whether each passed.
    const answers = new Map<number, { pass: boolean; ts: string }[]>();
    for (const r of db.all<{ card_id: number; ts: string; rating: number; score: number | null }>(
      `SELECT r.card_id, r.ts, r.rating, r.score FROM reviews r JOIN cards c ON c.id = r.card_id JOIN items i ON i.id = c.item_id WHERE r.practice = 0 AND EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag LIKE 'concept::%') ORDER BY r.card_id, r.ts, r.id`,
    )) {
      const pass = learn.passes(r.rating, r.score, p.target);
      if (pass === null) continue;
      (answers.get(r.card_id) ?? answers.set(r.card_id, []).get(r.card_id)!).push({ pass, ts: r.ts });
    }
    const itemCards = new Map<string, IndexCard[]>();
    for (const r of db.all<{ id: number; item_id: string; state: number }>(
      "SELECT c.id, c.item_id, c.state FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE c.suspended = 0 AND i.archived = 0 AND d.archived = 0 AND EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag LIKE 'concept::%')",
    )) {
      const a = answers.get(r.id) ?? [];
      const mastered = cardMastered(r.state, a.map((x) => x.pass), p.streak);
      const card = { item: r.item_id, mastered, answered: r.state !== 0, since: mastered ? masteredSince(a, p.streak) : null };
      (itemCards.get(r.item_id) ?? itemCards.set(r.item_id, []).get(r.item_id)!).push(card);
    }
    const graph = buildGraph(itemConcepts, itemNeeds);
    const stats = new Map<string, ConceptStat>();
    const stat = (path: string) => {
      let s = stats.get(path);
      if (!s) {
        const cards: IndexCard[] = [];
        for (const [item, concepts] of itemConcepts) if (concepts.some((c) => under(c, path))) cards.push(...(itemCards.get(item) ?? []));
        stats.set(path, (s = conceptStat(cards, p.share)));
      }
      return s;
    };
    const needMet = (item: string, need: string) => {
      if (stat(need).isMastered) return true;
      const concepts = itemConcepts.get(item) ?? [];
      return graph.nodes.some((d) => under(d, need) && concepts.some((c) => inCycle(graph, c, d)));
    };
    const depthOfItem = (item: string) => {
      const concepts = itemConcepts.get(item);
      if (concepts?.length) return Math.max(...concepts.map((c) => graph.depth.get(c) ?? 0));
      const below = (itemNeeds.get(item) ?? []).flatMap((n) => graph.nodes.filter((d) => under(d, n)).map((d) => (graph.depth.get(d) ?? 0) + 1));
      return below.length ? Math.max(...below) : 0;
    };
    const unlockOf = (item: string) =>
      (itemNeeds.get(item) ?? []).reduce<string | null>((m, n) => {
        const at = stat(n).masteredAt;
        return at && (!m || at > m) ? at : m;
      }, null);
    const inProgressItem = (item: string) => (itemConcepts.get(item) ?? []).some((c) => stat(c).inProgress);
    const index: Index = { itemConcepts, itemNeeds, graph, stat, needMet, depthOfItem, unlockOf, inProgressItem };
    this.cache.set(key, { version, index });
    return index;
  }

  /** Concepts in progress across a deck tree, counting the deepest ones (a parent concept in progress through its child counts once). */
  inProgressUnder(ix: Index, items: Iterable<string>): string[] {
    const used = new Set<string>();
    for (const item of items) for (const c of ix.itemConcepts.get(item) ?? []) used.add(c);
    const busy = [...used].filter((c) => ix.stat(c).inProgress);
    return busy.filter((c) => !busy.some((o) => o !== c && under(o, c)));
  }

  /** Items in a deck tree that carry concept or needs tags. */
  itemsUnder(root: string): string[] {
    return this.host.db
      .all<{ id: string }>(`SELECT i.id FROM items i JOIN decks d ON d.id = i.deck_id WHERE i.archived = 0 AND (d.name = ? OR d.name LIKE ? ESCAPE '\\') AND ${hasTags}`, root, root.replace(/[\\%_]/g, "\\$&") + "::%")
      .map((r) => r.id);
  }

  /**
   * Gate, cap and order for the new cards of a scope. `on(deck)` says whether a card's deck has
   * prerequisites on; `root` is the scope's gate root (null: gate only, no cap or order).
   */
  plan(news: { id: number; item_id: string; deck: string }[], on: (deck: string) => boolean, root: string | null, cfg: PresetConfig): QueuePlan {
    const ix = this.index(masteryParams(cfg));
    const locked = new Set<number>(), held = new Set<number>();
    const missing = new Map<string, number>();
    for (const c of news) {
      if (!on(c.deck)) continue;
      const unmet = (ix.itemNeeds.get(c.item_id) ?? []).filter((n) => !ix.needMet(c.item_id, n));
      if (!unmet.length) continue;
      locked.add(c.id);
      for (const n of unmet) missing.set(n, (missing.get(n) ?? 0) + 1);
    }
    const cap = root ? cfg.conceptsInProgress : 0;
    if (cap > 0) {
      const busy = this.inProgressUnder(ix, this.itemsUnder(root!));
      if (busy.length >= cap) {
        // What the started concepts need, all the way down, can still start: holding it would deadlock them.
        const needed = new Set<string>();
        const walk = (c: string) => {
          for (const d of ix.graph.edges.get(c) ?? []) if (!needed.has(d)) needed.add(d), walk(d);
        };
        for (const b of ix.graph.nodes) if (ix.stat(b).inProgress) walk(b);
        for (const c of news) {
          if (locked.has(c.id) || !on(c.deck)) continue;
          const concepts = ix.itemConcepts.get(c.item_id);
          if (concepts?.length && !ix.inProgressItem(c.item_id) && !concepts.some((k) => needed.has(k))) held.add(c.id);
        }
      }
    }
    const lockedBy = [...missing.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
    const sortNew = <T extends { id: number; item_id: string; ord: number }>(list: T[]) => {
      const key = new Map(list.map((c) => [c.id, { busy: ix.inProgressItem(c.item_id) ? 0 : 1, unlock: ix.unlockOf(c.item_id), depth: ix.depthOfItem(c.item_id) }]));
      return [...list].sort((a, b) => {
        const x = key.get(a.id)!, y = key.get(b.id)!;
        if (x.busy !== y.busy) return x.busy - y.busy;
        // Most recently unlocked first; no unlock time goes after.
        if (x.unlock !== y.unlock) return x.unlock === null ? 1 : y.unlock === null ? -1 : y.unlock.localeCompare(x.unlock);
        return x.depth - y.depth || a.ord - b.ord || a.id - b.id;
      });
    };
    return { locked, lockedBy, held, sortNew };
  }

  /**
   * Implicit reviews: due review cards whose concept a dependent card's passing answer exercised after
   * they became due. The credit lasts one of the card's intervals from that answer, then the card comes
   * back as usual. Returns the ids to leave out today.
   */
  credited(reviews: { id: number; item_id: string; deck: string; due: string; last_review: string | null }[], on: (deck: string) => boolean, cfg: PresetConfig, nowIso: string): Set<number> {
    const out = new Set<number>();
    const ix = this.index(masteryParams(cfg));
    const due = reviews.filter((c) => on(c.deck) && ix.itemConcepts.get(c.item_id)?.length);
    if (!due.length) return out;
    const since = due.reduce((m, c) => (c.due < m ? c.due : m), due[0].due);
    const target = learn.targetOf(cfg);
    const passes = this.host.db
      .all<{ item_id: string; ts: string; rating: number; score: number | null }>(
        "SELECT c.item_id, r.ts, r.rating, r.score FROM reviews r JOIN cards c ON c.id = r.card_id WHERE r.practice = 0 AND r.ts >= ? AND EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = c.item_id AND t.tag LIKE 'needs::%') ORDER BY r.ts",
        since,
      )
      .filter((r) => learn.passes(r.rating, r.score, target) === true);
    if (!passes.length) return out;
    const now = new Date(nowIso).getTime();
    for (const c of due) {
      const concepts = ix.itemConcepts.get(c.item_id)!;
      let latest: string | null = null;
      for (const p of passes) {
        if (p.ts < c.due || p.item_id === c.item_id) continue;
        if ((ix.itemNeeds.get(p.item_id) ?? []).some((n) => concepts.some((k) => related(k, n)))) latest = p.ts;
      }
      if (!latest) continue;
      const interval = Math.max(86400_000, new Date(c.due).getTime() - new Date(c.last_review ?? c.due).getTime());
      if (now < new Date(latest).getTime() + interval) out.add(c.id);
    }
    return out;
  }

  /** The concept map of a deck tree, in topological order (needs first). */
  conceptMap(deck: string, cfg: PresetConfig) {
    const ix = this.index(masteryParams(cfg));
    const items = this.itemsUnder(deck);
    const concepts = new Set<string>();
    const needsOf = new Map<string, Set<string>>();
    const dangling = new Set<string>();
    for (const item of items) {
      for (const c of ix.itemConcepts.get(item) ?? []) {
        concepts.add(c);
        const s = needsOf.get(c) ?? needsOf.set(c, new Set()).get(c)!;
        for (const n of ix.itemNeeds.get(item) ?? []) s.add(n);
      }
      for (const n of ix.itemNeeds.get(item) ?? []) if (ix.stat(n).cards === 0) dangling.add(n);
    }
    const rows = [...concepts].map((concept) => {
      const s = ix.stat(concept);
      const needs = [...(needsOf.get(concept) ?? [])].sort();
      const missing = needs.filter((n) => !ix.stat(n).isMastered && !ix.graph.nodes.some((d) => under(d, n) && inCycle(ix.graph, concept, d)));
      const state = s.isMastered && s.cards > 0 ? "mastered" : s.inProgress ? "in-progress" : missing.length ? "locked" : "unlocked";
      return { concept, depth: ix.graph.depth.get(concept) ?? 0, needs, cards: s.cards, mastered: s.mastered, inProgress: s.inProgress, state: state as "mastered" | "in-progress" | "unlocked" | "locked", missing };
    });
    rows.sort((a, b) => a.depth - b.depth || a.concept.localeCompare(b.concept));
    const cycles = ix.graph.cycles.filter((c) => c.some((x) => concepts.has(x)));
    return { deck, prerequisites: cfg.prerequisites, concepts: rows, cycles, danglingNeeds: [...dangling].sort() };
  }
}
