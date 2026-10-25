// Helpers several command groups share: scopes, id resolution, config patches.
import { compile, QueryError } from "../core/query.ts";
import { DEFAULT_PRESET, STATE_NAMES, type PresetConfig } from "../core/model.ts";
import { deckParts, type Etude } from "../core/engine.ts";
import { CliError, type Ctx, type FlagSpec } from "./registry.ts";
import { deepSet, idList, looseValue, splitPair } from "./input.ts";

export const DECK_FLAG: FlagSpec = { name: "deck", type: "string", description: "Limit to this deck and its subdecks.", placeholder: "NAME" };
export const QUERY_FLAG: FlagSpec = { name: "query", type: "string", alias: ["q"], description: "Limit to cards matching a search (see `Search language`).", placeholder: "SEARCH" };
export const SCOPE_FLAGS = [DECK_FLAG, QUERY_FLAG];
export const LIMIT_FLAG: FlagSpec = { name: "limit", type: "number", description: "Maximum rows to return.", default: 100 };
export const OFFSET_FLAG: FlagSpec = { name: "offset", type: "number", description: "Rows to skip (for paging).", default: 0 };

/** Shared by `preset optimize` and `deck optimize`. */
export const OPTIMIZE_FLAGS: FlagSpec[] = [
  { name: "apply", type: "boolean", description: "Save the new weights where the current ones come from, if they fit the history better." },
  { name: "reschedule", type: "boolean", description: "With --apply: replay every card's history in those decks with the new weights." },
];
export const OPTIMIZE_OUTPUT =
  "{ source: { kind: preset|deck, id|name }, decks, cards, reviews, items, current, weights, before: { logLoss, rmse }, after: { logLoss, rmse }, better, applied, rescheduled? }";
export const OPTIMIZE_DESCRIPTION =
  "Trains FSRS-6 on the review history (practice reviews don't count) of every deck that shares these weights, with fsrs-rs, the optimizer Anki uses, and compares how well the current and the new weights predict that history: log loss and RMSE, lower is better. Nothing changes without --apply, and --apply only saves weights that fit better (lower RMSE). Needs at least 400 reviews and the optional package @open-spaced-repetition/binding, which `npm install` adds on supported platforms.";

export async function optimizeCommand(ctx: Ctx, target: { preset: string } | { deck: string }) {
  if (ctx.flags.reschedule && !ctx.flags.apply) throw new CliError("--reschedule only applies with --apply");
  const out = await ctx.e.optimizeWeights(target, { apply: !!ctx.flags.apply && !ctx.dry, reschedule: !!ctx.flags.reschedule });
  return ctx.dry ? { dryRun: true, ...out } : out;
}

export const scopeOf = (f: Record<string, any>) => ({ deck: f.deck || undefined, query: f.query || undefined, ahead: f.ahead || undefined });

/** `--deck` and `--query` folded into one search string. */
export function queryOf(f: Record<string, any>): string | undefined {
  const parts: string[] = [];
  if (f.deck) parts.push(`deck:"${String(f.deck).replace(/"/g, "")}"`);
  if (f.query) parts.push(`(${f.query})`);
  return parts.length ? parts.join(" ") : undefined;
}

function compiled(q: string) {
  try {
    return compile(q);
  } catch (e) {
    if (e instanceof QueryError) throw new CliError(`search: ${e.message}`, "validation");
    throw e;
  }
}

const FROM = "FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id";

export function cardsMatching(e: Etude, q: string): number[] {
  const c = compiled(q);
  return e.db.all(`SELECT c.id ${FROM} WHERE ${c.where} ORDER BY i.ord, c.id`, ...c.params).map((r) => r.id as number);
}

export function itemsMatching(e: Etude, q: string): string[] {
  const c = compiled(q);
  return e.db.all(`SELECT i.id, MIN(i.ord) AS o ${FROM} WHERE ${c.where} GROUP BY i.id ORDER BY o`, ...c.params).map((r) => r.id as string);
}

