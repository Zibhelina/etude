// A chat out of the side panel, open among the Notebook's pages: dragged onto a pane, moved around, alone on the
// screen, back to the panel. Through the real UI: `etude serve` on a scratch collection with the scripted ACP agent
// (test/fixtures/fake-acp-agent.mjs), driven in Chromium. Not part of `npm test` (it needs Chromium, playwright-core
// and a built web app). From an etude2 worktree:
//   npm run build && node test/e2e/ask-dock.ts [<screenshot dir>]
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ask-dock-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const db = join(scratch, "etude.db");
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ ai: { ...e.settings().ai, agents: [{ id: "fake", name: "Fakey", command: process.execPath, args: [join(WT, "test/fixtures/fake-acp-agent.mjs")] }] } });
  e.addAgentProfile({ id: "p-fake", name: "Fakey", brain: { kind: "external", agent: "fake" } });
  e.setDefaultAgentProfile("p-fake");
  e.close();
}
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port)], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/agent/profiles").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: (process.env.SCHEME as any) ?? "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem("etude.agent.open")) localStorage.setItem("etude.agent.open", "1");
    } catch {}
  });
  await page.goto(base + "/notes");
  await page.getByText("Skip", { exact: true }).click({ timeout: 4000 }).catch(() => {});
  const panel = page.locator("[data-agent-panel]");
  await panel.waitFor();
  await page.locator("[data-pane]").first().waitFor();
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const docked = page.locator(".note-chat-host [data-agent-docked]");
  const turn = async (scope: any, text: string) => {
    const box = scope.locator("textarea[aria-label=Message]");
    await box.fill(text);
    await box.press("Enter");
  };
  const done = (scope: any) => scope.locator("button[aria-label=Stop]").waitFor({ state: "detached", timeout: 20000 });
  /** Press on one point, travel to another, let go. */
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, midShot?: string) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 12, from.y + 8, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await sleep(200);
    if (midShot) await shot(midShot);
    await page.mouse.up();
    await sleep(350);
  };
  const mid = async (loc: any) => {
    const b = (await loc.boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  /** The part of a pane that's on screen (one pane alone is as tall as its page). */
  const paneBox = async (sel: string) => {
    const b = (await page.locator(sel).first().boundingBox())!;
    const y = Math.max(b.y, 0);
    return { x: b.x, y, width: b.width, height: Math.min(b.y + b.height, 900) - y };
  };

  // The tutorial's first page is open. A chat with one reply in the panel.
  await page.locator("[data-pane] .note-sheet, [data-pane] .ns-root, [data-pane] .note-page").first().waitFor();
  const on = panel.locator("[data-agent-tab=on]");
  await turn(on, "say hello from the panel");
  await on.getByText("hello from the panel").last().waitFor();
  await done(on);
  await shot("0-panel");

  // ---- its tab dragged to the right edge of the page: a pane of its own there.
  const P = await paneBox("[data-pane]");
  await drag(await mid(panel.locator(".achat-tab.is-on .achat-tab-main")), { x: P.x + P.width - 60, y: P.y + P.height / 2 }, "1-dragging");
  await docked.waitFor();
  assert.equal(await page.locator("[data-pane]").count(), 2, "the chat has a pane of its own");
  await docked.getByText("hello from the panel").last().waitFor();
  assert.equal(await panel.locator("[role=tab]").count(), 1);
  assert.ok((await panel.locator("[role=tab]").first().innerText()).endsWith("New chat"), "the panel is left with a blank chat");
  const chatPane = "[data-pane]:has(.note-chat-host)";
  const pagePane = "[data-pane]:not(:has(.note-chat-host))";
  assert.ok((await paneBox(chatPane)).x > (await paneBox(pagePane)).x, "chat on the right");
  await shot("2-right");

  // It answers there, and the pane's tab has its name.
  await turn(docked, "say hello from the page");
  await docked.getByText("hello from the page").last().waitFor();
  await done(docked);
  const chatTab = page.locator(".note-tab[data-tab^='chat:']");
  await chatTab.waitFor();

  // ---- a turn that's still running and a half-typed message both survive the tab moving to the left.
  await turn(docked, "wait");
  await docked.locator("button[aria-label=Stop]").waitFor();
  await docked.locator("textarea[aria-label=Message]").fill("half typed");
  const Q = await paneBox(pagePane);
  await drag(await mid(chatTab), { x: Q.x + 50, y: Q.y + Q.height / 2 });
  assert.ok((await paneBox(chatPane)).x < (await paneBox(pagePane)).x, "chat on the left");
  assert.equal(await docked.locator("textarea[aria-label=Message]").inputValue(), "half typed");
  // With words in the box the button is Steer; emptied, it's Stop again.
  await docked.locator("button[aria-label=Steer]").waitFor();
  await docked.locator("textarea[aria-label=Message]").fill("");
  await docked.locator("button[aria-label=Stop]").click();
  await done(docked);
  await shot("3-left");

  // ---- under the page.
  const R = await paneBox(pagePane);
  await drag(await mid(chatTab), { x: R.x + R.width / 2, y: R.y + R.height - 50 });
  assert.ok((await paneBox(chatPane)).y > (await paneBox(pagePane)).y, "chat under the page");
  await shot("4-bottom");
  // ---- and over it.
  const S = await paneBox(pagePane);
  await drag(await mid(chatTab), { x: S.x + S.width / 2, y: S.y + 90 });
  assert.ok((await paneBox(chatPane)).y < (await paneBox(pagePane)).y, "chat over the page");
  await shot("5-top");

  // ---- alone on the screen: the page's tab closed.
  for (const x of await page.locator(`${pagePane} .note-tab .note-tab-x`).all()) await x.click({ force: true });
  await sleep(300);
  assert.equal(await page.locator("[data-pane]").count(), 1);
  await docked.waitFor();
  const box = (await docked.locator("[data-agent-composer]").boundingBox())!;
  assert.ok(box.y + box.height <= 900, "the message box is on screen");
  await shot("6-alone");

  // A reload comes back to it.
  await page.reload();
  await docked.getByText("hello from the page").last().waitFor();
  await shot("7-reloaded");

  // ---- back to the panel from its tab's menu (alone, it has no tab strip: split first).
  await page.goto(base + "/notes");
  await docked.waitFor();
  await page.evaluate(() => (window as any).__t0 = 1);
  // Another tab in the pane so the strip shows.
  await page.locator(".note-tab-plus").first().click({ force: true });
  await chatTab.waitFor();
  await chatTab.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to the side panel" }).click();
  await panel.locator("[data-agent-tab=on]").getByText("hello from the page").last().waitFor();
  assert.equal(await docked.count(), 0);
  assert.equal(await page.locator(".note-tab[data-tab^='chat:']").count(), 0);
  await shot("8-back-in-panel");

  // ---- "Open as a page" from the panel tab's menu, then dragged back onto the panel.
  await panel.locator(".achat-tab.is-on .achat-tab-main").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open as a page" }).click();
  await docked.getByText("hello from the page").last().waitFor();
  await chatTab.waitFor();
  await drag(await mid(chatTab), await mid(panel.locator("[data-agent-tab=on]")), "9-dragging-back");
  await panel.locator("[data-agent-tab=on]").getByText("hello from the page").last().waitFor();
  assert.equal(await docked.count(), 0);

  // ---- from another screen: Open as a page goes to the Notebook.
  await page.goto(base + "/stats");
  await panel.locator("[data-agent-tab=on]").getByText("hello from the page").last().waitFor();
  await panel.locator(".achat-tab.is-on .achat-tab-main").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open as a page" }).click();
  await docked.getByText("hello from the page").last().waitFor();
  assert.ok(page.url().includes("/notes"));
  await shot("10-from-stats");

  // With the panel closed the chat has the whole width, and its messages keep to a column.
  await page.keyboard.press("Control+j");
  await panel.waitFor({ state: "detached" });
  await sleep(400);
  await shot("11-panel-closed");
  const col = (await docked.locator("[data-agent-composer]").boundingBox())!;
  assert.ok(col.width <= 740, "a readable column");

  assert.deepEqual(errors, []);
  console.log("ok", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
  await browser.contexts()[0]?.pages()[0]?.screenshot({ path: join(SHOTS, "failed.png") }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
