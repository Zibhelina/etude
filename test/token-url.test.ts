// A server token given in the address (?token=…, as the desktop app and `etude serve --token` hand it
// out) is kept by the app and taken out of the address; no page or frame sends a Referer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";

test("every response says Referrer-Policy: no-referrer: pages, frames, the API, errors and refusals", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-referrer-"));
  const e = await Etude.open(join(dir, "etude.db"));
  t.after(() => { e.close(); rmSync(dir, { recursive: true, force: true }); });
  const dist = join(dir, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
  const open = createApp(e, { webDist: dist });
  const guarded = createApp(e, { webDist: dist, token: "s3cret" });
  const cases: [ReturnType<typeof createApp>, string, number][] = [
    [open, "/study?deck=x&token=s3cret", 200],
    [open, "/frame/basic", 200],
    [open, "/api/decks", 200],
    [open, "/api/items/nope", 404],
    [guarded, "/api/decks", 401],
  ];
  for (const [app, path, status] of cases) {
    const r = await app.request(path);
    assert.equal(r.status, status, path);
    assert.equal(r.headers.get("referrer-policy"), "no-referrer", path);
  }
});

type Win = { search: string; storage: Map<string, string>; failSet?: boolean };

/** Loads web/src/lib/transport.ts as a page with this address and storage would, and reports what it did. */
async function loadTransport(name: string, w: Win) {
  const replaced: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = ["location", "history", "localStorage"].map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  Object.defineProperty(g, "location", { configurable: true, value: { search: w.search, pathname: "/study", hash: "#top", href: `http://127.0.0.1:4610/study${w.search}#top`, origin: "http://127.0.0.1:4610" } });
  Object.defineProperty(g, "history", { configurable: true, value: { state: { n: 1 }, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) } });
  Object.defineProperty(g, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => w.storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (w.failSet) throw new Error("storage is off");
        w.storage.set(k, v);
      },
    },
  });
  try {
    const mod = await import(`../web/src/lib/transport.ts?${name}`);
    return { token: mod.apiToken() as string | null, replaced };
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(g, k, d) : delete g[k];
  }
}

test("the app keeps a ?token= from the address and takes it out, leaving the rest of the address", async () => {
  const storage = new Map<string, string>();
  const first = await loadTransport("first", { search: "?deck=Physics&token=s3cret", storage });
  assert.equal(first.token, "s3cret");
  assert.equal(storage.get("etude.token"), "s3cret");
  assert.deepEqual(first.replaced, ["/study?deck=Physics#top"]);

  const only = await loadTransport("only", { search: "?token=n3w", storage });
  assert.deepEqual(only.replaced, ["/study#top"]);

  // Later visits read the stored token and leave the address alone.
  const later = await loadTransport("later", { search: "?deck=Physics", storage });
  assert.equal(later.token, "n3w");
  assert.deepEqual(later.replaced, []);

  // Without storage the token still works for this page, and stays in the address so a reload keeps it.
  const blocked = await loadTransport("blocked", { search: "?token=s3cret", storage: new Map(), failSet: true });
  assert.equal(blocked.token, "s3cret");
  assert.deepEqual(blocked.replaced, []);
});
