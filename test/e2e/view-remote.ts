// `etude view` driving the real app: New tabs, pins and icons, tab groups (make, fold, recolour, move, dissolve),
// moving tabs into new panes, resizing, close-others, the sidebar, Notes' pages, the Ask panel and other screens,
// each checked in the page itself. `etude serve` on a scratch collection, driven in Chromium. Not part of
// `npm test`. From an etude2 worktree:
//   npm run build && node test/e2e/view-remote.ts [<screenshot dir>]
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "view-remote-"));
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
const ok = async (...argv: string[]) => {
  const r = await cli(...argv);
  assert.equal(r.code, 0, `${argv.join(" ")}: ${r.err}`);
  assert.equal(r.json.done, true, `${argv.join(" ")} wasn't carried out`);
  return r.json.view;
};
const ids: Record<string, string> = {};
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ onboarding: { ...e.settings().onboarding, done: true } });
  e.close();
  for (const [k, t] of [["a", "Lecture one"], ["b", "Reading list"], ["c", "Problem set"], ["d", "Formula sheet"]]) ids[k] = (await cli("note", "new", t, "--text", "Hi.")).json.id;
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
  const tab = (k: string) => page.locator(`.note-tab[data-tab="${ids[k] ?? k}"]`);
  await page.goto(`${base}/notes?id=${ids.a}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  await page.locator("[data-pane] .note-title").first().waitFor();
  for (let i = 0; i < 50 && !(await cli("view", "show")).json.live; i++) await sleep(200);

  // A New tab, then pages as tabs.
  let v = await ok("view", "open");
  assert.equal(v.panes[0].front.kind, "new");
  assert.equal(await page.locator('.note-tab[data-tab^="new:"]').count(), 1);
  for (const k of ["b", "c", "d"]) await ok("view", "open", ids[k]);
  await tab("d").waitFor();

  // Pin and an icon of its own; an icon on an unpinned tab says why not.
  const refused = await cli("view", "icon", ids.c, "🧪");
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /pin it first/);
  v = await ok("view", "pin", ids.b);
  await page.locator(`.note-tab[data-tab="${ids.b}"][data-pinned]`).waitFor();
  v = await ok("view", "icon", ids.b, "🧪");
  assert.equal(v.panes[0].tabs.find((t: any) => t.id === ids.b).icon, "emoji:🧪");

  // A group: made, named, coloured, folded and unfolded, one tab out.
  v = await ok("view", "group", ids.c, ids.d, "--name", "Exams", "--color", "red");
  const g = v.panes[0].groups[0];
  assert.deepEqual({ name: g.name, color: g.color, tabs: g.tabs }, { name: "Exams", color: "red", tabs: [ids.c, ids.d] });
  await page.locator(".note-tab-group", { hasText: "Exams" }).waitFor();
  await shot("1-pinned-and-group");
  await ok("view", "group-edit", "Exams", "--fold");
  await page.locator(".note-tab-group.is-folded").waitFor();
  await sleep(700);
  await shot("2-folded");
  v = await ok("view", "group-edit", "exams", "--unfold", "--color", "#33aa88");
  assert.equal(v.panes[0].groups[0].color, "#33aa88");
  assert.equal(v.panes[0].groups[0].collapsed, false);

  // A tab to its own pane on the right, the split resized, the group moved over.
  v = await ok("view", "move", ids.a, "--side", "right");
  assert.equal(v.panes.length, 2);
  assert.equal(await page.locator("[data-pane]").count(), 2);
  v = await ok("view", "resize", "2", "0.3");
  assert.ok(Math.abs(v.panes[1].box.w - 0.3) < 0.01, `pane 2 is ${v.panes[1].box.w} wide`);
  v = await ok("view", "group-move", "Exams", "--to", "2");
  assert.deepEqual(v.panes[1].groups[0].tabs, [ids.c, ids.d]);
  await page.locator(`[data-pane]:has(.note-tab[data-tab="${ids.a}"]) .note-tab-group`).waitFor({ timeout: 3000 });
  await shot("3-split-and-moved");
  v = await ok("view", "ungroup", "--tab", ids.d);
  assert.deepEqual(v.panes[1].groups[0].tabs, [ids.c]);
  v = await ok("view", "ungroup", "Exams");
  assert.equal(v.panes[1].groups.length, 0);
  v = await ok("view", "close-others", ids.d);
  assert.deepEqual(v.panes[1].tabs.map((t: any) => t.id), [ids.d]);

  // The app around the Notebook.
  v = await ok("view", "sidebar", "rail");
  assert.equal(v.shell.sidebar, "rail");
  await page.locator("[data-shell-sidebar][data-collapsed]").waitFor();
  v = await ok("view", "sidebar", "none");
  assert.equal(v.shell.sidebar, "none");
  v = await ok("view", "sidebar", "open");
  assert.equal(v.shell.sidebar, "open");
  v = await ok("view", "pages", "hide");
  assert.equal(v.shell.pages, false);
  v = await ok("view", "pages", "show");
  v = await ok("view", "panel", "open");
  assert.equal(v.shell.panel, true);
  await shot("4-panel-open");
  v = await ok("view", "panel", "close");
  assert.equal(v.shell.panel, false);
  v = await ok("view", "go", "stats");
  assert.equal(v.route, "/stats");
  // A Notebook command from another screen goes back to the Notebook and does it.
  v = await ok("view", "focus", ids.b);
  assert.match(v.route, /^\/notes/);
  await shot("5-back");
  assert.deepEqual(errors, []);
  console.log("ok: view remote, shots in", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
