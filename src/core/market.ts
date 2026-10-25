// The market: themes, decks and card types people share. It's a public GitHub repository (or any
// folder or URL with the same layout): one JSON file per entry under entries/, plus an index.json
// that CI regenerates. Reading needs no account; publishing opens a pull request with `gh`.
//
//   index.json                         { etude: "market/1", generated, repo, entries: [IndexEntry] }
//   entries/themes/<id>.json           { etudeMarket: 1, kind: "theme", id, name, ..., content: Theme }
//   entries/decks/<id>.json            { ..., kind: "deck", content: pack/1 }
//   entries/types/<id>.json            { ..., kind: "type", content: pack/1 with types (+ example items) }
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { EtudeError, plainLabel, type Etude } from "./engine.ts";
import { BUILTIN_THEMES, THEME_ID, ThemeError, freeThemeId, normalizeTheme, type Theme } from "./themes.ts";
import { validateType } from "./types.ts";

export const MARKET_REPO = "Zibhelina/etude-market";
export const DEFAULT_MARKET = { url: `https://raw.githubusercontent.com/${MARKET_REPO}/main`, repo: MARKET_REPO };
export const MARKET_KINDS = ["theme", "deck", "type"] as const;
export type MarketKind = (typeof MARKET_KINDS)[number];
/** Largest entry file the app will download or publish. */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const ENTRY_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

export interface MarketSettings {
  /** Where the index and entries are read from: a URL or a local folder. */
  url: string;
  /** GitHub repository pull requests go to. */
  repo: string;
}

export interface MarketMeta {
  id: string;
  kind: MarketKind;
  name: string;
  description: string;
  author: string;
  tags: string[];
  version: string;
  updated: string;
}

export interface MarketFile extends MarketMeta {
  etudeMarket: 1;
  content: any;
}

export type MarketSummary =
  | { theme: Theme }
  | { decks: string[]; items: number; cardTypes: Record<string, number>; types: { id: string; name: string }[]; watch: boolean; samples: string[] }
  | { types: { id: string; name: string; description: string; grader: string; fields: string[] }[]; items: number; samples: string[] };

/** A one-line label for an item, from its first text-like field. */
function sampleOf(item: any): string {
  const f = item?.fields ?? {};
  for (const k of ["prompt", "front", "question", "note", "text", "letter", "title"]) if (typeof f[k] === "string" && f[k].trim()) return plainLabel(f[k]).slice(0, 90);
  const first = Object.values(f).find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return first ? plainLabel(first).slice(0, 90) : "";
}
const samplesOf = (items: any[]) => [...new Set(items.map(sampleOf).filter(Boolean))].slice(0, 3);

export interface IndexEntry extends MarketMeta {
  path: string;
  bytes: number;
  /** Optional picture of the entry in use, `covers/<kind>s/<id>.<webp|png|jpg>`. */
  cover?: string;
  summary: MarketSummary;
}

export interface MarketIndex {
  etude: "market/1";
  generated: string;
  repo: string;
  entries: IndexEntry[];
}

export class MarketError extends EtudeError {}

export const entryPath = (kind: MarketKind, id: string) => `entries/${kind}s/${id}.json`;

const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

