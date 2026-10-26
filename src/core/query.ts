// Search language, compiled to SQL over `cards c JOIN items i JOIN decks d`.
//
//   deck:"Networks"       the deck and everything below it      (deck:net* wildcards)
//   tag:net::w1           the tag and every tag below it        (tag:exam::* wildcards)
//   type:numeric  id:net.w1.*  source:ch1
//   is:new is:learning is:review is:relearning is:due is:suspended is:buried is:archived
//   is:leftover           cards on faces their type no longer makes (see Etude.leftoverCards)
//   prop:lapses>=2  prop:reps=0  prop:stability<3  prop:difficulty>7  prop:due<=1 (days from now)
//   rated:1  rated:7:1    reviewed in the last N days (optionally with that rating)
//   word  "a phrase"      text in any of the item's fields, ignoring case (not markup or media file names)
//   front:word  prompt:   text in one field (by name); an empty value finds items where it's empty
//   -term  a OR b  (grouping)   implicit AND between terms
//
// Free text runs against `items.search`, which `itemSearchText` derives from the fields when an item is saved.
// With free text, the "relevance" order puts items whose title is the word, then starts with it, first.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export class QueryError extends Error {}

type Token = { kind: "term"; text: string; neg: boolean } | { kind: "or" } | { kind: "open"; neg: boolean } | { kind: "close" };

function tokenize(q: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (/\s/.test(ch)) { i++; continue; }
    let neg = false;
    if (ch === "-" && i + 1 < q.length && !/\s/.test(q[i + 1])) { neg = true; i++; }
    if (q[i] === "(") { out.push({ kind: "open", neg }); i++; continue; }
    if (q[i] === ")") { out.push({ kind: "close" }); i++; continue; }
    let text = "";
    while (i < q.length && !/[\s()]/.test(q[i])) {
      if (q[i] === '"') {
        const end = q.indexOf('"', i + 1);
        if (end === -1) throw new QueryError("unclosed quote");
        text += q.slice(i + 1, end);
        i = end + 1;
      } else text += q[i++];
    }
    if (!neg && (text === "OR" || text === "or")) out.push({ kind: "or" });
    else if (text) out.push({ kind: "term", text, neg });
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const entity = (m: string, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m;

/** Text without HTML: real tags dropped (block tags become spaces; a bare < or > is text), entities decoded. */
export function stripHtml(text: string): string {
  return text
    .replace(/<\/?(?:br|div|p|li|tr|td|th|h\d)\b[^<>]*>/gi, " ")
    .replace(/<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>/g, "")
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, entity);
}

/** Search compares folded text on both sides, so case is ignored in every script (SQLite's LIKE only folds ASCII). */
export const fold = (s: string) => s.normalize("NFC").toLowerCase();

const SOUND = /\[sound:[^\]]*\]/gi;
const MEDIA_PATH = /^\S+\.(?:mp3|wav|ogg|oga|opus|m4a|aac|flac|webm|mp4|m4v|mov|png|jpe?g|gif|webp|avif|svg|bmp)(?:[?#]\S*)?$/i;
/** A value that only points at a recording, picture or video (a path, a URL, Anki's [sound:...]), with no text to show or search. */
export function isMediaRef(s: string): boolean {
  const t = s.replace(SOUND, " ").trim();
  return t ? MEDIA_PATH.test(t) : s.trim() !== "";
}

/** What search matches in one field value: its text, folded, one line per string, without markup or media references. */
export function searchText(value: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const t = stripHtml(v).replace(SOUND, " ").replace(/\s+/g, " ").trim();
      if (t && !isMediaRef(t)) out.push(fold(t));
    } else if (typeof v === "number") out.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return out.join("\n");
}

/** The stored search text of an item: every field's values, never their names. */
export const itemSearchText = (fields: Record<string, unknown>) => searchText(Object.values(fields));

/** The SQL functions compiled searches call. Every connection to a collection registers them. */
export function registerSearchFunctions(db: DatabaseSync) {
  db.function("etude_fold", { deterministic: true }, (s) => (s == null ? null : fold(String(s))));
  // A field's value as JSON (`fields -> '$."name"'`), turned into the same text free-text search sees.
  db.function("etude_search_text", { deterministic: true }, (j) => (j == null ? null : searchText(JSON.parse(String(j)))));
}

const like = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c).replace(/\*/g, "%");
const PROPS: Record<string, string> = {
  reps: "c.reps",
  lapses: "c.lapses",
  stability: "c.stability",
  difficulty: "c.difficulty",
  state: "c.state",
};

