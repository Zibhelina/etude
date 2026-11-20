// Ctrl/⌘K finds Notebook pages as well as decks: by title, by the folder above, by their text, and the last opened before typing. Through the real UI: `etude serve` on a scratch
// collection with the scripted ACP agent (test/fixtures/fake-acp-agent.mjs), driven in Chromium. Not part of
// `npm test` (it needs Chromium, playwright-core and a built web app). From an etude2 worktree:
//   npm run build && node test/e2e/finder-pages.ts [<screenshot dir>]
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "finder-pages-"));
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
  await make("third", ["Problem set", "--text", "Q1. Prove the exchange argument for interval scheduling."]);
  await make("accent", ["Revisão de álgebra", "--text", "Matrizes."]);
  e.ensureDeck("Lectures::Week 1");
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

  await page.goto(`${base}/notes?id=${ids.inside}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  await page.locator("[data-pane] .note-title").first().waitFor();
  await page.goto(base + "/stats");
  await sleep(500);
  const finder = page.locator("[data-deck-finder]");
  const open = async () => {
    await page.keyboard.press("Control+k");
    await finder.waitFor();
  };
  const rows = () => finder.locator("[role=option]").evaluateAll((els: HTMLElement[]) => els.map((x) => x.innerText.replace(/\s+/g, " ").trim()));
  const type = async (q: string) => {
    await finder.locator("input").fill(q);
    await sleep(450);
  };

  // Before typing: decks, then the page opened last.
  await open();
  await sleep(300);
  assert.ok((await finder.innerText()).includes("JUMP BACK IN") || (await finder.innerText()).includes("Jump back in"));
  assert.ok((await rows()).some((r: string) => r.includes("Lecture one")), `the last page opened is offered: ${await rows()}`);
  await shot("0-before-typing");

  // By title, by letters in order, without accents, by the folder above it.
  await type("lect");
  let r = await rows();
  assert.ok(r.some((x: string) => x.includes("Lecture one")) && r.some((x: string) => x.includes("Lectures")), `a page and a deck: ${r}`);
  await shot("1-title");
  await type("revisao alg");
  assert.ok((await rows())[0].includes("Revisão de álgebra"));
  await type("course");
  r = await rows();
  assert.ok(r.some((x: string) => x.includes("Course") && x.includes("Folder")), `the folder: ${r}`);
  assert.ok(r.some((x: string) => x.includes("Lecture one") && x.includes("Course")), `the page inside it, with its path: ${r}`);
  // By its text.
  await type("exchange argument");
  r = await rows();
  assert.ok(r.length === 1 && r[0].includes("Problem set") && r[0].includes("exchange argument"), `found by its text, with the words around: ${r}`);
  await shot("2-in-text");
  // Enter opens it in the Notebook.
  await page.keyboard.press("Enter");
  await page.waitForURL(new RegExp(ids.third));
  await page.locator("[data-pane] .note-title").first().waitFor();

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