const isRemote = (url: string) => /^https?:\/\//i.test(url);
const localDir = (url: string) => resolve(url.replace(/^file:\/\//, ""));

/**
 * raw.githubusercontent.com caches a branch for five minutes, whatever the query string. For a
 * refresh, ask the GitHub API which commit the branch is on and read that commit instead.
 */
async function pinnedUrl(url: string): Promise<string> {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/([\w./-]+?)\/?$/.exec(url);
  if (!m) return url;
  try {
    const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/commits/${m[3]}`, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/vnd.github.sha" } });
    const sha = res.ok ? (await res.text()).trim() : "";
    return /^[0-9a-f]{40}$/.test(sha) ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${sha}` : url;
  } catch {
    return url;
  }
}

/** Reads one file of the market, from a URL or a folder. */
async function readMarketFile(url: string, path: string, opts: { fresh?: boolean } = {}): Promise<{ text: string; bytes: number }> {
  if (!isRemote(url)) {
    const p = join(localDir(url), path);
    if (!existsSync(p)) throw new MarketError(`the market has no ${path}`, 404);
    const buf = readFileSync(p);
    if (buf.length > MAX_ENTRY_BYTES) throw new MarketError(`${path} is larger than ${MAX_ENTRY_BYTES} bytes`);
    return { text: buf.toString("utf8"), bytes: buf.length };
  }
  const full = `${(opts.fresh ? await pinnedUrl(url) : url).replace(/\/+$/, "")}/${path}`;
  let res: Response;
  try {
    res = await fetch(full, { signal: AbortSignal.timeout(20_000), headers: { Accept: "application/json, text/plain" } });
  } catch (e) {
    throw new MarketError(`couldn't reach the market (${(e as Error).message})`, 502);
  }
  if (res.status === 404) throw new MarketError(`the market has no ${path}`, 404);
  if (!res.ok) throw new MarketError(`the market answered ${res.status} for ${path}`, 502);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ENTRY_BYTES) throw new MarketError(`${path} is larger than ${MAX_ENTRY_BYTES} bytes`);
  return { text: buf.toString("utf8"), bytes: buf.length };
}

function parseJson(text: string, what: string): any {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new MarketError(`${what} isn't valid JSON: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------ validation

/** Problems with an entry file's shape and content (empty when it's fine). Doesn't touch a database. */
export function checkEntry(file: any): string[] {
  const errors: string[] = [];
  if (!file || typeof file !== "object" || Array.isArray(file)) return ["an entry must be a JSON object"];
  if (file.etudeMarket !== 1) errors.push('expected "etudeMarket": 1');
  if (!MARKET_KINDS.includes(file.kind)) errors.push(`kind must be one of ${MARKET_KINDS.join(", ")}`);
  if (typeof file.id !== "string" || !ENTRY_ID.test(file.id)) errors.push("id must be a lowercase slug (a-z, 0-9, -), 2 to 64 characters");
  if (typeof file.name !== "string" || !file.name.trim()) errors.push("name is required");
  else if (file.name.length > 80) errors.push("name is longer than 80 characters");
  if (file.description !== undefined && typeof file.description !== "string") errors.push("description must be text");
  if (typeof file.description === "string" && file.description.length > 2000) errors.push("description is longer than 2000 characters");
  if (typeof file.author !== "string" || !file.author.trim()) errors.push("author is required");
  if (file.tags !== undefined && (!Array.isArray(file.tags) || file.tags.some((t: unknown) => typeof t !== "string" || t.length > 32) || file.tags.length > 12)) errors.push("tags must be a list of at most 12 short words");
  if (file.version !== undefined && typeof file.version !== "string") errors.push("version must be text");
  const c = file.content;
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    errors.push("content is required");
    return errors;
  }
  if (file.kind === "theme") {
    try {
      const { removed } = normalizeTheme(c);
      if (removed.length) errors.push(`theme CSS has remote references that would be removed: ${removed.join(", ")}`);
    } catch (e) {
      errors.push(`theme: ${e instanceof ThemeError ? e.message : String(e)}`);
    }
    if (BUILTIN_THEMES.some((t) => t.id === c.id)) errors.push(`theme id "${c.id}" is a built-in theme; pick another`);
  } else if (file.kind === "deck" || file.kind === "type") {
    if (c.etude !== "pack/1") errors.push('content must be an Etude pack ("etude": "pack/1")');
    if (!Array.isArray(c.items ?? [])) errors.push("content.items must be a list");
    if (!Array.isArray(c.types ?? [])) errors.push("content.types must be a list");
    for (const t of c.types ?? []) {
      const te = validateType(t);
      if (te.length) errors.push(`type ${t?.id ?? "?"}: ${te.join("; ")}`);
    }
    if (file.kind === "deck" && !(c.items ?? []).length) errors.push("a deck needs at least one item");
    if (file.kind === "type" && !(c.types ?? []).length) errors.push("a card type entry needs at least one type in content.types");
  }
  return errors;
}

export function metaOf(file: MarketFile): MarketMeta {
  return {
    id: file.id,
    kind: file.kind,
    name: file.name.trim(),
    description: (file.description ?? "").trim(),
    author: file.author.trim(),
    tags: (file.tags ?? []).map((t) => t.trim()).filter(Boolean),
    version: file.version || "1",
    updated: file.updated || "",
  };
}

/** What the index says about an entry, so the app can show it without downloading it. */
export function summarize(file: MarketFile): MarketSummary {
  const c = file.content;
  if (file.kind === "theme") return { theme: normalizeTheme(c).theme };
  const items: any[] = c.items ?? [];
  const types: any[] = c.types ?? [];
  if (file.kind === "type") {
    return {
      types: types.map((t) => ({ id: t.id, name: t.name, description: t.description ?? "", grader: t.grader?.kind ?? "self", fields: (t.fields ?? []).map((f: any) => f.name) })),
      items: items.length,
      samples: samplesOf(items),
    };
  }
  const cardTypes: Record<string, number> = {};
  for (const it of items) cardTypes[it.type] = (cardTypes[it.type] ?? 0) + 1;
  const decks = [...new Set([...(c.decks ?? []).map((d: any) => d.name), ...items.map((i) => i.deck)])].filter(Boolean).sort();
  const watch = (c.presets ?? []).some((p: any) => p?.config?.mode === "watch") || (c.decks ?? []).some((d: any) => d?.config?.mode === "watch");
  return { decks, items: items.length, cardTypes, types: types.map((t) => ({ id: t.id, name: t.name })), watch, samples: samplesOf(items) };
}

// ------------------------------------------------------------------ reading

export function marketSettings(e: Etude): MarketSettings {
  const s = (e.settings() as any).market ?? {};
  return { url: s.url || DEFAULT_MARKET.url, repo: s.repo || DEFAULT_MARKET.repo };
}

const indexCache = new Map<string, { at: number; index: MarketIndex }>();

const COVER_EXT = ["webp", "png", "jpg"] as const;
export const MAX_COVER_BYTES = 600 * 1024;
const COVER_TYPE: Record<string, string> = { webp: "image/webp", png: "image/png", jpg: "image/jpeg" };

/** An entry's cover image, as bytes and a content type. */
export async function fetchCover(url: string, cover: string): Promise<{ body: Buffer; type: string }> {
  const m = /^covers\/(themes|decks|types)\/[a-z0-9-]+\.(webp|png|jpg)$/.exec(cover);
  if (!m) throw new MarketError(`unexpected cover path ${cover}`);
  let body: Buffer;
  if (!isRemote(url)) {
    const p = join(localDir(url), cover);
    if (!existsSync(p)) throw new MarketError(`the market has no ${cover}`, 404);
    body = readFileSync(p);
  } else {
    const res = await fetch(`${url.replace(/\/+$/, "")}/${cover}`, { signal: AbortSignal.timeout(20_000) }).catch((e) => {
      throw new MarketError(`couldn't reach the market (${(e as Error).message})`, 502);
    });
    if (!res.ok) throw new MarketError(`the market answered ${res.status} for ${cover}`, res.status === 404 ? 404 : 502);
    body = Buffer.from(await res.arrayBuffer());
  }
  if (body.length > MAX_COVER_BYTES) throw new MarketError(`${cover} is larger than ${MAX_COVER_BYTES} bytes`);
  return { body, type: COVER_TYPE[m[2]] };
}

