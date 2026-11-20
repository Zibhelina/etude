// The chats' sidebar in Ask: open and close, beside the chat in a wide panel and over it in a narrow one, pinned
// chats on top, then by date, filter by agent, search through what was said, rename, pin and delete. Through the real
// UI: `etude serve` on a scratch collection, driven in Chromium. Not part of `npm test`. From an etude2 worktree:
//   npm run build && node test/e2e/ask-sidebar.ts [<screenshot dir>]   (WEB=<dir> serves another build)
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Etude } from "../../src/core/engine.ts";
import { agentFor } from "../../src/core/agent.ts";
const require = createRequire(join(process.env.PLAYWRIGHT_FROM ?? process.cwd(), "package.json"));
const { chromium } = require("playwright-core");

const WT = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ask-sidebar-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const db = join(scratch, "etude.db");
const ids: Record<string, string> = {};
{
  const e = await Etude.open(db, { home: scratch });
  e.addAgentProfile({ id: "plain", name: "Plain" });
  e.addAgentProfile({ id: "tutor", name: "Tutor" });
  e.setDefaultAgentProfile("plain");
  const a = agentFor(e);
  const store = (a as any).store;
  const day = 86_400_000;
  const chats: [string, string, number, string][] = [
    ["Triangle rasterization", "plain", 0, "how do I fill a triangle with the top-left rule?"],
    ["Midterm grade", "plain", 0.1, "I got 62 out of 75 on the midterm"],
    ["Sofa beds for the cousins", "tutor", 1, "find sofa beds under 200 dollars"],
    ["Keypad lock", "plain", 3, "which keypad lock fits a 54 mm hole"],
    ["Fourier series", "tutor", 12, "explain the Fourier series with a picture"],
    ["Bloom filters", "plain", 45, "what is a bloom filter"],
  ];
  for (const [title, profile, ago, said] of chats) {
    const c = a.createConversation(null, profile);
    a.renameConversation(c.id, title);
    store.run("INSERT INTO agent_messages (conversation_id, role, content, created) VALUES (?, 'user', ?, ?)", c.id, JSON.stringify({ text: said, attachments: [] }), new Date().toISOString());
    store.run("INSERT INTO agent_messages (conversation_id, role, content, created) VALUES (?, 'assistant', ?, ?)", c.id, JSON.stringify({ text: `Here's how: ${said} — step by step.`, items: [], model: "x", ms: 1, changed: false }), new Date().toISOString());
    store.run("UPDATE agent_conversations SET updated = ? WHERE id = ?", new Date(Date.now() - ago * day).toISOString(), c.id);
    ids[title] = c.id;
  }
  a.pinConversation(ids["Keypad lock"], true);
  e.close();
}
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port), ...(process.env.WEB ? ["--web", process.env.WEB] : [])], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/agent/profiles").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem("etude.agent.open")) localStorage.setItem("etude.agent.open", "1");
      if (!localStorage.getItem("etude.agent.width")) localStorage.setItem("etude.agent.width", "960");
    } catch {}
  });
  await page.goto(base + "/notes");
  await page.getByText("Skip", { exact: true }).click({ timeout: 4000 }).catch(() => {});
  const panel = page.locator("[data-agent-panel]");
  await panel.waitFor();
  const side = panel.locator("[data-chat-sidebar]");
  assert.equal(await side.count(), 0, "closed at first");

  // Open it: beside the chat (wide panel), pinned first, then by date.
  await panel.locator("[data-chat-sidebar-toggle]").click();
  await side.waitFor();
  assert.ok(!(await side.evaluate((el: Element) => el.classList.contains("is-overlay"))), "beside the chat when there's room");
  await sleep(300);
  const labels = await side.locator(".csb-label").allTextContents();
  assert.deepEqual(labels, ["Agents", "Pinned", "Today", "Yesterday", "Previous 30 days", new Date(Date.now() - 45 * 86_400_000).toLocaleDateString(undefined, { month: "long" })].slice(0, labels.length));
  assert.equal(await side.locator("[data-chat-row] [data-chat-title]").first().textContent(), "Keypad lock");
  await page.screenshot({ path: join(SHOTS, "1-wide.png") });

  // Pick a chat: it opens beside.
  await side.locator(`[data-chat-row="${ids["Fourier series"]}"] .csb-row-main`).click();
  await panel.getByText("explain the Fourier series with a picture").first().waitFor();
  assert.equal(await side.locator(`[data-chat-row="${ids["Fourier series"]}"]`).getAttribute("class").then((c: string) => c.includes("is-on")), true);

  // Only Tutor's chats.
  await side.locator(".csb-row-main", { hasText: "Tutor" }).click();
  const tutorRows = await side.locator("[data-chat-row] [data-chat-title]").allTextContents();
  assert.deepEqual(tutorRows.sort(), ["Fourier series", "Sofa beds for the cousins"]);
  await page.screenshot({ path: join(SHOTS, "2-tutor.png") });
  await side.locator(".csb-row-main", { hasText: "Tutor" }).click();

  // Search finds the words said, not just titles.
  await side.getByRole("button", { name: "Search chats" }).first().click();
  await side.getByLabel("Search chats").fill("54 mm");
  await side.locator("[data-chat-search] [data-chat-row]").first().waitFor();
  assert.equal(await side.locator("[data-chat-search] [data-chat-row]").count(), 1);
  assert.match(await side.locator("[data-chat-search]").textContent(), /54 mm/);
  await page.screenshot({ path: join(SHOTS, "3-search.png") });
  await side.getByLabel("Search chats").press("Escape");

  // Rename and pin from the row's menu.
  const row = side.locator(`[data-chat-row="${ids["Bloom filters"]}"]`);
  await row.hover();
  await row.locator(".csb-row-more").click();
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await sleep(300);
  assert.equal(await side.locator(".csb-section").nth(1).locator("[data-chat-row]").count(), 2, "two pinned");
  const pinned = await fetch(base + "/api/agent/conversations").then((r) => r.json());
  assert.equal(pinned.conversations.find((c: any) => c.id === ids["Bloom filters"]).pinned, true);
  await row.locator(".csb-row-main").dblclick();
  await side.getByLabel("Chat name").fill("Bloom filters, explained");
  await side.getByLabel("Chat name").press("Enter");
  await side.getByText("Bloom filters, explained").waitFor();

  // Delete asks twice.
  const del = side.locator(`[data-chat-row="${ids["Midterm grade"]}"]`);
  await del.hover();
  await del.locator(".csb-row-more").click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("menuitem", { name: "Delete for good?" }).click();
  await sleep(400);
  assert.equal(await side.locator(`[data-chat-row="${ids["Midterm grade"]}"]`).count(), 0);

  // Narrow panel: over the chat, with a scrim that closes it.
  await page.evaluate(() => localStorage.setItem("etude.agent.width", "430"));
  await page.reload();
  await panel.waitFor();
  await side.waitFor();
  assert.ok(await side.evaluate((el: Element) => el.classList.contains("is-overlay")), "over the chat when narrow");
  await page.screenshot({ path: join(SHOTS, "4-narrow.png") });
  await panel.locator(".csb-scrim").click({ position: { x: 400, y: 400 } });
  await sleep(200);
  assert.equal(await side.count(), 0);
  // Ctrl+Shift+S from the composer.
  await panel.locator("textarea").first().click();
  await page.keyboard.press("Control+Shift+S");
  await side.waitFor();
  assert.deepEqual(errors, []);
  console.log("ok", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
