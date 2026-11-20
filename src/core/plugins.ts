// Etude plugins: manifest validation, static checks, SHA-256 hashing, per-collection storage
// (installed plugins, KV store, append-only event log), and bundled free starter plugins.
//
// Security contract:
//  - Every plugin runs inside a sandboxed iframe (`sandbox="allow-scripts"`, opaque origin).
//  - Host enforces every call against the plugin's *granted* permissions (never just manifest).
//  - Updating a plugin that requests extra permissions pauses it (`enabled = 0`) until approved.
//  - Plugins can never access AI keys, Ask agents, local disk folders, Sync credentials,
//    other plugins' storage, or native phone bridges (plugins are desktop + web only).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EtudeError, type Etude } from "./engine.ts";
import type { Db } from "./db.ts";

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const MAX_PLUGIN_FILES = 64;
export const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;
export const MAX_KV_KEYS = 256;
export const MAX_KV_VALUE_BYTES = 64 * 1024;
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;

export const STATIC_PERMISSIONS = [
  "ui.commands",
  "ui.floating",
  "ui.sidebar",
  "ui.tab",
  "ui.block",
  "storage",
  "notify",
  "read.decks",
  "read.cards",
  "read.reviews",
  "read.notes",
  "write.cards",
  "write.notes",
  "events.review",
] as const;

export type StaticPermission = (typeof STATIC_PERMISSIONS)[number];
export type PluginPlatform = "desktop" | "web";