export async function fetchIndex(url: string, opts: { refresh?: boolean } = {}): Promise<MarketIndex> {
  const hit = indexCache.get(url);
  if (hit && !opts.refresh && Date.now() - hit.at < 60_000) return hit.index;
  const { text } = await readMarketFile(url, "index.json", { fresh: opts.refresh });
  const index = parseJson(text, "index.json");
  if (index?.etude !== "market/1" || !Array.isArray(index.entries)) throw new MarketError("index.json isn't an Etude market index");
  indexCache.set(url, { at: Date.now(), index });
  return index;
}

export async function fetchEntry(url: string, entry: Pick<IndexEntry, "kind" | "id" | "path">): Promise<MarketFile> {
  const path = entry.path || entryPath(entry.kind, entry.id);
  if (!/^entries\/(themes|decks|types)\/[a-z0-9-]+\.json$/.test(path)) throw new MarketError(`unexpected entry path ${path}`);
  const { text } = await readMarketFile(url, path);
  const file = parseJson(text, path);
  const errors = checkEntry(file);
  if (errors.length) throw new MarketError(`${path} is invalid: ${errors.join("; ")}`);
  if (file.id !== entry.id || file.kind !== entry.kind) throw new MarketError(`${path} says it is ${file.kind} "${file.id}", the index says ${entry.kind} "${entry.id}"`);
  return file as MarketFile;
}

