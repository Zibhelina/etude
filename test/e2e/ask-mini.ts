// Minimi's mini chat through the real UI: replies read like the side panel (no balloon), thoughts and steps fold the
// same way, and the message box is the panel's. Scratch collection, scripted ACP agent, Chromium. From a worktree:
//   npm run build && node test/e2e/ask-mini.ts [<screenshot dir>]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Etude } from "../../src/core/engine.ts";
const require = createRequire(join(process.env.PLAYWRIGHT_FROM ?? process.cwd(), "package.json"));
const { chromium } = require("playwright-core");

const WT = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ask-mini-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const db = join(scratch, "etude.db");
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ ai: { ...e.settings().ai, agents: [{ id: "fake", name: "Fakey", command: process.execPath, args: [join(WT, "test/fixtures/fake-acp-agent.mjs")] }] } });
  e.addAgentProfile({ id: "p-fake", name: "Fakey", body: "minimi", brain: { kind: "external", agent: "fake" } } as any);
  e.setDefaultAgentProfile("p-fake");
  e.close();
}
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port)], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/agent/profiles").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, colorScheme: (process.env.SCHEME as any) ?? "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript(() => {
    try { localStorage.setItem("etude.agent.open", "0"); localStorage.setItem("etude.fun", "1"); } catch {}
  });
  await page.goto(base + "/");
  await page.getByText("Skip", { exact: true }).click({ timeout: 4000 }).catch(() => {});
  await sleep(800);
  await page.screenshot({ path: join(SHOTS, "start.png") });
  await page.locator("[data-minimi]").first().click({ timeout: 8000 }).catch(() => page.keyboard.press("Control+j"));
  const mini = page.locator("[data-minimi-chat]");
  await mini.waitFor();
  const box = mini.locator("textarea[aria-label=Message]");
  const say = async (text: string) => {
    await box.fill(text);
    await box.press("Enter");
    await mini.locator("button[aria-label=Stop]").waitFor({ state: "attached" }).catch(() => {});
    await mini.locator("button[aria-label=Stop]").waitFor({ state: "detached", timeout: 20000 });
  };
  // The composer is the panel's: who, model/effort pills, the context ring. Here they sit in a row under the box,
  // which keeps only the text and Send, and nothing in that row is cut off.
  await mini.locator("[data-agent-composer]").waitFor();
  assert.equal(await mini.locator(".achat-ctl.is-below [data-agent-switcher]").count(), 1, "who pill under the box");
  assert.equal(await mini.locator("[data-agent-composer] [data-agent-switcher]").count(), 0, "no pills inside the box");
  const cut = await mini.locator(".achat-ctl.is-below").evaluate((row: Element) => [...row.querySelectorAll<HTMLElement>(".achat-pill span.truncate, .achat-pill > span")].filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent));
  assert.deepEqual(cut, [], "pill labels not truncated");
  await page.screenshot({ path: join(SHOTS, "mini-empty.png") });
  await say("think");
  await say("tool");
  await say("say A plain reply, **no balloon** around it, the way the side panel shows it.");
  await sleep(300);
  // Replies sit on the page; only your messages keep a balloon.
  assert.equal(await mini.locator("[data-agent-reply] [data-mbub]").count(), 0, "no reply balloons");
  assert.ok((await mini.locator(".mchat-you").count()) >= 3, "your messages in balloons");
  await mini.hover();
  await page.screenshot({ path: join(SHOTS, "mini-chat.png") });
  await mini.screenshot({ path: join(SHOTS, "mini-chat-close.png") }).catch(() => {});
  assert.deepEqual(errors, []);
  console.log("ok", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
  process.exit(failed ? 1 : 0);
}
