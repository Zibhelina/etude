// Security audit (5 Nov): tests for controls that had none. Each one says what an attacker would try.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { cardFrame, frameCsp } from "../src/server/frame.ts";
import { loadTypeDir } from "../src/core/types.ts";
import { initSandbox, runScript, ScriptError } from "../src/core/sandbox.ts";
import { Etude } from "../src/core/engine.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const directives = (csp: string) => Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));

test("card frames: the policy keeps a card's code to the Etude server and data it makes itself", () => {
  const d = directives(frameCsp("http://127.0.0.1:4610/"));
  assert.equal(d["default-src"], "'none'");
  for (const k of ["connect-src", "img-src", "media-src"]) assert.equal(d[k], "http://127.0.0.1:4610 data: blob:", k);
  assert.equal(d["frame-src"], "'none'", "no frames inside a card");
  assert.equal(d["form-action"], "'none'", "no form posts out");
  assert.doesNotMatch(frameCsp("http://127.0.0.1:4610/"), /\*|https?:\/\/(?!127\.0\.0\.1:4610)/, "no wildcard, no other host");
  // An opaque base (the iPhone app's capacitor://) allows no origin at all; a relative one means the page's own.
  assert.equal(directives(frameCsp("capacitor://localhost/"))["connect-src"], "'none' data: blob:");
  assert.equal(directives(frameCsp("./"))["connect-src"], "'self' data: blob:");
});

test("card frames: the policy comes first in every frame document, and a type's code can't close its script early", () => {
  const def = loadTypeDir(join(ROOT, "types", "basic"));
  const html = cardFrame(def, "http://127.0.0.1:4610/");
  const meta = html.indexOf(`<meta http-equiv="Content-Security-Policy" content="${frameCsp("http://127.0.0.1:4610/")}">`);
  assert.ok(meta > 0);
  for (const tag of ["<link", "<script", "<style"]) assert.ok(html.indexOf(tag) > meta, `${tag} after the policy`);
  const hostile = cardFrame({ ...def, template: { ...def.template, js: 'const s = "</script><script>parent.location = 1</script>";', css: "</style><script>x()</script>" } }, "http://127.0.0.1:4610/");
  assert.doesNotMatch(hostile, /<\/script><script>parent\.location/);
  assert.doesNotMatch(hostile, /<\/style><script>x\(\)/);
});

test("QuickJS: user scripts hit a memory cap, a stack cap and a deadline, and have no host functions", async () => {
  await initSandbox();
  const run = (body: string, timeoutMs = 5000) => runScript(body, { params: [], args: {}, where: "attack", timeoutMs });
  assert.throws(() => run("const a = []; for (;;) a.push(new Array(1e6).fill(1));"), (e: unknown) => e instanceof ScriptError && /memory/i.test(e.message), "memory");
  assert.throws(() => run("const f = (n) => f(n + 1) + 1; return f(0);"), (e: unknown) => e instanceof ScriptError && /stack/i.test(e.message), "stack");
  assert.throws(() => run("for (;;) {}", 200), /timed out/, "deadline");
  const reach = run("return [typeof require, typeof process, typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof importScripts, typeof setTimeout];") as string[];
  assert.deepEqual(reach, Array(7).fill("undefined"), "nothing of Node or the browser");
  assert.deepEqual(run("return [typeof os, typeof scriptArgs, typeof print];"), ["undefined", "undefined", "undefined"], "no QuickJS os/std modules (files, processes)");
});

test("QuickJS: a script that overflows its stack again and again can't break the sandbox for every other script", async () => {
  await initSandbox();
  const run = (body: string) => runScript(body, { params: [], args: {}, where: "attack", timeoutMs: 5000 });
  // Before, each overflow left an unfreeable runtime in the module and after about nine every script failed.
  for (let i = 0; i < 50; i++) {
    assert.throws(() => run("function f(n) { return f(n + 1) + 1; } return f(0);"), /stack overflow/);
    await initSandbox();
  }
  assert.equal(run("function f(n) { return f(n + 1) + 1; } try { f(0) } catch (e) { return 'caught' }"), "caught", "a script may catch its own overflow");
  assert.equal(run("function g(n) { return n ? g(n - 1) + 1 : 0 } return g(800)"), 800, "honest recursion still has room");
  assert.equal(run("return 1 + 1"), 2);
  // Where the host's own stack is smaller (some workers), it runs out first: the module is replaced and scripts go on.
  const sandbox = new URL("../src/core/sandbox.ts", import.meta.url).href;
  const code = `import { initSandbox, runScript } from ${JSON.stringify(sandbox)};
await initSandbox();
const run = (body) => runScript(body, { params: [], args: {}, where: "attack", timeoutMs: 5000 });
const seen = new Set();
for (let i = 0; i < 20; i++) { try { run("function f(n) { return f(n + 1) + 1; } return f(0);"); } catch (e) { seen.add(e.constructor.name); } await initSandbox(); }
console.log(JSON.stringify({ seen: [...seen], after: run("return 1 + 1") }));`;
  const r = spawnSync(process.execPath, ["--stack-size=150", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 60_000 });
  const last = r.stdout.trim().split("\n").at(-1) ?? "";
  assert.deepEqual(JSON.parse(last), { seen: ["ScriptError"], after: 2 }, r.stderr.slice(-400));
});

