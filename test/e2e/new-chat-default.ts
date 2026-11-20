// A new chat from Ctrl+K (or a new tab in the Ask panel) starts with the default agent, even when the last chat
// was with someone else; Minimi's mini chat still follows whoever is in the corner. `etude serve` on a scratch
// collection, driven in Chromium. Not part of `npm test`. From an etude2 worktree:
//   npm run build && node test/e2e/new-chat-default.ts [<screenshot dir>]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "new-chat-default-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const db = join(scratch, "etude.db");
const env = { ...process.env, ETUDE_HOME: scratch };
const cli = async (...argv: string[]) => {
  let out = "", err = "";
  const code = await run(["--db", db, ...argv, "--json"], { stdout: (x) => (out += x), stderr: (x) => (err += x), stdin: () => "", isTTY: false, env });
  assert.equal(code, 0, `${argv.join(" ")}: ${err}`);
  return out.trim() ? JSON.parse(out) : null;
};
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ onboarding: { ...e.settings().onboarding, done: true } });
  e.close();
}
const note = (await cli("note", "new", "Lecture one", "--text", "Hi.")).id;
await cli("agents", "add", "Ada", "--id", "ada", "--default");
const server = spawn(process.execPath, [join(WT, "src/cli/main.ts"), "--db", db, "serve", "--port", String(port), ...(process.env.WEB ? ["--web", process.env.WEB] : [])], { cwd: WT, env, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/notes").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, colorScheme: "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  // The last chat was with Minimi.
  await page.addInitScript(() => localStorage.setItem("etude.agent.with", "minimi"));
  await page.goto(`${base}/notes?id=${note}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  await page.locator("[data-pane] .note-title").first().waitFor();
  await page.locator("[data-pane] .note-title").first().click();
  await page.keyboard.press("Control+k");
  await page.keyboard.type(">new chat");
  await page.keyboard.press("Enter");
  await page.locator("[data-place-picker]").waitFor();
  await page.keyboard.press("Enter");
  await page.locator("[data-place-picker]").waitFor({ state: "detached" });
  const chat = page.locator('[role="tabpanel"][data-agent-tab]').last();
  await chat.waitFor();
  await sleep(600);
  await page.screenshot({ path: join(SHOTS, "1-ctrl-k-chat.png") });
  const text = (await chat.textContent()) ?? "";
  assert.match(text, /Ada/, "the new chat is with the default agent");
  assert.doesNotMatch(text, /Minimi/, "not with the last one talked to");
  assert.deepEqual(errors, []);
  console.log("ok: new chat starts with the default agent, shots in", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
