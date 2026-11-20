// A reply that's still being written when the window reloads: the chat picks it up where it was (thoughts, tools,
// words so far), keeps Stop, and shows the rest live. Through the real UI: `etude serve` on a scratch collection with
// the scripted ACP agent (test/fixtures/fake-acp-agent.mjs), driven in Chromium. Not part of `npm test`. From an
// etude2 worktree:
//   npm run build && node test/e2e/ask-reload.ts [<screenshot dir>]
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ask-reload-"));
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
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port)], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch, FAKE_SLOW_MS: "5000" }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/agent/profiles").then((r) => r.ok, () => false)) break; await sleep(150); }

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
  await panel.locator("[data-agent-thought]").first().waitFor();
  await shot("0-before-reload");

  // ================= reload mid-reply
  await page.reload();
  await panel.waitFor();
  await panel.getByText("Halfway there.").waitFor({ timeout: 4000 });
  assert.ok(await panel.locator("[data-agent-thought]").count() >= 1, "the thought came back");
  assert.ok(await panel.getByText("Reading the deck").count() >= 1, "the running tool came back");
  await panel.locator("button[aria-label=Stop]").waitFor();
  assert.equal(await panel.locator("[data-agent-user]").count(), 1, "the question shows once");
  await shot("1-picked-up");

  // ================= the rest arrives live, and the reply is saved once
  await panel.getByText("All the way there.").waitFor({ timeout: 10000 });
  await panel.locator("button[aria-label=Stop]").waitFor({ state: "detached", timeout: 5000 });
  assert.equal(await panel.locator("[data-agent-user]").count(), 1, "still one question");
  assert.equal(await panel.getByText("All the way there.").count(), 1, "the ending shows once");
  await shot("2-finished");
  await page.reload();
  await panel.getByText("All the way there.").waitFor();
  assert.equal(await panel.locator("[data-agent-user]").count(), 1);
  assert.equal(await panel.locator("button[aria-label=Stop]").count(), 0, "nothing running after the next reload");

  // ================= stop works on a picked-up reply
  await box.fill("slow");
  await box.press("Enter");
  await panel.getByText("Halfway there.").nth(1).waitFor();
  await page.reload();
  await panel.locator("button[aria-label=Stop]").click();
  await panel.locator("button[aria-label=Stop]").waitFor({ state: "detached", timeout: 5000 });
  assert.equal(await panel.getByText("All the way there.").count(), 1, "the stopped reply didn't finish");
  await shot("3-stopped");

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
