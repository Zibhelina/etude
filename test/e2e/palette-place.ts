// Opening a tab at a chosen place in a pane's strip: `etude view open --before`, and Ctrl+K's place step
// (←/→ walk the gaps between tabs, the mouse picks one over the strip). `etude serve` on a scratch collection,
// driven in Chromium. Not part of `npm test`. From an etude2 worktree:
//   npm run build && node test/e2e/palette-place.ts [<screenshot dir>]
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "palette-place-"));
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

  for (const k of ["b", "c", "d"]) await ok("view", "open", ids[k], "--before", "end");
  await tab("d").waitFor();
  const order = async () => (await cli("view", "show")).json.panes[0].tabs.map((t: any) => (t.kind === "new" ? "new" : Object.keys(ids).find((k) => ids[k] === t.id)));
  assert.deepEqual(await order(), ["a", "b", "c", "d"]);

  // From outside: in front of a tab, then at the end.
  let v = await ok("view", "open", "--before", ids.b);
  assert.deepEqual(await order(), ["a", "new", "b", "c", "d"]);
  await ok("view", "close", v.panes[0].tabs[1].id);
  const bad = await cli("view", "open", "--where", "right", "--before", ids.b);
  assert.notEqual(bad.code, 0);

  // Ctrl+K, > New tab, then two gaps left of the end: in front of c.
  const palette = async (cmd: string) => {
    await page.locator(".note-tab").first().click();
    await page.keyboard.press("Control+k");
    await page.keyboard.type(">" + cmd);
    await page.keyboard.press("Enter");
    await page.locator("[data-place-picker][data-live]").waitFor();
  };
  await palette("new tab");
  const line = page.locator(".place-live-tabline");
  await line.waitFor();
  const endX = (await line.boundingBox())!.x;
  assert.ok(endX > (await tab("d").boundingBox())!.x, "a New tab starts at the end");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  const cx = (await tab("c").boundingBox())!.x;
  await sleep(150);
  assert.ok(Math.abs((await line.boundingBox())!.x - (cx - 2)) < 3, "the mark sits in front of c");
  assert.match((await page.locator(".place-live-bar").textContent()) ?? "", /before Problem set/);
  await shot("1-keys");
  await page.keyboard.press("Enter");
  await page.locator("[data-place-picker]").waitFor({ state: "detached" });
  for (let i = 0; i < 20 && (await order()).length < 5; i++) await sleep(150);
  assert.deepEqual(await order(), ["a", "b", "new", "c", "d"]);
  await ok("view", "close", (await cli("view", "show")).json.panes[0].tabs[2].id);

  // The mouse over the strip: just left of b's middle is the gap in front of b.
  await palette("new page");
  const bb = (await tab("b").boundingBox())!;
  await page.mouse.move(bb.x + 4, bb.y + bb.height / 2);
  await sleep(150);
  assert.match((await page.locator(".place-live-bar").textContent()) ?? "", /before Reading list/);
  await shot("2-mouse");
  await page.mouse.click(bb.x + 4, bb.y + bb.height / 2);
  for (let i = 0; i < 20 && (await order()).length < 5; i++) await sleep(150);
  const after = (await cli("view", "show")).json.panes[0].tabs.map((t: any) => t.id);
  assert.equal(after[2], ids.b);
  assert.ok(![ids.a, ids.b, ids.c, ids.d].includes(after[1]), "the new page sits in front of b");
  assert.deepEqual(errors, []);
  console.log("ok: palette place, shots in", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