// ------------------------------------------------------------------ installed state

export interface InstalledEntry {
  kind: MarketKind;
  name: string;
  version: string;
  updated: string;
  at: string;
  /** What it put in the collection: theme id, top-level deck names, or type ids. */
  ids: string[];
}

export function installedEntries(e: Etude): Record<string, InstalledEntry> {
  return e.db.setting<{ installed?: Record<string, InstalledEntry> }>("market", {}).installed ?? {};
}

function recordInstall(e: Etude, id: string, rec: InstalledEntry) {
  const cur = e.db.setting<{ installed?: Record<string, InstalledEntry> }>("market", {});
  e.db.setSetting("market", { ...cur, installed: { ...(cur.installed ?? {}), [id]: rec } });
}

export function forgetInstall(e: Etude, id: string): boolean {
  const cur = e.db.setting<{ installed?: Record<string, InstalledEntry> }>("market", {});
  if (!cur.installed?.[id]) return false;
  const { [id]: _gone, ...rest } = cur.installed;
  e.db.setSetting("market", { ...cur, installed: rest });
  return true;
}

/** "installed", "update" (the market has a newer version), or null. */
export function installState(e: Etude, entry: MarketMeta, installed = installedEntries(e)): "installed" | "update" | null {
  const rec = installed[entry.id];
  if (!rec || rec.kind !== entry.kind) return null;
  return rec.version !== entry.version || (entry.updated && rec.updated !== entry.updated) ? "update" : "installed";
}

// ------------------------------------------------------------------ install

export async function installEntry(e: Etude, id: string, opts: { url?: string; dryRun?: boolean; kind?: MarketKind } = {}) {
  const url = opts.url ?? marketSettings(e).url;
  const index = await fetchIndex(url);
  const matches = index.entries.filter((x) => x.id === id && (!opts.kind || x.kind === opts.kind));
  if (!matches.length) throw new MarketError(`the market has no entry "${id}"`, 404);
  if (matches.length > 1) throw new MarketError(`"${id}" is both a ${matches.map((m) => m.kind).join(" and a ")}; pass the kind`, 409);
  const file = await fetchEntry(url, matches[0]);
  return installFile(e, file, { dryRun: opts.dryRun });
}

/** Adds an entry file to the collection. Installing the same entry again updates it in place. */
export function installFile(e: Etude, file: MarketFile, opts: { dryRun?: boolean } = {}) {
  const errors = checkEntry(file);
  if (errors.length) throw new MarketError(`invalid market entry: ${errors.join("; ")}`);
  const meta = metaOf(file);
  const prev = installedEntries(e)[meta.id];
  let result: "created" | "updated" | "unchanged";
  let ids: string[];
  let report: any;

  if (file.kind === "theme") {
    const custom = e.settings().themes;
    const want = String(file.content.id);
    // An update keeps the id it got the first time; a new install takes the published id when it's free.
    let themeId = prev?.kind === "theme" && custom.some((t) => t.id === prev.ids[0]) ? prev.ids[0] : want;
    if (!(prev?.kind === "theme" && themeId === prev.ids[0]) && (BUILTIN_THEMES.some((t) => t.id === themeId) || custom.some((t) => t.id === themeId))) {
      themeId = freeThemeId(want, custom.map((t) => t.id));
    }
    if (!THEME_ID.test(themeId)) themeId = freeThemeId(file.name, custom.map((t) => t.id));
    const old = custom.find((t) => t.id === themeId);
    const next = normalizeTheme({ ...file.content, id: themeId }).theme;
    result = !old ? "created" : JSON.stringify(old) === JSON.stringify(next) ? "unchanged" : "updated";
    if (!opts.dryRun && result !== "unchanged") e.saveTheme(next);
    ids = [themeId];
    report = { theme: themeId };
  } else {
    const pack = file.content;
    const r = e.importPack(pack, { dryRun: opts.dryRun });
    report = r;
    const changed = r.items.created + r.items.updated + r.types.created + r.types.updated;
    result = prev ? (changed ? "updated" : "unchanged") : "created";
    ids =
      file.kind === "type"
        ? (pack.types ?? []).map((t: any) => t.id)
        : [...new Set(([...(pack.decks ?? []).map((d: any) => d.name), ...(pack.items ?? []).map((i: any) => i.deck)] as string[]).filter(Boolean).map((n) => n.split("::")[0].trim()))];
  }
  if (!opts.dryRun) recordInstall(e, meta.id, { kind: meta.kind, name: meta.name, version: meta.version, updated: meta.updated, at: new Date().toISOString(), ids });
  return { entry: meta, result, ids, dryRun: !!opts.dryRun, report };
}

