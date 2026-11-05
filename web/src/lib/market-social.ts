// Likes, dislikes, downloads and comments on Market entries, through the Etude account server.
// Keys: `<kind>/<id>` for free catalog entries, `paid/<listing>` for paid decks.
// Reading is public; voting, commenting, reporting and blocking need a signed-in account.
import { useCallback, useEffect, useState } from "react";
import { etudeFetch } from "./transport";

export interface EntryCounts { likes: number; dislikes: number; downloads: number; comments: number }
export interface EntryStats extends EntryCounts { myVote: -1 | 0 | 1 }
export interface MarketComment { id: string; author: string; authorId: string; body: string; mine: boolean; created: string; edited: string | null }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await etudeFetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : method !== "GET" ? "{}" : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw Object.assign(new Error(typeof data?.error === "string" ? data.error : data?.error?.message ?? "The request failed."), { status: res.status });
  return data as T;
}

const q = (key: string) => `key=${encodeURIComponent(key)}`;
// The cloud nests the author ({ id, name }) and wraps single comments in { comment }; the UI wants them flat.
const flat = (c: any): MarketComment => ({ id: c.id, body: c.body, mine: !!c.mine, created: c.created, edited: c.edited ?? null, author: typeof c.author === "object" ? c.author?.name ?? "" : c.author ?? "", authorId: typeof c.author === "object" ? c.author?.id ?? "" : c.authorId ?? "" });
const one = (r: any) => flat(r?.comment ?? r);
const stats = (r: any): EntryStats => ({ likes: r?.likes ?? 0, dislikes: r?.dislikes ?? 0, downloads: r?.downloads ?? 0, comments: r?.comments ?? 0, myVote: (r?.myVote ?? 0) as -1 | 0 | 1 });
export const social = {
  stats: () => call<{ entries: Record<string, EntryCounts> }>("GET", "/api/account/market/stats"),
  entry: (key: string) => call<any>("GET", `/api/account/market/entry-stats?${q(key)}`).then(stats),
  vote: (key: string, value: -1 | 0 | 1) => call<any>("PUT", "/api/account/market/votes", { key, value }).then(stats),
  /** Newest first; `before` is the cursor the previous page returned. */
  comments: (key: string, before?: string) =>
    call<any>("GET", `/api/account/market/comments?${q(key)}${before ? `&before=${encodeURIComponent(before)}` : ""}`).then((r) => ({ comments: (r.comments ?? []).map(flat), next: (r.next ?? null) as string | null })),
  comment: (key: string, body: string) => call<any>("POST", "/api/account/market/comments", { key, body }).then(one),
  edit: (id: string, body: string) => call<any>("PATCH", `/api/account/market/comments/${encodeURIComponent(id)}`, { body }).then(one),
  remove: (id: string) => call<{ ok: boolean }>("DELETE", `/api/account/market/comments/${encodeURIComponent(id)}`),
  report: (id: string, reason: string) => call<{ ok: boolean }>("POST", `/api/account/market/comments/${encodeURIComponent(id)}/report`, { reason }),
  block: (authorId: string) => call<{ ok: boolean }>("POST", `/api/account/market/blocks/${encodeURIComponent(authorId)}`),
  unblock: (authorId: string) => call<{ ok: boolean }>("DELETE", `/api/account/market/blocks/${encodeURIComponent(authorId)}`),
};

/** Counts for every entry, loaded once per Market visit. Empty (and quiet) when the server is unreachable. */
export function useMarketStats() {
  const [stats, setStats] = useState<Record<string, EntryCounts>>({});
  const load = useCallback(() => social.stats().then((r) => setStats(r.entries ?? {})).catch(() => {}), []);
  useEffect(() => void load(), [load]);
  return { stats, reload: load };
}

/** "1.2k" style, for counts beside a tile. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
}

export function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
