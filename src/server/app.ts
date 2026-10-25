// HTTP API, card frames, the card runtime and the web app.
import { Hono, type Context } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DEFAULT_SETTINGS, Etude, EtudeError, type StudyScope } from "../core/engine.ts";
import { DEFAULT_PRESET, type Rating } from "../core/model.ts";
import { cardFrame } from "./frame.ts";

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

function sendFile(c: Context, path: string, opts: { cors?: boolean; cache?: string } = {}) {
  if (!existsSync(path) || !statSync(path).isFile()) return c.text("not found", 404);
  const headers: Record<string, string> = { "Content-Type": MIME[extname(path)] ?? "application/octet-stream", "Cache-Control": opts.cache ?? "no-cache" };
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
}

export function createApp(etude: Etude, opts: AppOptions = {}) {
  const app = new Hono();
  opts = { ...opts, kitDir: opts.kitDir ?? [opts.webDist && join(opts.webDist, "kit"), join(ROOT, "web", "dist", "kit")].find((d) => d && existsSync(join(d, "kit.js"))) ?? null };

  app.onError((err, c) => {
    if (err instanceof EtudeError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: String(err?.message ?? err) }, 500);
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
      // The Anki importer takes the package itself, so it's the one route that may send bytes.
      const binary = c.req.method === "POST" && c.req.path === "/api/anki/import" && ct.includes("application/octet-stream");
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

  const body = async <T = any>(c: Context): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw new EtudeError("request body must be JSON");
    }
  };
  const scopeOf = (c: Context): StudyScope => ({ deck: c.req.query("deck") || undefined, query: c.req.query("q") || undefined });

  // ------------------------------------------------------------- decks
  app.get("/api/decks", (c) => c.json(etude.deckTree()));
  app.post("/api/decks", async (c) => {
    const b = await body(c);
    etude.ensureDeck(String(b.name ?? ""));
    return c.json(etude.deck(String(b.name)));
  });
  app.get("/api/deck", (c) => c.json(etude.deck(c.req.query("name") ?? "")));
  app.patch("/api/deck", async (c) => c.json(etude.updateDeck(c.req.query("name") ?? "", await body(c))));
  app.delete("/api/deck", (c) => {
    etude.deleteDeck(c.req.query("name") ?? "");
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
  app.get("/api/types/:id", (c) => c.json(etude.type(c.req.param("id"))));
  app.put("/api/types/:id", async (c) => c.json(etude.saveType({ ...(await body(c)), id: c.req.param("id") })));
  app.delete("/api/types/:id", (c) => {
    etude.deleteType(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/types/:id/reset", (c) => {
    etude.resetType(c.req.param("id"));
    return c.json(etude.type(c.req.param("id")));
  });
  app.post("/api/types-preview", async (c) => {
    const b = await body(c);
    return c.json(await etude.previewType(b.def, b.fields ?? {}, { seed: b.seed, face: b.face, answer: b.answer }));
  });

  // ------------------------------------------------------------- items
  app.get("/api/items", (c) =>
    c.json(etude.search(c.req.query("q") ?? "", { limit: Math.min(Number(c.req.query("limit") ?? 100), 1000), offset: Number(c.req.query("offset") ?? 0), order: c.req.query("order") })),
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
    const ids: number[] = (b.cardIds ?? []).map(Number);
    switch (b.action) {
      case "suspend": etude.setSuspended(ids, true); break;
      case "unsuspend": etude.setSuspended(ids, false); break;
      case "reset": etude.resetCards(ids); break;
      default: throw new EtudeError(`unknown action ${b.action}`);
    }
    return c.json({ ok: true, count: ids.length });
  });

  // ------------------------------------------------------------- study
  app.get("/api/study/counts", (c) => c.json(etude.counts(scopeOf(c))));
  app.get("/api/study/next", (c) => c.json(etude.next(scopeOf(c), { exclude: c.req.query("exclude") ? Number(c.req.query("exclude")) : undefined })));
  app.get("/api/study/card/:cardId", (c) => c.json(etude.present(Number(c.req.param("cardId")), c.req.query("seed") ? Number(c.req.query("seed")) : undefined)));
  app.post("/api/study/submit", async (c) => {
    const b = await body(c);
    return c.json(await etude.submit(Number(b.cardId), Number(b.seed), b.answer ?? null, { practice: !!b.practice }));
  });
  app.post("/api/study/feedback", async (c) => c.json(await etude.feedback(Number((await body(c)).attemptId))));
  app.post("/api/study/rate", async (c) => {
    const b = await body(c);
    return c.json(etude.rate(Number(b.cardId), Number(b.rating) as Rating, { attemptId: b.attemptId ? Number(b.attemptId) : undefined, durationMs: b.durationMs, practice: !!b.practice }));
  });
  app.post("/api/study/undo", (c) => c.json(etude.undo()));
  app.post("/api/reschedule", async (c) => c.json(etude.reschedule(await body(c))));

  // ------------------------------------------------- stats, tags, packs
  app.get("/api/stats", (c) => c.json(etude.stats(scopeOf(c), Number(c.req.query("days") ?? 30) || 30)));
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
    const data = Buffer.from(await c.req.arrayBuffer());
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
    const keys = [s.ai.decision?.apiKeyEnv, s.ai.feedback?.apiKeyEnv, s.ai.vision?.apiKeyEnv].filter(Boolean) as string[];
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
  app.patch("/api/settings", async (c) => c.json(etude.updateSettings(await body(c))));
  app.get("/api/themes", (c) => c.json({ selected: etude.currentTheme().id, themes: etude.listThemes() }));
  app.put("/api/themes/:id", async (c) => c.json(etude.saveTheme({ ...(await body(c)), id: c.req.param("id") })));
  app.delete("/api/themes/:id", (c) => c.json(etude.deleteTheme(c.req.param("id"))));
  app.put("/api/theme", async (c) => c.json(etude.selectTheme(String((await body(c)).id ?? ""))));

  // --------------------------------------------- card frames and runtime
  app.get("/frame/:type", (c) => {
    const def = etude.type(c.req.param("type"));
    const base = publicBase(c);
    return c.body(cardFrame(def, base), 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
  });
  // The type editor previews unsaved code: it posts the definition and gets a frame back.
  app.post("/api/frame", async (c) => {
    const b = await body(c);
    const base = publicBase(c);
    return c.json({ html: cardFrame(b.def, base) });
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
  app.get("/media/*", (c) => {
    const rel = normalize(c.req.path.slice("/media/".length));
    const full = resolve(etude.mediaDir, rel);
    if (!full.startsWith(resolve(etude.mediaDir) + "/")) return c.text("not found", 404);
    // Card frames have an opaque origin, and @font-face needs CORS even for same-origin paths.
    return sendFile(c, full, { cors: true });
  });

  // ----------------------------------------------------------- web app
  if (opts.webDist) {
    const dist = opts.webDist;
    app.get("*", (c) => {
      const rel = normalize(c.req.path).replace(/^\/+/, "");
      const full = resolve(dist, rel);
      if (rel && full.startsWith(resolve(dist)) && existsSync(full) && statSync(full).isFile())
        return sendFile(c, full, { cache: rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
      return sendFile(c, join(dist, "index.html"));
    });
  }
  return app;
}