// ------------------------------------------------------------------ publish

export interface SubmissionInput {
  kind: MarketKind;
  /** Theme id, deck name, or type id in this collection. */
  ref: string;
  id?: string;
  name?: string;
  description?: string;
  author?: string;
  tags?: string[];
  version?: string;
  /** Card types: how many of your items of the type ride along as examples (default 3). */
  examples?: number;
}

const stripType = (def: any) => {
  const { updated: _u, builtin: _b, ...rest } = def;
  return rest;
};

/** Builds the entry file for something in this collection. */
export function buildSubmission(e: Etude, input: SubmissionInput): MarketFile {
  const { kind, ref } = input;
  if (!MARKET_KINDS.includes(kind)) throw new MarketError(`kind must be one of ${MARKET_KINDS.join(", ")}`);
  if (!ref?.trim()) throw new MarketError(`say which ${kind} to publish`);
  let content: any;
  let name = input.name?.trim();
  let description = input.description?.trim() ?? "";

  if (kind === "theme") {
    const t = e.theme(ref);
    if (t.builtin) throw new MarketError(`"${t.name}" ships with Etude already; publish a copy you made from it`);
    const { builtin: _b, ...plain } = t;
    content = plain;
    name ||= t.name;
  } else if (kind === "deck") {
    const d = e.deck(ref);
    content = e.exportPack({ deck: d.name, name: name || d.name });
    if (!content.items.length) throw new MarketError(`deck "${d.name}" has no active items to share`);
    delete content.exported;
    name ||= d.name.split("::").pop()!;
    description ||= d.description ?? "";
  } else {
    const def = e.type(ref);
    const shipped = e.listTypes().find((t) => t.id === ref);
    if (def.builtin && !shipped?.edited) throw new MarketError(`"${def.name}" ships with Etude already; publish your own type`);
    const n = Math.max(0, Math.min(20, input.examples ?? 3));
    const sample = n ? e.exportPack({ query: `type:${ref}` }) : { items: [], decks: [], presets: [] };
    const items = sample.items.slice(0, n);
    const used = new Set(items.flatMap((i: any) => i.deck.split("::").map((_: string, k: number, a: string[]) => a.slice(0, k + 1).join("::"))));
    content = {
      etude: "pack/1",
      name: name || def.name,
      types: [stripType(def)],
      decks: (sample.decks ?? []).filter((d: any) => used.has(d.name)).map((d: any) => ({ name: d.name, description: d.description })),
      items,
    };
    name ||= def.name;
    description ||= def.description ?? "";
  }
  const file: MarketFile = {
    etudeMarket: 1,
    kind,
    id: input.id?.trim() || slugify(name!) || slugify(ref),
    name: name!,
    description,
    author: input.author?.trim() || "anonymous",
    tags: (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12),
    version: input.version?.trim() || "1",
    updated: new Date().toISOString().slice(0, 10),
    content,
  };
  const errors = checkEntry(file);
  if (errors.length) throw new MarketError(`can't publish this: ${errors.join("; ")}`);
  const bytes = Buffer.byteLength(JSON.stringify(file));
  if (bytes > MAX_ENTRY_BYTES) throw new MarketError(`this ${kind} is ${(bytes / 1e6).toFixed(1)} MB; the market takes up to ${MAX_ENTRY_BYTES / 1e6} MB per entry`);
  return file;
}

