// HTTP API, card frames, the card runtime and the web app.
import { syncRoutes } from "./sync.ts";
import { accountRoutes } from "./account.ts";
import { pingFreeInstall } from "../core/account.ts";
import { syncFor } from "../core/sync/client.ts";
import { Hono, type Context } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DEFAULT_SETTINGS, Etude, EtudeError, type StudyScope } from "../core/engine.ts";
import { ScriptError } from "../core/sandbox.ts";
import { chatProviderKeyEnv } from "../core/ai.ts";
import { chatGptNativeHost, readChatGptHostId } from "../core/chatgpt.ts";
import { DEFAULT_PRESET, type Rating } from "../core/model.ts";
import { MAX_MEDIA_BYTES, mediaType } from "../core/media.ts";
import { cardFrame } from "./frame.ts";
import { runFrameHtml } from "../core/run-frame.ts";
import { pyodideFile } from "./pyodide.ts";
import { ASSET_NAME, assetMime } from "../core/assets.ts";
import { agentFor, AgentError, AGENT_MAX_ATTACHMENT_BYTES, type AgentEvent } from "../core/agent.ts";
import { streamSSE } from "hono/streaming";
import { applyUpdate, updateStatus, UpdateError } from "../core/update.ts";
import { isEventName, telemetryAllowed, telemetryFor, usageEventFor } from "../core/telemetry.ts";
import { buildSubmission, fetchComingSoon, fetchComingSoonAsset, fetchMarketMedia, fetchCover, fetchEntry, fetchIndex, ghStatus, installEntry, installState, installedEntries, manualPublishUrl, marketSettings, publishFile, summarize, entryPath, entryJson, forgetInstall, type MarketKind } from "../core/market.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".whl": "application/zip",
  ".tar": "application/x-tar",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
};

/** Third-party files the card runtime imports, served from node_modules so nothing is vendored. */
function vendorPath(name: string): string | null {
  const katexDist = dirname(require.resolve("katex/package.json")) + "/dist";
  if (name === "marked.js") return join(dirname(require.resolve("marked/package.json")), "lib", "marked.esm.js");
  if (name === "katex.js") return join(katexDist, "katex.mjs");
  if (name === "katex.css") return join(katexDist, "katex.min.css");
  if (name.startsWith("fonts/") && /^fonts\/[\w.-]+$/.test(name)) return join(katexDist, name);
  return null;
}

/**
 * Card documents run a type's own code. `sandbox allow-scripts` gives them an opaque origin even
 * when opened as a top-level page (a link to /frame/<type>), so that code can never act as the app.
 */
const FRAME_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*", "Content-Security-Policy": "sandbox allow-scripts" };

/**
 * The app page's own policy. Only the app's bundled scripts run here; card code runs in sandboxed
 * frames loaded by URL (/frame/<type>, /frame-doc/<id>), which carry their own policy. Embeds stay
 * framable by other apps, so there is no frame-ancestors.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  // Notes can embed YouTube (privacy-enhanced) and Vimeo players; nothing else frames in the app page.
  "frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function withAppCsp(res: Response, path: string): Response {
  if (path.endsWith(".html")) res.headers.set("Content-Security-Policy", APP_CSP);
  return res;
}

function sendFile(c: Context, path: string, opts: { cors?: boolean; cache?: string; mime?: string } = {}) {
  if (!existsSync(path) || !statSync(path).isFile()) return c.text("not found", 404);
  const headers: Record<string, string> = { "Content-Type": opts.mime ?? MIME[extname(path)] ?? "application/octet-stream", "Cache-Control": opts.cache ?? "no-cache" };
  // Card frames have an opaque origin, so everything they load is a cross-origin request.
  if (opts.cors) headers["Access-Control-Allow-Origin"] = "*";
  return c.body(readFileSync(path), 200, headers);
}

/** The app's public root. Behind a TLS proxy (Tailscale serve) the request arrives as http, so trust X-Forwarded-Proto/Host or card frames load their runtime over http and get blocked as mixed content. */
function publicBase(c: Context): string {
  const u = new URL("/", c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0].trim();
  const host = c.req.header("x-forwarded-host")?.split(",")[0].trim();
  if (proto === "https" || proto === "http") u.protocol = proto + ":";
  if (host) u.host = host;
  return u.toString();
}

export interface AppOptions {
  /** Require this bearer token on every API call (for access from other devices). */
  token?: string;
  /** Serve the built web app from here; omit in dev (Vite serves it). */
  webDist?: string | null;
  /** The card editor kit (default: `kit/` inside the web build, else web/dist/kit in the repo). */
  kitDir?: string | null;
  /** Restarts the server on the new code after a successful update. Without it, the update tells the user to restart. */
  onRestart?: () => void;
  /** Extra Host names (no port) to answer for without a token, besides localhost and Tailscale's *.ts.net. */
  allowHosts?: string[];
  /** Listening on this computer only: keep the Host check even with a token, so a rebound name can't reach the pages outside /api. */
  localOnly?: boolean;
}

/** Hostnames always served: loopback, and Tailscale MagicDNS names, which only Tailscale can point anywhere. */
export function hostAllowed(hostHeader: string, extra: Set<string> = new Set()): boolean {
  let name = hostHeader.toLowerCase().trim();
  if (name.startsWith("[")) name = name.slice(0, name.indexOf("]") + 1);
  else name = name.replace(/:\d+$/, "");
  name = name.replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost") || name === "[::1]" || /^127(\.\d{1,3}){3}$/.test(name)) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name)) return true;
  return extra.has(name);
}

/** Largest .apkg upload accepted. */
const MAX_ANKI_UPLOAD = 2 * 1024 ** 3;