/** Item ids from arguments (with `-` for stdin lines) and/or `--query`/`--deck`. */
export function resolveItems(ctx: Ctx, refs: string[] | undefined, opts: { archived?: "only" | "include" } = {}): string[] {
  const ids = idList(ctx, refs);
  let q = queryOf(ctx.flags);
  if (!ids.length && !q) throw new CliError("give item ids (or - to read them from stdin), or --query / --deck");
  if (q && opts.archived === "only") q = `(${q}) is:archived`;
  if (q && opts.archived === "include") q = `(${q}) (is:archived OR -is:archived)`;
  const out = new Set<string>();
  if (ids.length) {
    const missing = ids.filter((id) => !ctx.e.db.get("SELECT 1 FROM items WHERE id = ?", id));
    if (missing.length) throw new CliError(`unknown item${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`, "not_found");
    ids.forEach((id) => out.add(id));
  }
  if (q) itemsMatching(ctx.e, q).forEach((id) => out.add(id));
  return [...out];
}

/** Card ids from refs (a number is a card id, anything else an item id meaning all its cards) and/or a search. */
export function resolveCards(ctx: Ctx, refs: string[] | undefined): number[] {
  const list = idList(ctx, refs);
  const q = queryOf(ctx.flags);
  if (!list.length && !q) throw new CliError("give card ids or item ids (or - to read them from stdin), or --query / --deck");
  const out = new Set<number>();
  const missing: string[] = [];
  for (const r of list) {
    if (/^\d+$/.test(r)) {
      if (ctx.e.db.get("SELECT 1 FROM cards WHERE id = ?", Number(r))) out.add(Number(r));
      else missing.push(`card ${r}`);
    } else {
      const rows = ctx.e.db.all("SELECT id FROM cards WHERE item_id = ?" + (ctx.flags.face ? " AND face = ?" : "") + " ORDER BY id", r, ...(ctx.flags.face ? [ctx.flags.face] : []));
      if (!rows.length) missing.push(ctx.e.db.get("SELECT 1 FROM items WHERE id = ?", r) ? `item ${r} (no card with face ${ctx.flags.face})` : `item ${r}`);
      rows.forEach((x) => out.add(x.id));
    }
  }
  if (missing.length) throw new CliError(`unknown ${missing.join(", ")}`, "not_found");
  if (q) cardsMatching(ctx.e, q).forEach((id) => out.add(id));
  return [...out];
}

/** One card id from a ref; an item id works when the item has a single card (or with --face). */
export function oneCard(ctx: Ctx, ref: string): number {
  if (/^\d+$/.test(ref)) {
    if (!ctx.e.db.get("SELECT 1 FROM cards WHERE id = ?", Number(ref))) throw new CliError(`unknown card ${ref}`, "not_found");
    return Number(ref);
  }
  const rows = ctx.e.db.all("SELECT id, face FROM cards WHERE item_id = ?" + (ctx.flags.face ? " AND face = ?" : "") + " ORDER BY id", ref, ...(ctx.flags.face ? [ctx.flags.face] : []));
  if (!rows.length) throw new CliError(`unknown item ${ref}`, "not_found");
  if (rows.length > 1) throw new CliError(`item ${ref} has ${rows.length} cards (${rows.map((r) => `${r.id}:${r.face}`).join(", ")}); give a card id or --face`);
  return rows[0].id;
}

export const FACE_FLAG: FlagSpec = { name: "face", type: "string", description: "With item ids: only the card for this face." };

// ------------------------------------------------------------- config

export const CONFIG_KEYS = Object.keys({ ...DEFAULT_PRESET, weights: null }) as (keyof PresetConfig)[];
export const RESCHEDULE_KEYS: (keyof PresetConfig)[] = ["desiredRetention", "learningSteps", "relearningSteps", "maximumInterval", "weights", "deadline", "deadlineMargin"];

function configValue(key: string, raw: string): unknown {
  const v = looseValue(raw);
  if ((key === "learningSteps" || key === "relearningSteps") && typeof v === "string") return v.split(/[\s,]+/).filter(Boolean);
  if (key === "deadline") {
    if (v === null || raw.trim() === "" || /^(none|null)$/i.test(raw.trim())) return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new CliError(`deadline: bad date "${raw}"`, "validation");
    return d.toISOString();
  }
  if (key === "weights" && (v === null || /^(none|null|default)$/i.test(raw.trim()))) return null;
  return v;
}

