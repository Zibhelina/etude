// Dragging a block by its grip to a part of the page that's off screen: held near the pane's bottom the page
// scrolls down, held over the top bar it scrolls back up, and the block lands where it's dropped.
// Not part of `npm test` (it needs Chromium, playwright-core and a built web app). From a worktree:
//   npm run build && node test/e2e/notes-drag-scroll.ts [<screenshot dir>]
// (WEB_DIST=<dir> serves a web build from elsewhere.)
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "drag-scroll-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Top" }] },
    ...Array.from({ length: 60 }, (_, i) => para(`Line ${i + 1}`)),
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Mover" }] },
  ],
};
const db = join(scratch, "etude.db");
let id = "";
let id2 = "";
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ onboarding: { ...e.settings().onboarding, done: true } });
  let out = "";
  assert.equal(await run(["note", "new", "Long", "--doc", JSON.stringify(doc), "--json"], { stdout: (x) => (out += x), stderr: (x) => process.stderr.write(x), stdin: () => "", isTTY: false, env: process.env }, { etude: e }), 0);
  const r = JSON.parse(out);
  id = r.id ?? r.note?.id;
  out = "";
  assert.equal(await run(["note", "new", "Other", "--md", "Beside it.", "--json"], { stdout: (x) => (out += x), stderr: (x) => process.stderr.write(x), stdin: () => "", isTTY: false, env: process.env }, { etude: e }), 0);
  const r2 = JSON.parse(out);
  id2 = r2.id ?? r2.note?.id;
  e.close();
}
const web = process.env.WEB_DIST ? ["--web", process.env.WEB_DIST] : [];
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port), ...web], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/settings").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, colorScheme: "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.goto(`${base}/notes?id=${id}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  const ed = page.locator("[data-pane] .ProseMirror").first();
  await ed.waitFor();
  await sleep(400);
  // The pane's scroller, as the editor finds it: its own box when split, else the window.
  const scrollTop = () =>
    ed.evaluate((el: HTMLElement) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY;
        if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p.scrollTop;
      }
      return document.scrollingElement!.scrollTop;
    });
  // The part of the first pane on screen.
  const paneBox = () =>
    ed.evaluate((el: HTMLElement) => {
      const r = (el.closest(".is-multi .note-pane-box") ?? el.closest("[data-pane]")!).getBoundingClientRect();
      const top = Math.max(r.top, 0);
      return { x: r.left, y: top, width: r.width, height: Math.min(r.bottom, innerHeight) - top };
    });
  // The page's blocks by their text (the editor keeps an empty paragraph at the end).
  const order = () => ed.evaluate((el: HTMLElement) => Array.from(el.children).map((c) => c.textContent?.trim() ?? "").filter(Boolean));
  // The drag itself, as the browser delivers it: dragstart on the grip, dragover at the pointer every 50 ms (Chromium
  // repeats it while the pointer holds still), drop under the pointer, dragend on the grip. Playwright's own drag
  // emulation queues the dragovers and hands them over late, so the page wouldn't see a held pointer.
  await page.evaluate(() => {
    const w = window as any;
    let dt: DataTransfer | null = null;
    let src: Element | null = null;
    let at = { x: 0, y: 0 };
    let pump = 0;
    const fire = (type: string, target: Element | null, x: number, y: number) =>
      target?.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }));
    w.__drag = {
      start(x: number, y: number) {
        dt = new DataTransfer();
        src = document.querySelector(".note-handle.is-on .note-handle-grip");
        at = { x, y };
        fire("dragstart", src, x, y);
        pump = window.setInterval(() => fire("dragover", document.elementFromPoint(at.x, at.y), at.x, at.y), 50);
      },
      move(x: number, y: number) {
        at = { x, y };
        fire("dragover", document.elementFromPoint(x, y), x, y);
      },
      drop() {
        clearInterval(pump);
        fire("drop", document.elementFromPoint(at.x, at.y), at.x, at.y);
        fire("dragend", src, at.x, at.y);
      },
    };
  });
  const glide = async (x: number, y: number) => {
    const from = await page.evaluate(() => (window as any).__at);
    for (let i = 1; i <= 6; i++) {
      const p = { x: from.x + ((x - from.x) * i) / 6, y: from.y + ((y - from.y) * i) / 6 };
      await page.evaluate((p: { x: number; y: number }) => { (window as any).__at = p; (window as any).__drag.move(p.x, p.y); }, p);
      await sleep(40);
    }
  };
  const grip = page.locator(".note-handle.is-on .note-handle-grip").first();
  const block = (text: string) => ed.locator(":scope > *", { hasText: new RegExp(`^${text}$`) }).first();
  const press = async (text: string) => {
    const b = (await block(text).boundingBox())!;
    await page.mouse.move(b.x + 30, b.y + b.height / 2);
    await grip.waitFor();
    const g = (await grip.boundingBox())!;
    const p = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
    await page.evaluate((p: { x: number; y: number }) => { (window as any).__at = p; (window as any).__drag.start(p.x, p.y); }, p);
    await glide(p.x + 40, p.y + (b.y > 300 ? -50 : 50));
  };
  const dropOn = async (text: string, where: "above" | "below") => {
    const b = (await block(text).boundingBox())!;
    const y = where === "above" ? b.y + 3 : b.y + b.height - 3;
    await glide(b.x + 60, y);
    await sleep(150);
    await glide(b.x + 62, y + (where === "above" ? -1 : 1));
    await page.evaluate(() => (window as any).__drag.drop());
    await sleep(300);
  };
  const waitScroll = async (done: (s: number) => boolean) => {
    let s = await scrollTop();
    for (let i = 0; i < 50 && !done(s); i++) {
      await sleep(100);
      s = await scrollTop();
    }
    return s;
  };

  const scenario = async (label: string) => {
    const pane = await paneBox();
    assert.equal(await scrollTop(), 0, `${label}: starts at the top`);
    let o = await order();
    const first = o[0];
    const last = o[o.length - 1];
    // Carry the first block to the end: held near the bottom of the pane, the page scrolls down to its end.
    await press(first);
    await glide(pane.x + pane.width / 2, pane.y + pane.height - 20);
    let prev = -1;
    const s = await waitScroll((s) => { const still = s === prev && s > 0; prev = s; return still; });
    await shot(`${label}-1-scrolled-down`);
    assert.ok(s > 600, `${label}: page scrolled down while held near the bottom (scrollTop ${s})`);
    await dropOn(last, "below");
    o = await order();
    assert.equal(o[o.length - 1], first, `${label}: ${first} landed at the end: ${o.slice(-3).join(" | ")}`);
    await shot(`${label}-2-dropped-at-end`);
    // And the block that was last, carried over the sticky top bar: the page scrolls back up, and it goes first.
    await press(last);
    await glide(pane.x + pane.width / 2, pane.y + 20);
    const up = await waitScroll((s) => s === 0);
    await shot(`${label}-3-scrolled-up`);
    assert.equal(up, 0, `${label}: page scrolled back to the top while held over the top bar`);
    await dropOn(o[0], "above");
    o = await order();
    assert.equal(o[0], last, `${label}: ${last} landed first: ${o.slice(0, 3).join(" | ")}`);
    await shot(`${label}-4-dropped-first`);
  };

  await scenario("single");
  // Split: a second page on the right, so each pane scrolls inside its own box (João's usual layout).
  await page.evaluate((note: string) => window.dispatchEvent(new CustomEvent("etude:open-note", { detail: { note, side: "right" } })), id2);
  await page.locator(".notes-split.is-multi").waitFor({ timeout: 5000 });
  await sleep(500);
  await page.mouse.move(10, 10);
  assert.equal(await page.locator("[data-pane]").count(), 2);
  await scenario("split");

  // With nothing being dragged, the pointer near the edge doesn't scroll anything.
  const before = await scrollTop();
  const pane = await paneBox();
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 15);
  await sleep(600);
  assert.equal(await scrollTop(), before);
  assert.deepEqual(errors, []);
  console.log("ok: drag autoscroll down and up, one pane and split, blocks land where dropped; shots in", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
