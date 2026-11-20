// Steer, permissions, and the Notebook coming back as it was left. Through the real UI: `etude serve` on a scratch
// collection with the scripted ACP agent (test/fixtures/fake-acp-agent.mjs), driven in Chromium. Not part of
// `npm test` (it needs Chromium, playwright-core and a built web app). From an etude2 worktree:
//   npm run build && node test/e2e/ask-steer.ts [<screenshot dir>]
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ask-steer-"));
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
  e.close();
}
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port)], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/agent/profiles").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
let page: any;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: (process.env.SCHEME as any) ?? "dark" });
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

  // ================= the Notebook comes back as it was left
  await page.goto(`${base}/notes?id=${ids.inside}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  await page.locator("[data-pane] .note-title").first().waitFor();
  // A second page in a tab of its own, then a split: two panes.
  await row(ids.other).click({ modifiers: ["Control"] });
  await page.locator(`.note-tab[data-tab="${ids.other}"]`).waitFor();
  await row(ids.inside).click();
  await sleep(300);
  const before = { tabs: await tabs(), panes: await page.locator("[data-pane]").count(), url: page.url() };
  assert.ok(before.tabs.includes(ids.inside) && before.tabs.includes(ids.other), `both pages open: ${before.tabs}`);
  await shot("0-notebook-before");

  // Off to Stats and back through the sidebar.
  await page.getByRole("button", { name: "Stats", exact: true }).first().click();
  await page.waitForURL(/\/stats/);
  await sleep(400);
  await page.getByRole("button", { name: "Notebook", exact: true }).first().click();
  await page.locator("[data-pane] .note-title").first().waitFor();
  await sleep(500);
  assert.deepEqual(await tabs(), before.tabs, "the same tabs, no New tab added");
  assert.equal(await page.locator("[data-pane]").count(), before.panes);
  assert.equal(await page.locator("[data-pane] .note-title").first().inputValue().catch(() => page.locator("[data-pane] .note-title").first().innerText()), "Lecture one");
  assert.ok(page.url().includes(ids.inside), `the address is the front page again: ${page.url()}`);
  await shot("1-notebook-back");

  // ================= a folder folded over the open page stays folded while the page is edited
  const fold = row(ids.folder).locator("[aria-label=Fold], [aria-label=Unfold]").first();
  await row(ids.inside).waitFor();
  await row(ids.folder).hover();
  await fold.click({ force: true });
  await row(ids.inside).waitFor({ state: "detached" });
  const body = page.locator("[data-pane] .ProseMirror").first();
  await body.click();
  await page.keyboard.type(" More words typed after folding.");
  const title = page.locator("[data-pane] .note-title").first();
  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" (edited)");
  await sleep(2500); // past the save and the list reload
  assert.equal(await row(ids.inside).count(), 0, "the folder stayed folded while its page was edited");
  await shot("2-stays-folded");
  // …and after another screen.
  await page.getByRole("button", { name: "Stats", exact: true }).first().click();
  await page.waitForURL(/\/stats/);
  await page.getByRole("button", { name: "Notebook", exact: true }).first().click();
  await page.locator("[data-pane] .note-title").first().waitFor();
  await sleep(600);
  assert.equal(await row(ids.inside).count(), 0, "still folded after a visit to Stats");
  // Going to another page and back to it shows it in the tree again.
  await row(ids.other).click();
  await sleep(300);
  await page.locator(`.note-tab[data-tab="${ids.inside}"]`).first().click();
  await row(ids.inside).waitFor();

  // With nothing open, the Notebook opens on its start page.
  await page.evaluate(() => localStorage.removeItem("etude.notes.layout"));
  await page.goto(base + "/notes");
  await page.locator("[data-pane]").first().waitFor();
  await sleep(500);
  const fresh = await tabs();
  assert.ok(fresh.length <= 1 && !fresh.includes(ids.inside), `only the start page: ${fresh}`);
  await shot("3-nothing-open");

  // ================= Steer
  const panel = page.locator("[data-agent-panel] [data-agent-tab=on]");
  await panel.waitFor();
  const box = panel.locator("textarea[aria-label=Message]");
  await box.fill("work");
  await box.press("Enter");
  const stop = panel.locator("button[aria-label=Stop]");
  await stop.waitFor();
  await panel.getByText("Starting.").waitFor();
  assert.equal(await panel.locator("button[aria-label=Steer]").count(), 0, "an empty box: Stop");
  await shot("4-working-stop");
  await box.fill("use the blue one");
  await panel.locator("button[aria-label=Steer]").waitFor();
  assert.equal(await stop.count(), 0, "something typed: Steer takes Stop's place");
  await shot("5-working-steer");
  await box.fill("");
  await stop.waitFor();
  await box.fill("use the blue one");
  await box.press("Enter");
  await panel.getByText("Changed course: use the blue one").waitFor();
  await panel.locator("button[aria-label=Stop]").waitFor({ state: "detached" });
  assert.equal(await box.inputValue(), "");
  assert.equal(await panel.locator("[data-agent-steer]").innerText(), "use the blue one");
  assert.equal(await panel.getByText("Steer queued").count(), 0);
  await shot("6-steered");
  await page.reload();
  await panel.locator("[data-agent-steer]").waitFor();
  assert.equal(await panel.locator("[data-agent-steer]").innerText(), "use the blue one", "it's saved with the reply");

  // A picture goes with Steer too, and the Stop button wears the accent like Send.
  await box.fill("work");
  await box.press("Enter");
  await stop.waitFor();
  const bg = await stop.evaluate((b: HTMLElement) => getComputedStyle(b).backgroundColor);
  const hl = await stop.evaluate((b: HTMLElement) => { const d = document.createElement("div"); d.style.color = "var(--highlight)"; b.parentElement!.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; });
  assert.equal(bg, hl, "Stop is painted with the accent");
  await panel.getByText("Starting.").last().waitFor();
  await panel.locator("input[type=file]").setInputFiles({ name: "look.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") });
  await panel.locator("[data-agent-att=image]").first().waitFor();
  await box.fill("this one");
  await panel.locator("button[aria-label=Steer]").waitFor();
  await shot("6b-steer-with-picture");
  await box.press("Enter");
  await panel.getByText("Changed course: this one").waitFor();
  await panel.locator("button[aria-label=Stop]").waitFor({ state: "detached" });
  assert.equal(await panel.locator("[data-agent-steer-files] [data-agent-att=image]").count(), 1, "the picture shows where it was steered");
  assert.equal(await panel.locator("textarea[aria-label=Message] ~ * [data-agent-att=image], [data-agent-composer] [data-agent-att=image]").count(), 0, "and left the box");
  await shot("6c-steered-picture");

  // A steer that came after the turn's last step runs as a follow-up: each answer shows once, outside the fold.
  await box.fill("late");
  await box.press("Enter");
  await panel.getByText("First answer.").last().waitFor();
  await box.fill("the cat");
  await box.press("Enter");
  await panel.locator("button[aria-label=Stop]").waitFor({ state: "detached" });
  await sleep(300);
  assert.equal(await panel.getByText("Second answer, about the cat.").count(), 1, "the follow-up's answer shows once");
  assert.ok(await panel.getByText("First answer.").last().isVisible(), "the first answer isn't folded away");
  assert.ok(await panel.locator("[data-agent-work]").last().isVisible(), "the step is folded");
  await shot("6d-late-steer");

  // ================= permissions
  const pick = panel.locator("[data-agent-permission-pick]");
  assert.equal(await pick.getAttribute("data-agent-permission-pick"), "dangerous");
  const turn = async (text: string) => {
    await box.fill(text);
    await box.press("Enter");
  };
  const ended = () => panel.locator("button[aria-label=Stop]").waitFor({ state: "detached", timeout: 15000 });
  const card = panel.locator("[data-agent-permission]");
  // Only dangerous: an ordinary edit goes through, a delete asks.
  await turn("edit /home/me/notes/plan.md");
  await panel.getByText("edited", { exact: true }).last().waitFor();
  await ended();
  assert.equal(await card.count(), 0);
  await turn("ask");
  await card.waitFor();
  await shot("7-dangerous-asks");
  await card.getByRole("button", { name: "Allow once" }).click();
  await panel.getByText("allowed:yes").last().waitFor();
  await ended();
  // Ask for everything.
  await pick.click();
  await page.locator("[data-agent-permission-list]").waitFor();
  await sleep(300);
  await shot("8-permission-menu");
  await page.locator("[data-agent-permission-list] [data-permission=ask]").click();
  assert.equal(await pick.getAttribute("data-agent-permission-pick"), "ask");
  await turn("edit /home/me/notes/plan.md");
  await card.waitFor();
  await card.getByRole("button", { name: "Allow once" }).click();
  await ended();
  // Allow everything.
  await pick.click();
  await page.locator("[data-agent-permission-list] [data-permission=allow]").click();
  assert.equal(await pick.getAttribute("data-agent-permission-pick"), "allow");
  await turn("ask");
  await panel.getByText("allowed:yes").nth(1).waitFor();
  await ended();
  assert.equal(await card.count(), 0, "nothing asked");
  await shot("9-allow");
  assert.equal((await (await fetch(base + "/api/agent/permission")).json()).permission, "allow");

  // ================= closing the panel's only tab closes the panel; it opens again on a blank chat
  const whole = page.locator("[data-agent-panel]");
  await whole.locator("[role=tab]").first().hover();
  await page.keyboard.press("Alt+t");
  assert.equal(await whole.locator("[role=tab]").count(), 2);
  await whole.locator(".achat-tab-x").first().click({ force: true });
  assert.equal(await whole.locator("[role=tab]").count(), 1, "one of two tabs closed: the panel stays");
  await whole.locator(".achat-tab-x").first().click({ force: true });
  await whole.waitFor({ state: "detached" });
  await shot("10-panel-closed");
  await page.keyboard.press("Control+j");
  await whole.waitFor();
  assert.equal(await whole.locator("[role=tab]").count(), 1);
  assert.equal(await whole.locator("[data-agent-steer]").count(), 0, "a blank chat");

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
