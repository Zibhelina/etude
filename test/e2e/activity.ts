// Activity (Settings → Privacy → Activity) in the real app: off at first (Stats invites, the window sends nothing),
// turned on in Settings, then typing in a page and a Markdown file on disk, time in each, and Stats showing them by
// name; no text reaches the table; turning it off with Delete stops and removes it. `etude serve` on a scratch
// collection, driven in Chromium. Not part of `npm test`. From an etude2 worktree:
//   npm run build && node test/e2e/activity.ts [<screenshot dir>]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "activity-e2e-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const db = join(scratch, "etude.db");
const env = { ...process.env, ETUDE_HOME: scratch };
const cli = async (...argv: string[]) => {
  let out = "", err = "";
  const code = await run(["--db", db, ...argv, "--json"], { stdout: (x) => (out += x), stderr: (x) => (err += x), stdin: () => "", isTTY: false, env });
  return { code, json: out.trim() ? JSON.parse(out) : null, err };
};
const vault = join(scratch, "vault");
mkdirSync(vault);
writeFileSync(join(vault, "Reading.md"), "# Reading\n\nStart.\n");
let pageA = "", pageB = "";
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ onboarding: { ...e.settings().onboarding, done: true } });
  e.close();
  pageA = (await cli("note", "new", "Lecture one", "--text", "Hi.")).json.id;
  pageB = (await cli("note", "new", "Problem set", "--text", "Hi.")).json.id;
}
const folder = (await cli("folder", "open", vault)).json;
const fileId = `fs:${folder.id}/Reading.md`;

const server = spawn(process.execPath, [join(WT, "src/cli/main.ts"), "--db", db, "serve", "--port", String(port), ...(process.env.WEB ? [`--web`, process.env.WEB] : [])], { cwd: WT, env, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/notes").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: "dark" });
  // Automated browsers record nothing unless a test says so.
  await ctx.addInitScript(() => localStorage.setItem("etude.activity.test", "1"));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("console", (m: any) => m.type() === "error" && !/favicon|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  const posts: string[] = [];
  page.on("request", (r: any) => r.method() === "POST" && new URL(r.url()).pathname === "/api/activity" && posts.push(r.postData() ?? ""));
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  const status = async () => (await cli("activity")).json;
  const show = async () => (await cli("activity", "show", "--days", "7")).json;
  const typeIn = async (id: string, text: string) => {
    await page.goto(`${base}/notes?id=${encodeURIComponent(id)}`);
    const ed = page.locator("[data-pane] .ProseMirror, [data-pane] .cm-content").first();
    await ed.waitFor();
    await ed.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Control+End");
    await page.keyboard.type(text, { delay: 15 });
  };
  /** Leaving the page sends what's waiting (pagehide), like closing the window. */
  const leave = async () => {
    await page.goto(`${base}/decks`);
    await sleep(400);
  };

  // A fresh collection makes its Notes tutorial on the first visit and opens it a moment later: let that settle.
  await page.goto(`${base}/notes`);
  let last = "";
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (page.url() === last && i > 8) break;
    last = page.url();
  }

  // 1. Off: Stats invites, and typing sends nothing.
  await page.goto(`${base}/stats`);
  await page.locator("[data-activity-invite]").waitFor();
  await shot("1-stats-invite");
  await typeIn(pageA, " Nothing counts yet.");
  await leave();
  assert.deepEqual(posts, [], "nothing was sent while Activity was off");
  assert.equal((await status()).rows, 0);

  // 2. On, from Settings → Privacy.
  await page.goto(`${base}/settings#privacy`);
  const sw = page.locator("#privacy-activity");
  await sw.waitFor();
  await sleep(500);
  await page.locator('[data-settings-section="activity"]').screenshot({ path: join(SHOTS, "2-settings-off.png") });
  await sw.click();
  for (let i = 0; i < 30 && !(await status()).on; i++) await sleep(100);
  assert.equal((await status()).on, true);
  await page.locator("[data-activity-keep]").first().waitFor();
  await page.locator('[data-settings-section="activity"]').screenshot({ path: join(SHOTS, "3-settings-on.png") });

  // 3. Writing in a page and in a Markdown file, a few seconds in each.
  await typeIn(pageA, " one two three four five");
  await sleep(6000);
  await typeIn(fileId, "\nsix seven eight");
  await sleep(6000);
  await typeIn(pageB, " nine");
  await leave();
  for (let i = 0; i < 30 && (await show()).top.length < 3; i++) await sleep(150);
  const s = await show();
  const by = (ref: string) => s.top.find((t: any) => t.ref === ref);
  assert.ok(by(pageA), `page A recorded: ${JSON.stringify(s.top)}`);
  assert.equal(by(pageA).title, "Lecture one");
  assert.equal(by(pageA).words, 5, "five words started in page A");
  assert.equal(by(pageA).kind, "page");
  assert.ok(by(pageA).ms >= 4000, `time in page A: ${by(pageA).ms}`);
  assert.equal(by(fileId).kind, "file");
  assert.equal(by(fileId).title, "Reading");
  assert.equal(by(fileId).path, "Reading.md");
  assert.equal(by(fileId).words, 3);
  assert.ok(by(fileId).ms >= 4000, `time in the file: ${by(fileId).ms}`);
  assert.equal(by(pageB).words, 1);
  assert.ok(s.totals.typed >= " one two three four five".length + "six seven eight".length);
  // No text in what was sent or kept.
  for (const p of posts) assert.equal(/one two|seven|nine|Lecture/.test(p), false, `a request carried text: ${p}`);
  const e = await Etude.open(db, { home: scratch });
  const dump = JSON.stringify(e.db.all("SELECT * FROM activity_log"));
  e.close();
  assert.equal(/one|seven|nine|Lecture|Reading/.test(dump.replace(fileId, "")), false, dump);

  // 4. Stats shows it by name; a page opens from the list.
  await page.goto(`${base}/stats`);
  await page.locator("[data-activity-top]").waitFor();
  assert.ok(await page.locator("[data-activity-top]", { hasText: "Lecture one" }).count());
  assert.ok(await page.locator("[data-activity-top]", { hasText: "Reading" }).count());
  await page.locator("[data-activity-stats]").scrollIntoViewIfNeeded();
  await shot("4-stats-activity");
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  await page.locator("[data-activity-stats]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, "5-stats-phone-width.png") });
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.locator("[data-activity-top] button", { hasText: "Lecture one" }).click();
  await page.waitForURL(/\/notes\?id=/);
  assert.match(page.url(), new RegExp(encodeURIComponent(pageA)));

  // 5. Off and deleted: rows go, and nothing more is sent.
  await page.goto(`${base}/settings#privacy`);
  await page.locator("#privacy-activity").click();
  await page.locator("[data-activity-off-delete]").waitFor();
  await page.screenshot({ path: join(SHOTS, "6-turn-off-dialog.png") });
  await page.locator("[data-activity-off-delete]").click();
  for (let i = 0; i < 30 && (await status()).on; i++) await sleep(100);
  const after = await status();
  assert.deepEqual([after.on, after.rows], [false, 0]);
  const before = posts.length;
  await typeIn(pageA, " after");
  await leave();
  assert.equal(posts.length, before, "nothing was sent after turning it off");
  assert.equal((await status()).rows, 0);
  await page.goto(`${base}/stats`);
  await page.locator("[data-activity-invite]").waitFor();

  assert.deepEqual(errors, []);
  console.log("ok: activity e2e, shots in", SHOTS);
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
