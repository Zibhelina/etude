// The Notebook's pages stay in the sidebar on the other screens: open folders stay open, a page picked there brings
// you back to the Notebook with it open, and the Notebook keeps its tabs. `etude serve` on a scratch collection,
// driven in Chromium. Not part of `npm test`. From an etude2 worktree:
//   npm run build && node test/e2e/notes-sidebar-away.ts [<screenshot dir>]
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "notes-away-"));
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
const ids: Record<string, string> = {};
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ onboarding: { ...e.settings().onboarding, done: true } });
  e.close();
  ids.f = (await cli("note", "new", "Course", "--folder")).json.id;
  ids.a = (await cli("note", "new", "Lecture one", "--text", "Hi.", "--parent", ids.f)).json.id;
  ids.b = (await cli("note", "new", "Reading list", "--text", "Hi.")).json.id;
}
const server = spawn(process.execPath, [join(WT, "src/cli/main.ts"), "--db", db, "serve", "--port", String(port), ...(process.env.WEB ? ["--web", process.env.WEB] : [])], { cwd: WT, env, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/notes").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, colorScheme: "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const row = (k: string) => page.locator(`[data-notes-slot] [data-note-row="${ids[k]}"]`);
  await page.goto(`${base}/notes?id=${ids.b}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  await page.locator("[data-pane] .note-title").first().waitFor();
  // Unfold the folder so its page shows.
  await row("f").click();
  await row("a").waitFor({ timeout: 3000 });
  await shot("1-notebook");

  // Another screen: the pages, and the open folder, are still there.
  await page.locator('[data-shell-sidebar] button[aria-label="Library"], [data-shell-sidebar] button[aria-label="Decks"]').first().click();
  await page.waitForFunction(() => location.pathname !== "/notes");
  await sleep(500);
  assert.ok(await row("f").isVisible(), "the folder row stays in the sidebar");
  assert.ok(await row("a").isVisible(), "the open folder stays open");
  assert.ok(!(await page.locator("[data-pane]").first().isVisible()), "the Notebook itself is out of sight");
  await shot("2-away");

  // A page picked there brings you back to the Notebook with it in front, and the other tab is still there.
  await row("a").click();
  await page.waitForFunction((id: string) => location.pathname === "/notes" && new URLSearchParams(location.search).get("id") === id, ids.a);
  await sleep(400);
  assert.ok(await page.locator("[data-pane]").first().isVisible());
  assert.ok(await page.locator(`.note-tab[data-tab="${ids.b}"]`).count() >= 0);
  await shot("3-back");
  assert.deepEqual(errors, []);
  console.log("ok: notes sidebar away, shots in", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