/** Pretty JSON for entry files: readable diffs in pull requests. */
export const entryJson = (file: MarketFile) => JSON.stringify(file, null, 2) + "\n";

/** A GitHub page where someone without `gh` can add the file by hand (GitHub forks for them). */
export function manualPublishUrl(repo: string, file: MarketFile): string {
  const path = entryPath(file.kind, file.id);
  const text = entryJson(file);
  if (text.length <= 6000) return `https://github.com/${repo}/new/main?filename=${encodeURIComponent(path)}&value=${encodeURIComponent(text)}`;
  return `https://github.com/${repo}/upload/main/entries/${file.kind}s`;
}

type Gh = (args: string[], input?: unknown) => any;

function ghRunner(bin = process.env.ETUDE_GH || "gh"): Gh {
  return (args, input) => {
    let out: string;
    try {
      out = execFileSync(bin, args, { input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    } catch (err: any) {
      if (err?.code === "ENOENT") throw new MarketError("the GitHub CLI (gh) isn't installed", 424);
      const msg = String(err?.stderr || err?.message || err).trim().split("\n").filter((l: string) => !/^mise /.test(l)).join(" ");
      throw Object.assign(new MarketError(`gh ${args.slice(0, 2).join(" ")}: ${msg}`, 502), { stderr: msg });
    }
    // Version-manager shims (mise, asdf) can print a line of their own before gh's output.
    let t = out.trim();
    const start = t.search(/^[[{]/m);
    if (start > 0) t = t.slice(start);
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  };
}

/** Whether publishing through `gh` works here, and as whom. */
export function ghStatus(gh: Gh = ghRunner()): { ok: boolean; login?: string; reason?: string } {
  try {
    const user = gh(["api", "user"]);
    return user?.login ? { ok: true, login: user.login } : { ok: false, reason: "gh isn't signed in" };
  } catch (e) {
    const m = (e as Error).message;
    return { ok: false, reason: /not installed/.test(m) ? m : /auth|login|401/i.test(m) ? "gh isn't signed in (run `gh auth login`)" : m };
  }
}

/**
 * Opens a pull request adding (or updating) the entry file. Uses the signed-in `gh`: forks the
 * market repository when you can't push to it, commits the file on a new branch, opens the PR.
 */
export function publishFile(file: MarketFile, opts: { repo?: string; gh?: Gh } = {}) {
  const repo = opts.repo ?? MARKET_REPO;
  const gh = opts.gh ?? ghRunner();
  const status = ghStatus(gh);
  if (!status.ok) throw new MarketError(status.reason ?? "gh isn't available", 424);
  const login = status.login!;
  const [owner, name] = repo.split("/");
  const upstream = gh(["api", `repos/${repo}`]);
  const base = upstream?.default_branch ?? "main";
  const canPush = !!upstream?.permissions?.push;
  let target = repo;
  if (!canPush) {
    gh(["api", "-X", "POST", `repos/${repo}/forks`, "--input", "-"], { default_branch_only: true });
    target = `${login}/${name}`;
    // A fresh fork takes a moment to exist; an old one may be behind.
    for (let i = 0; i < 10; i++) {
      try {
        gh(["api", "-X", "POST", `repos/${target}/merge-upstream`, "--input", "-"], { branch: base });
        break;
      } catch {
        execFileSync("sleep", ["2"]);
      }
    }
  }
  const head = gh(["api", `repos/${repo}/git/ref/heads/${base}`]);
  const branch = `${file.kind}-${file.id}-${Date.now().toString(36)}`;
  gh(["api", "-X", "POST", `repos/${target}/git/refs`, "--input", "-"], { ref: `refs/heads/${branch}`, sha: head.object.sha });
  const path = entryPath(file.kind, file.id);
  let sha: string | undefined;
  try {
    sha = gh(["api", `repos/${target}/contents/${path}?ref=${branch}`])?.sha;
  } catch {
    sha = undefined;
  }
  const verb = sha ? "Update" : "Add";
  const label = file.kind === "type" ? "card type" : file.kind;
  gh(["api", "-X", "PUT", `repos/${target}/contents/${path}`, "--input", "-"], {
    message: `${verb} ${label}: ${file.name}`,
    content: Buffer.from(entryJson(file)).toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
  });
  const body = [
    `${verb}s the ${label} **${file.name}** by ${file.author}.`,
    "",
    file.description || "",
    "",
    `Published from Etude with \`etude market publish\`. The check on this pull request validates the file; the index updates itself after merge.`,
  ].join("\n");
  const pr = gh(["api", "-X", "POST", `repos/${repo}/pulls`, "--input", "-"], {
    title: `${verb} ${label}: ${file.name}`,
    head: canPush ? branch : `${login}:${branch}`,
    base,
    body,
    maintainer_can_modify: true,
  });
  return { url: pr.html_url as string, number: pr.number as number, branch, repo, fork: canPush ? null : target, path, updated: !!sha, login, owner };
}

// ------------------------------------------------------------------ index (for the market repository)

/** Validates every entry file under `dir/entries` and builds the index. `install` dry-runs each into a scratch collection. */
export async function buildIndex(dir: string, opts: { repo?: string; dryRunInto?: () => Promise<Etude> } = {}) {
  const root = resolve(dir);
  const entries: IndexEntry[] = [];
  const problems: { path: string; errors: string[] }[] = [];
  const seen = new Map<string, string>();
  for (const kind of MARKET_KINDS) {
    const sub = join(root, "entries", `${kind}s`);
    if (!existsSync(sub)) continue;
    for (const f of readdirSync(sub).filter((f) => f.endsWith(".json")).sort()) {
      const path = `entries/${kind}s/${f}`;
      const full = join(sub, f);
      const errors: string[] = [];
      let file: any;
      try {
        file = JSON.parse(readFileSync(full, "utf8"));
      } catch (e) {
        problems.push({ path, errors: [`not valid JSON: ${(e as Error).message}`] });
        continue;
      }
      errors.push(...checkEntry(file));
      if (!errors.length) {
        if (file.kind !== kind) errors.push(`kind is "${file.kind}" but the file is in entries/${kind}s`);
        if (`${file.id}.json` !== f) errors.push(`the file must be named ${file.id}.json`);
        const key = `${file.kind}:${file.id}`;
        if (seen.has(file.id)) errors.push(`id "${file.id}" is already used by ${seen.get(file.id)}`);
        seen.set(file.id, path);
        void key;
      }
      const bytes = statSync(full).size;
      if (bytes > MAX_ENTRY_BYTES) errors.push(`file is larger than ${MAX_ENTRY_BYTES} bytes`);
      if (!errors.length && opts.dryRunInto && (file.kind === "deck" || file.kind === "type")) {
        const scratch = await opts.dryRunInto();
        try {
          scratch.importPack(file.content, { dryRun: true });
        } catch (e) {
          errors.push(`import: ${(e as Error).message}`);
        } finally {
          scratch.close();
        }
      }
      if (errors.length) {
        problems.push({ path, errors });
        continue;
      }
      const ext = COVER_EXT.find((x) => existsSync(join(root, "covers", `${kind}s`, `${file.id}.${x}`)));
      const cover = ext ? `covers/${kind}s/${file.id}.${ext}` : undefined;
      if (cover && statSync(join(root, cover)).size > MAX_COVER_BYTES) {
        problems.push({ path: cover, errors: [`cover is larger than ${MAX_COVER_BYTES / 1024} KB`] });
        continue;
      }
      entries.push({ ...metaOf(file), path, bytes, ...(cover ? { cover } : {}), summary: summarize(file) });
    }
  }
  entries.sort((a, b) => (b.updated || "").localeCompare(a.updated || "") || a.name.localeCompare(b.name));
  const index: MarketIndex = { etude: "market/1", generated: new Date().toISOString(), repo: opts.repo ?? MARKET_REPO, entries };
  return { index, problems };
}
