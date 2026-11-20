// Tabs and rich replies in Ask through the real UI: `etude serve` on a scratch collection with the scripted ACP
// agent (test/fixtures/fake-acp-agent.mjs), driven in Chromium. Not part of `npm test` (it needs Chromium,
// playwright-core and a built web app). From an etude2 worktree:
//   npm run build && node test/e2e/ask-rich.ts [<screenshot dir>] [<folder with voice.mp3, pic.png, heart.webp>]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Etude } from "../../src/core/engine.ts";
const require = createRequire(join(process.env.PLAYWRIGHT_FROM ?? process.cwd(), "package.json"));
const { chromium } = require("playwright-core");

const WT = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ask-rich-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
const ASSETS = process.argv[3] ?? scratch;
mkdirSync(SHOTS, { recursive: true });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
for (const f of ["pic.png", "heart.webp"]) if (!existsSync(join(ASSETS, f))) writeFileSync(join(ASSETS, f), PNG);
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium", args: ["--autoplay-policy=no-user-gesture-required"] });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, colorScheme: (process.env.SCHEME as any) ?? "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript(() => {
    // Runs in every frame; a widget's sandbox has no storage.
    try {
      localStorage.setItem("etude.agent.open", "1");
      if (!localStorage.getItem("etude.agent.width")) localStorage.setItem("etude.agent.width", "520");
    } catch {}
  });
  await page.goto(base + "/");
  const panel = page.locator("[data-agent-panel]");
  // A new collection opens on the welcome screens.
  await page.getByText("Skip", { exact: true }).click({ timeout: 4000 }).catch(() => {});
  await panel.waitFor();
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const box = () => panel.locator("[data-agent-tab=on] textarea[aria-label=Message]");
  const say = async (text: string) => {
    await box().fill(`say ${text}`);
    await box().press("Enter");
    await panel.locator("[data-agent-tab=on] button[aria-label=Send], [data-agent-tab=on] button[aria-label=Stop]").first().waitFor({ state: "attached" });
    await panel.locator("[data-agent-tab=on] button[aria-label=Stop]").waitFor({ state: "detached", timeout: 20000 });
  };
  const on = panel.locator("[data-agent-tab=on]");
  const talkTo = async (name: string) => {
    if (await on.locator(`button[aria-label^="Talking to ${name}"]`).count()) return;
    await on.locator("button[aria-label^='Talking to']").click();
    await page.getByRole("menuitem", { name }).or(page.getByRole("option", { name })).or(page.locator("[data-slot=popover-content] button", { hasText: name })).first().click();
    await on.locator(`button[aria-label^="Talking to ${name}"]`).waitFor();
  };
  await talkTo("Fakey");

  // ---- one reply with everything in it
  await say([
    "A chart, a widget and a note block:",
    "",
    "```chart",
    JSON.stringify({ type: "line", title: "Cards reviewed", x: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], series: [{ name: "This week", data: [12, 30, 22, 41, 38, 15, 52] }, { name: "Last week", data: [8, 14, 26, 20, 31, 9, 27] }] }),
    "```",
    "",
    "```widget",
    `<div style="padding:14px"><h3>A counter</h3><div style="display:flex;gap:10px;align-items:center"><b id="n">0</b><button id="b">+1</button><button class="primary" data-etude-send="say You pressed the widget button.">Tell the agent</button></div></div><script>let n=0;b.onclick=()=>document.getElementById("n").textContent=++n</script>`,
    "```",
    "",
    "```note",
    JSON.stringify([{ type: "callout", attrs: { kind: "tip" }, content: [{ type: "paragraph", content: [{ type: "text", text: "A callout, the way a page shows it." }] }] }, { type: "mathBlock", attrs: { latex: "e^{i\\pi} + 1 = 0" } }]),
    "```",
  ].join("\n"));
  await on.locator("[data-agent-chart] svg").waitFor();
  await on.locator("[data-agent-widget] iframe").waitFor();
  await on.locator("[data-agent-note] .note-callout, [data-agent-note] [data-callout], [data-agent-note] .katex").first().waitFor();
  await sleep(600);
  await shot("1-chart-widget-note");

  // The widget talks back: its button sends the agent a message.
  const frame = page.frameLocator("[data-agent-tab=on] [data-agent-widget] iframe");
  await frame.locator("#b").click();
  assert.equal(await frame.locator("#n").textContent(), "1");
  await frame.locator("[data-etude-send]").click();
  await on.getByText("You pressed the widget button.").last().waitFor({ timeout: 15000 });

  // ---- the message box's pickers: the model and effort the agent offers, picked before and after the first message
  await shot("1b-composer");
  assert.match(await on.locator("[data-agent-control=reasoning_effort]").innerText(), /medium/);
  await on.locator("[data-agent-control=reasoning_effort]").click();
  await page.locator("[data-agent-control-list=reasoning_effort] [cmdk-item]", { hasText: "high" }).click();
  await on.locator("[data-agent-control=model]").click();
  await page.locator("[data-agent-control-list=model] [cmdk-item]", { hasText: "big" }).click();
  await box().fill("think");
  await box().press("Enter");
  await on.getByText("Thought it through on fake:big at high.").waitFor({ timeout: 15000 });
  // The thinking folds into one line and opens on a click; the ring shows the context and opens the chat's details.
  await on.locator("[data-agent-thought] button").last().click();
  await on.getByText("Let me think about this.").waitFor();
  await on.locator("[data-agent-ring]").click();
  const card = page.locator("[data-agent-session]");
  await card.getByText("52k of 200k tokens").waitFor();
  await card.getByText("26%").waitFor();
  await sleep(300);
  await shot("1c-thought-and-session");
  await page.keyboard.press("Escape");

  // ---- a second tab, working while the first one is still going
  await box().fill("wait");
  await box().press("Enter");
  await on.locator("button[aria-label=Stop]").waitFor();
  await panel.locator("button[aria-label='New chat']").click();
  assert.equal(await panel.locator("[role=tab]").count(), 2);
  await talkTo("Fakey");
  await say([`Files from this computer:`, "", `MEDIA:${join(ASSETS, "pic.png")}`, "", ...(existsSync(join(ASSETS, "voice.mp3")) ? [`MEDIA:${join(ASSETS, "voice.mp3")}`, ""] : []), `::sticker{file="${join(ASSETS, "heart.webp")}"}`, "", "```chart", JSON.stringify({ type: "donut", title: "Due today", data: { New: 12, Learning: 7, Review: 41 } }), "```"].join("\n"));
  await on.locator(".achat-picture img").waitFor();
  assert.ok(await on.locator(".achat-picture img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), "the picture loaded");
  assert.ok(await on.locator(".achat-sticker").evaluate((i: HTMLImageElement) => i.naturalWidth > 0), "the sticker loaded");
  if (existsSync(join(ASSETS, "voice.mp3"))) {
    await on.locator("[data-agent-voice] button[aria-label=Play]").click();
    await on.locator("[data-agent-voice] button[aria-label=Pause]").waitFor();
    await sleep(1200);
    assert.ok(await on.locator("[data-agent-voice] audio").evaluate((a: HTMLAudioElement) => a.currentTime > 0.3 && a.duration > 1), "the voice note plays");
    await on.locator("[data-agent-voice] button[aria-label=Pause]").click();
  }
  // The first tab is still working behind this one.
  assert.equal(await panel.locator("[role=tab]").first().locator("[aria-label=Working]").count(), 1);
  await sleep(400);
  await shot("2-second-tab-media");

  // Back to the first: stop it; it's the same chat, still there.
  await panel.locator("[role=tab]").first().click();
  await on.locator("button[aria-label=Stop]").click();
  await on.locator("button[aria-label=Stop]").waitFor({ state: "detached" });
  assert.equal(await on.locator("[data-agent-chart]").count(), 1);
  await shot("3-first-tab-again");

  // Tabs come back after a reload, with the same one in front.
  await page.reload();
  await panel.waitFor();
  await panel.locator("[data-agent-tab=on] [data-agent-chart] svg").waitFor();
  assert.equal(await panel.locator("[role=tab]").count(), 2);
  await panel.locator("[role=tab]").nth(1).click();
  await panel.locator("[data-agent-tab=on] .achat-picture img").waitFor();
  // Closing a tab leaves the chat in the history.
  await panel.locator("[data-agent-tab=on]").waitFor();
  await panel.locator(".achat-tab.is-on button[aria-label^=Close]").click();
  assert.equal(await panel.locator("[role=tab]").count(), 1);
  await panel.locator("button[aria-label=History]").click();
  assert.equal(await page.locator("[data-agent-history] li").count(), 2);
  await page.keyboard.press("Escape");

  // A narrow panel.
  await page.evaluate(() => localStorage.setItem("etude.agent.width", "340"));
  await page.reload();
  await panel.locator("[data-agent-tab=on] [data-agent-chart] svg").waitFor();
  await sleep(500);
  await shot("4-narrow");
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
