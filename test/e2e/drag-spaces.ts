// A page dragged in the Notebook tree from the collection into a folder on this computer becomes a file there, and a
// file dragged out of the folder into the collection becomes a page; the originals wait in the Archive and the
// folder's trash. `etude serve` on a scratch collection and a scratch folder, driven in Chromium. Not part of `npm test`.
// From an etude2 worktree:  npm run build && node test/e2e/drag-spaces.ts [<screenshot dir>]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "drag-spaces-e2e-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const vault = join(scratch, "Vault");
mkdirSync(join(vault, "Box"), { recursive: true });
writeFileSync(join(vault, "Idea.md"), "# Idea\n\nA thought.\n");
const db = join(scratch, "etude.db");
const env = { ...process.env, ETUDE_HOME: scratch };
const cli = async (...argv: string[]) => {
  let out = "", err = "";
  const code = await run(["--db", db, ...argv, "--json"], { stdout: (x) => (out += x), stderr: (x) => (err += x), stdin: () => "", isTTY: false, env });
  return { code, json: out.trim() ? JSON.parse(out) : null, err };
};
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ onboarding: { ...e.settings().onboarding, done: true } });
  e.close();
}
const folder = (await cli("folder", "open", vault)).json;
const fid = (rel = "") => (rel ? `fs:${folder.id}/${rel}` : `fs:${folder.id}`);
const note = (await cli("note", "new", "Travelling page", "--md", "Packed for the trip.")).json;

const server = spawn(process.execPath, [join(WT, "src/cli/main.ts"), "--db", db, "serve", "--port", String(port), ...(process.env.WEB ? ["--web", process.env.WEB] : [])], { cwd: WT, env, stdio: ["ignore", "inherit", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/notes").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
let page: any = null;
try {
  page = await browser.newPage({ viewport: { width: 1500, height: 950 }, colorScheme: "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const row = (id: string) => page.locator(`[data-notes-slot] [data-note-row="${id}"]`);
  const until = async (what: string, f: () => boolean | Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await f()) return; await sleep(100); }
    throw new Error(`timed out: ${what}`);
  };
  const drag = async (from: any, to: any) => {
    const a = (await from.locator("span.truncate").first().boundingBox())!;
    const b = (await to.boundingBox())!;
    await page.mouse.move(a.x + 8, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 12, a.y + a.height / 2 - 8, { steps: 3 });
    await page.mouse.move(b.x + 80, b.y + b.height / 2, { steps: 10 });
    await shot("drag-over");
    await page.mouse.up();
  };

  await page.goto(`${base}/notes?id=${encodeURIComponent("new:start")}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  await row(fid()).waitFor({ timeout: 8000 });
  await row(fid()).click();
  await row(fid("Box")).waitFor({ timeout: 5000 });

  // Collection → folder: the page is a file in Box, and the note is in the Archive.
  await drag(row(note.id), row(fid("Box")));
  await until("the file is in Box", () => existsSync(join(vault, "Box", "Travelling page.etude")));
  await page.getByText("The notes are in the Archive", { exact: false }).waitFor({ timeout: 4000 });
  const archived = (await cli("note", "show", note.id)).json;
  assert.equal(archived.archived, true);
  assert.equal(await row(note.id).count(), 0, "the page left the collection's tree");
  await shot("taken");

  // Folder → collection: the file is a page again, and the file is in the folder's trash.
  if (!(await row(fid("Box/Travelling page.etude")).count())) await row(fid("Box")).click();
  await row(fid("Box/Travelling page.etude")).waitFor({ timeout: 5000 });
  const top = (await cli("note", "list")).json.filter((n: any) => !n.parentId && !n.archived);
  const other = top[0];
  assert.ok(other, "a page of the collection to drop on");
  await drag(row(fid("Box/Travelling page.etude")), row(other.id));
  await until("the file is a note", async () => (await cli("note", "list")).json.some((n: any) => n.title === "Travelling page" && !n.archived));
  assert.equal(existsSync(join(vault, "Box", "Travelling page.etude")), false);
  const trash = readdirSync(join(vault, ".trash"), { recursive: true }).map(String);
  assert.ok(trash.some((f) => f.includes("Travelling page")), `in the trash: ${trash.join(", ")}`);
  await shot("brought");
  assert.deepEqual(errors, []);
  console.log("ok");
} catch (e) {
  failed = true;
  console.error(e);
  if (page) await page.screenshot({ path: join(SHOTS, "failure.png") }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}
console.log("screenshots:", SHOTS);
process.exit(failed ? 1 : 0);