/**
 * Applies `key=value` pairs to a config layer. `autoRate.good=0.9` fills the rest of autoRate from
 * `base` (what applies without this layer), because a layer replaces the whole object.
 */
export function applyConfigPairs(layer: Partial<PresetConfig>, pairs: string[], base: PresetConfig): Partial<PresetConfig> {
  const next: Record<string, any> = structuredClone(layer);
  for (const p of pairs) {
    const [key, raw] = splitPair(p, "key=value");
    const top = key.split(".")[0];
    if (!CONFIG_KEYS.includes(top as keyof PresetConfig)) throw new CliError(`unknown setting "${top}". Settings: ${CONFIG_KEYS.join(", ")}`, "validation");
    if (key.includes(".")) {
      if (top !== "autoRate") throw new CliError(`"${top}" has no sub-keys`, "validation");
      next.autoRate = { ...base.autoRate, ...(next.autoRate ?? {}) };
      deepSet(next, key, looseValue(raw));
    } else next[key] = configValue(key, raw);
  }
  return next;
}

export function unsetConfigKeys(layer: Partial<PresetConfig>, keys: string[]): { config: Partial<PresetConfig>; removed: string[] } {
  const next: Record<string, any> = structuredClone(layer);
  const removed: string[] = [];
  for (const k of keys) {
    if (!CONFIG_KEYS.includes(k as keyof PresetConfig)) throw new CliError(`unknown setting "${k}". Settings: ${CONFIG_KEYS.join(", ")}`, "validation");
    if (k in next) {
      delete next[k];
      removed.push(k);
    }
  }
  return { config: next, removed };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function diffConfig(before: PresetConfig, after: PresetConfig) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of CONFIG_KEYS) if (!same(before[k], after[k])) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  return out;
}

export const needsReschedule = (changed: Record<string, unknown>) => Object.keys(changed).some((k) => RESCHEDULE_KEYS.includes(k as keyof PresetConfig));

/** Where each effective setting of a deck comes from, like the Options tab shows it. */
export function configSources(e: Etude, deckName: string) {
  const parts = deckParts(deckName);
  const presets = new Map(e.listPresets().map((p) => [p.id, p]));
  const sources: Record<string, { kind: "default" | "parent-preset" | "parent" | "preset" | "deck"; deck?: string; preset?: string }> = {};
  for (const k of CONFIG_KEYS) {
    let s: (typeof sources)[string] = { kind: "default" };
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join("::");
      let d;
      try {
        d = e.deck(name);
      } catch {
        continue;
      }
      const own = i === parts.length;
      const p = d.presetId ? presets.get(d.presetId) : undefined;
      if (p && p.config[k] !== undefined) s = own ? { kind: "preset", preset: p.id } : { kind: "parent-preset", deck: name, preset: p.id };
      if (d.config[k] !== undefined) s = own ? { kind: "deck", deck: name } : { kind: "parent", deck: name };
    }
    sources[k] = s;
  }
  return sources;
}

// ------------------------------------------------------------- items

export function itemBrief(e: Etude, id: string) {
  const r = e.db.get("SELECT i.*, d.name AS deck FROM items i JOIN decks d ON d.id = i.deck_id WHERE i.id = ?", id);
  if (!r) throw new CliError(`unknown item ${id}`, "not_found");
  const fields = JSON.parse(r.fields);
  return {
    id: r.id,
    type: r.type,
    deck: r.deck,
    tags: JSON.parse(r.tags) as string[],
    title: e.titleOf(r.type, fields),
    archived: !!r.archived,
    generated: typeof fields.generator === "string",
    cards: e.db.all("SELECT id, face, state, due, suspended FROM cards WHERE item_id = ? ORDER BY id", id).map((c) => ({ cardId: c.id, face: c.face, state: STATE_NAMES[c.state], due: c.due, suspended: !!c.suspended })),
  };
}

export const stateName = (s: number) => STATE_NAMES[s] ?? String(s);
