import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";

test("app page has a strict CSP; card documents (saved and unsaved) are sandboxed", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-csp-"));
  const e = await Etude.open(join(dir, "etude.db"));
  t.after(() => { e.close(); rmSync(dir, { recursive: true, force: true }); });
  const dist = join(dir, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><script src=\"/theme-boot.js\"></script>");
  writeFileSync(join(dist, "assets", "a.js"), "1");
  const app = createApp(e, { webDist: dist });

  const csp = (await app.request("/decks")).headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self'(;|$)/, "no inline or eval scripts on the app page");
  assert.match(csp, /object-src 'none'/);
  assert.equal((await app.request("/assets/a.js")).headers.get("content-security-policy"), null);

  assert.equal((await app.request("/frame/basic")).headers.get("content-security-policy"), "sandbox allow-scripts");
  const made = await (await app.request("/api/frame-doc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ html: "<p>draft</p>" }) })).json();
  const doc = await app.request(made.url);
  assert.equal(doc.headers.get("content-security-policy"), "sandbox allow-scripts");
  assert.equal(await doc.text(), "<p>draft</p>");
  assert.equal((await app.request("/frame-doc/nope")).status, 404);
});

test("app-build names the entry script the server hands out now, and notices a new build", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-build-"));
  const e = await Etude.open(join(dir, "etude.db"));
  t.after(() => { e.close(); rmSync(dir, { recursive: true, force: true }); });
  const dist = join(dir, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  const page = (h: string) => `<!doctype html><script src="/theme-boot.js"></script><script type="module" crossorigin src="/assets/index-${h}.js"></script>`;
  writeFileSync(join(dist, "index.html"), page("AAA"));
  const app = createApp(e, { webDist: dist });
  const entry = async () => ((await (await app.request("/api/app-build")).json()) as { entry: string | null }).entry;
  assert.equal(await entry(), "/assets/index-AAA.js");
  // A rebuild writes a new index.html; the next look sees it (mtime changes, so bump it for a fast test).
  writeFileSync(join(dist, "index.html"), page("BBB"));
  const { utimesSync } = await import("node:fs");
  utimesSync(join(dist, "index.html"), new Date(), new Date(Date.now() + 5000));
  assert.equal(await entry(), "/assets/index-BBB.js");
  assert.equal((await app.request("/api/app-build")).headers.get("cache-control"), "no-store");
  assert.equal(((await (await createApp(e, { webDist: null }).request("/api/app-build")).json()) as any).entry, null);
});
