// The browser worker's entry (src/browser/worker.ts) must stay a tiny module with no static imports
// that loads the real worker with import(). If shared code ends up in the entry's chunk, other
// chunks import that chunk, and WebKit then evaluates the entry a second time: the collection
// booted twice on OPFS in the iOS app. The harness (harness.html?step=fresh) checks the live count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../src/browser/${p}`, import.meta.url), "utf8");
const code = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

test("the worker entry has no static imports and loads worker-core.ts dynamically", () => {
  const entry = code(src("worker.ts"));
  assert.doesNotMatch(entry, /^\s*import[\s{*"']/m, "worker.ts must not import anything statically");
  assert.doesNotMatch(entry, /^\s*export\b/m, "worker.ts must not export anything");
  assert.match(entry, /import\(\s*["']\.\/worker-core\.ts["']\s*\)/);
});

test("nothing imports the worker entry; the page starts it as a worker", () => {
  for (const f of ["client.ts", "app-main.ts", "harness.ts", "native-shell.ts", "native-chatgpt.ts", "worker-core.ts"]) {
    const s = code(src(f));
    assert.doesNotMatch(s, /from\s+["']\.\/worker(\.ts)?["']|import\(\s*["']\.\/worker(\.ts)?["']\s*\)/, `${f} imports the worker entry`);
  }
  assert.match(code(src("client.ts")), /new Worker\(new URL\("\.\/worker\.ts", import\.meta\.url\)/);
});

test("worker-core replays the messages the entry held, in order, and counts its runs", () => {
  const core = code(src("worker-core.ts"));
  assert.match(core, /export function start\(queued: MessageEvent\[\]\)/);
  assert.match(core, /self\.onmessage = handle;\s*for \(const ev of queued\)/);
  assert.match(core, /method === "_evals"/);
  assert.doesNotMatch(core, /^self\.onmessage =/m);
});
