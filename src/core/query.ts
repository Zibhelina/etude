// Search language, compiled to SQL over `cards c JOIN items i JOIN decks d`.
//
//   deck:"Networks"       the deck and everything below it      (deck:net* wildcards)
//   tag:net::w1           the tag and every tag below it        (tag:exam::* wildcards)
//   type:numeric  id:net.w1.*  source:ch1
//   is:new is:learning is:review is:relearning is:due is:suspended is:buried is:archived
//   prop:lapses>=2  prop:reps=0  prop:stability<3  prop:difficulty>7  prop:due<=1 (days from now)
//   rated:1  rated:7:1    reviewed in the last N days (optionally with that rating)
//   word  "a phrase"      text anywhere in the item's fields
//   -term  a OR b  (grouping)   implicit AND between terms
import type { SQLInputValue } from "node:sqlite";

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
}

export function compile(query: string, now = new Date()): Compiled {
  const tokens = tokenize(query ?? "");
  const params: SQLInputValue[] = [];
  let pos = 0;
  let mentionsArchived = false;

  const term = (text: string): string => {
    const m = /^([a-z]+):(.*)$/i.exec(text);
    if (!m) {
      params.push(`%${like(text)}%`, `%${like(text)}%`);
      return "(i.fields LIKE ? ESCAPE '\\' OR i.id LIKE ? ESCAPE '\\')";
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
      default:
        throw new QueryError(`unknown search key "${key}:"`);
    }
  };

  // expr := and (OR and)* ; and := unit+ ; unit := term | (expr)
  const unit = (): string | null => {
    const t = tokens[pos];
    if (!t) return null;
    if (t.kind === "term") { pos++; const s = term(t.text); return t.neg ? `NOT ${s}` : s; }
    if (t.kind === "open") {
      pos++;
      const inner = expr();
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
  return { where, params };
}
