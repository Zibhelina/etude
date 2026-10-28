// Adaptive decks: what Etude knows about the learner across a deck tree with adaptiveChallenge or
// adaptivePace on, read from its cards, answers and ratings, and what that changes in the queue and
// in preparing a card. The math is in learner.ts; decks without these settings never get here.
import type { Db } from "./db.ts";
import type { CardRow, CardTypeDef, Grade, PresetConfig, SchedulerDef } from "./model.ts";
import * as sched from "./scheduler.ts";
import * as learn from "./learner.ts";
import { deckParts, hashString, parse } from "./util.ts";

/** What the adaptive module reads through the engine. */
export interface AdaptiveHost {
  db: Db;
  configFor(deck: string): PresetConfig;
  type(id: string): CardTypeDef;
  scriptFor(cfg: PresetConfig): SchedulerDef | null;
  cardWithDeck(cardId: number): CardRow & { deck: string };
  /** The deck's stored name; throws for an unknown deck. */
  deckName(deck: string): string;
  dayStart(at: Date): Date;
}

/** A placement session's name; `true` (no name) is the session answers had before sessions were named. */
export const placementSession = (p: string | boolean | undefined) => (typeof p === "string" && p.trim() ? p.trim().slice(0, 64) : "1");

/** Learner estimates and lookups for one showing of a card on an adaptive deck. */
export interface AdaptContext {
  learner: learn.Learner;
  /** Placement session of this showing. */
  session?: string;
  /** Card types see `learner` (adaptiveChallenge on); otherwise only the showing's skill and flags are recorded. */
  challenge: boolean;
  itemId: string;
  cardId: number;
  model: learn.SkillModel;
  known: Set<string>;
  seen: Map<string, number>;
}

interface RootCard {
  id: number;
  itemId: string;
  state: number;
  stability: number;
  active: boolean;
  tags: string[];
  /** The face's skill first, then any `skill::` tags. */
  skills: string[];
  /** Index in the deck's levels, or -1. */
  level: number;
  /** Placement band, or -1. */
  band: number;
}

interface RootData {
  root: string;
  cfg: PresetConfig;
  cards: Map<number, RootCard>;
  attempts: { ts: string; a: learn.GradedAttempt }[];
  model: learn.SkillModel;
  maxTs: string;
  known: Set<string>;
  /** Of `known`, items known only because a placement passed their band. */
  assumed: number;
  seen: Map<string, number>;
  scores: Map<number, { ts: string; score: number }[]>;
  /** The latest placement session, per skill; `frontier` is the bisection's, revised by the quick checks. */
  placement: Map<string, { bands: number[]; state: learn.PlacementState; frontier: number; checks: { done: number; passed: number } }>;
  /** Any session's state, for picking its next probe. */
  placementOf: (session: string) => Map<string, { bands: number[]; state: learn.PlacementState }>;
  levels: Map<string, learn.LevelState> | null;
  /** In a band a placement showed to be known. */
  passed: (c: RootCard) => boolean;
}

export class Adaptive {
  private readonly host: AdaptiveHost;

  constructor(host: AdaptiveHost) {
    this.host = host;
  }