const STATIC_PERM_SET = new Set<string>(STATIC_PERMISSIONS);
const NET_PERM = /^net:([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;
const SAFE_REL_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ALLOWED_PLATFORMS = new Set<string>(["desktop", "web"]);

export const PERMISSION_LABELS: Record<string, string> = {
  "ui.commands": "Add entries to Ctrl/⌘K and the right-click menu",
  "ui.floating": "Show a floating panel over Etude",
  "ui.sidebar": "Add a sidebar panel",
  "ui.tab": "Open a tab in the Notebook",
  "ui.block": "Provide an embeddable block for Notebook pages",
  storage: "Keep its own settings and event log in your collection",
  notify: "Show notifications and play a sound",
  "read.decks": "Read your deck names and due counts",
  "read.cards": "Read your cards (never private answers during review)",
  "read.reviews": "Read your review history",
  "read.notes": "Read your Notebook pages",
  "write.cards": "Create or edit cards (undoable)",
  "write.notes": "Create or edit Notebook pages (undoable)",
  "events.review": "Receive an event after each card review",
};

export function describePermission(perm: string): string {
  if (PERMISSION_LABELS[perm]) return PERMISSION_LABELS[perm];
  const m = NET_PERM.exec(perm);
  if (m) return `Connect to https://${m[1]} only`;
  return perm;
}

export function isValidPermission(perm: unknown): perm is string {
  if (typeof perm !== "string") return false;
  return STATIC_PERM_SET.has(perm) || NET_PERM.test(perm);
}

/** Allowed `connect-src` origins derived strictly from granted `net:<host>` permissions. */
export function netConnectOrigins(granted: string[]): string[] {
  const out: string[] = [];
  for (const p of granted) {
    const m = NET_PERM.exec(p);
    if (m) out.push(`https://${m[1]}`);
  }
  return [...new Set(out)].sort();
}

export interface PluginManifest {
  etude: "plugin/1";
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  main: string;
  views?: Record<string, string>;
  permissions: string[];
  platforms: PluginPlatform[];
}

export interface PluginPackage {
  manifest: PluginManifest;
  /** Relative path -> UTF-8 source text. */
  files: Record<string, string>;
}

export interface InstalledPlugin {
  id: string;
  manifest: PluginManifest;
  hash: string;
  enabled: boolean;
  granted: string[];
  /** Permissions declared in manifest that are not yet granted (e.g. after an update). */
  pendingPermissions: string[];
  source: "local" | "market" | "bundled";
  installedAt: string;
  updatedAt: string;
  bytes: number;
  fileCount: number;
}

export interface PluginEventRow {
  id: number;
  pluginId: string;
  ts: string;
  kind: string;
  payload: unknown;
}

/** Deterministic SHA-256 over the manifest and sorted file contents, for Market hash pinning. */
export function pluginHash(pkg: PluginPackage): string {
  const h = createHash("sha256");
  const sortedManifest = JSON.stringify(pkg.manifest, Object.keys(pkg.manifest).sort());
  h.update("manifest\0");
  h.update(sortedManifest);
  h.update("\0");
  for (const name of Object.keys(pkg.files).sort()) {
    h.update("file\0");
    h.update(name);
    h.update("\0");
    h.update(pkg.files[name]);
    h.update("\0");
  }
  return h.digest("hex");
}

function cleanRelPath(p: string): string | null {
  const norm = p.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!SAFE_REL_PATH.test(norm) || norm.includes("..") || norm.startsWith("/") || norm.endsWith("/")) return null;
  const parts = norm.split("/");
  if (parts.some((seg) => !seg || seg === "." || seg === "..")) return null;
  return norm;
}

/**
 * Static safety & shape checks run locally (`etude plugin check`), in Market CI, and on install.
 * Rejects remote code loading (`<script src="http...">`, dynamic remote `import()`, `importScripts`),
 * traversal paths, oversized packages, and unknown permissions.
 */
export function checkPlugin(pkg: unknown): string[] {
  const errors: string[] = [];
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return ["plugin package must be an object { manifest, files }"];
  const { manifest: m, files } = pkg as { manifest?: any; files?: any };
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["manifest must be an object"];
  if (m.etude !== "plugin/1") errors.push('manifest.etude must be "plugin/1"');
  if (typeof m.id !== "string" || !PLUGIN_ID.test(m.id)) errors.push("manifest.id must be a lowercase slug (2-64 chars: a-z, 0-9, -)");
  if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 80) errors.push("manifest.name is required (1-80 chars)");
  if (typeof m.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$/.test(m.version)) errors.push('manifest.version must be semver (e.g. "1.0.0")');
  if (typeof m.author !== "string" || !m.author.trim() || m.author.length > 80) errors.push("manifest.author is required (1-80 chars)");
  if (typeof m.description !== "string" || m.description.length > 500) errors.push("manifest.description must be text (up to 500 chars)");
  if (typeof m.main !== "string" || !cleanRelPath(m.main) || !m.main.endsWith(".js")) errors.push('manifest.main must be a relative .js file (e.g. "main.js")');

  if (!Array.isArray(m.permissions)) errors.push("manifest.permissions must be an array");
  else {
    const seen = new Set<string>();
    for (const p of m.permissions) {
      if (!isValidPermission(p)) errors.push(`unknown or invalid permission "${String(p)}"`);
      else if (seen.has(p)) errors.push(`duplicate permission "${p}"`);
      else seen.add(p);
    }
  }
  if (!Array.isArray(m.platforms) || !m.platforms.length || !m.platforms.every((p: unknown) => typeof p === "string" && ALLOWED_PLATFORMS.has(p))) {
    errors.push('manifest.platforms must list "desktop" and/or "web" (phones are not enabled yet)');
  }
  if (m.views !== undefined) {
    if (!m.views || typeof m.views !== "object" || Array.isArray(m.views)) errors.push("manifest.views must map view ids to relative .html files");
    else {
      for (const [k, v] of Object.entries(m.views)) {
        if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(k)) errors.push(`invalid view id "${k}"`);
        if (typeof v !== "string" || !cleanRelPath(v) || !v.endsWith(".html")) errors.push(`view "${k}" must point to a relative .html file`);
      }
    }
  }

  if (!files || typeof files !== "object" || Array.isArray(files)) {
    errors.push("files must be an object mapping relative paths to text");
    return errors;
  }
  const names = Object.keys(files);
  if (names.length === 0) errors.push("files cannot be empty");
  if (names.length > MAX_PLUGIN_FILES) errors.push(`too many files (max ${MAX_PLUGIN_FILES})`);
  let totalBytes = 0;
  for (const name of names) {
    const clean = cleanRelPath(name);
    if (!clean || clean !== name) {
      errors.push(`invalid file path "${name}"`);
      continue;
    }
    const content = files[name];
    if (typeof content !== "string") {
      errors.push(`file "${name}" must be UTF-8 text`);
      continue;
    }
    totalBytes += Buffer.byteLength(content, "utf8");
    // Static scan for remote code loading (the CSP also enforces this at runtime).
    if (/\.(js|mjs|html|htm)$/i.test(name)) {
      if (/<script[^>]+src\s*=\s*["']?\s*(https?:|\/\/)/i.test(content)) errors.push(`${name}: remote <script src> is forbidden`);
      if (/\bimport\s*\(\s*["'`]\s*(https?:|\/\/)/i.test(content)) errors.push(`${name}: remote dynamic import() is forbidden`);
      if (/\bimportScripts\s*\(/i.test(content)) errors.push(`${name}: importScripts() is forbidden`);
      if (/<\s*link[^>]+href\s*=\s*["']?\s*(https?:|\/\/)/i.test(content)) errors.push(`${name}: remote stylesheets/links are forbidden`);
    }
    if (name.endsWith(".js")) {
      try {
        new Function(`return async function (etude) {\n${content}\n}`);
      } catch (e) {
        errors.push(`${name}: syntax error: ${(e as Error).message}`);
      }
    }
  }
  if (totalBytes > MAX_PLUGIN_BYTES) errors.push(`plugin exceeds max size (${MAX_PLUGIN_BYTES} bytes)`);
  if (typeof m.main === "string" && !(m.main in files)) errors.push(`manifest.main "${m.main}" is missing from files`);
  if (m.views && typeof m.views === "object" && !Array.isArray(m.views)) {
    for (const [k, v] of Object.entries(m.views)) {
      if (typeof v === "string" && !(v in files)) errors.push(`view "${k}" file "${v}" is missing from files`);
    }
  }
  return errors;
}

/** Loads a plugin package from a directory containing `plugin.json` and its source files. */
export function loadPluginDir(dir: string): PluginPackage {
  const root = resolve(dir);
  const manifestPath = join(root, "plugin.json");
  if (!existsSync(manifestPath)) throw new EtudeError(`no plugin.json in ${dir}`, 400);
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new EtudeError(`plugin.json is invalid JSON: ${(e as Error).message}`, 400);
  }
  const files: Record<string, string> = {};
  const walk = (cur: string) => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = normalize(relative(root, full)).replaceAll("\\", "/");
        if (rel === "plugin.json") continue;
        if (Object.keys(files).length >= MAX_PLUGIN_FILES) throw new EtudeError(`too many files in ${dir} (max ${MAX_PLUGIN_FILES})`, 400);
        const st = statSync(full);
        if (st.size > MAX_PLUGIN_BYTES) throw new EtudeError(`file ${rel} exceeds max plugin size`, 400);
        files[rel] = readFileSync(full, "utf8");
      }
    }
  };
  walk(root);
  return { manifest, files };
}

/** Scaffolds a minimal starter plugin folder (`etude plugin new <id>`). */
export function scaffoldPlugin(id: string, dir: string, opts: { name?: string; author?: string } = {}): { dir: string; files: string[] } {
  if (!PLUGIN_ID.test(id)) throw new EtudeError("id must be a lowercase slug (2-64 chars: a-z, 0-9, -)");
  const target = resolve(dir);
  if (existsSync(join(target, "plugin.json"))) throw new EtudeError(`${target} already has a plugin.json`, 409);
  mkdirSync(target, { recursive: true });
  const name = opts.name?.trim() || id.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const manifest: PluginManifest = {
    etude: "plugin/1",
    id,
    name,
    version: "0.1.0",
    author: opts.author?.trim() || "You",
    description: `${name} plugin for Etude.`,
    main: "main.js",
    views: { panel: "panel.html" },
    permissions: ["ui.commands", "ui.floating", "notify", "storage"],
    platforms: ["desktop", "web"],
  };
  const mainJs = `// Controller for ${name}. Runs inside a sandboxed iframe.\netude.commands.register({\n  id: "toggle",\n  label: "${name}: Show / hide",\n  async run() {\n    const open = await etude.floating.isOpen();\n    if (open) await etude.floating.close();\n    else await etude.floating.open({ view: "panel", title: "${name}", width: 260, height: 180 });\n  },\n});\n`;
  const panelHtml = `<!doctype html>\n<html><body style="font-family:var(--font-sans,system-ui);color:var(--foreground);margin:0;padding:12px">\n<h3 style="margin:0 0 8px">${name}</h3>\n<button id="ping">Say hi</button>\n<script>\ndocument.getElementById("ping").onclick = () => etude.notify({ title: "${name}", description: "Hello from your plugin!" });\n</script>\n</body></html>\n`;
  writeFileSync(join(target, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(target, "main.js"), mainJs);
  writeFileSync(join(target, "panel.html"), panelHtml);
  return { dir: target, files: ["plugin.json", "main.js", "panel.html"] };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLED_DIR = join(ROOT, "examples", "plugins");

/** Free plugins shipped with Etude as ready-to-install examples (e.g. Pomodoro). */
export function bundledPlugins(): (PluginPackage & { hash: string })[] {
  if (!existsSync(BUNDLED_DIR)) return [];
  const out: (PluginPackage & { hash: string })[] = [];
  for (const d of readdirSync(BUNDLED_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || !existsSync(join(BUNDLED_DIR, d.name, "plugin.json"))) continue;
    try {
      const pkg = loadPluginDir(join(BUNDLED_DIR, d.name));
      if (checkPlugin(pkg).length === 0) out.push({ ...pkg, hash: pluginHash(pkg) });
    } catch {}
  }
  return out.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

export function bundledPlugin(id: string): (PluginPackage & { hash: string }) | null {
  if (!PLUGIN_ID.test(id)) return null;
  return bundledPlugins().find((p) => p.manifest.id === id) ?? null;
}

// ------------------------------------------------------------------ database store

export function ensurePluginSchema(db: Db) {
  db.sql.exec(`
CREATE TABLE IF NOT EXISTS plugins (
  id           TEXT PRIMARY KEY,
  manifest     TEXT NOT NULL,
  files        TEXT NOT NULL,
  hash         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 0,
  granted      TEXT NOT NULL DEFAULT '[]',
  source       TEXT NOT NULL DEFAULT 'local',
  installed_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_kv (
  plugin_id  TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
CREATE TABLE IF NOT EXISTS plugin_events (
  id        INTEGER PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  ts        TEXT NOT NULL,
  kind      TEXT NOT NULL,
  payload   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plugin_events_plugin ON plugin_events(plugin_id, id);
`);
}

export class PluginStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
    ensurePluginSchema(db);
  }

  private toView(row: any): InstalledPlugin {
    const manifest = JSON.parse(row.manifest) as PluginManifest;
    const files = JSON.parse(row.files) as Record<string, string>;
    const granted = JSON.parse(row.granted) as string[];
    const grantSet = new Set(granted);
    const pendingPermissions = manifest.permissions.filter((p) => !grantSet.has(p));
    const bytes = Object.values(files).reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0);
    return {
      id: row.id,
      manifest,
      hash: row.hash,
      enabled: !!row.enabled,
      granted,
      pendingPermissions,
      source: row.source,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
      bytes,
      fileCount: Object.keys(files).length,
    };
  }

  list(): InstalledPlugin[] {
    return this.db.all("SELECT * FROM plugins ORDER BY id").map((r) => this.toView(r));
  }

  get(id: string): InstalledPlugin | null {
    const row = this.db.get("SELECT * FROM plugins WHERE id = ?", id);
    return row ? this.toView(row) : null;
  }

  packageOf(id: string): (PluginPackage & { hash: string; enabled: boolean; granted: string[] }) | null {
    const row = this.db.get("SELECT * FROM plugins WHERE id = ?", id);
    if (!row) return null;
    return {
      manifest: JSON.parse(row.manifest),
      files: JSON.parse(row.files),
      hash: row.hash,
      enabled: !!row.enabled,
      granted: JSON.parse(row.granted),
    };
  }

  /**
   * Installs or updates a plugin package.
   * On an update that asks for *more* permissions than previously granted, the plugin is paused
   * (`enabled = 0`) unless `grant` explicitly approves the new permissions.
   */
  install(
    pkg: PluginPackage,
    opts: { source?: "local" | "market" | "bundled"; expectedHash?: string; enable?: boolean; grant?: string[] } = {},
  ): { plugin: InstalledPlugin; status: "installed" | "updated" | "unchanged"; pausedForPermissions: boolean } {
    const errors = checkPlugin(pkg);
    if (errors.length) throw new EtudeError(`invalid plugin: ${errors.join("; ")}`, 400);
    const hash = pluginHash(pkg);
    if (opts.expectedHash && opts.expectedHash !== hash) {
      throw new EtudeError(`plugin "${pkg.manifest.id}" hash mismatch: expected ${opts.expectedHash.slice(0, 12)}, got ${hash.slice(0, 12)}`, 400);
    }
    const existing = this.db.get("SELECT * FROM plugins WHERE id = ?", pkg.manifest.id);
    const now = new Date().toISOString();
    const declared = new Set(pkg.manifest.permissions);
    if (!existing) {
      const granted = (opts.grant ?? (opts.enable ? pkg.manifest.permissions : [])).filter((p) => declared.has(p));
      const enabled = opts.enable ? 1 : 0;
      this.db.run(
        "INSERT INTO plugins (id, manifest, files, hash, enabled, granted, source, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        pkg.manifest.id,
        JSON.stringify(pkg.manifest),
        JSON.stringify(pkg.files),
        hash,
        enabled,
        JSON.stringify([...new Set(granted)]),
        opts.source ?? "local",
        now,
        now,
      );
      return { plugin: this.get(pkg.manifest.id)!, status: "installed", pausedForPermissions: false };
    }
    const prevGranted = (JSON.parse(existing.granted) as string[]).filter((p) => declared.has(p));
    const nextGranted = opts.grant ? opts.grant.filter((p) => declared.has(p)) : prevGranted;
    const grantSet = new Set(nextGranted);
    const asksMore = pkg.manifest.permissions.some((p) => !grantSet.has(p));
    const pausedForPermissions = asksMore && !opts.grant;
    const nextEnabled = pausedForPermissions ? 0 : opts.enable !== undefined ? Number(opts.enable) : existing.enabled;
    const unchanged = existing.hash === hash && existing.enabled === nextEnabled && existing.granted === JSON.stringify([...new Set(nextGranted)]);
    if (!unchanged) {
      this.db.run(
        "UPDATE plugins SET manifest = ?, files = ?, hash = ?, enabled = ?, granted = ?, source = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(pkg.manifest),
        JSON.stringify(pkg.files),
        hash,
        nextEnabled,
        JSON.stringify([...new Set(nextGranted)]),
        opts.source ?? existing.source,
        now,
        pkg.manifest.id,
      );
    }
    return { plugin: this.get(pkg.manifest.id)!, status: unchanged ? "unchanged" : "updated", pausedForPermissions };
  }

  setEnabled(id: string, enabled: boolean): InstalledPlugin {
    const cur = this.get(id);
    if (!cur) throw new EtudeError(`unknown plugin "${id}"`, 404);
    this.db.run("UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?", enabled ? 1 : 0, new Date().toISOString(), id);
    return this.get(id)!;
  }

  setPermissions(id: string, granted: string[]): InstalledPlugin {
    const cur = this.get(id);
    if (!cur) throw new EtudeError(`unknown plugin "${id}"`, 404);
    const allowed = new Set(cur.manifest.permissions);
    const clean = [...new Set(granted.filter((p) => typeof p === "string" && allowed.has(p)))];
    this.db.run("UPDATE plugins SET granted = ?, updated_at = ? WHERE id = ?", JSON.stringify(clean), new Date().toISOString(), id);
    return this.get(id)!;
  }

  uninstall(id: string): { removed: string } {
    const cur = this.get(id);
    if (!cur) throw new EtudeError(`unknown plugin "${id}"`, 404);
    this.db.run("DELETE FROM plugins WHERE id = ?", id);
    return { removed: id };
  }

  private assertStorage(id: string) {
    const p = this.get(id);
    if (!p) throw new EtudeError(`unknown plugin "${id}"`, 404);
    if (!p.enabled) throw new EtudeError(`plugin "${id}" is disabled`, 403);
    if (!p.granted.includes("storage")) throw new EtudeError(`plugin "${id}" lacks "storage" permission`, 403);
  }

  kvGetAll(id: string): Record<string, unknown> {
    this.assertStorage(id);
    const rows = this.db.all<{ key: string; value: string }>("SELECT key, value FROM plugin_kv WHERE plugin_id = ? ORDER BY key", id);
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = JSON.parse(r.value);
    return out;
  }

  kvGet(id: string, key: string): unknown {
    this.assertStorage(id);
    const row = this.db.get<{ value: string }>("SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?", id, key);
    return row ? JSON.parse(row.value) : null;
  }

  kvSet(id: string, key: string, value: unknown): { key: string; value: unknown } {
    this.assertStorage(id);
    if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) throw new EtudeError("invalid storage key", 400);
    if (value === null || value === undefined) {
      this.db.run("DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?", id, key);
      return { key, value: null };
    }
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw, "utf8") > MAX_KV_VALUE_BYTES) throw new EtudeError(`storage value exceeds ${MAX_KV_VALUE_BYTES} bytes`, 413);
    const count = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM plugin_kv WHERE plugin_id = ?", id)?.n ?? 0);
    const exists = !!this.db.get("SELECT 1 FROM plugin_kv WHERE plugin_id = ? AND key = ?", id, key);
    if (!exists && count >= MAX_KV_KEYS) throw new EtudeError(`plugin "${id}" reached max ${MAX_KV_KEYS} storage keys`, 400);
    this.db.run(
      "INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      id,
      key,
      raw,
      new Date().toISOString(),
    );
    return { key, value: JSON.parse(raw) };
  }

  appendEvent(id: string, kind: string, payload: unknown): PluginEventRow {
    this.assertStorage(id);
    if (typeof kind !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(kind)) throw new EtudeError("invalid event kind", 400);
    const raw = JSON.stringify(payload ?? null);
    if (Buffer.byteLength(raw, "utf8") > MAX_EVENT_PAYLOAD_BYTES) throw new EtudeError(`event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`, 413);
    const ts = new Date().toISOString();
    const res = this.db.run("INSERT INTO plugin_events (plugin_id, ts, kind, payload) VALUES (?, ?, ?, ?)", id, ts, kind, raw);
    return { id: Number(res.lastInsertRowid), pluginId: id, ts, kind, payload: JSON.parse(raw) };
  }

  listEvents(id: string, opts: { kind?: string; after?: number; limit?: number } = {}): PluginEventRow[] {
    this.assertStorage(id);
    const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 100)));
    const after = Number.isInteger(opts.after) ? opts.after! : 0;
    const rows = opts.kind
      ? this.db.all("SELECT * FROM plugin_events WHERE plugin_id = ? AND kind = ? AND id > ? ORDER BY id ASC LIMIT ?", id, opts.kind, after, limit)
      : this.db.all("SELECT * FROM plugin_events WHERE plugin_id = ? AND id > ? ORDER BY id ASC LIMIT ?", id, after, limit);
    return rows.map((r: any) => ({ id: r.id, pluginId: r.plugin_id, ts: r.ts, kind: r.kind, payload: JSON.parse(r.payload) }));
  }
}

const stores = new WeakMap<Etude, PluginStore>();
export function pluginsFor(e: Etude): PluginStore {
  let s = stores.get(e);
  if (!s) {
    s = new PluginStore(e.db);
    stores.set(e, s);
  }
  return s;
}
