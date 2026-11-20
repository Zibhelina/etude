// Ctrl+T / Ctrl+W open and close the tab where you are (the Notebook pane, or the Ask panel when you're in it); Ctrl+, clears notifications. Through the real UI: `etude serve` on a scratch
// collection with the scripted ACP agent (test/fixtures/fake-acp-agent.mjs), driven in Chromium. Not part of
// `npm test` (it needs Chromium, playwright-core and a built web app). From an etude2 worktree:
//   npm run build && node test/e2e/tab-keys.ts [<screenshot dir>]
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "tab-keys-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const db = join(scratch, "etude.db");
const ids: Record<string, string> = {};
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ ai: { ...e.settings().ai, agents: [{ id: "fake", name: "Fakey", command: process.execPath, args: [join(WT, "test/fixtures/fake-acp-agent.mjs")] }] }, onboarding: { ...e.settings().onboarding, done: true } });
  e.addAgentProfile({ id: "p-fake", name: "Fakey", brain: { kind: "external", agent: "fake" } });
  e.setDefaultAgentProfile("p-fake");
  const make = async (key: string, argv: string[]) => {
    let out = "";
    assert.equal(await run(["note", "new", ...argv, "--json"], { stdout: (x) => (out += x), stderr: (x) => process.stderr.write(x), stdin: () => "", isTTY: false, env: process.env }, { etude: e }), 0);
    const r = JSON.parse(out);
    ids[key] = r.id ?? r.note?.id;
    assert.ok(ids[key], `made ${key}`);
  };
  await make("folder", ["Course", "--folder"]);
  await make("inside", ["Lecture one", "--parent", "Course", "--text", "First line."]);
  await make("other", ["Reading list", "--text", "A book."]);
  await make("third", ["Problem set", "--text", "Q1."]);
  await make("fourth", ["Formula sheet", "--text", "E = mc2."]);
  e.close();
}
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port)], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/agent/profiles").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
let page: any;
try {
  page = await browser.newPage({ viewport: { width: 1900, height: 900 }, colorScheme: (process.env.SCHEME as any) ?? "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem("etude.agent.open")) localStorage.setItem("etude.agent.open", "1");
    } catch {}
  });
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const tabs = () => page.locator(".note-tab").evaluateAll((els: HTMLElement[]) => els.map((x) => x.dataset.tab));
  const row = (id: string) => page.locator(`[role=tree] [data-note-row="${id}"]`).first();

  const askTabs = () => page.locator("[data-agent-tab]").count();
  await page.goto(`${base}/notes?id=${ids.inside}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  await page.locator("[data-pane] .note-title").first().waitFor();
  await row(ids.other).click({ modifiers: ["Control"] });
  await page.locator(`.note-tab[data-tab="${ids.other}"]`).waitFor();
  await page.locator("[data-agent-tab]").first().waitFor();
  const a0 = await askTabs();
  // In the Notebook: a click on the page, then the keys.
  await page.locator("[data-pane] .note-title").first().click();
  const t0 = await tabs();
  await page.keyboard.press("Control+t");
  await sleep(300);
  const t1 = await tabs();
  assert.equal(t1.length, t0.length + 1, `Ctrl+T adds a Notebook tab: ${t0} -> ${t1}`);
  assert.ok(t1.some((t: string) => t.startsWith("new:")), "it is a New tab");
  assert.equal(await askTabs(), a0, "the Ask panel is untouched");
  await shot("1-ctrl-t");
  await page.keyboard.press("Control+w");
  await sleep(300);
  assert.deepEqual(await tabs(), t0, "Ctrl+W closes the New tab in front");
  await page.keyboard.press("Control+w");
  await sleep(300);
  assert.ok(!(await tabs()).includes(ids.other), "Ctrl+W closes the next tab in front");
  // In the Ask panel.
  const nb = await tabs();
  await page.locator("[data-agent-panel] textarea[aria-label=Message]:visible").first().click();
  await page.keyboard.press("Control+t");
  await sleep(300);
  assert.equal(await askTabs(), a0 + 1, "Ctrl+T in the panel adds an Ask tab");
  assert.deepEqual(await tabs(), nb, "the Notebook is untouched");
  await page.locator("[data-agent-panel] textarea[aria-label=Message]:visible").first().click();
  await page.keyboard.press("Control+w");
  await sleep(300);
  assert.equal(await askTabs(), a0, "Ctrl+W in the panel closes the Ask tab in front");
  assert.deepEqual(await tabs(), nb, "the Notebook is still untouched");
  await shot("2-ask");
  // Ctrl+, clears a notification (archiving a page shows one), and the sidebar stays.
  await row(ids.third).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Archive/ }).first().click();
  await page.locator("[data-sonner-toast]").first().waitFor();
  await shot("3-toast");
  await page.locator("[data-pane] .note-title").first().click();
  await page.keyboard.press("Control+Comma");
  await sleep(800);
  assert.equal(await page.locator("[data-sonner-toast]").count(), 0, "Ctrl+, cleared the notification");
  assert.ok(await page.locator("[data-shell-sidebar]").count(), "the sidebar is still there");
  await shot("4-cleared");

  assert.deepEqual(errors, [], "no page errors");
  console.log("ok", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
  await page?.screenshot({ path: join(SHOTS, "failed.png") }).catch(() => {});
  console.error("url", page?.url());
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
