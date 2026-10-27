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
