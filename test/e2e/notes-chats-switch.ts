// A chat in the Notebook writing a reply: picking another chat in the sidebar shows that one (the reply goes on
// on the server), going back picks the reply up where it is, and its end lands in its own chat only. Through the real UI: `etude serve` on a scratch collection, driven in Chromium.
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "notes-chats-switch-"));
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
  e.updateSettings({ ai: { ...e.settings().ai, agents: [{ id: "fake", name: "Fakey", command: process.execPath, args: [join(WT, "test/fixtures/fake-acp-agent.mjs")] }] }, onboarding: { ...e.settings().onboarding, done: true } });
  e.addAgentProfile({ id: "p-fake", name: "Fakey", brain: { kind: "external", agent: "fake" } });
  e.setDefaultAgentProfile("p-fake");
  const a = agentFor(e);
  const store = (a as any).store;
  for (const [title, said] of [["Triangle rasterization", "how do I fill a triangle"], ["Keypad lock", "which lock fits 54 mm"]]) {
    const c = a.createConversation(null, "p-fake");
    a.renameConversation(c.id, title);
    store.run("INSERT INTO agent_messages (conversation_id, role, content, created) VALUES (?, 'user', ?, ?)", c.id, JSON.stringify({ text: said, attachments: [] }), new Date().toISOString());
    ids[title] = c.id;
  }
  e.close();
}
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port), ...(process.env.WEB ? ["--web", process.env.WEB] : [])], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch, FAKE_SLOW_MS: "5000" }, stdio: ["ignore", "ignore", "inherit"] });
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

  await panel.locator("[data-chat-tab]").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open as a page" }).click();
  const chatPage = page.locator(".note-chat-page");
  await chatPage.waitFor();
  const list = sb.locator("[data-chat-sidebar]");
  await list.waitFor();
  const shows = (t: string) => chatPage.getByText(t).count();

  // A reply on its way in the chat in front.
  const box = chatPage.locator("textarea").first();
  await box.fill("slow");
  await box.press("Enter");
  await chatPage.getByText("Halfway there.").first().waitFor({ timeout: 8000 });
  const running = (await fetch(base + "/api/agent/conversations").then((r) => r.json())).running as string[];
  assert.equal(running.length, 1, "one reply running");
  const slowId = running[0];
  await page.screenshot({ path: join(SHOTS, "1-running.png") });

  // Another chat from the sidebar: it shows, without the reply.
  await list.locator(`[data-chat-row="${ids["Keypad lock"]}"] .csb-row-main`).click();
  await chatPage.getByText("which lock fits 54 mm").first().waitFor({ timeout: 4000 });
  await sleep(500);
  assert.equal(await shows("Halfway there."), 0, "the other chat's reply isn't shown here");
  assert.equal(await shows("slow"), 0, "nor its question");
  assert.ok((await list.locator(`[data-chat-row="${ids["Keypad lock"]}"]`).getAttribute("class"))!.includes("is-on"));
  await page.screenshot({ path: join(SHOTS, "2-other-chat.png") });
  // Its composer is free: no Stop.
  assert.equal(await chatPage.getByRole("button", { name: /^Stop/ }).count(), 0, "no Stop in the other chat");

  // Back to the running chat: the reply so far, then its end.
  await list.locator(`[data-chat-row="${slowId}"] .csb-row-main`).click();
  await chatPage.getByText("Halfway there.").first().waitFor({ timeout: 4000 });
  await chatPage.getByText("All the way there.").first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(SHOTS, "3-back.png") });

  // Away again while it runs, and it ends while away: the end lands in its own chat, not in the one in front.
  await box.fill("slow");
  await box.press("Enter");
  await sleep(600);
  await list.locator(`[data-chat-row="${ids["Triangle rasterization"]}"] .csb-row-main`).click();
  await chatPage.getByText("how do I fill a triangle").first().waitFor({ timeout: 4000 });
  await sleep(6000);
  assert.equal(await shows("All the way there."), 0, "the reply's end didn't land in the chat in front");
  const tri = await fetch(base + `/api/agent/conversations/${ids["Triangle rasterization"]}`).then((r) => r.json());
  assert.equal(tri.messages.length, 1, "nothing saved into the wrong chat");
  const slow = await fetch(base + `/api/agent/conversations/${slowId}`).then((r) => r.json());
  assert.equal(slow.messages.filter((m: any) => m.role === "assistant").length, 2, "both replies saved in their chat");
  await list.locator(`[data-chat-row="${slowId}"] .csb-row-main`).click();
  await sleep(800);
  assert.equal(await shows("All the way there."), 2, "both ends shown back in their chat");
  assert.equal(await chatPage.getByRole("button", { name: /^Stop/ }).count(), 0);
  await page.screenshot({ path: join(SHOTS, "4-ended-away.png") });

  // Delete from the sidebar: the chat in front goes, the list too.
  const row = list.locator(`[data-chat-row="${slowId}"]`);
  await row.hover();
  await row.locator(".csb-row-more").click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("menuitem", { name: "Delete for good?" }).click();
  await sleep(800);
  assert.equal(await list.locator(`[data-chat-row="${slowId}"]`).count(), 0);
  assert.ok(!(await fetch(base + "/api/agent/conversations").then((r) => r.json())).conversations.some((c: any) => c.id === slowId));
  assert.deepEqual(errors, []);
  console.log("ok", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
  await browser.contexts()[0]?.pages()[0]?.screenshot({ path: join(SHOTS, "fail.png") }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
