// A folder on this computer that Sync carries to another device, driven from the Notebook: mark it from the folder's
// menu, see the mark, watch its files arrive as real files on a second device (a second collection in this process,
// over the folder transport), an edit come back, removals held and let through, a folder from the other device given
// a place here from the Open a folder dialog, and Sync stopped. Not part of `npm test`.
// From an etude2 worktree:  npm run build && node test/e2e/folder-sync.ts [<screenshot dir>]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Etude } from "../../src/core/engine.ts";
import { syncFor } from "../../src/core/sync/client.ts";
const require = createRequire(join(process.env.PLAYWRIGHT_FROM ?? process.cwd(), "package.json"));
const { chromium } = require("playwright-core");

const WT = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "folder-sync-e2e-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const password = "a test Sync password";
const shared = join(scratch, "vault");

// This computer: a folder with a journal in it. The other device: a collection of its own in the same vault.
const dirA = join(scratch, "A", "Vault");
mkdirSync(join(dirA, "Journal"), { recursive: true });
writeFileSync(join(dirA, "Welcome.md"), "# Welcome\n");
writeFileSync(join(dirA, "Journal", "Monday.md"), "Walked to the lake.\n");
for (let i = 0; i < 30; i++) writeFileSync(join(dirA, "Journal", `day ${String(i).padStart(2, "0")}.md`), `day ${i}\n`);
const dbA = join(scratch, "a.db"), homeA = join(scratch, "ha");
let folderId = "";
{
  const a = await Etude.open(dbA, { home: homeA });
  a.updateSettings({ onboarding: { ...a.settings().onboarding, done: true } });
  syncFor(a).setup({ folder: shared });
  await syncFor(a).unlock({ password });
  folderId = a.folders.open(dirA, { name: "Vault" }).id;
  a.close();
}
const b = await Etude.open(join(scratch, "b.db"), { home: join(scratch, "hb") });
syncFor(b).setup({ folder: shared });
await syncFor(b).unlock({ password });
const dirB = join(scratch, "B", "Journal");
const dirB2 = join(scratch, "B", "From the laptop");
mkdirSync(dirB2, { recursive: true });
writeFileSync(join(dirB2, "Hello.md"), "From the other device.\n");
const fid = (rel = "") => (rel ? `fs:${folderId}/${rel}` : `fs:${folderId}`);

