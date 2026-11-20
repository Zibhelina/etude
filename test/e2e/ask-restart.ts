// The server restarts (an update, `systemctl restart`) while a reply is being written. The reply can't go on (its
// agent stops with the server), but what it wrote is kept: it stays on screen while the server is away, and comes
// back saved, marked as cut short, with Stop gone and the chat ready for the next message. Through the real UI:
// `etude serve` on a scratch collection with the scripted ACP agent, driven in Chromium. Not part of `npm test`.
//   npm run build && node test/e2e/ask-restart.ts [<screenshot dir>]
import { spawn, type ChildProcess } from "node:child_process";
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ask-restart-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const db = join(scratch, "etude.db");
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ ai: { ...e.settings().ai, agents: [{ id: "fake", name: "Fakey", command: process.execPath, args: [join(WT, "test/fixtures/fake-acp-agent.mjs")] }] }, onboarding: { ...e.settings().onboarding, done: true } });
  e.addAgentProfile({ id: "p-fake", name: "Fakey", brain: { kind: "external", agent: "fake" } });
  e.setDefaultAgentProfile("p-fake");
  e.close();
}
const base = `http://127.0.0.1:${port}`;
const up = () => fetch(base + "/api/agent/profiles").then((r) => r.ok, () => false);
async function start(): Promise<ChildProcess> {
  const s = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port)], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch, FAKE_SLOW_MS: "5000" }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 100; i++) { if (await up()) break; await sleep(150); }
  return s;
}
const stopServer = (s: ChildProcess) => new Promise<void>((r) => { s.once("exit", () => r()); s.kill("SIGTERM"); });
let server = await start();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
let page: any;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem("etude.agent.open")) localStorage.setItem("etude.agent.open", "1");
    } catch {}
  });
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.goto(base + "/notes");
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  const panel = page.locator("[data-agent-panel] [data-agent-tab=on]");
  await panel.waitFor();
  const box = panel.locator("textarea[aria-label=Message]");
  await box.fill("slow");
  await box.press("Enter");
  await panel.getByText("Halfway there.").waitFor();
  await shot("0-writing");

  // ================= the server goes away mid-reply: what was written stays on screen
  await stopServer(server);
  for (const ms of [300, 1200, 1500]) {
    await sleep(ms);
    assert.equal(await panel.getByText("Halfway there.").count(), 1, "the words so far stay while the server is away");
    assert.equal(await panel.locator("[data-agent-user]").count(), 1, "and so does the question");
  }
  assert.equal(await box.inputValue(), "", "the question isn't put back in the box as if it never went");
  await shot("1-server-away");

  // ================= it comes back: the reply is saved as far as it got, marked as cut short, and Stop is gone
  server = await start();
  await panel.locator("button[aria-label=Stop]").waitFor({ state: "detached", timeout: 8000 });
  await panel.locator("[data-agent-cut]").waitFor({ timeout: 4000 });
  assert.equal(await panel.getByText("Halfway there.").count(), 1, "the words so far show once");
  assert.equal(await panel.getByText("All the way there.").count(), 0, "it didn't finish");
  assert.equal(await panel.locator("[data-agent-user]").count(), 1, "one question");
  await shot("2-back");
  await page.reload();
  await panel.getByText("Halfway there.").waitFor();
  assert.equal(await panel.locator("[data-agent-cut]").count(), 1, "still marked after a reload");
  assert.equal(await panel.locator("button[aria-label=Stop]").count(), 0);

  // ================= the chat goes on
  await box.fill("hello");
  await box.press("Enter");
  await panel.locator("[data-agent-user]").nth(1).waitFor();
  await panel.locator("button[aria-label=Stop]").waitFor({ state: "detached", timeout: 10000 });
  assert.equal(await panel.locator("[data-agent-cut]").count(), 1, "the next reply isn't cut");
  await shot("3-next-reply");

  // ================= a reply picked up after a reload survives the same way
  await box.fill("slow");
  await box.press("Enter");
  await panel.getByText("Halfway there.").nth(1).waitFor();
  await page.reload();
  await panel.getByText("Halfway there.").nth(1).waitFor({ timeout: 4000 });
  await stopServer(server);
  await sleep(1500);
  assert.equal(await panel.getByText("Halfway there.").count(), 2, "the picked-up reply stays while the server is away");
  server = await start();
  await panel.locator("button[aria-label=Stop]").waitFor({ state: "detached", timeout: 8000 });
  await panel.locator("[data-agent-cut]").nth(1).waitFor({ timeout: 4000 });
  assert.equal(await panel.getByText("Halfway there.").count(), 2);
  await shot("4-picked-up-then-cut");

  assert.deepEqual(errors, [], "no page errors");
  console.log("ok", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
  await page?.screenshot({ path: join(SHOTS, "failed.png") }).catch(() => {});
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