  /** The highest deck at or above `deck` with an adaptive setting on: skills are measured across it. */
  adaptiveRoot(deck: string): string | null {
    const parts = deckParts(deck);
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join("::");
      if (!this.host.db.get("SELECT 1 FROM decks WHERE name = ?", name)) continue;
      const c = this.host.configFor(name);
      if (c.adaptiveChallenge || c.adaptivePace) return name;
    }
    return null;
  }

  private rootCache = new Map<string, { version: string; data: RootData }>();

  /** Cards, graded history and estimates for an adaptive root, cached until anything they depend on changes. */
  private rootData(root: string): RootData {
    const cfg = this.host.configFor(root);
    // Card states can change without a review (reschedule, reset), so their totals are part of the version.
    const v = this.host.db.get(
      "SELECT (SELECT MAX(id) FROM attempts) AS a, (SELECT MAX(id) FROM reviews) AS r, (SELECT COUNT(*) || ':' || TOTAL(state) || ':' || TOTAL(stability) || ':' || TOTAL(suspended) FROM cards) AS c, (SELECT MAX(updated) FROM items) AS i",
    )!;
    const version = JSON.stringify([v.a, v.r, v.c, v.i, cfg]);
    const hit = this.rootCache.get(root);
    if (hit?.version === version) return hit.data;
    const scope = "(d.name = ? OR d.name LIKE ? ESCAPE '\\')";
    const sp = [root, root.replace(/[\\%_]/g, "\\$&") + "::%"];
    const defs = new Map<string, CardTypeDef | null>();
    const def = (id: string) => {
      if (!defs.has(id)) {
        try {
          defs.set(id, this.host.type(id));
        } catch {
          defs.set(id, null);
        }
      }
      return defs.get(id)!;
    };
    const cards = new Map<number, RootCard>();
    for (const r of this.host.db.all(
      `SELECT c.id, c.item_id, c.face, c.state, c.stability, c.suspended, i.type, i.tags, i.ord, i.archived FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE ${scope} ORDER BY i.ord, c.id`,
      ...sp,
    )) {
      const tags = parse<string[]>(r.tags, []);
      const skills = [def(r.type)?.skills?.[r.face] ?? "general", ...tags.filter((t) => t.startsWith("skill::")).map((t) => t.slice(7))];
      cards.set(r.id, { id: r.id, itemId: r.item_id, state: r.state, stability: r.stability, active: !r.suspended && !r.archived, tags, skills, level: learn.levelIndex(cfg.levels, tags), band: -1 });
    }
    // Placement bands per skill: levels, or tenths of the deck by position. Only bands with cards count.
    const bands = new Map<string, number[]>();
    const bySkill = new Map<string, RootCard[]>();
    for (const c of cards.values()) if (c.active) (bySkill.get(c.skills[0]) ?? bySkill.set(c.skills[0], []).get(c.skills[0])!).push(c);
    for (const [skill, list] of bySkill) {
      list.forEach((c, rank) => (c.band = learn.bandOf(cfg.levels, c.tags, rank, list.length)));
      bands.set(skill, [...new Set(list.map((c) => c.band).filter((b) => b >= 0))].sort((a, b) => a - b));
    }
    const attempts: RootData["attempts"] = [];
    const seen = new Map<string, number>();
    const scores = new Map<number, { ts: string; score: number }[]>();
    // Probes per placement session (answers from before sessions had names count as one session).
    const sessions = new Map<string, { first: string; probes: Map<string, { band: number; score: number }[]>; reviews: Set<number> }>();
    let maxTs = "";
    for (const r of this.host.db.all(
      `SELECT a.ts, a.card_id, a.grade, a.review_id, rv.rating FROM attempts a JOIN cards c ON c.id = a.card_id JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id LEFT JOIN reviews rv ON rv.id = a.review_id WHERE ${scope} ORDER BY a.ts, a.id`,
      ...sp,
    )) {
      if (r.ts > maxTs) maxTs = r.ts;
      const g = parse<Partial<Grade>>(r.grade, {});
      const card = cards.get(r.card_id);
      const ad = g.adaptive;
      if (ad?.variant) seen.set(`${r.card_id}#${ad.variant}`, (seen.get(`${r.card_id}#${ad.variant}`) ?? 0) + 1);
      // Only rated answers count: burying or suspending a card instead of rating it, or undoing the rating, leaves the answer out.
      if (typeof g.score !== "number" || !card || r.review_id == null) continue;
      (scores.get(r.card_id) ?? scores.set(r.card_id, []).get(r.card_id)!).push({ ts: r.ts, score: g.score });
      // A first showing is encoding, not recall, so it would only pull the skill estimates down; unless
      // the learner rated it Easy: they already knew the word, and that is evidence like any review.
      if (ad?.goal === "teach" && r.rating !== 4) continue;
      attempts.push({ ts: r.ts, a: { cardId: r.card_id, key: ad?.variant ? `${card.itemId}#${ad.variant}` : `card:${r.card_id}`, skills: card.skills, score: g.score, prior: ad?.difficulty } });
      if (ad?.placement) {
        const key = String(ad.placement);
        const sess = sessions.get(key) ?? sessions.set(key, { first: r.ts, probes: new Map(), reviews: new Set() }).get(key)!;
        sess.reviews.add(r.review_id);
        const skill = card.skills[0];
        (sess.probes.get(skill) ?? sess.probes.set(skill, []).get(skill)!).push({ band: bands.get(skill)?.indexOf(card.band) ?? -1, score: g.score });
      }
    }
    const placementOf = (session: string) => {
      const probes = sessions.get(session)?.probes;
      const out = new Map<string, { bands: number[]; state: learn.PlacementState }>();
      for (const [skill, list] of bands) out.set(skill, { bands: list, state: learn.placementState(list.length, probes?.get(skill) ?? []) });
      return out;
    };
    const latest = [...sessions.entries()].sort((a, b) => b[1].first.localeCompare(a[1].first))[0]?.[0];
    const placement: RootData["placement"] = new Map([...placementOf(latest ?? "")].map(([skill, p]) => [skill, { ...p, frontier: p.state.frontier, checks: { done: 0, passed: 0 } }]));
    // Quick checks: first answers since the session began to cards in the bands it passed. Too many
    // wrong in a band revises the frontier down to it.
    const sess = latest ? sessions.get(latest) : undefined;
    if (sess) {
      const checks = new Map<string, Map<number, boolean[]>>();
      for (const r of this.host.db.all<{ id: number; card_id: number; rating: number }>(
        `SELECT r.id, r.card_id, r.rating FROM reviews r JOIN cards c ON c.id = r.card_id JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE ${scope} AND r.state = 0 AND r.practice = 0 AND r.ts >= ? ORDER BY r.ts, r.id`,
        ...sp,
        sess.first,
      )) {
        const c = cards.get(r.card_id);
        const p = c && placement.get(c.skills[0]);
        if (!c || !p || sess.reviews.has(r.id)) continue;
        const band = p.bands.indexOf(c.band);
        if (band < 0 || band >= p.state.frontier) continue;
        const byBand = checks.get(c.skills[0]) ?? checks.set(c.skills[0], new Map()).get(c.skills[0])!;
        (byBand.get(band) ?? byBand.set(band, []).get(band)!).push(r.rating > 1);
        p.checks.done++;
        if (r.rating > 1) p.checks.passed++;
      }
      for (const [skill, p] of placement) p.frontier = learn.revisedFrontier(p.state.frontier, checks.get(skill) ?? new Map());
    }
    // Bands below a placement's frontier were passed; frontier 0 (or no placement) passes nothing.
    const passed = (c: RootCard) => {
      const p = placement.get(c.skills[0]);
      return !!p && p.state.probes > 0 && c.band >= 0 && p.bands.indexOf(c.band) < p.frontier;
    };
    // Known: one of the item's cards graduated to review, or, until one of its cards is rated Again,
    // the latest placement passed its band.
    const failed = new Set(
      this.host.db
        .all<{ item_id: string }>(`SELECT DISTINCT c.item_id FROM reviews r JOIN cards c ON c.id = r.card_id JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE ${scope} AND r.rating = 1`, ...sp)
        .map((r) => r.item_id),
    );
    const known = new Set<string>();
    for (const c of cards.values()) if (c.state === 2) known.add(c.itemId);
    const assumed = new Set<string>();
    for (const c of cards.values()) if (!known.has(c.itemId) && !failed.has(c.itemId) && passed(c)) assumed.add(c.itemId);
    for (const id of assumed) known.add(id);
    let levels: Map<string, learn.LevelState> | null = null;
    if (cfg.levels.length) {
      levels = new Map();
      const isCheck = (c: RootCard, i: number) => {
        const tag = cfg.levels[i].check;
        return !!tag && c.tags.some((t) => t === tag || t.startsWith(tag + "::"));
      };
      for (const skill of bySkill.keys()) {
        const counts = cfg.levels.map(() => ({ total: 0, stable: 0, checks: 0, checksPassed: 0 }));
        for (const c of bySkill.get(skill)!) {
          cfg.levels.forEach((_, i) => {
            if (!isCheck(c, i)) return;
            counts[i].checks++;
            const last = scores.get(c.id)?.at(-1)?.score;
            if (last !== undefined && last >= learn.targetOf(cfg)) counts[i].checksPassed++;
          });
          if (c.level < 0 || isCheck(c, c.level)) continue;
          counts[c.level].total++;
          if (c.state === 2 && c.stability >= learn.KNOWN_STABILITY) counts[c.level].stable++;
        }
        const p = placement.get(skill);
        // Past every band: the highest level that has cards, not the last level of the list.
        const floor = p && p.state.probes > 0 ? (p.bands[p.frontier] ?? p.bands.at(-1) ?? 0) : 0;
        levels.set(skill, learn.levelState(cfg.levels, counts, cfg, floor));
      }
    }
    const data: RootData = { root, cfg, cards, attempts, model: learn.fitSkills(attempts.map((x) => x.a)), maxTs, known, assumed: assumed.size, seen, scores, placement, placementOf, levels, passed };
    this.rootCache.set(root, { version, data });
    return data;
  }

  /** Learner estimates for one showing of a card, as of `asOf`. Null unless the card's deck is adaptive. */
  adaptContext(cardId: number, asOf: string, opts: { placement?: string | boolean } = {}): AdaptContext | null {
    const c = this.host.cardWithDeck(cardId);
    const cfg = this.host.configFor(c.deck);
    if (!cfg.adaptiveChallenge && !cfg.adaptivePace) return null;
    const root = this.adaptiveRoot(c.deck);
    if (!root) return null;
    const A = this.rootData(root);
    const rc = A.cards.get(cardId);
    const skills = rc?.skills ?? ["general"];
    const model = asOf > A.maxTs ? A.model : learn.fitSkills(A.attempts.filter((x) => x.ts < asOf).map((x) => x.a));
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, r3(x)]));
    const R = sched.retrievability(c, new Date(asOf), cfg);
    const quickCheck = !opts.placement && !!rc && rc.state === 0 && A.passed(rc);
    const script = this.host.scriptFor(cfg);
    const goal: learn.LearnerGoal = script && script.ratings === false ? "practice" : c.state === 0 && !opts.placement && !quickCheck ? "teach" : "measure";
    const learner: learn.Learner = {
      asOf,
      goal,
      target: learn.targetOf(A.cfg),
      skill: skills[0],
      ability: round(model.ability),
      success: round(model.success),
      answers: { ...model.answers },
      level: A.levels ? Object.fromEntries(A.levels) : null,
      card: {
        state: (["new", "learning", "review", "relearning"] as const)[c.state] ?? "new",
        reps: c.reps,
        lapses: c.lapses,
        stability: r3(c.stability),
        retrievability: R == null ? null : r3(R),
        scores: (A.scores.get(cardId) ?? []).filter((x) => x.ts < asOf).slice(-5).map((x) => r3(x.score)),
      },
      placement: !!opts.placement,
      quickCheck,
    };
    const session = opts.placement ? placementSession(opts.placement) : undefined;
    return { learner, ...(session ? { session } : {}), challenge: cfg.adaptiveChallenge, itemId: c.item_id, cardId, model, known: A.known, seen: A.seen };
  }

  /**
   * Today's new-card limit for an adaptive root, from the last seven days before today. Only new cards
   * taught count: a card first shown as a placement probe or a quick check was tested, not learned, so
   * neither that showing nor its later reviews say what new cards cost.
   */
  private paceFor(root: string, cfg: PresetConfig): learn.Pace {
    const day = this.host.dayStart(new Date());
    const from = new Date(day.getTime() - 7 * 86400_000).toISOString(), to = day.toISOString();
    const scope = "(d.name = ? OR d.name LIKE ? ESCAPE '\\')";
    const sp = [root, root.replace(/[\\%_]/g, "\\$&") + "::%"];
    const join = "JOIN cards c ON c.id = x.card_id JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id";
    const tested = new Set<number>();
    let news = 0;
    for (const r of this.host.db.all(`SELECT x.card_id, x.ts, a.grade FROM reviews x ${join} LEFT JOIN attempts a ON a.id = x.attempt_id WHERE x.practice = 0 AND x.state = 0 AND ${scope}`, ...sp)) {
      const ad = parse<Partial<Grade>>(r.grade, {}).adaptive;
      if (ad?.placement || ad?.quickCheck) tested.add(r.card_id);
      else if (r.ts >= from && r.ts < to) news++;
    }
    // Reviews of young cards (in review, stability under three weeks): did recently learned cards hold?
    const young = { reviews: 0, passed: 0 };
    for (const r of this.host.db.all(`SELECT x.card_id, x.rating, x.card_before FROM reviews x ${join} WHERE x.practice = 0 AND x.state = 2 AND x.ts >= ? AND x.ts < ? AND ${scope}`, from, to, ...sp)) {
      if (tested.has(r.card_id) || !(parse<{ stability?: number }>(r.card_before, {}).stability! < learn.YOUNG_STABILITY)) continue;
      young.reviews++;
      if (r.rating > 1) young.passed++;
    }
    // Reviews without a recorded duration count as 15 seconds.
    const rv = this.host.db.get(
      `SELECT SUM(COALESCE(x.duration_ms, 15000)) AS ms, COUNT(DISTINCT substr(x.ts, 1, 10)) AS days FROM reviews x ${join} WHERE x.practice = 0 AND x.ts >= ? AND x.ts < ? AND ${scope}`,
      from,
      to,
      ...sp,
    )!;
    return learn.pace(cfg, { activeDays: Number(rv.days ?? 0), young, minutes: Number(rv.ms ?? 0) / 60000, newCards: news });
  }

  /**
   * Today's new cards on an adaptive root: the pace sets newPerDay, cards in bands a placement passed
   * come as quick checks (on top of it, up to quickChecksPerDay), and the level frontier orders the rest.
   * `firsts` are today's first showings across the root; the ones that count toward the new-card limits come back.
   */
  newCards<T extends CardRow, F extends { id: number }>(root: string, cfg: PresetConfig, news: T[], firsts: F[]) {
    const A = this.rootData(root);
    if (cfg.adaptivePace) cfg = { ...cfg, newPerDay: this.paceFor(root, A.cfg).value };
    const passed = (id: number) => {
      const rc = A.cards.get(id);
      return !!rc && A.passed(rc);
    };
    let quick = news.filter((c) => passed(c.id));
    if (quick.length) news = news.filter((c) => !passed(c.id));
    const doneQuick = firsts.filter((r) => passed(r.id)).length;
    quick = quick.slice(0, Math.max(0, cfg.quickChecksPerDay - doneQuick));
    if (A.levels) news = this.levelFrontier(A, news);
    return { cfg, news, quick, firsts: firsts.filter((r) => !passed(r.id)) };
  }

  /** New cards up to the learner's level for each skill, with the next level's mixed in once it opens. Higher ones wait. */
  private levelFrontier<T extends CardRow>(A: RootData, news: T[]): T[] {
    const at = (c: T) => A.cards.get(c.id)?.level ?? -1;
    const main: T[] = [], next: T[] = [];
    for (const c of news) {
      const rc = A.cards.get(c.id);
      const st = rc && A.levels!.get(rc.skills[0]);
      if (!rc || !st || rc.level < 0 || rc.level <= st.index) main.push(c);
      else if (rc.level === st.index + 1 && st.nextOpen) next.push(c);
    }
    main.sort((a, b) => at(a) - at(b));
    const every = A.cfg.levelMix > 0 ? Math.max(1, Math.round(1 / A.cfg.levelMix)) : Infinity;
    const out: T[] = [];
    while (main.length || (next.length && every !== Infinity)) {
      if (next.length && (out.length + 1) % every === 0) out.push(next.shift()!);
      else if (main.length) out.push(main.shift()!);
      else out.push(next.shift()!);
    }
    return out;
  }

  /** The next placement probe: a new card in the band that halves what's left to find, for the skill with the fewest answers. */
  placementPick<T extends CardRow>(root: string | null, rows: T[], dayStart: string, session: string): T | null {
    if (!root) return null;
    const A = this.rootData(root);
    const fresh = rows.filter((c) => c.state === 0 && A.cards.get(c.id)?.active);
    let best: { skill: string; probes: number; band: number } | null = null;
    for (const [skill, p] of A.placementOf(session)) {
      if (p.state.next === null) continue;
      const band = p.bands[p.state.next];
      if (!fresh.some((c) => A.cards.get(c.id)!.skills[0] === skill && A.cards.get(c.id)!.band === band)) continue;
      if (!best || p.state.probes < best.probes) best = { skill, probes: p.state.probes, band };
    }
    if (!best) return null;
    const pool = fresh.filter((c) => A.cards.get(c.id)!.skills[0] === best!.skill && A.cards.get(c.id)!.band === best!.band);
    return pool.sort((a, b) => hashString(dayStart + a.id) - hashString(dayStart + b.id))[0] ?? null;
  }

  /** Skills, levels, placement and today's pace for an adaptive deck. */
  learnerSummary(deck: string) {
    const name = this.host.deckName(deck);
    const root = this.adaptiveRoot(name);
    if (!root) return { deck: name, adaptive: false as const };
    const A = this.rootData(root);
    const c = A.cfg;
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const skills = [...new Set([...[...A.cards.values()].filter((x) => x.active).map((x) => x.skills[0]), ...Object.keys(A.model.answers)])].sort();
    return {
      deck: name,
      adaptive: true as const,
      root,
      settings: { adaptiveChallenge: c.adaptiveChallenge, adaptivePace: c.adaptivePace, targetSuccess: learn.targetOf(c), minutesPerDay: c.minutesPerDay, levels: c.levels },
      skills: skills.map((skill) => {
        const p = A.placement.get(skill);
        const theta = A.model.ability[skill];
        return {
          skill,
          answers: A.model.answers[skill] ?? 0,
          success: A.model.success[skill] == null ? null : r3(A.model.success[skill]),
          ability: theta == null ? null : r3(theta),
          /** Predicted success on a card of middling difficulty. */
          typical: theta == null ? null : r3(learn.sigmoid(theta)),
          level: A.levels?.get(skill) ?? null,
          placement:
            p && p.state.probes > 0
              ? { probes: p.state.probes, done: p.state.next === null, frontier: bandLabel(c, p.bands[p.frontier]), revised: p.frontier < p.state.frontier, checks: p.checks }
              : null,
        };
      }),
      /** Items the learner knows, and how many of those only a placement vouches for. */
      known: { items: A.known.size, assumed: A.assumed },
      pace: c.adaptivePace ? this.paceFor(root, c) : null,
    };
  }
}

