// Find and replace in a page (Ctrl+F, Ctrl+H, match case, Replace, All, one undo) and Delete in the tree (asked
// first, the pages inside go too). Through the real UI: `etude serve` on a scratch collection, driven in Chromium.
// Not part of `npm test` (it needs Chromium, playwright-core and a built web app):
//   npm run build && node test/e2e/notes-find-delete.ts [<screenshot dir>]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Etude } from "../../src/core/engine.ts";
import { run } from "../../src/cli/run.ts";
const require = createRequire(join(process.env.PLAYWRIGHT_FROM ?? "/home/joao/dev/lotus", "package.json"));
const { chromium } = require("playwright-core");

const WT = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "notes-find-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const db = join(scratch, "etude.db");
const ids: Record<string, string> = {};
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ onboarding: { ...e.settings().onboarding, done: true } });
  const make = async (key: string, argv: string[]) => {
    let out = "";
    assert.equal(await run(["note", "new", ...argv, "--json"], { stdout: (x) => (out += x), stderr: (x) => process.stderr.write(x), stdin: () => "", isTTY: false, env: process.env }, { etude: e }), 0);
    const r = JSON.parse(out);
    ids[key] = r.id ?? r.note?.id;
    assert.ok(ids[key], `made ${key}`);
  };
  await make("essay", ["Essay", "--md", "The cat sat.\n\nThe **cat** ran. A Cat."]);
  await make("parent", ["Old notes", "--text", "Going."]);
  await make("child", ["Inside", "--parent", "Old notes", "--text", "Also going."]);
  await make("keep", ["Keep me", "--text", "Staying."]);
  e.close();
}
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port)], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/notes").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
let page: any;
try {
  page = await browser.newPage({ viewport: { width: 1500, height: 900 }, colorScheme: (process.env.SCHEME as any) ?? "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const row = (id: string) => page.locator(`[role=tree] [data-note-row="${id}"]`).first();
  const count = () => page.locator(".note-find-count").innerText();
  const prose = page.locator("[data-pane] .note-prose").first();

  await page.goto(`${base}/notes?id=${ids.essay}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  await prose.waitFor();
  await prose.click();

  // Ctrl+F: matches highlighted, whatever their case.
  await page.keyboard.press("Control+f");
  await page.locator(".note-find-input[aria-label=Find]").waitFor();
  await page.keyboard.type("cat");
  await sleep(150);
  assert.equal(await page.locator(".note-find-hit").count(), 3, "three matches, one inside bold");
  assert.match(await count(), /of 3/);
  await page.keyboard.press("Enter");
  await sleep(100);
  assert.equal(await page.locator(".note-find-hit.is-current").count(), 1, "one current match");
  await shot("1-find");
  // Match case leaves the two lowercase ones.
  await page.getByRole("button", { name: "Match case" }).click();
  await sleep(100);
  assert.match(await count(), /of 2/);

  // Ctrl+H: the replace row; Replace swaps one (keeping its bold), All the rest in one undo step.
  await page.keyboard.press("Control+h");
  const repl = page.locator(".note-find-input[aria-label='Replace with']");
  await repl.waitFor();
  await repl.fill("dog");
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await sleep(150);
  assert.match(await count(), /of 1/, "one left after Replace");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await sleep(150);
  assert.equal(await count(), "No results");
  const text = await prose.innerText();
  assert.match(text, /The dog sat\./);
  assert.match(text, /The dog ran\. A Cat\./, "the capitalized one stays with Match case on");
  assert.equal(await prose.locator("strong").innerText(), "dog", "bold kept");
  await shot("2-replaced");

  // Esc closes the bar and the highlights go.
  await page.keyboard.press("Escape");
  await sleep(100);
  assert.equal(await page.locator(".note-find").count(), 0, "bar closed");
  assert.equal(await page.locator(".note-find-hit").count(), 0, "no highlights");
  // Undo: All was one step.
  await page.keyboard.press("Control+z");
  await sleep(100);
  assert.match(await prose.innerText(), /The dog sat\.[\s\S]*The cat ran/, "one undo brings back what All replaced");
  await page.keyboard.press("Control+y");
  await sleep(100);

  // It was saved.
  let saved = "";
  for (let i = 0; i < 30 && !/The dog ran/.test(saved); i++) {
    await sleep(200);
    saved = JSON.stringify(await fetch(`${base}/api/notes/${ids.essay}`).then((r) => r.json()));
  }
  assert.match(saved, /dog/, "the replacement was saved");

  // The page menu has it too.
  await page.getByRole("button", { name: "Page options" }).first().click();
  await page.getByRole("menuitem", { name: /Find and replace/ }).click();
  await page.locator(".note-find-input[aria-label='Replace with']").waitFor();
  await sleep(200);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Replace with", "the field has the focus, not the menu button");
  await shot("3-from-menu");
  await page.keyboard.press("Escape");
  await sleep(100);
  assert.equal(await page.locator(".note-find").count(), 0, "Esc closed it");

  // Delete: asked first, says the page inside goes too, and both are gone for good (not in the archive).
  await row(ids.parent).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const ask = page.locator("[data-delete-ask]");
  await ask.waitFor();
  assert.match(await ask.innerText(), /Delete “Old notes”\?/);
  assert.match(await ask.innerText(), /The page inside it goes too/);
  await shot("4-delete-ask");
  await ask.getByRole("button", { name: "Delete" }).click();
  await page.locator("[data-sonner-toast]").first().waitFor();
  assert.match(await page.locator("[data-sonner-toast]").first().innerText(), /Deleted “Old notes” and 1 page inside/);
  await sleep(300);
  assert.equal(await row(ids.parent).count(), 0, "row gone");
  const live = (await fetch(`${base}/api/notes`).then((r) => r.json())).map((n: any) => n.id);
  const archived = (await fetch(`${base}/api/notes?archived=1`).then((r) => r.json())).map((n: any) => n.id);
  for (const k of ["parent", "child"]) assert.ok(!live.includes(ids[k]) && !archived.includes(ids[k]), `${k} deleted for good`);
  assert.ok(live.includes(ids.keep) && live.includes(ids.essay), "the others stay");
  await shot("5-deleted");

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