const env = { ...process.env, ETUDE_HOME: homeA };
const server = spawn(process.execPath, [join(WT, "src/cli/main.ts"), "--db", dbA, "serve", "--port", String(port), ...(process.env.WEB ? ["--web", process.env.WEB] : [])], { cwd: WT, env, stdio: ["ignore", "inherit", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/notes").then((r) => r.ok, () => false)) break; await sleep(150); }
/** This computer syncs now (the app does it by itself every half minute), and the other device after it. */
const syncA = async () => {
  const r = await fetch(base + "/api/sync/now", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`sync now: ${r.status} ${await r.text()}`);
  for (let i = 0; i < 100; i++) {
    const st = await (await fetch(base + "/api/sync/status")).json();
    if (!st.busy && !st.media.active) return;
    await sleep(100);
  }
};
const syncB = () => syncFor(b).now({ waitMedia: true });
const round = async () => {
  await syncA();
  await syncB();
  await syncA();
  await syncB();
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
let page: any = null;
try {
  page = await browser.newPage({ viewport: { width: 1500, height: 950 }, colorScheme: "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("console", (m: any) => m.type() === "error" && !/favicon|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const row = (rel: string) => page.locator(`[data-notes-slot] [data-note-row="${fid(rel)}"]`);
  const until = async (what: string, f: () => boolean | Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await f()) return;
      await sleep(100);
    }
    throw new Error(`timed out: ${what}`);
  };

  await page.goto(`${base}/notes`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  await row("").waitFor({ timeout: 8000 });
  await row("").click();
  await row("Journal").waitFor({ timeout: 4000 });

  // The folder's menu starts it: the dialog says how much travels, and the row is marked once it does.
  assert.equal(await row("Journal").locator("[data-synced]").count(), 0);
  await row("Journal").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Sync to your other devices…" }).click();
  const dialog = page.locator("[data-folder-sync=on]");
  await dialog.waitFor();
  await dialog.locator("[data-folder-sync-size]", { hasText: "31 files" }).waitFor({ timeout: 5000 });
  await sleep(450);
  await shot("1-sync-dialog");
  await dialog.getByRole("button", { name: "Sync this folder" }).click();
  await row("Journal").locator("[data-synced]").waitFor({ timeout: 6000 });
  await page.locator("[data-sonner-toast]", { hasText: "Syncing “Journal”" }).waitFor({ timeout: 4000 });
  await shot("2-synced-row");
  // Something inside a synced folder travels with it: no item of its own.
  await row("Journal").click();
  await row("Journal/Monday.md").waitFor({ timeout: 4000 });

  // The other device sees it in the vault, gives it a place, and gets real files.
  await round();
  const there = b.folderSync.status().elsewhere;
  assert.deepEqual(there.map((x) => [x.name, x.files]), [["Journal", 31]]);
  b.folderSync.link(there[0].syncId, dirB);
  await round();
  assert.equal(readdirSync(dirB).length, 31);
  assert.equal(readFileSync(join(dirB, "Monday.md"), "utf8"), "Walked to the lake.\n");

  // Typed here, in the editor: it reaches the other device's file. Edited there: the open editor shows it.
  await row("Journal/Monday.md").click();
  const content = page.locator("[data-pane] .cm-content").first();
  await content.waitFor({ timeout: 5000 });
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("Typed on this computer.");
  await until("the text reaches this computer's file", () => readFileSync(join(dirA, "Journal", "Monday.md"), "utf8").includes("Typed on this computer."));
  await round();
  assert.match(readFileSync(join(dirB, "Monday.md"), "utf8"), /Typed on this computer\./);
  await sleep(1100);
  writeFileSync(join(dirB, "Monday.md"), readFileSync(join(dirB, "Monday.md"), "utf8") + "\nAdded on the other device.\n");
  await round();
  assert.match(readFileSync(join(dirA, "Journal", "Monday.md"), "utf8"), /Added on the other device\./);
  await page.locator("[data-pane] .cm-content", { hasText: "Added on the other device." }).first().waitFor({ timeout: 10000 });

  // Most of the folder removed at once: held, said in a notice, and let through from it.
  for (let i = 0; i < 26; i++) unlinkSync(join(dirA, "Journal", `day ${String(i).padStart(2, "0")}.md`));
  await round();
  assert.equal(readdirSync(dirB).filter((n) => !n.startsWith(".")).length, 31, "the other device keeps everything");
  const held = page.locator("[data-sonner-toast]", { hasText: "Sync is holding back removals in “Journal”" });
  await held.waitFor({ timeout: 8000 });
  assert.match(await held.innerText(), /26 of the 31 files/);
  await sleep(450);
  await shot("3-held");
  await held.getByRole("button", { name: "Go ahead" }).click();
  await sleep(600);
  await round();
  assert.equal(readdirSync(dirB).filter((n) => !n.startsWith(".")).length, 5);
  assert.equal(readdirSync(join(dirB, ".trash")).length, 26, "there they are in the folder's trash");
  await until("the notice goes away", async () => (await held.count()) === 0, 10000);

  // A folder the other device syncs is offered in Open a folder, and gets a place on this computer.
  const theirs = b.folderSync.mark(b.folders.idOf(dirB2) ?? `fs:${b.folders.open(dirB2, { name: "From the laptop" }).id}`);
  assert.equal(theirs.name, "From the laptop");
  await round();
  await page.locator("[data-app-sidebar], aside, nav").getByText("Notebook", { exact: true }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open a folder from this computer…" }).click();
  const offered = page.locator("[data-synced-elsewhere]");
  await offered.waitFor({ timeout: 5000 });
  assert.match(await offered.innerText(), /From the laptop/);
  assert.match(await offered.innerText(), /1 file ·/);
  const destA = join(scratch, "A", "Laptop notes");
  await offered.getByLabel("Where From the laptop goes").fill(destA);
  await sleep(450);
  await shot("4-offered");
  await offered.getByRole("button", { name: "Put it here" }).click();
  await page.locator("[data-notes-slot] [data-note-row]", { hasText: "From the laptop" }).first().waitFor({ timeout: 6000 });
  await round();
  assert.equal(readFileSync(join(destA, "Hello.md"), "utf8"), "From the other device.\n");
  await shot("5-placed");

  // Stopping it here: the mark goes, the files stay on both.
  await row("Journal").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Stop syncing…" }).click();
  await page.locator("[data-folder-sync=off]").getByRole("button", { name: "Stop on this computer" }).click();
  await until("the mark goes", async () => (await row("Journal").locator("[data-synced]").count()) === 0);
  assert.equal(existsSync(join(dirA, "Journal", "Monday.md")), true);
  assert.equal(existsSync(join(dirB, "Monday.md")), true);
  assert.deepEqual(errors, []);
  console.log("ok: folder sync, shots in", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
  await page?.screenshot({ path: join(SHOTS, "failed.png") }).catch(() => {});
  console.error("toasts:", await page?.locator("[data-sonner-toast]").allInnerTexts().catch(() => null), "dialogs:", await page?.locator("[role=dialog]").allInnerTexts().catch(() => null));
  console.error("shots in", SHOTS);
} finally {
  await browser.close();
  server.kill();
  b.close();
}
process.exit(failed ? 1 : 0);