/** Marks each variant with the learner's predicted success, how much of it they know, and how often they saw it. */
export function annotateVariants(def: CardTypeDef, fields: Record<string, unknown>, adapt: AdaptContext): Record<string, unknown> {
  const v = def.variants!;
  const list = fields[v.field];
  if (!Array.isArray(list)) return fields;
  const idKey = v.id ?? "id", reqKey = v.requires ?? "requires", diffKey = v.difficulty ?? "difficulty";
  const theta = adapt.model.ability[adapt.learner.skill] ?? 0;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const difficultyOf = (e: any) => adapt.model.difficulty.get(`${adapt.itemId}#${String(e[idKey] ?? "")}`) ?? learn.toLogit(typeof e[diffKey] === "number" ? e[diffKey] : 0.5);
  // The item's usual difficulty: the median of its variants, for showings that measure memory.
  const sorted = list.filter((e) => e && typeof e === "object" && !Array.isArray(e)).map((e) => learn.fromLogit(difficultyOf(e))).sort((a, b) => a - b);
  const median = sorted.length ? (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 : 0.5;
  return {
    ...fields,
    [v.field]: list.map((e) => {
      if (!e || typeof e !== "object" || Array.isArray(e)) return e;
      const id = String(e[idKey] ?? "");
      const req: string[] = Array.isArray(e[reqKey]) ? e[reqKey].map(String) : [];
      const b = difficultyOf(e);
      return {
        ...e,
        _p: r3(learn.sigmoid(theta - b)),
        _known: req.length ? r3(req.filter((x) => adapt.known.has(x)).length / req.length) : 1,
        _seen: adapt.seen.get(`${adapt.cardId}#${id}`) ?? 0,
        _difficulty: r3(learn.fromLogit(b)),
        _offset: r3(learn.fromLogit(b) - median),
      };
    }),
  };
}

/** The prior difficulty of the variant with this id, from the item's fields. */
export function variantPrior(def: CardTypeDef, fields: Record<string, unknown>, id: string): number | undefined {
  const v = def.variants;
  const list = v ? fields[v.field] : undefined;
  if (!v || !Array.isArray(list)) return undefined;
  const e = list.find((x) => x && typeof x === "object" && String(x[v.id ?? "id"]) === id);
  const d = e?.[v.difficulty ?? "difficulty"];
  return typeof d === "number" ? d : undefined;
}

function bandLabel(cfg: PresetConfig, band: number | undefined): string {
  if (band === undefined) return cfg.levels.length ? "beyond the last level" : "the end of the deck";
  return cfg.levels.length ? cfg.levels[band].tag : `${band * 10}% into the deck`;
}