/** The request body as bytes, refusing it as soon as it passes `max` (Content-Length is checked first). */
async function readBody(c: Context, max: number, message: string): Promise<Buffer> {
  const declared = Number(c.req.header("content-length") ?? NaN);
  if (declared > max) throw new EtudeError(message, 413);
  const reader = c.req.raw.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) {
        await reader.cancel();
        throw new EtudeError(message, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function createApp(etude: Etude, opts: AppOptions = {}) {
  const app = new Hono();
  opts = { ...opts, kitDir: opts.kitDir ?? [opts.webDist && join(opts.webDist, "kit"), join(ROOT, "web", "dist", "kit")].find((d) => d && existsSync(join(d, "kit.js"))) ?? null };

  // No Referer from any page or frame: a card frame, or a site a card or the app links to, never learns
  // the address it came from (an app page opened with ?token=… carries it until the app removes it).
  app.use("*", async (c, next) => {
    await next();
    try {
      c.res.headers.set("Referrer-Policy", "no-referrer");
    } catch {
      // A response with immutable headers (proxied as is) keeps its own.
    }
  });

  app.onError((err, c) => {
    if (err instanceof EtudeError) {
      // Account errors carry the Sync server's code (sync_required, not_owned…); the store apps reword those.
      const code = (err as { code?: unknown }).code;
      return c.json(typeof code === "string" ? { error: err.message, code } : { error: err.message }, err.status as 400);
    }
    if (err instanceof AgentError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof UpdateError) return c.json({ error: err.message, details: err.details }, err.status as 400);
    // A card type's own script failing (prepare, a generator, a grader) is the deck's problem, not a bug in Etude, and
    // its message carries the card's ids and text: answered, never sent as an error report.
    if (err instanceof ScriptError) return c.json({ error: err.message }, 422);
    console.error(err);
    // A bug in the core (not a refusal): an anonymous error report, when they're on (src/core/telemetry.ts).
    try {
      telemetryFor(etude).report({ kind: "core.error", message: `${err?.name ?? "Error"}: ${String(err?.message ?? err)}`, stack: String(err?.stack ?? "") });
    } catch {}
    return c.json({ error: String(err?.message ?? err) }, 500);
  });

  // DNS rebinding: a page on evil.example that re-resolves to 127.0.0.1 still sends Host: evil.example.
  // Only names that can't be rebound by a stranger are served without a token.
  const allowHosts = new Set((opts.allowHosts ?? []).map((h) => h.toLowerCase()));
  app.use("*", async (c, next) => {
    if (opts.token && !opts.localOnly) return next();
    const raw = (c.req.header("host") ?? "").toLowerCase();
    if (!raw) return next(); // HTTP/1.0 clients and in-process requests (tests, app.request) send none
    if (hostAllowed(raw, allowHosts)) return next();
    return c.json({ error: `host "${raw}" refused: Etude only answers on localhost. Run it with --allow-host ${raw.replace(/:\d+$/, "")} (or --token) to serve this name.` }, 421);
  });

  // Mutating requests must be JSON from this app: blocks other websites from driving a local server.
  app.use("/api/*", async (c, next) => {
    if (opts.token) {
      const auth = c.req.header("authorization") ?? "";
      const q = c.req.query("token");
      if (auth !== `Bearer ${opts.token}` && q !== opts.token) return c.json({ error: "unauthorized" }, 401);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const ct = c.req.header("content-type") ?? "";
      // Package and media uploads send bytes; other mutations must be JSON.
      const binary = c.req.method === "POST" && (["/api/anki/import", "/api/media"].includes(c.req.path) || /^\/api\/agent\/conversations\/[\w-]+\/attachments$/.test(c.req.path)) && ct.includes("application/octet-stream");
      if (!ct.includes("application/json") && !binary) return c.json({ error: "expected application/json" }, 415);
      const origin = c.req.header("origin");
      if (origin && origin !== "null") {
        const host = c.req.header("host");
        try {
          const o = new URL(origin);
          if (o.host !== host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(o.host)) return c.json({ error: "cross-origin request refused" }, 403);
        } catch {
          return c.json({ error: "bad origin" }, 403);
        }
      }
    }
    await next();
  });

  // Usage counts by feature, from the routes the app calls (only when the person turned them on; never the content).
  app.use("/api/*", async (c, next) => {
    await next();
    const t = telemetryFor(etude);
    if (c.res.status >= 300 || !t.active || !t.prefs().usageStats) return;
    const name = usageEventFor(c.req.method, c.req.path);
    if (!name) return;
    t.count(name);
    if (c.req.path === "/api/study/submit") {
      const j = await c.res.clone().json().catch(() => null);
      if (j?.grade?.grader?.kind === "ai") t.count("ai.grade");
    }
  });

  const body = async <T = any>(c: Context): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw new EtudeError("request body must be JSON");
    }
  };
  const scopeOf = (c: Context): StudyScope => ({ deck: c.req.query("deck") || undefined, query: c.req.query("q") || undefined, ahead: c.req.query("ahead") === "1" || undefined, placement: c.req.query("placement") || undefined });

  syncRoutes(app, etude);
  accountRoutes(app as any, etude);

  app.post("/api/media", async (c) => {
    if (!c.req.header("content-type")?.includes("application/octet-stream")) return c.json({ error: "expected application/octet-stream" }, 415);
    const name = c.req.query("name") ?? "";
    if (!mediaType(name)) throw new EtudeError("unsupported media type; choose an image, audio, video or PDF file");
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_MEDIA_BYTES) {
            await reader.cancel();
            throw new EtudeError("media files must be 100 MiB or smaller", 413);
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    return c.json(etude.storeMedia(name, Buffer.concat(chunks)));
  });
  app.post("/api/media/import", async (c) => c.json(etude.importMedia((await body(c)).path)));

  // ------------------------------------------------------------- clean up
  app.get("/api/cleanup", (c) => {
    const media = etude.unusedMedia();
    return c.json({ leftover: etude.leftoverReport(), media: { count: media.length, bytes: media.reduce((n, f) => n + f.bytes, 0), files: media.slice(0, 200) } });
  });
  app.post("/api/cleanup/cards", async (c) => {
    const b = await body(c);
    return c.json(etude.deleteLeftoverCards({ type: b.type || undefined, face: b.face || undefined }));
  });
  app.post("/api/cleanup/media", (c) => c.json(etude.deleteUnusedMedia()));
  app.post("/api/occlusion", async (c) => {
    const b = await body(c);
    return c.json(etude.addOcclusion(b, { dryRun: !!b.dryRun || c.req.query("dryRun") === "1" }));
  });

  // ------------------------------------------------------------- decks
  // Notes (beta): pages with a document body.
  app.get("/api/notes", (c) => c.json(etude.notes.list({ archived: c.req.query("archived") === "1" })));
  app.get("/api/notes/graph", (c) => c.json(etude.notes.graph()));
  app.get("/api/notes/search", (c) => c.json(etude.notes.search(c.req.query("q") ?? "", Number(c.req.query("limit") ?? 20) || 20)));
  app.post("/api/notes", async (c) => {
    const b = await body(c);
    return c.json(etude.notes.create({ title: b.title, parentId: b.parentId ?? null, doc: b.doc, icon: b.icon, look: b.look, after: b.after ?? null, kind: b.kind, scene: b.scene, file: b.file }));
  });
  // A .excalidraw file as a canvas (its inline pictures go into the media).
  app.post("/api/notes/import-excalidraw", async (c) => {
    const b = await body(c);
    const { sceneFromExcalidraw } = await import("../core/notes.ts");
    if (typeof b.data !== "string" || b.data.length > 60 * 1024 * 1024) throw new EtudeError("give the drawing as data (the .excalidraw file's text, 60 MB at most)", b.data ? 413 : 400);
    let raw: unknown;
    try {
      raw = JSON.parse(b.data);
    } catch {
      throw new EtudeError("that file isn't an Excalidraw drawing (not JSON)");
    }
    const scene = sceneFromExcalidraw(raw, (name, data) => etude.storeMedia(name, data));
    const title = String(b.title ?? "").replace(/\.excalidraw(\.json)?$/i, "") || "Canvas";
    return c.json(etude.notes.create({ title, parentId: b.parentId ?? null, kind: "canvas", scene }));
  });
  app.post("/api/notes/import", async (c) => {
    const b = await body(c);
    const files = Array.isArray(b.files) ? b.files.map((f: any) => ({ path: String(f?.path ?? ""), text: String(f?.text ?? "") })) : [];
    if (files.reduce((n: number, f: { text: string }) => n + f.text.length, 0) > 50 * 1024 * 1024) throw new EtudeError("that's too much markdown at once (50 MB at most)", 413);
    const media = b.media && typeof b.media === "object" ? Object.fromEntries(Object.entries(b.media).filter(([, v]) => typeof v === "string" && /^\/media\/files\/[0-9a-f]{64}\.[a-z0-9]+$/.test(v as string))) as Record<string, string> : {};
    const pdfs = Array.isArray(b.pdfs) ? b.pdfs.filter((f: any) => typeof f?.path === "string" && typeof f?.file === "string").map((f: any) => ({ path: String(f.path), file: String(f.file) })) : [];
    return c.json(etude.notes.importMarkdown(files, { parentId: b.parentId ?? null, media, pdfs }));
  });
  app.get("/api/notes/:id", (c) => c.json(etude.notes.get(c.req.param("id"))));
  app.get("/api/notes/:id/backlinks", (c) => c.json(etude.notes.backlinks(c.req.param("id"))));
  app.get("/api/notes/:id/export", async (c) => {
    const { docToHtml, docToMarkdown } = await import("../core/notes-md.ts");
    const n = etude.notes.get(c.req.param("id"));
    const html = c.req.query("format") === "html";
    const name = (n.title.trim() || "Untitled").replace(/[\\/:*?"<>|]+/g, " ").trim();
    if (n.kind === "pdf") {
      const data = n.file ? etude.readMediaFile(n.file) : null;
      if (!data) throw new EtudeError("this PDF's file is missing from the media", 404);
      return new Response(new Uint8Array(data), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name.replace(/\.pdf$/i, ""))}.pdf` } });
    }
    if (n.kind === "canvas") {
      const { sceneToExcalidraw } = await import("../core/notes.ts");
      return new Response(JSON.stringify(sceneToExcalidraw(n.scene!, (m) => etude.readMediaFile(m)), null, 2), {
        headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}.excalidraw` },
      });
    }
    return new Response(html ? docToHtml(n.doc, n.title) : docToMarkdown(n.doc, n.title), {
      headers: { "content-type": html ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}.${html ? "html" : "md"}` },
    });
  });
  app.patch("/api/notes/:id", async (c) => {
    const b = await body(c);
    return c.json(etude.notes.update(c.req.param("id"), { title: b.title, doc: b.doc, icon: b.icon, look: b.look, kind: b.kind, scene: b.scene }));
  });
  app.post("/api/notes/:id/move", async (c) => {
    const b = await body(c);
    const index = b.index === undefined || b.index === null ? undefined : Number(b.index);
    return c.json(etude.notes.move(c.req.param("id"), b.parentId ?? null, index));
  });
  app.post("/api/notes/:id/archive", async (c) => {
    const b = await body(c);
    if (typeof b.archived !== "boolean") throw new EtudeError("archived must be a boolean");
    return c.json(etude.notes.setArchived(c.req.param("id"), b.archived));
  });
  app.delete("/api/notes/:id", (c) => c.json(etude.notes.delete(c.req.param("id"))));
  app.get("/api/decks", (c) => c.json(etude.deckTree({ archived: c.req.query("archived") === "1" })));
  app.get("/api/decks/archive", (c) => c.json(etude.archiveSummary()));
  app.post("/api/decks", async (c) => {
    const b = await body(c);
    etude.ensureDeck(String(b.name ?? ""));
    return c.json(etude.deck(String(b.name)));
  });
  app.post("/api/decks/order", async (c) => {
    const b = await body(c);
    return c.json({ order: etude.reorderDecks(String(b.parent ?? ""), Array.isArray(b.order) ? b.order.map(String) : []) });
  });
  app.post("/api/decks/move", async (c) => {
    const b = await body(c);
    const index = b.index === undefined || b.index === null ? undefined : Number(b.index);
    return c.json(etude.moveDeck(String(b.name ?? ""), String(b.parent ?? ""), index));
  });
  app.get("/api/deck", (c) => {
    const name = c.req.query("name") ?? "";
    return c.json({ ...etude.deck(name), typeSchedulers: etude.typeSchedulers(name) });
  });
  app.get("/api/deck/usage", (c) => c.json(etude.deckUsage(c.req.query("name") ?? "")));
  app.post("/api/deck/archive", async (c) => {
    const b = await body(c);
    if (typeof b.archived !== "boolean") throw new EtudeError("archived must be a boolean");
    return c.json(etude.setDeckArchived(c.req.query("name") ?? "", b.archived, { subdecks: b.subdecks === true }));
  });
  app.get("/api/deck/faces", (c) => c.json(etude.deckFaces(c.req.query("name") ?? "")));
  app.patch("/api/deck", async (c) => c.json(etude.updateDeck(c.req.query("name") ?? "", await body(c))));
  app.delete("/api/deck", async (c) => {
    const b = await body(c);
    etude.deleteDeck(c.req.query("name") ?? "", { items: b.items === true });
    return c.json({ ok: true });
  });

  // ----------------------------------------------------------- presets
  app.get("/api/presets", (c) => c.json(etude.listPresets()));
  app.put("/api/presets/:id", async (c) => c.json(etude.savePreset({ ...(await body(c)), id: c.req.param("id") })));
  app.delete("/api/presets/:id", (c) => {
    etude.deletePreset(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------- types
  app.get("/api/types", (c) => c.json(etude.listTypes()));
  // The definition without asset bytes; `assetFiles` lists them (name, size, hash).
  app.get("/api/types/:id", (c) => c.json({ ...etude.type(c.req.param("id")), assetFiles: etude.typeAssets(c.req.param("id")) }));
  app.put("/api/types/:id", async (c) => {
    const r = etude.saveTypeReport({ ...(await body(c)), id: c.req.param("id") });
    return c.json({ ...r.type, leftover: r.leftover });
  });
  // What a type's cards saved for themselves (etude.setPref): read when a card opens, written by the card frame.
  app.get("/api/types/:id/prefs", (c) => c.json(etude.typePrefs(c.req.param("id"))));
  app.put("/api/types/:id/prefs", async (c) => {
    const b = await body(c);
    return c.json(etude.setTypePref(c.req.param("id"), b.key, b.value ?? null));
  });
  app.delete("/api/types/:id/prefs", (c) => c.json(etude.resetTypePrefs(c.req.param("id"))));
  app.get("/api/types/:id/leftover", (c) => c.json(etude.leftoverReport({ type: c.req.param("id") })));
  app.get("/api/types/:id/usage", (c) => c.json(etude.typeUsage(c.req.param("id"))));
  app.get("/api/types/:id/decks", (c) => c.json(etude.typeDecks(c.req.param("id"))));
  app.delete("/api/types/:id", async (c) => {
    const r = etude.deleteType(c.req.param("id"), { items: !!(await body(c)).items });
    return c.json({ ok: true, ...r });
  });
  app.post("/api/types/:id/reset", (c) => {
    etude.resetType(c.req.param("id"));
    return c.json(etude.type(c.req.param("id")));
  });
  app.get("/api/type-folders", (c) => c.json(etude.listTypeFolders()));
  app.post("/api/type-folders", async (c) => c.json({ path: etude.createTypeFolder((await body(c)).path ?? "") }));
  app.post("/api/type-folders/rename", async (c) => {
    const b = await body(c);
    return c.json(etude.renameTypeFolder(b.from ?? "", b.to ?? ""));
  });
  app.post("/api/type-folders/delete", async (c) => c.json(etude.deleteTypeFolder((await body(c)).path ?? "")));
  app.post("/api/types/:id/move", async (c) => c.json({ id: c.req.param("id"), folder: etude.moveType(c.req.param("id"), (await body(c)).folder ?? "") }));
  app.post("/api/types-preview", async (c) => {
    const b = await body(c);
    return c.json(await etude.previewType(b.def, b.fields ?? {}, { seed: b.seed, face: b.face, answer: b.answer }));
  });

  // ------------------------------------------------------------- items
  app.get("/api/items", (c) =>
    c.json(etude.search(c.req.query("q") ?? "", { limit: Math.min(Number(c.req.query("limit") ?? 100), 1000), offset: Number(c.req.query("offset") ?? 0), order: c.req.query("order"), reverse: c.req.query("reverse") === "1" })),
  );
  app.get("/api/items/:id", (c) => c.json(etude.item(c.req.param("id"))));
  app.put("/api/items/:id", async (c) => {
    const b = await body(c);
    const result = etude.upsertItem({ ...b, id: c.req.param("id") });
    return c.json({ result, item: etude.item(c.req.param("id")) });
  });
  app.post("/api/items/:id/preview", async (c) => {
    const b = await body(c);
    return c.json(etude.prepare(c.req.param("id"), b.face ?? "main", Number(b.seed ?? 1)));
  });
  app.post("/api/items/:id/ai-edit", async (c) => {
    const b = await body(c);
    return c.json(await etude.suggestItemEdit(c.req.param("id"), b.instruction, { fields: b.fields }));
  });
  app.post("/api/items-bulk", async (c) => {
    const b = await body(c);
    const ids: string[] = b.ids ?? [];
    switch (b.action) {
      case "archive": etude.setArchived(ids, true); break;
      case "unarchive": etude.setArchived(ids, false); break;
      case "move": etude.moveItems(ids, String(b.deck)); break;
      case "tag": etude.tagItems(ids, b.add ?? [], b.remove ?? []); break;
      case "delete": etude.deleteItems(ids); break;
      default: throw new EtudeError(`unknown action ${b.action}`);
    }
    return c.json({ ok: true, count: ids.length });
  });
  app.post("/api/cards-bulk", async (c) => {
    const b = await body(c);
    let ids: number[] = (b.cardIds ?? []).map(Number);
    switch (b.action) {
      case "suspend": ids = etude.setSuspended(ids, true); break;
      case "suspend-note": ids = etude.setSuspended(etude.noteCards(ids), true); break;
      case "unsuspend": etude.setSuspended(ids, false); break;
      case "reset": etude.resetCards(ids); break;
      case "bury": ids = etude.setBuried(ids, undefined, { preserveExisting: true }); break;
      case "bury-note": ids = etude.setBuried(etude.noteCards(ids), undefined, { preserveExisting: true }); break;
      case "unbury": etude.setBuried(ids, null); break;
      default: throw new EtudeError(`unknown action ${b.action}`);
    }
    return c.json({ ok: true, count: ids.length, cardIds: ids });
  });

  // ------------------------------------------------------------- study
  app.get("/api/study/counts", (c) => c.json(etude.counts(scopeOf(c))));
  app.get("/api/study/next", (c) => c.json(etude.next(scopeOf(c), { exclude: c.req.query("exclude") ? Number(c.req.query("exclude")) : undefined })));
  app.get("/api/study/card/:cardId", (c) => c.json(etude.present(Number(c.req.param("cardId")), c.req.query("seed") ? Number(c.req.query("seed")) : undefined)));
  app.post("/api/study/submit", async (c) => {
    const b = await body(c);
    return c.json(await etude.submit(Number(b.cardId), Number(b.seed), b.answer ?? null, { practice: !!b.practice, asOf: typeof b.asOf === "string" ? b.asOf : undefined, placement: typeof b.placement === "string" ? b.placement : !!b.placement }));
  });
  app.post("/api/study/feedback", async (c) => c.json(await etude.feedback(Number((await body(c)).attemptId))));
  app.post("/api/study/rate", async (c) => {
    const b = await body(c);
    return c.json(etude.rate(Number(b.cardId), Number(b.rating ?? 0) as Rating | 0, { attemptId: b.attemptId ? Number(b.attemptId) : undefined, durationMs: b.durationMs, practice: !!b.practice }));
  });
  app.get("/api/schedulers", (c) => c.json(etude.listSchedulers()));
  app.get("/api/schedulers/:id", (c) => c.json(etude.scheduler(c.req.param("id"))));
  app.put("/api/schedulers/:id", async (c) => c.json(etude.saveScheduler({ ...(await body(c)), id: c.req.param("id") })));
  app.delete("/api/schedulers/:id", (c) => {
    etude.deleteScheduler(c.req.param("id"));
    return c.json({ deleted: c.req.param("id") });
  });
  app.post("/api/schedulers/:id/reset", (c) => {
    etude.resetScheduler(c.req.param("id"));
    return c.json({ reset: c.req.param("id") });
  });
  app.post("/api/study/undo", (c) => c.json(etude.undo()));
  app.get("/api/watch/list", (c) => c.json({ cards: etude.watchList(scopeOf(c)) }));
  app.get("/api/watch/card/:cardId", (c) => c.json(etude.watchCard(Number(c.req.param("cardId")), c.req.query("seed") ? Number(c.req.query("seed")) : undefined)));
  app.post("/api/watch/grade", async (c) => {
    const b = await body(c);
    return c.json(await etude.watchGrade(Number(b.cardId), Number(b.seed), b.answer, { ai: !!b.ai }));
  });
  app.post("/api/reschedule", async (c) => c.json(etude.reschedule(await body(c))));
  app.post("/api/optimize", async (c) => {
    const b = await body(c);
    const target = b.preset ? { preset: String(b.preset) } : { deck: String(b.deck ?? "") };
    return c.json(await etude.optimizeWeights(target, { apply: !!b.apply, reschedule: !!b.reschedule }));
  });

  // ------------------------------------------------- stats, tags, packs
  app.get("/api/stats", (c) => c.json(etude.stats(scopeOf(c), Number(c.req.query("days") ?? 30) || 30)));
  app.get("/api/stats/skills", (c) => c.json(etude.learnerSummary(c.req.query("deck") ?? "")));
  app.get("/api/tags", (c) => c.json(etude.listTags()));
  app.put("/api/tags", async (c) => {
    const b = await body(c);
    etude.setTagMeta(String(b.tag), b);
    return c.json({ ok: true });
  });
  app.post("/api/tags/rename", async (c) => {
    const b = await body(c);
    etude.renameTag(String(b.from), String(b.to));
    return c.json({ ok: true });
  });
  app.post("/api/import", async (c) => c.json(etude.importPack(await body(c), { dryRun: c.req.query("dryRun") === "1" })));
  // The package arrives as the raw body; flags are query parameters.
  app.post("/api/anki/import", async (c) => {
    const data = await readBody(c, MAX_ANKI_UPLOAD, "Anki packages must be 2 GiB or smaller");
    if (!data.length) throw new EtudeError("the Anki package is empty");
    return c.json(
      etude.importAnki(data, {
        dryRun: ["1", "true"].includes(c.req.query("dryRun") ?? ""),
        scheduling: !["0", "false"].includes(c.req.query("scheduling") ?? ""),
        deckPrefix: c.req.query("deckPrefix") || undefined,
      }),
    );
  });
  app.get("/api/export", (c) => c.json(etude.exportPack({ ...scopeOf(c), name: c.req.query("name") || undefined })));
  app.get("/api/settings", (c) => {
    const s = etude.settings();
    const keys = [s.ai.decision?.apiKeyEnv, chatProviderKeyEnv(s.ai.feedback), chatProviderKeyEnv(s.ai.vision)].filter(Boolean) as string[];
    return c.json({
      ...s,
      keyStatus: Object.fromEntries(keys.map((k) => [k, !!process.env[k]])),
      dbPath: etude.path,
      mediaDir: etude.mediaDir,
      version: VERSION,
      defaults: DEFAULT_SETTINGS,
    });
  });
  app.get("/api/defaults", (c) => c.json(DEFAULT_PRESET));
  app.post("/api/ai/test", async (c) => c.json(await etude.testAi()));
  app.patch("/api/settings", async (c) => {
    const next = etude.updateSettings(await body(c));
    // A Privacy toggle turned off drops what was waiting to be sent, at once.
    telemetryFor(etude).applyPrefs();
    return c.json(next);
  });
  // Anonymous error reports and usage counts from the app's window (Settings → Privacy; src/core/telemetry.ts).
  app.get("/api/telemetry", (c) => {
    const t = telemetryFor(etude);
    return c.json({ active: t.active, allowed: telemetryAllowed(), forced: /^(1|on|true|yes)$/i.test(process.env.ETUDE_TELEMETRY ?? ""), prefs: t.prefs(), pending: t.pending() });
  });
  app.post("/api/telemetry/report", async (c) => {
    const b = await body<{ kind?: unknown; message?: unknown; stack?: unknown }>(c);
    const kind = typeof b.kind === "string" ? b.kind : "window.error";
    return c.json({ queued: telemetryFor(etude).report({ kind, message: String(b.message ?? "").slice(0, 2000), stack: String(b.stack ?? "").slice(0, 16_000) }) });
  });
  app.post("/api/telemetry/event", async (c) => {
    const b = await body<{ name?: unknown }>(c);
    if (!isEventName(b.name)) throw new EtudeError(`unknown event "${String(b.name)}"`);
    return c.json({ counted: telemetryFor(etude).count(b.name) });
  });
  app.post("/api/telemetry/flush", async (c) => c.json(await telemetryFor(etude).flush()));
  // One API key into $ETUDE_HOME/.env. The answer says whether it is set, never what it is.
  app.post("/api/settings/key", async (c) => {
    const b = await body<{ name?: unknown; value?: unknown }>(c);
    if (b.value != null && typeof b.value !== "string") throw new EtudeError("value must be text");
    return c.json(etude.setApiKey(String(b.name ?? ""), (b.value as string | null | undefined) ?? null));
  });
  app.get("/api/onboarding", (c) => c.json(etude.onboardingStatus()));

  // ------------------------------------------------------- ChatGPT plan
  // The sign-in listener runs here, so its 127.0.0.1 callback only reaches a browser on this machine.
  let login: { url: string; started: number; opened?: boolean; error?: string } | null = null;
  let models: { at: number; rows: { slug: string; displayName: string }[] } | null = null;
  const loginState = () => (login ? (login.error ? { state: "error", error: login.error } : { state: "pending", url: login.url }) : null);
  const requestHost = (c: Context) => (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").split(",")[0].trim();
  const localBrowser = (c: Context) => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(requestHost(c).replace(/:\d+$/, ""));

  app.post("/api/chatgpt/login", async (c) => {
    const host = requestHost(c);
    // The phone apps run this app in the page's worker with their own listener and browser sheet.
    const nativeApp = !!chatGptNativeHost();
    if (!nativeApp && !localBrowser(c))
      return c.json({
        remote: true,
        host,
        cli: "etude settings chatgpt login",
        message:
          "Sign-in finishes on 127.0.0.1, which this browser can't reach. Run `etude settings chatgpt login` on the machine running Etude; if that machine has no browser, sign in here and run `etude settings chatgpt import <file>` there with the copied ~/.etude/chatgpt.json.",
      });
    if (login && !login.error) return c.json({ pending: true, url: login.url, host, opened: login.opened });
    const session = await etude.chatgptLogin().catch((e) => {
      throw new EtudeError(`couldn't start ChatGPT sign-in: ${(e as Error).message}`, 502);
    });
    const current: { url: string; started: number; opened?: boolean; error?: string } = { url: session.url, started: Date.now(), opened: session.opened };
    login = current;
    session.wait.then(
      () => {
        if (login === current) login = null;
      },
      (e: Error) => {
        if (login === current) current.error = e.message;
      },
    );
    return c.json({ pending: true, url: session.url, host, opened: session.opened });
  });

  app.get("/api/chatgpt/status", async (c) => {
    const status = etude.chatgptStatus();
    if (status.signedIn && status.plan === "enabled" && (!models || Date.now() - models.at > 5 * 60 * 1000)) {
      const rows = await etude.chatgptModels().catch(() => []);
      models = { at: Date.now(), rows };
    }
    return c.json({
      ...status,
      hostId: readChatGptHostId(etude.home),
      models: status.signedIn ? (models?.rows ?? []) : [],
      login: loginState(),
    });
  });

  app.post("/api/chatgpt/logout", async (c) => {
    login = null;
    models = null;
    return c.json({ ...(await etude.chatgptLogout()), ...etude.chatgptStatus() });
  });
  app.get("/api/themes", (c) => c.json({ selected: etude.currentTheme().id, themes: etude.listThemes() }));
  app.put("/api/themes/:id", async (c) => c.json(etude.saveTheme({ ...(await body(c)), id: c.req.param("id") })));
  app.delete("/api/themes/:id", (c) => c.json(etude.deleteTheme(c.req.param("id"))));
  app.put("/api/theme", async (c) => c.json(etude.selectTheme(String((await body(c)).id ?? ""))));

  // ------------------------------------------------------------- agent
  const agent = agentFor(etude);
  app.get("/api/agent/models", async (c) => c.json(await agent.models(c.req.query("force") === "1")));
  app.get("/api/agent/conversations", (c) => c.json({ conversations: agent.listConversations(), running: agent.listConversations().filter((x) => agent.runningTurn(x.id)).map((x) => x.id) }));
  app.post("/api/agent/conversations", async (c) => c.json(agent.createConversation((await body(c)).model ?? null)));
  app.get("/api/agent/conversations/:id", (c) => c.json({ ...agent.conversation(c.req.param("id")), running: agent.runningTurn(c.req.param("id")) }));
  app.delete("/api/agent/conversations/:id", (c) => c.json(agent.deleteConversation(c.req.param("id"))));
  app.patch("/api/agent/conversations/:id", async (c) => {
    const b = await body(c);
    if (typeof b.model === "string") agent.setConversationModel(c.req.param("id"), b.model);
    if (typeof b.title === "string") agent.renameConversation(c.req.param("id"), b.title);
    return c.json(agent.conversation(c.req.param("id")));
  });
  app.post("/api/agent/conversations/:id/attachments", async (c) => {
    const id = c.req.param("id");
    const name = c.req.query("name") ?? "file";
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > AGENT_MAX_ATTACHMENT_BYTES) {
            await reader.cancel();
            throw new AgentError("attachments must be 50 MB or smaller", 413);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const meta = agent.addAttachment(id, name, Buffer.concat(chunks));
    return c.json(await agent.prepareAttachment(id, meta.id));
  });
  app.get("/api/agent/conversations/:id/attachments/:att", (c) => {
    const m = agent.attachment(c.req.param("id"), c.req.param("att"));
    return sendFile(c, m.path, { mime: m.mime });
  });
  app.post("/api/agent/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    const b = await body(c);
    agent.conversation(id);
    if (agent.runningTurn(id)) throw new AgentError("the agent is still working on this conversation", 409);
    return streamSSE(c, async (sse) => {
      const queue: AgentEvent[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      const push = (e: AgentEvent) => {
        queue.push(e);
        wake?.();
      };
      const turn = agent
        .send(id, { text: String(b.text ?? ""), attachments: Array.isArray(b.attachments) ? b.attachments.map(String) : [], model: b.model ?? undefined, page: typeof b.page === "string" ? b.page : undefined }, push)
        .catch((e) => push({ type: "error", error: (e as Error).message }))
        .finally(() => {
          finished = true;
          wake?.();
        });
      // A closed tab doesn't stop the turn; the reply is saved and shows up when the panel reloads.
      sse.onAbort(() => {});
      while (!finished || queue.length) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = null;
        while (queue.length) {
          const e = queue.shift()!;
          await sse.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {});
        }
      }
      await turn;
    });
  });
  app.post("/api/agent/turns/:turn/confirm", async (c) => {
    const b = await body(c);
    if (!agent.confirm(c.req.param("turn"), String(b.callId ?? ""), !!b.allow)) throw new AgentError("nothing is waiting for that confirmation", 404);
    return c.json({ ok: true });
  });
  app.post("/api/agent/turns/:turn/stop", (c) => c.json({ stopped: agent.stop(c.req.param("turn")) }));
  app.post("/api/agent/conversations/:id/undo", async (c) => {
    const b = await body(c);
    return c.json(agent.undo(c.req.param("id"), b.messageId ? Number(b.messageId) : undefined));
  });

  // ------------------------------------------------------------- update
  // `?check=1` asks the remote (at most every 10 min unless `force=1`); without it, the last known state.
  app.get("/api/update", async (c) =>
    c.json({ ...(await updateStatus({ fetch: c.req.query("check") === "1", force: c.req.query("force") === "1" })), canRestart: !!opts.onRestart }),
  );
  app.post("/api/update", async (c) => {
    const out = await applyUpdate();
    const restarting = out.result === "updated" && !!opts.onRestart;
    // Answer first, then restart on the new code.
    if (restarting) setTimeout(() => opts.onRestart!(), 250);
    return c.json({ ...out, restarting });
  });

  // ------------------------------------------------------------- market
  app.get("/api/market", async (c) => {
    const cfg = marketSettings(etude);
    const refresh = c.req.query("refresh") === "1";
    const [index, soon] = await Promise.all([fetchIndex(cfg.url, { refresh }), fetchComingSoon(cfg.url, { refresh })]);
    const installed = installedEntries(etude);
    return c.json({ ...cfg, generated: index.generated, comingSoon: soon.entries, entries: index.entries.map((x) => ({ ...x, installed: installState(etude, x, installed), installedIds: installed[x.id]?.kind === x.kind ? installed[x.id].ids : [] })), selectedTheme: etude.currentTheme().id });
  });
  app.get("/api/market/entry/:kind/:id", async (c) => {
    const kind = c.req.param("kind") as MarketKind;
    const file = await fetchEntry(marketSettings(etude).url, { kind, id: c.req.param("id"), path: entryPath(kind, c.req.param("id")) });
    return c.json(file);
  });
  app.get("/api/market/cover/:kind/:id", async (c) => {
    const url = marketSettings(etude).url;
    const hit = (await fetchIndex(url)).entries.find((x) => x.kind === c.req.param("kind") && x.id === c.req.param("id"));
    if (!hit?.cover) return c.json({ error: "no cover" }, 404);
    const { body, type } = await fetchCover(url, hit.cover);
    return c.body(new Uint8Array(body), 200, { "Content-Type": type, "Cache-Control": "max-age=600" });
  });
  app.get("/api/market/media/:kind/:id/:index", async (c) => {
    const url = marketSettings(etude).url;
    const hit = (await fetchIndex(url)).entries.find((x) => x.kind === c.req.param("kind") && x.id === c.req.param("id"));
    const slot = c.req.param("index");
    const path = /^\d+$/.test(slot) ? hit?.media?.[Number(slot)] : undefined;
    if (!path) return c.json({ error: "no media" }, 404);
    const { body, type } = await fetchMarketMedia(url, path);
    return c.body(new Uint8Array(body), 200, { "Content-Type": type, "Cache-Control": "max-age=600", "X-Content-Type-Options": "nosniff" });
  });
  // Coming soon: decks being made, listed in the catalog's coming-soon.json. Pictures only by slot, never by path.
  app.get("/api/market/coming-soon", async (c) => c.json(await fetchComingSoon(marketSettings(etude).url, { refresh: c.req.query("refresh") === "1" })));
  app.get("/api/market/coming-soon/:id/:slot{cover|[0-9]+}", async (c) => {
    const url = marketSettings(etude).url;
    const hit = (await fetchComingSoon(url)).entries.find((x) => x.id === c.req.param("id"));
    const slot = c.req.param("slot");
    const path = slot === "cover" ? hit?.cover : hit?.media[Number(slot)];
    if (!path) return c.json({ error: slot === "cover" ? "no cover" : "no media" }, 404);
    const { body, type } = await fetchComingSoonAsset(url, path);
    return c.body(new Uint8Array(body), 200, { "Content-Type": type, "Cache-Control": "max-age=600", "X-Content-Type-Options": "nosniff" });
  });
  app.post("/api/market/install", async (c) => {
    const b = await body(c);
    const out = await installEntry(etude, String(b.id ?? ""), { kind: b.kind, dryRun: !!b.dryRun });
    if (b.use && out.entry.kind === "theme" && !b.dryRun) etude.selectTheme(out.ids[0]);
    // The anonymous download count: not awaited, and a server that's down never fails the install.
    void pingFreeInstall(etude, out, marketSettings(etude).url);
    return c.json(out);
  });
  app.post("/api/market/forget", async (c) => c.json({ forgot: forgetInstall(etude, String((await body(c)).id ?? "")) }));
  app.get("/api/market/publish/status", (c) => c.json({ ...ghStatus(), repo: marketSettings(etude).repo }));
  app.post("/api/market/publish", async (c) => {
    const b = await body(c);
    const repo = marketSettings(etude).repo;
    const gh = b.dryRun ? null : ghStatus();
    const file = buildSubmission(etude, { ...b, author: b.author || (gh?.ok ? gh.login : undefined) });
    const preview = { path: entryPath(file.kind, file.id), bytes: Buffer.byteLength(entryJson(file)), entry: { ...file, content: undefined }, summary: summarize(file), manualUrl: manualPublishUrl(repo, file), repo };
    if (b.dryRun) return c.json({ dryRun: true, ...preview, ...(b.full ? { file } : {}) });
    if (!gh?.ok) return c.json({ error: gh?.reason ?? "gh isn't available", ...preview }, 424);
    return c.json({ ...publishFile(file, { repo }), ...preview });
  });

  // --------------------------------------------- card frames and runtime
  const frameAssets = (id: string) => ({ type: id, files: etude.typeAssets(id) });
  // Runs code from a note's code blocks (src/core/run-frame.ts): sandboxed, no access to the app.
  app.get("/frame/run", (c) => c.body(runFrameHtml(publicBase(c)), 200, FRAME_HEADERS));
  app.get("/frame/:type", (c) => {
    const def = etude.type(c.req.param("type"));
    const base = publicBase(c);
    return c.body(cardFrame(def, base, frameAssets(def.id)), 200, FRAME_HEADERS);
  });
  // Unsaved previews (type editor, Market) as a served document: a srcdoc frame would inherit the
  // app page's Content-Security-Policy, which doesn't allow a card's inline scripts.
  const docs = new Map<string, string>();
  app.post("/api/frame-doc", async (c) => {
    const b = await body(c);
    if (typeof b.html !== "string" || b.html.length > 8 * 1024 * 1024) throw new EtudeError("html must be text under 8 MiB");
    const id = globalThis.crypto.randomUUID();
    docs.set(id, b.html);
    while (docs.size > 64) docs.delete(docs.keys().next().value!);
    return c.json({ url: `/frame-doc/${id}` });
  });
  app.get("/frame-doc/:id", (c) => {
    const html = docs.get(c.req.param("id"));
    return html === undefined ? c.text("not found", 404) : c.body(html, 200, FRAME_HEADERS);
  });
  // The type editor previews unsaved code: it posts the definition and gets a frame back.
  app.post("/api/frame", async (c) => {
    const b = await body(c);
    const base = publicBase(c);
    // An unsaved edit of a stored type still reaches the stored assets.
    const id = typeof b.def?.id === "string" ? b.def.id : "";
    return c.json({ html: cardFrame(b.def, base, frameAssets(id)) });
  });
  // Python for code blocks. Pyodide's own files come with Etude; packages (numpy, matplotlib…) are fetched the
  // first time a block imports them, checked against Pyodide's list of hashes, and kept in $ETUDE_HOME.
  // pdf.js's fonts, character maps and decoders, for PDFs in Notes (the app loads pdf.js itself).
  app.get("/runtime/pdfjs/:dir/:file", (c) => {
    const dir = c.req.param("dir");
    const f = c.req.param("file");
    if (!["standard_fonts", "cmaps", "wasm"].includes(dir) || !/^[\w.-]+$/.test(f)) return c.text("not found", 404);
    let root: string;
    try {
      root = dirname(require.resolve("pdfjs-dist/package.json"));
    } catch {
      return c.text("not found", 404);
    }
    return sendFile(c, join(root, dir, f), { cache: "public, max-age=604800" });
  });
  app.get("/runtime/pyodide/:file", async (c) => {
    const f = await pyodideFile(c.req.param("file"), etude.home);
    if (!f) return c.text("not found", 404, { "Access-Control-Allow-Origin": "*" });
    return sendFile(c, f, { cors: true, cache: "public, max-age=604800" });
  });
  app.get("/runtime/vendor/*", (c) => {
    const name = c.req.path.slice("/runtime/vendor/".length);
    const p = vendorPath(name);
    return p ? sendFile(c, p, { cors: true, cache: "public, max-age=86400" }) : c.text("not found", 404);
  });
  // The editor kit is built with the web app (web/dist/kit) and loaded by card frames on demand.
  app.get("/runtime/kit/:file", (c) => {
    const f = c.req.param("file");
    if (!/^[\w.-]+\.js$/.test(f) || !opts.kitDir) return c.text("not found", 404);
    return sendFile(c, join(opts.kitDir, f), { cors: true, cache: f === "kit.js" ? "no-cache" : "public, max-age=31536000, immutable" });
  });
  app.get("/runtime/:file", (c) => {
    const f = c.req.param("file");
    if (!/^[\w.-]+$/.test(f)) return c.text("not found", 404);
    return sendFile(c, join(ROOT, "runtime", f), { cors: true });
  });
  // A type's asset files. `?h=` is the content hash `etude.asset()` puts in the URL: when it matches,
  // the file can be cached for good, and a changed asset gets a new URL.
  app.get("/type-assets/:type/:name", (c) => {
    const name = c.req.param("name");
    const asset = ASSET_NAME.test(name) ? etude.typeAsset(c.req.param("type"), name) : undefined;
    const headers: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    };
    if (!asset) return c.text("not found", 404, headers);
    headers["Content-Type"] = assetMime(name);
    headers["Cache-Control"] = c.req.query("h") === asset.hash ? "public, max-age=31536000, immutable" : "no-cache";
    headers["ETag"] = `"${asset.hash}"`;
    if (c.req.header("if-none-match") === headers.ETag) return c.body(null, 304, headers);
    return c.body(new Uint8Array(asset.bytes), 200, headers);
  });
  app.get("/media/*", (c) => {
    const rel = normalize(c.req.path.slice("/media/".length));
    const full = resolve(etude.mediaDir, rel);
    if (!full.startsWith(resolve(etude.mediaDir) + sep)) return c.text("not found", 404);
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    c.header("X-Content-Type-Options", "nosniff");
    // A file that isn't here may still be on its way from another device: never keep the miss.
    if (!existsSync(full) || !statSync(full).isFile()) return c.text("not found", 404, { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    // Card frames have an opaque origin, and @font-face needs CORS even for same-origin paths.
    return sendFile(c, full, { cors: true, mime: mediaType(full)?.mime, cache: rel.startsWith(`files${sep}`) ? "public, max-age=31536000, immutable" : undefined });
  });

  // ----------------------------------------------------------- web app
  if (opts.webDist) {
    const dist = opts.webDist;
    app.get("*", (c) => {
      const rel = normalize(c.req.path).replace(/^[\\/]+/, "");
      const full = resolve(dist, rel);
      if (rel && full.startsWith(resolve(dist) + sep) && existsSync(full) && statSync(full).isFile())
        return withAppCsp(sendFile(c, full, { cache: rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache" }), full);
      return withAppCsp(sendFile(c, join(dist, "index.html")), "index.html");
    });
  }
  return app;
}