export interface Compiled {
  where: string;
  params: SQLInputValue[];
  /** With free text: the ORDER BY terms of the "relevance" order (best first), and their params. */
  rank: { sql: string; params: SQLInputValue[] } | null;
}

/** What compiling needs from the collection. */
export interface SearchLookup {
  /** The field names (across all types) a `key:` term can search, matched without case. A key that is neither built in nor a field is an error. */
  fieldNames?(key: string): string[];
  /** Ids of the cards `is:leftover` finds. */
  leftoverCards?(): number[];
}

export function compile(query: string, now = new Date(), lookup: SearchLookup = {}): Compiled {
  const tokens = tokenize(query ?? "");
  const params: SQLInputValue[] = [];
  let pos = 0;
  let mentionsArchived = false;
  // Free-text words that aren't negated: what relevance ranks by.
  const words: string[] = [];
  let negated = 0;

  const term = (text: string, neg: boolean): string => {
    const m = /^([A-Za-z_]\w*):(.*)$/.exec(text);
    if (!m) {
      if (!neg && !negated) words.push(text);
      params.push(`%${like(fold(text))}%`, `%${like(text)}%`);
      return "(i.search LIKE ? ESCAPE '\\' OR i.id LIKE ? ESCAPE '\\')";
    }
    const key = m[1].toLowerCase();
    const val = m[2];
    switch (key) {
      case "deck": {
        if (val.includes("*")) { params.push(like(val), like(val) + "::%"); return "(d.name LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\')"; }
        params.push(val, like(val) + "::%");
        return "(d.name = ? COLLATE NOCASE OR d.name LIKE ? ESCAPE '\\')";
      }
      case "tag": {
        params.push(like(val), like(val) + "::%");
        return "EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND (t.tag LIKE ? ESCAPE '\\' OR t.tag LIKE ? ESCAPE '\\'))";
      }
      case "type": params.push(val); return "i.type = ?";
      case "id": params.push(like(val)); return "i.id LIKE ? ESCAPE '\\'";
      case "source": params.push(`%${like(val)}%`); return "i.source LIKE ? ESCAPE '\\'";
      case "face": params.push(val); return "c.face = ?";
      case "is": {
        const iso = now.toISOString();
        switch (val.toLowerCase()) {
          case "new": return "c.state = 0";
          case "learning": return "c.state IN (1, 3)";
          case "learn": return "c.state IN (1, 3)";
          case "review": return "c.state = 2";
          case "relearning": return "c.state = 3";
          case "due": params.push(iso); return "(c.state != 0 AND c.due <= ?)";
          case "suspended": return "c.suspended = 1";
          case "buried": params.push(iso); return "(c.buried_until IS NOT NULL AND c.buried_until > ?)";
          case "archived": mentionsArchived = true; return "i.archived = 1";
          case "leftover": {
            if (!lookup.leftoverCards) throw new QueryError("is:leftover needs a collection");
            params.push(JSON.stringify(lookup.leftoverCards()));
            return "c.id IN (SELECT value FROM json_each(?))";
          }
          default: throw new QueryError(`unknown is:${val}`);
        }
      }
      case "prop": {
        const p = /^([a-z]+)(<=|>=|!=|=|<|>)(-?\d+(?:\.\d+)?)$/i.exec(val);
        if (!p) throw new QueryError(`bad prop:${val}`);
        const [, name, op, num] = p;
        if (name === "due") {
          params.push(new Date(now.getTime() + Number(num) * 86400_000).toISOString());
          return `(c.state != 0 AND c.due ${op === "=" ? "<=" : op} ?)`;
        }
        const col = PROPS[name.toLowerCase()];
        if (!col) throw new QueryError(`unknown prop ${name}`);
        params.push(Number(num));
        return `${col} ${op} ?`;
      }
      case "rated": {
        const [days, rating] = val.split(":");
        const n = Number(days);
        if (!Number.isFinite(n) || n <= 0) throw new QueryError(`bad rated:${val}`);
        params.push(new Date(now.getTime() - n * 86400_000).toISOString());
        let extra = "";
        if (rating) { params.push(Number(rating)); extra = " AND r.rating = ?"; }
        return `EXISTS (SELECT 1 FROM reviews r WHERE r.card_id = c.id AND r.ts >= ?${extra})`;
      }
      default: {
        const names = lookup.fieldNames?.(m[1]) ?? [];
        if (!names.length) throw new QueryError(`unknown search key "${key}:"`);
        const value = (name: string) => {
          params.push(`$."${name}"`);
          return "COALESCE(etude_search_text(i.fields -> ?), '')";
        };
        if (!val) return `(${names.map((n) => `${value(n)} = ''`).join(" AND ")})`;
        return `(${names.map((n) => { const v = value(n); params.push(`%${like(fold(val))}%`); return `${v} LIKE ? ESCAPE '\\'`; }).join(" OR ")})`;
      }
    }
  };

  // expr := and (OR and)* ; and := unit+ ; unit := term | (expr)
  const unit = (): string | null => {
    const t = tokens[pos];
    if (!t) return null;
    if (t.kind === "term") { pos++; const s = term(t.text, t.neg); return t.neg ? `NOT ${s}` : s; }
    if (t.kind === "open") {
      pos++;
      if (t.neg) negated++;
      const inner = expr();
      if (t.neg) negated--;
      if (tokens[pos]?.kind !== "close") throw new QueryError("missing )");
      pos++;
      return t.neg ? `NOT (${inner})` : `(${inner})`;
    }
    return null;
  };
  const and = (): string => {
    const parts: string[] = [];
    for (let u = unit(); u; u = unit()) parts.push(u);
    if (!parts.length) throw new QueryError("expected a search term");
    return parts.length === 1 ? parts[0] : parts.join(" AND ");
  };
  const expr = (): string => {
    const parts = [and()];
    while (tokens[pos]?.kind === "or") { pos++; parts.push(and()); }
    return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
  };

  let where = tokens.length ? expr() : "1";
  if (pos < tokens.length) throw new QueryError("unexpected )");
  if (!mentionsArchived) where = `(${where}) AND i.archived = 0`;
  return { where, params, rank: rank(words) };
}

/**
 * Per word: 0 the title is the word, 1 starts with it, 2 has a word starting with it, 3 contains it, 4 only
 * another field does. Among titles with a word in them, ties go to the shorter title, the closer match.
 */
function rank(words: string[]): Compiled["rank"] {
  if (!words.length) return null;
  const title = "etude_fold(i.title)";
  const patterns = words.map((w) => like(fold(w)));
  const score = words.map(() => `CASE WHEN ${title} LIKE ? ESCAPE '\\' THEN 0 WHEN ${title} LIKE ? ESCAPE '\\' THEN 1 WHEN ${title} LIKE ? ESCAPE '\\' THEN 2 WHEN ${title} LIKE ? ESCAPE '\\' THEN 3 ELSE 4 END`).join(" + ");
  const inTitle = words.map(() => `${title} LIKE ? ESCAPE '\\'`).join(" OR ");
  return {
    sql: `${score}, CASE WHEN ${inTitle} THEN length(i.title) ELSE 0 END`,
    params: [...patterns.flatMap((p) => [p, `${p}%`, `% ${p}%`, `%${p}%`]), ...patterns.map((p) => `%${p}%`)],
  };
}
