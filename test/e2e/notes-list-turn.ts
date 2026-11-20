// Turning one list item into another kind, in place, through the real editor: "[]" typed before a nested bullet,
// "/todo" on an empty sub-item, the grip's "Turn into" on a bullet between to-dos, "- " at the start of a to-do,
// the undo that gives the typed "- " back, and Backspace at the start of an item (plain text, then the line above).
// Not part of `npm test` (it needs Chromium, playwright-core and a built web app). From a worktree:
//   npm run build && node test/e2e/notes-list-turn.ts [<screenshot dir>]
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "list-turn-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const p = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const li = (text: string, ...kids: any[]) => ({ type: "listItem", content: [p(text), ...kids] });
const ti = (text: string, checked = false) => ({ type: "taskItem", attrs: { checked }, content: [p(text)] });
const doc = {
  type: "doc",
  content: [
    { type: "bulletList", content: [li("core"), li("University", { type: "taskList", content: [ti("CMPT 307 lecture", true)] }, { type: "bulletList", content: [li("CMPT 361", { type: "bulletList", content: [li("G7"), li("lecure"), li("")] })] }, { type: "taskList", content: [ti("CMPT 371")] })] },
  ],
};
const db = join(scratch, "etude.db");
let id = "";
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ onboarding: { ...e.settings().onboarding, done: true } });
  let out = "";
  assert.equal(await run(["note", "new", "Plan", "--doc", JSON.stringify(doc), "--json"], { stdout: (x) => (out += x), stderr: (x) => process.stderr.write(x), stdin: () => "", isTTY: false, env: process.env }, { etude: e }), 0);
  const r = JSON.parse(out);
  id = r.id ?? r.note?.id;
  e.close();
}
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port)], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/settings").then((r) => r.ok, () => false)) break; await sleep(150); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, colorScheme: "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.goto(`${base}/notes?id=${id}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  const ed = page.locator("[data-pane] .ProseMirror").first();
  await ed.waitFor();
  // The outline as the editor holds it: each item as "[ ] text" / "[x] text" / "• text", nesting as indent.
  const outline = () =>
    ed.evaluate((root: HTMLElement) => {
      const lines: string[] = [];
      const walk = (el: Element, depth: number) => {
        for (const c of Array.from(el.children)) {
          if (c.tagName === "LI") {
            const task = c.hasAttribute("data-checked");
            const own = c.querySelector(":scope > p, :scope > div > p");
            const mark = task ? (c.getAttribute("data-checked") === "true" ? "[x]" : "[ ]") : c.parentElement?.tagName === "OL" ? "1." : "•";
            // The line's own text, without the editor's decorations (a to-do's "0/2" of its sub-items).
            const clone = own?.cloneNode(true) as HTMLElement | undefined;
            clone?.querySelectorAll("[contenteditable=false]").forEach((x) => x.remove());
            lines.push(`${"  ".repeat(depth)}${mark} ${clone?.textContent ?? ""}`);
            walk(c, depth + 1);
          } else walk(c, depth);
        }
      };
      walk(root, 0);
      return lines;
    });
  const lineOf = (text: string) => ed.locator("li p", { hasText: new RegExp(`^${text}$`) }).first();
  await shot("0-before");

  // ---- "[" then "]" before G7: that item alone becomes a to-do, still under CMPT 361.
  await lineOf("G7").click();
  await page.keyboard.press("Home");
  await page.keyboard.type("[");
  await page.keyboard.type("]");
  await sleep(150);
  let o = await outline();
  assert.deepEqual(o, ["• core", "• University", "  [x] CMPT 307 lecture", "  • CMPT 361", "    [ ] G7", "    • lecure", "    • ", "  [ ] CMPT 371"], o.join("\n"));
  await page.keyboard.type("x");
  assert.equal(await ed.locator("li[data-checked] p", { hasText: /^xG7$/ }).count(), 1, "the cursor stayed at the start of the line");
  await page.keyboard.press("Backspace");
  await shot("1-bracket");

  // ---- "/todo" on the empty sub-item.
  await ed.locator("li:not([data-checked]) p:empty, li:not([data-checked]) p:has(br.ProseMirror-trailingBreak)").last().click();
  await page.keyboard.type("/todo");
  await page.locator(".note-slash").waitFor();
  await page.keyboard.press("Enter");
  await sleep(150);
  o = await outline();
  assert.deepEqual(o.slice(3, 7), ["  • CMPT 361", "    [ ] G7", "    • lecure", "    [ ] "], o.join("\n"));
  await page.keyboard.type("read G8");
  await shot("2-slash");

  // ---- the grip on CMPT 361, "Turn into" To-do: joins the to-dos around it, its sub-items come along.
  const box = (await lineOf("CMPT 361").boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await sleep(200);
  const grip = page.locator(".note-handle.is-on .note-handle-grip").first();
  await grip.click();
  await page.locator(".note-bm").waitFor();
  await shot("3-menu");
  await page.locator(".note-bm-turn", { hasText: "To-do list" }).click();
  await sleep(150);
  o = await outline();
  assert.deepEqual(o, ["• core", "• University", "  [x] CMPT 307 lecture", "  [ ] CMPT 361", "    [ ] G7", "    • lecure", "    [ ] read G8", "  [ ] CMPT 371"], o.join("\n"));
  const lists = await ed.locator(":scope > ul > li").nth(1).evaluate((li: HTMLElement) => Array.from(li.querySelectorAll(":scope > ul, :scope > div > ul")).length);
  assert.equal(lists, 1, "CMPT 307, 361 and 371 are one to-do list now");
  await shot("4-turned");

  // ---- "- " at the start of the to-do G7 makes it a bullet again; one undo brings the to-do back.
  await lineOf("G7").click();
  await page.keyboard.press("Home");
  await page.keyboard.type("- ");
  await sleep(150);
  o = await outline();
  assert.equal(o[4], "    • G7", o.join("\n"));
  await page.keyboard.press("Control+z");
  await sleep(150);
  o = await outline();
  // Like any shortcut that formats as you type, undo gives back what was typed, as text.
  assert.equal(o[4], "    [ ] - G7", `undo: ${o.join("\n")}`);
  await shot("5-dash-undo");

  // ---- "[] " on the empty line under the list: a to-do at once, and the habit's space doesn't land in its text.
  await ed.locator(":scope > p").last().click();
  await page.keyboard.type("[] buy milk");
  await sleep(150);
  o = await outline();
  assert.equal(o.at(-1), "[ ] buy milk", o.join("\n"));
  await shot("6-paragraph");

  // ---- Backspace right after "[]": the line goes plain where it is (the cursor stays on it), then joins the one above.
  await lineOf("lecure").click();
  await page.keyboard.press("Home");
  await page.keyboard.type("[]");
  await sleep(120);
  await page.keyboard.press("Backspace");
  await sleep(120);
  o = await outline();
  assert.ok(!o.some((l: string) => l.includes("lecure")), `lecure is plain text now: ${o.join("\n")}`);
  assert.equal(await ed.evaluate(() => getSelection()?.anchorNode?.textContent), "lecure", "the cursor is still on it");
  await page.keyboard.press("Backspace");
  await sleep(120);
  assert.equal(await ed.evaluate(() => getSelection()?.anchorNode?.textContent), "- G7lecure", "joined to the line above");
  await shot("7-backspace");

  // ---- the page saved what the editor shows.
  await sleep(1200);
  const saved = await fetch(`${base}/api/notes/${id}`).then((r) => r.json());
  const text = JSON.stringify(saved);
  assert.ok(text.includes("read G8") && text.includes("taskItem"), "saved");
  assert.deepEqual(errors, []);
  console.log("ok: list items turn in place —", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