test("etude serve refuses to listen beyond localhost without a token", () => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-serve-"));
  try {
    for (const host of ["0.0.0.0", "::", "192.168.1.20"]) {
      const r = spawnSync(process.execPath, [join(ROOT, "src/cli/main.ts"), "serve", "--host", host, "--port", "0"], { env: { ...process.env, ETUDE_HOME: home, ETUDE_TOKEN: "" }, encoding: "utf8", timeout: 20_000 });
      assert.notEqual(r.status, 0, host);
      assert.match(r.stdout + r.stderr, /refusing to listen beyond localhost without --token/, host);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the desktop window: isolated, sandboxed, no Node; links, navigation, permissions and IPC kept to Etude's own page", () => {
  const app = read("desktop/app.ts");
  const prefs = /webPreferences:\s*\{([\s\S]*?)\n {4}\}/.exec(app)?.[1] ?? "";
  assert.match(prefs, /contextIsolation: true/);
  assert.match(prefs, /sandbox: true/);
  assert.match(prefs, /nodeIntegration: false/);
  assert.doesNotMatch(prefs, /webSecurity: false|allowRunningInsecureContent: true|nodeIntegrationInSubFrames: true/);
  assert.match(app, /setWindowOpenHandler\([\s\S]*?return \{ action: "deny" \};/, "no new windows");
  assert.match(app, /wc\.on\("will-navigate", keepInside\)/);
  assert.match(app, /wc\.on\("will-redirect", keepInside\)/);
  assert.match(app, /\["http:", "https:", "mailto:"\]\.includes\(u\.protocol\)/, "only web and mail links leave the app");
  assert.match(app, /setPermissionRequestHandler\([^\n]*details\.isMainFrame/);
  assert.match(app, /setPermissionCheckHandler\([^\n]*details\.isMainFrame/);
  assert.match(app, /e\.senderFrame === win\.webContents\.mainFrame/, "IPC answers the top frame only");
  const preload = read("desktop/preload.cjs");
  assert.equal((preload.match(/exposeInMainWorld\(/g) ?? []).length, 1);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*\b(?:require|process|ipcRenderer)\s*[,}]/, "no raw Node or IPC handed to the page");
});

test("Anki import: media names that would leave the media folder are skipped", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-anki-names-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = unzipSync(new Uint8Array(readFileSync(join(ROOT, "test/fixtures/anki/media-gate.apkg"))));
  const map = JSON.parse(new TextDecoder().decode(files.media)) as Record<string, string>;
  const bytes = files[Object.keys(map)[0]];
  const evil: Record<string, string> = { "0": "../../escaped.png", "1": "sub/dir.png", "2": "..\\win.png", "3": "..", "4": Object.values(map)[0] };
  const apkg = join(dir, "names.apkg");
  writeFileSync(apkg, zipSync({ "collection.anki2": files["collection.anki2"], media: new TextEncoder().encode(JSON.stringify(evil)), "0": bytes, "1": bytes, "2": bytes, "3": bytes, "4": bytes }));
  const e = await Etude.open(join(dir, "etude.db"));
  t.after(() => e.close());
  const report = e.importAnki(apkg);
  const unsafe = report.skipped.filter((s: { what: string; reason: string }) => s.what === "media" && s.reason === "unsafe file name").map((s: { name: string }) => s.name).sort();
  assert.deepEqual(unsafe, ["..", "../../escaped.png", "..\\win.png", "sub/dir.png"]);
  assert.ok(!existsSync(join(dir, "escaped.png")) && !existsSync(join(e.mediaDir, "..", "escaped.png")), "nothing written outside");
  if (existsSync(join(e.mediaDir, "anki"))) for (const n of readdirSync(join(e.mediaDir, "anki"))) assert.ok(!n.includes(".."), n);
});

test("card messages: each side only listens to the other (the browser checks these; this keeps them in place)", () => {
  assert.match(read("runtime/runtime.js"), /if \(e\.source !== parent\) return;/, "a card frame takes messages from the app only");
  const frame = read("web/src/components/card-frame.tsx");
  assert.match(frame, /if \(e\.source !== iframe\.current\?\.contentWindow\) return;/, "the app takes messages from its own frame only");
  assert.match(frame, /const type = typeOfSrc\(p\.src\);/, "a card saves preferences for its own type only");
  assert.match(frame, /if \(!isLocal\(\) \|\| !\/\^\\\/\(media\|type-assets\)\\\/\/\.test\(path\)\)/, "a card can ask only for media and type assets");
  assert.match(read("src/browser/client.ts"), /locks\.request\(LOCK, \{ ifAvailable: true \}/, "one tab opens the collection at a time");
});
