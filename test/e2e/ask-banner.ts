// A new chat's start: the plain greeting with up to three ideas, and an agent's banner in its place. Through the
// real UI: `etude serve` on a scratch collection, driven in Chromium. Not part of `npm test`. From an etude2 worktree:
//   npm run build && node test/e2e/ask-banner.ts [<screenshot dir>]   (WEB=<dir> serves another build; BANNER=<image>)
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Etude } from "../../src/core/engine.ts";
const require = createRequire(join(process.env.PLAYWRIGHT_FROM ?? process.cwd(), "package.json"));
const { chromium } = require("playwright-core");

const WT = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ask-banner-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
// 1×1 PNG, unless a real banner is given.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const db = join(scratch, "etude.db");
const setDefault = async (id: string) => {
  const e = await Etude.open(db, { home: scratch });
  e.setDefaultAgentProfile(id);
  e.close();
};
{
  const e = await Etude.open(db, { home: scratch });
  const banner = process.env.BANNER ? e.importMedia(process.env.BANNER).file : e.storeMedia("banner.png", PNG).file;
  e.addAgentProfile({ id: "plain", name: "Plain" });
  e.addAgentProfile({ id: "pretty", name: "Pretty", banner });
  e.setDefaultAgentProfile("plain");
  e.close();
}
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port), ...(process.env.WEB ? ["--web", process.env.WEB] : [])], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/agent/profiles").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: (process.env.SCHEME as any) ?? "dark" });
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
  const empty = panel.locator("[data-agent-empty]");
  await empty.waitFor();

  // No banner: who, a question and at most three plain ideas.
  assert.equal(await empty.locator("[data-agent-banner]").count(), 0);
  await empty.locator("[data-agent-avatar=plain]").waitFor();
  const n = await empty.locator("[data-suggestion]").count();
  assert.ok(n >= 1 && n <= 3, `1 to 3 ideas, got ${n}`);
  await panel.screenshot({ path: join(SHOTS, "plain.png") });

  // The agent with a banner: the picture alone, inside the panel, no ideas.
  await setDefault("pretty");
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("etude.agent") && k !== "etude.agent.open") localStorage.removeItem(k);
  });
  await page.reload();
  await panel.waitFor();
  const img = panel.locator("[data-agent-banner=pretty]");
  await img.waitFor({ timeout: 8000 });
  await page.waitForFunction(() => {
    const i = document.querySelector("[data-agent-banner]") as HTMLImageElement | null;
    return !!i && i.complete && i.naturalWidth > 0;
  });
  assert.equal(await panel.locator("[data-suggestion]").count(), 0);
  const [pb, ib] = [await panel.boundingBox(), await img.boundingBox()];
  assert.ok(ib!.x >= pb!.x && ib!.x + ib!.width <= pb!.x + pb!.width + 0.5, "the banner stays inside the panel");
  await panel.screenshot({ path: join(SHOTS, "banner.png") });

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
