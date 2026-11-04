// The serverless builds (etude.study/app and the phone apps): the app page's CSP and the nonce card
// frames get, which API key names the browser accepts, and backups that would unpack too far.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { keyNameProblem } from "../src/core/env-names.ts";
import { readBackup } from "../src/browser/backup-zip.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("csp-boot: only the app's files and this load's nonce run; no inline script, object or foreign base", () => {
  const boot = read("src/browser/csp-boot.js");
  const scriptSrc = /"script-src ([^"]*)" \+ nonce \+ "([^"]*)"/.exec(boot);
  assert.ok(scriptSrc, "script-src carries the nonce");
  const directive = scriptSrc[1] + "NONCE" + scriptSrc[2];
  assert.match(directive, /^'self' blob: 'nonce-NONCE' /);
  assert.doesNotMatch(directive, /unsafe-inline/);
  assert.match(boot, /crypto\.getRandomValues\(bytes\)/, "a fresh nonce on every load");
  for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) assert.ok(boot.includes(`"${d}"`), d);
});

test("the browser page has no inline script, and the build puts csp-boot.js first in <head>", () => {
  const html = read("src/browser/index.html");
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) assert.match(tag, /\ssrc="/, `inline script in index.html: ${tag}`);
  const vite = read("src/browser/vite.config.ts");
  assert.match(vite, /plugins: \[[^\]]*\bappCsp\b[^\]]*\]/);
  assert.match(vite, /<meta charset="UTF-8" \\\/>\\n\/, \(m\) => `\$\{m\}    <script src="\$\{src\}"><\/script>/);
});

test("card frames in the serverless builds carry the page's nonce on every script they run", () => {
  const local = read("src/browser/frame-local.ts");
  const placeholder = /export const FRAME_NONCE = '([^']+)'/.exec(local)?.[1];
  assert.equal(placeholder, 'nonce="%ETUDE_NONCE%"');
  assert.match(local, /const script = \(js: string\) => `<script \$\{FRAME_NONCE\}>/, "the shim and the runtime");
  assert.match(local, /<script type="module" \$\{FRAME_NONCE\}>/, "the card's own module");
  const frame = read("web/src/components/card-frame.tsx");
  assert.ok(frame.includes(`const NONCE_PLACEHOLDER = '${placeholder}';`), "card-frame.tsx swaps the same placeholder");
  assert.match(frame, /__etudeFrameNonce/);
  assert.ok(read("src/browser/csp-boot.js").includes('Object.defineProperty(window, "__etudeFrameNonce"'));
});

test("API key names: only credential-shaped names, never configuration the core reads", () => {
  for (const ok of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "MY_LLM_KEY", "GITHUB_TOKEN"]) assert.equal(keyNameProblem(ok), null, ok);
  for (const bad of ["ETUDE_SQL", "ETUDE_MARKET_KEY", "NODE_OPTIONS", "PATH", "HOME", "LD_PRELOAD_KEY", "openrouter_api_key", "OPENROUTER", "", 42])
    assert.ok(keyNameProblem(bad), String(bad));
  const worker = read("src/browser/worker-core.ts");
  assert.match(worker, /const problem = keyNameProblem\(name\);\s*if \(problem\) throw new Error\(problem\);/, "the browser's setEnv checks the name");
  assert.match(worker, /if \(m && !keyNameProblem\(m\[1\]\)\) process\.env/, "and loads only key names");
});

test("backups: declared sizes are counted before anything is inflated; other entries are skipped", () => {
  const db = new TextEncoder().encode("SQLite format 3\u0000 rest of the database");
  const ok = readBackup(zipSync({ "etude.db": db, "etude-backup.json": new TextEncoder().encode("{}"), "media/a.png": new Uint8Array([1, 2, 3]), "../evil": new Uint8Array([9]), "notes.txt": new Uint8Array(10) }));
  assert.deepEqual(Object.keys(ok).sort(), ["etude-backup.json", "etude.db", "media/a.png"]);
  assert.deepEqual([...ok["media/a.png"]], [1, 2, 3]);

  // 64 MiB of zeros deflates to about 64 KB: a small file that unpacks far beyond its size.
  const bomb = zipSync({ "etude.db": db, "media/zeros.bin": new Uint8Array(64 * 1024 * 1024) }, { level: 9 });
  assert.ok(bomb.length < 1024 * 1024, `the bomb is small (${bomb.length} bytes)`);
  assert.throws(() => readBackup(bomb, { file: 16 * 1024 * 1024, total: 1024 ** 3, entries: 100 }), /too large to restore here: media\/zeros\.bin would unpack/);
  assert.throws(() => readBackup(bomb, { file: 1024 ** 3, total: 32 * 1024 * 1024, entries: 100 }), /too large to restore here: it would unpack to more than/);
  const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`media/${i}`, new Uint8Array(1)]));
  assert.throws(() => readBackup(zipSync(many), { file: 1024, total: 1024, entries: 5 }), /more than 5 files/);
  assert.throws(() => readBackup(new TextEncoder().encode("not a zip at all")), /isn't an Etude backup \(not a zip\)/);
});
