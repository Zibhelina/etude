// Notes' sidebar shows Pages or Chats: a chat tab in front switches it to Chats, a page back to Pages; picking a chat
// there changes the chat in front; another chat opens beside as a new tab; the chat's own button flips the view; a
// rename there reaches the open chat. Through the real UI: `etude serve` on a scratch collection, driven in Chromium.
// Not part of `npm test`. From an etude2 worktree:
//   npm run build && node test/e2e/notes-chats.ts [<screenshot dir>]   (WEB=<dir> serves another build)
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "notes-chats-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const db = join(scratch, "etude.db");
const ids: Record<string, string> = {};
let pageId = "";
{
  const e = await Etude.open(db, { home: scratch });
  pageId = (e as any).createNote ? (e as any).createNote({ title: "Lecture notes", body: "hello" }).id : "";
  const a = agentFor(e);
  const store = (a as any).store;
  for (const [title, said] of [["Triangle rasterization", "how do I fill a triangle"], ["Keypad lock", "which lock fits 54 mm"]]) {
    const c = a.createConversation(null);
    a.renameConversation(c.id, title);
    store.run("INSERT INTO agent_messages (conversation_id, role, content, created) VALUES (?, 'user', ?, ?)", c.id, JSON.stringify({ text: said, attachments: [] }), new Date().toISOString());
    ids[title] = c.id;
  }
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
    } catch {}
  });
  await page.goto(base + "/notes");
  await page.getByText("Skip", { exact: true }).click({ timeout: 4000 }).catch(() => {});
  const panel = page.locator("[data-agent-panel]");
  await panel.waitFor();
  const sb = page.locator("[data-notes-slot]");
  await sb.waitFor();
  const view = () => page.locator("[data-notes-view][aria-selected=true]").getAttribute("data-notes-view");

  // Open the panel's chat as a Notebook page: the sidebar turns to Chats, and the chat has no column of its own.
  await panel.locator("[data-chat-tab]").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open as a page" }).click();
  await page.locator(".note-chat-page").waitFor();
  await sleep(400);
  assert.equal(await view(), "chats");
  assert.equal(await page.locator(".note-chat-page [data-chat-sidebar]").count(), 0, "no second column");
  const list = sb.locator("[data-chat-sidebar]");
  await list.waitFor();
  // On Chats the sidebar is only the chats: Library and the rest are gone, the switch is at the top.
  assert.equal(await page.locator("[data-shell-sidebar] .sb-item").count(), 0, "no Library, Notebook… on Chats");
  await page.screenshot({ path: join(SHOTS, "1-chats.png") });

  // Pick a chat in the sidebar: the chat in front shows it.
  await list.locator(`[data-chat-row="${ids["Keypad lock"]}"] .csb-row-main`).click();
  await page.locator(".note-chat-page").getByText("which lock fits 54 mm").first().waitFor();
  assert.ok((await list.locator(`[data-chat-row="${ids["Keypad lock"]}"]`).getAttribute("class"))!.includes("is-on"));
  const tabsBefore = await page.locator(".note-chat-page .note-tab, .note-tabs [data-tab]").count();

  // Another in a new tab, from the row's menu.
  const row = list.locator(`[data-chat-row="${ids["Triangle rasterization"]}"]`);
  await row.hover();
  await row.locator(".csb-row-more").click();
  await page.getByRole("menuitem", { name: "Open in a new tab" }).click();
  await page.locator(".note-chat-page").getByText("how do I fill a triangle").first().waitFor();
  assert.ok((await list.locator(`[data-chat-row="${ids["Triangle rasterization"]}"]`).getAttribute("class"))!.includes("is-on"));
  // Picking the first again brings its tab forward (no third tab).
  await list.locator(`[data-chat-row="${ids["Keypad lock"]}"] .csb-row-main`).click();
  await page.locator(".note-chat-page").getByText("which lock fits 54 mm").first().waitFor();

  // Rename in the sidebar: the open chat's tab follows.
  await list.locator(`[data-chat-row="${ids["Keypad lock"]}"] .csb-row-main`).dblclick();
  await list.getByLabel("Chat name").fill("Door lock");
  await list.getByLabel("Chat name").press("Enter");
  await page.locator(".note-topbar").getByText("Door lock").first().waitFor({ timeout: 5000 });

  // The chat's own button flips the sidebar to Pages and back.
  await page.locator(".note-chat-page [data-chat-sidebar-toggle]").click();
  await sleep(200);
  assert.equal(await view(), "pages");
  assert.ok((await page.locator("[data-shell-sidebar] .sb-item").count()) > 3, "the usual rows are back on Pages");
  await page.screenshot({ path: join(SHOTS, "2-pages.png") });
  await page.locator(".note-chat-page [data-chat-sidebar-toggle]").click();
  await sleep(200);
  assert.equal(await view(), "chats");

  // New chat from the sidebar: the chat in front becomes a blank one.
  await list.getByRole("button", { name: "New chat", exact: true }).click();
  await sleep(500);
  assert.equal(await list.locator(".csb-row.is-on[data-chat-row]").count(), 0);
  assert.deepEqual(errors, []);
  console.log("ok", SHOTS, tabsBefore);
} catch (e) {
  failed = true;
  console.error(e);
  await browser.contexts()[0]?.pages()[0]?.screenshot({ path: join(SHOTS, "fail.png") }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
