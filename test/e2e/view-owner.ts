// Two browsers on one engine (the Mac's Etude and Athanor's, both showing Athanor's collection): only the window
// used last carries out `etude view` commands, and the other takes over once that one is used. They don't share
// localStorage, so the server decides (/api/view/owner). `etude serve` on a scratch collection, Chromium. Not part of
// `npm test`. From an etude2 worktree:
//   npm run build && node test/e2e/view-owner.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Etude } from "../../src/core/engine.ts";
import { run } from "../../src/cli/run.ts";
const require = createRequire(join(process.env.PLAYWRIGHT_FROM ?? process.cwd(), "package.json"));
const { chromium } = require("playwright-core");

const WT = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "view-owner-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const db = join(scratch, "etude.db");
const env = { ...process.env, ETUDE_HOME: scratch };
const cli = async (...argv: string[]) => {
  let out = "", err = "";
  const code = await run(["--db", db, ...argv, "--json"], { stdout: (x) => (out += x), stderr: (x) => (err += x), stdin: () => "", isTTY: false, env });
  return { code, json: out.trim() ? JSON.parse(out) : null, err };
};
const ids: Record<string, string> = {};
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ onboarding: { ...e.settings().onboarding, done: true } });
  e.close();
  for (const [k, t] of [["a", "Start"], ["b", "For the Mac"], ["c", "For Athanor"]]) ids[k] = (await cli("note", "new", t, "--text", "Hi.")).json.id;
}
const server = spawn(process.execPath, [join(WT, "src/cli/main.ts"), "--db", db, "serve", "--port", String(port)], { cwd: WT, env, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/notes").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
try {
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: "dark" });
    const p = await ctx.newPage();
    await p.goto(`${base}/notes?id=${ids.a}`);
    await p.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
    await p.locator("[data-pane] .note-title").first().waitFor();
    return p;
  };
  const tabs = (p: any): Promise<string[]> => p.evaluate(() => {
    const out: string[] = [];
    const walk = (n: any) => { if (!n || typeof n !== "object") return; if (Array.isArray(n.tabs)) out.push(...n.tabs); for (const v of Object.values(n)) walk(v); };
    walk(JSON.parse(localStorage.getItem("etude.notes.layout") ?? "null"));
    return out;
  });
  const has = async (p: any, id: string) => { for (let i = 0; i < 60; i++) { if ((await tabs(p)).includes(id)) return true; await sleep(150); } return false; };
  const mac = await open();
  const athanor = await open();
  // The Mac's window is used: it answers.
  await mac.evaluate(() => dispatchEvent(new Event("focus")));
  await sleep(600);
  let r = await cli("view", "open", ids.b);
  assert.equal(r.code, 0, r.err);
  assert.ok(await has(mac, ids.b), "the window used last didn't open it");
  await sleep(800);
  assert.ok(!(await tabs(athanor)).includes(ids.b), "the other browser opened it too");
  // Then Athanor's: it answers, and the Mac's doesn't.
  await athanor.evaluate(() => dispatchEvent(new Event("focus")));
  await sleep(600);
  r = await cli("view", "open", ids.c);
  assert.equal(r.code, 0, r.err);
  assert.ok(await has(athanor, ids.c), "the window used last didn't open it");
  await sleep(800);
  assert.ok(!(await tabs(mac)).includes(ids.c), "the window used before opened it too");
  const shown = await cli("view", "show");
  assert.ok(JSON.stringify(shown.json).includes(ids.c), "view show reports another window");
  console.log("ok view owner");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
