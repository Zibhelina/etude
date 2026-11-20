// A folder on this computer, open in the Notebook: its files show in the sidebar as they are on disk, a Markdown file
// opens in the live editor and what's typed lands in the file, a change made on disk by another program shows in the
// open editor, a [[link]] opens the file it names, and removing a file moves it to the folder's trash.
// `etude serve` on a scratch collection and a scratch folder, driven in Chromium. Not part of `npm test`.
// From an etude2 worktree:  npm run build && node test/e2e/folders.ts [<screenshot dir>]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "folders-e2e-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

// The folder: a small vault with what the editor has to draw.
const vault = join(scratch, "Vault");
mkdirSync(join(vault, "Journal"), { recursive: true });
mkdirSync(join(vault, "Assets"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==", "base64");
writeFileSync(join(vault, "Assets", "strip.png"), PNG);
const WELCOME = `---
created: 2026-01-05
tags: [demo, notes]
---

# Welcome

Some **bold**, some *italic*, a ==marked== word, a #tag and a [web link](https://example.com).

See [[Monday]] and [[Journal/Tuesday|the day after]].

- [ ] buy milk
- [x] write the note

> [!note]
> A callout with a formula $e^{i\\pi} + 1 = 0$.

| Name | Value |
| --- | --- |
| alpha | 1 |
| beta | 2 |

![[strip.png]]

\`\`\`python
print("hi")
\`\`\`

Last line.
`;
writeFileSync(join(vault, "Welcome.md"), WELCOME);
writeFileSync(join(vault, "Journal", "Monday.md"), "# Monday\n\nWalked to the lake.\n");
writeFileSync(join(vault, "Journal", "Tuesday.md"), "# Tuesday\n\nRained.\n");
writeFileSync(join(vault, "main.py"), "print('hi')\n");
writeFileSync(join(vault, "data.bin"), Buffer.from([0, 1, 2, 3, 255]));

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
assert.ok(folder?.id, "the folder opened from the CLI");
const fid = (rel = "") => (rel ? `fs:${folder.id}/${rel}` : `fs:${folder.id}`);

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
  page.on("console", (m: any) => m.type() === "error" && !/favicon|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const row = (rel: string) => page.locator(`[data-notes-slot] [data-note-row="${fid(rel)}"]`);
  const until = async (what: string, f: () => boolean | Promise<boolean>, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await f()) return;
      await sleep(100);
    }
    throw new Error(`timed out: ${what}`);
  };

  // A pinned file shows on the start page while its folder is still folded in the tree (the tree lists a folder
  // only once it's unfolded), and so does one that was opened lately.
  const mark = (rel: string, what: "pin" | "opened", body: unknown = {}) =>
    fetch(`${base}/api/notes/${encodeURIComponent(fid(rel))}/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => assert.equal(r.status, 200));
  await mark("Welcome.md", "pin");
  await mark("main.py", "pin");
  await mark("Journal/Monday.md", "opened");
  await page.goto(`${base}/notes?id=${encodeURIComponent("new:start")}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  const pins = page.locator(".ns-page section[aria-label='Pinned']");
  await pins.getByText("Welcome", { exact: true }).waitFor({ timeout: 8000 });
  await pins.getByText("main.py", { exact: true }).waitFor({ timeout: 4000 });
  await page.locator(".ns-page section[aria-label='Jump back in']").getByText("Monday", { exact: true }).waitFor({ timeout: 4000 });
  assert.equal(await row("Welcome.md").count(), 0, "the folder isn't unfolded: the tree doesn't list the file");
  // Empty slots that say what they're for close the last row of pins (4 across).
  const shelf = await page.evaluate(() => {
    const kids = [...document.querySelectorAll(".ns-page section[aria-label='Pinned'] .ns-shelf > *")];
    return { cards: kids.filter((k) => !k.classList.contains("ns-ghost")).length, ghosts: kids.filter((k) => k.classList.contains("ns-ghost")).length };
  });
  assert.ok(shelf.cards >= 2, JSON.stringify(shelf));
  assert.equal(shelf.ghosts, (4 - (shelf.cards % 4)) % 4, JSON.stringify(shelf));
  assert.equal((shelf.cards + shelf.ghosts) % 4, 0, "the row is full");
  await shot("0-start-pinned");
  // Unpinned from there, it leaves the row though the tree never listed it.
  await mark("main.py", "pin", { pinned: false });
  await mark("Welcome.md", "pin", { pinned: false });
  await page.reload();
  await page.locator(".ns-page").waitFor({ timeout: 8000 });
  await sleep(800);
  assert.equal(await page.locator(".ns-page section[aria-label='Pinned']").getByText("main.py", { exact: true }).count(), 0);
  // The open folder is a row of the tree, under the collection's notes; unfolding it lists the disk.
  await row("").waitFor({ timeout: 8000 });
  assert.equal((await row("").innerText()).trim(), "Vault");
  await row("").click();
  await row("Welcome.md").waitFor({ timeout: 4000 });
  const names = await page.locator(`[data-notes-slot] [data-note-row^="${fid()}/"]`).allInnerTexts();
  assert.deepEqual(names.map((n: string) => n.trim()), ["Assets", "Journal", "data.bin", "main.py", "Welcome"], "folders first, then files by name; Markdown without its extension");
  await shot("1-tree");

  // A Markdown file opens in the live editor: formatting drawn in place, markup hidden away from the cursor.
  await row("Welcome.md").click();
  const ed = page.locator("[data-pane] .note-md-editor .cm-content");
  await ed.waitFor({ timeout: 5000 });
  await page.locator(".cm-md-h1").first().waitFor();
  await page.locator(".cm-md-img img").first().waitFor({ timeout: 5000 });
  await sleep(600);
  const drawn = await page.evaluate(() => {
    const q = (s: string) => document.querySelector(`.note-md-editor ${s}`);
    const img = q(".cm-md-img img") as HTMLImageElement | null;
    return {
      h1: q(".cm-md-h1")?.textContent,
      props: [...document.querySelectorAll(".note-md-editor .cm-md-props span")].map((e) => e.textContent),
      wiki: [...document.querySelectorAll(".note-md-editor .cm-md-wiki")].map((e) => e.textContent),
      checks: [...document.querySelectorAll<HTMLInputElement>(".note-md-editor .cm-md-check")].map((e) => e.checked),
      table: !!q(".cm-md-table-view table"),
      cells: [...document.querySelectorAll(".note-md-editor .cm-md-table-view td")].map((e) => e.textContent),
      math: !!q(".cm-md-callout .katex"),
      hl: q(".cm-md-hl")?.textContent,
      tag: q(".cm-md-tag")?.textContent,
      img: img ? { ok: img.complete && img.naturalWidth > 0, w: img.naturalWidth } : null,
      code: q(".cm-md-cb-label")?.textContent,
      strong: q(".cm-md-strong")?.textContent,
      text: (document.querySelector(".note-md-editor .cm-content") as HTMLElement).innerText,
    };
  });
  assert.equal(drawn.h1, "Welcome", "the heading shows without its #");
  assert.deepEqual(drawn.props, ["created", "2026-01-05", "tags", "[demo, notes]"], "the properties block is a small table");
  assert.deepEqual(drawn.wiki, ["Monday", "the day after"], "[[links]] show their name or their alias");
  assert.deepEqual(drawn.checks, [false, true], "to-dos are boxes");
  assert.ok(drawn.table, "a table is drawn as a table");
  assert.deepEqual(drawn.cells, ["alpha", "1", "beta", "2"]);
  assert.ok(drawn.math, "math renders in the callout");
  assert.equal(drawn.hl, "marked");
  assert.equal(drawn.tag, "#tag");
  assert.deepEqual(drawn.img, { ok: true, w: 64 }, "the picture named by ![[…]] loads from the folder");
  assert.equal(drawn.code, "python");
  assert.equal(drawn.strong, "bold", "the ** marks are hidden");
  assert.ok(!drawn.text.includes("[[") && !drawn.text.includes("=="), "no raw markup away from the cursor");
  await shot("2-markdown-live");

  // Opening a file never writes it.
  assert.equal(readFileSync(join(vault, "Welcome.md"), "utf8"), WELCOME);

  // Typing saves to the file on disk, and only what was typed changes.
  await page.locator(".note-md-editor .cm-line", { hasText: "Last line." }).click();
  // The file ends with a line break, so the very end is an empty line: one up is "Last line."
  await page.keyboard.press("Control+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.type(" Typed in Etude.");
  await until("the typed text reaches the file", () => readFileSync(join(vault, "Welcome.md"), "utf8").includes("Last line. Typed in Etude."));
  assert.equal(readFileSync(join(vault, "Welcome.md"), "utf8"), WELCOME.replace("Last line.", "Last line. Typed in Etude."));
  await page.locator(".note-save.saved").waitFor({ timeout: 4000 });

  // Ticking a to-do writes [x] in the file.
  await page.locator(".note-md-editor .cm-md-check").first().click();
  await until("the tick reaches the file", () => readFileSync(join(vault, "Welcome.md"), "utf8").includes("- [x] buy milk"));

  // Another program appends to the file: the open editor shows it, without reopening.
  await sleep(700);
  const before = readFileSync(join(vault, "Welcome.md"), "utf8");
  writeFileSync(join(vault, "Welcome.md"), before + "\nAppended by another program.\n");
  await page.locator(".note-md-editor .cm-line", { hasText: "Appended by another program." }).waitFor({ timeout: 8000 });
  await shot("3-changed-on-disk");

  // Both at once: typing here while the file changes on disk keeps both.
  await page.locator(".note-md-editor .cm-line", { hasText: "Appended by another program." }).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  const onDisk = readFileSync(join(vault, "Welcome.md"), "utf8");
  await page.keyboard.type(" And this from here.");
  writeFileSync(join(vault, "Welcome.md"), onDisk.replace("# Welcome", "# Welcome home"));
  await until("both changes are in the file", () => {
    const t = readFileSync(join(vault, "Welcome.md"), "utf8");
    return t.includes("# Welcome home") && t.includes("Appended by another program. And this from here.");
  }, 12000);
  await page.locator(".cm-md-h1", { hasText: "Welcome home" }).waitFor({ timeout: 5000 });

  // A [[link]] opens the file it names, found by name anywhere in the folder.
  await page.locator(".note-md-editor .cm-md-wiki", { hasText: "Monday" }).click();
  await page.waitForFunction((id: string) => new URLSearchParams(location.search).get("id") === id, fid("Journal/Monday.md"), { timeout: 5000 });
  await page.locator(".cm-md-h1", { hasText: "Monday" }).waitFor();
  await row("Journal/Monday.md").waitFor({ timeout: 4000 });
  assert.match((await row("Journal/Monday.md").getAttribute("class")) ?? "", /is-on/, "the tree unfolds to the open file");
  await shot("4-followed-link");

  // Code opens in the code editor, and a file Etude has no view for says so.
  await row("main.py").click();
  await page.locator("[data-pane] .note-file-editor:not(.note-md-editor) .cm-content").waitFor({ timeout: 4000 });
  await row("data.bin").click();
  await page.locator(".local-other-name", { hasText: "data.bin" }).waitFor({ timeout: 4000 });
  await row("Assets").click();
  await row("Assets/strip.png").click();
  await page.locator(".local-media img").waitFor({ timeout: 4000 });
  await shot("5-picture");

  // A file made by another program shows up in the tree on its own.
  writeFileSync(join(vault, "Journal", "Wednesday.md"), "# Wednesday\n");
  await row("Journal/Wednesday.md").waitFor({ timeout: 9000 });

  // A new Markdown file from the menu is a file on disk; renaming it renames the file.
  await row("Journal").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New Markdown file" }).click();
  await until("Untitled.md is on disk", () => existsSync(join(vault, "Journal", "Untitled.md")));
  await row("Journal/Untitled.md").waitFor({ timeout: 4000 });
  await row("Journal/Untitled.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.locator(".note-row-rename").fill("Thursday");
  await page.keyboard.press("Enter");
  await until("the file is renamed on disk", () => existsSync(join(vault, "Journal", "Thursday.md")) && !existsSync(join(vault, "Journal", "Untitled.md")));
  await row("Journal/Thursday.md").waitFor({ timeout: 4000 });
  await page.waitForFunction((id: string) => new URLSearchParams(location.search).get("id") === id, fid("Journal/Thursday.md"), { timeout: 5000 });

  // A new page in the folder is a .etude file, edited by the page editor; what's typed lands in the file.
  await row("Journal").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New page" }).click();
  await until("Untitled.etude is on disk", () => existsSync(join(vault, "Journal", "Untitled.etude")));
  await page.waitForFunction((id: string) => new URLSearchParams(location.search).get("id") === id, fid("Journal/Untitled.etude"), { timeout: 5000 });
  const prose = page.locator("[data-pane] .note-prose").first();
  await prose.waitFor({ timeout: 5000 });
  await prose.click();
  await page.keyboard.type("Written in the page editor.");
  const pageText = (name: string) => {
    try {
      return JSON.stringify(JSON.parse(readFileSync(join(vault, "Journal", name), "utf8")).doc);
    } catch {
      return "";
    }
  };
  await until("the page's text reaches its file", () => pageText("Untitled.etude").includes("Written in the page editor."), 8000);
  assert.equal(JSON.parse(readFileSync(join(vault, "Journal", "Untitled.etude"), "utf8")).etude, 1);
  // Its title is its own, kept in the file: until it has one, the file's name shows faintly where the title goes.
  const title = page.locator("[data-pane] textarea.note-title").first();
  const hint = page.locator("[data-pane] .note-title-hint").first();
  const fileTitle = (name: string) => {
    try {
      return JSON.parse(readFileSync(join(vault, "Journal", name), "utf8")).title ?? null;
    } catch {
      return undefined;
    }
  };
  assert.equal(await title.inputValue(), "", "no title until one is given");
  assert.equal(await hint.textContent(), "Untitled", "the file's name is suggested");
  await shot("6c-title-suggested");
  // Typing the start of the name leaves the rest suggested, and Tab takes it.
  await title.click();
  await page.keyboard.type("Unt");
  assert.equal(await hint.textContent(), "Untitled");
  assert.equal(await hint.locator(".note-title-typed").textContent(), "Unt");
  await page.keyboard.press("Tab");
  assert.equal(await title.inputValue(), "Untitled");
  assert.equal(await hint.count(), 0, "nothing left to suggest");
  await until("the title taken from the name reaches the file", () => fileTitle("Untitled.etude") === "Untitled", 8000);
  // Another title is the page's own, and the file keeps its name.
  await title.fill("Plans for the week");
  await prose.click();
  await until("the new title reaches the file", () => fileTitle("Untitled.etude") === "Plans for the week", 8000);
  assert.equal(existsSync(join(vault, "Journal", "Plans for the week.etude")), false, "a title renames nothing");
  assert.equal((await row("Journal/Untitled.etude").innerText()).trim(), "Untitled", "the tree lists the file by its name");
  // A title that isn't the name's start hides the suggestion; clearing it brings the suggestion back.
  await title.fill("");
  assert.equal(await hint.textContent(), "Untitled");
  await until("an empty title leaves the file", () => fileTitle("Untitled.etude") === null, 8000);
  await title.fill("Plans for the week");
  assert.equal(await hint.count(), 0);
  await until("the title is back in the file", () => fileTitle("Untitled.etude") === "Plans for the week", 8000);
  // The file renamed (the tree's Rename): the page keeps its title.
  await row("Journal/Untitled.etude").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const nameField = page.locator("[data-notes-slot] input").first();
  await nameField.waitFor({ timeout: 3000 });
  await sleep(100);
  await nameField.fill("Plans");
  await nameField.press("Enter");
  await until("the page's file is renamed", () => existsSync(join(vault, "Journal", "Plans.etude")) && !existsSync(join(vault, "Journal", "Untitled.etude")));
  await page.waitForFunction((id: string) => new URLSearchParams(location.search).get("id") === id, fid("Journal/Plans.etude"), { timeout: 5000 });
  await page.locator("[data-pane] .note-prose", { hasText: "Written in the page editor." }).first().waitFor({ timeout: 5000 });
  assert.equal(await page.locator("[data-pane] textarea.note-title").first().inputValue(), "Plans for the week");
  // Another program rewrites the page's file: the open page shows it.
  await sleep(1200);
  const planFile = join(vault, "Journal", "Plans.etude");
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  plan.doc.content.push({ type: "paragraph", content: [{ type: "text", text: "Added by another program." }] });
  writeFileSync(planFile, JSON.stringify(plan, null, 1) + "\n");
  await page.locator("[data-pane] .note-prose", { hasText: "Added by another program." }).first().waitFor({ timeout: 10000 });
  await shot("6b-page-file");

  // The pane zoomed out or in (Ctrl + − / +): a file's editor still ends at the bottom of the window, its status bar on the edge.
  await page.goto(`${base}/notes?id=${encodeURIComponent(fid("Welcome.md"))}`);
  await page.locator("[data-pane] .cm-content").first().waitFor({ timeout: 6000 });
  await page.locator("[data-pane] .cm-content").first().click();
  const statusBottom = () => page.evaluate(() => Math.round(window.innerHeight - (document.querySelector("[data-pane] .note-file-status") as HTMLElement).getBoundingClientRect().bottom));
  assert.ok(Math.abs(await statusBottom()) <= 1, "at 100% the status bar sits on the bottom edge");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("[data-pane] .note-file-status")!).borderTopWidth), "0px", "no line is drawn over the status bar");
  for (const key of ["Control+Minus", "Control+Minus", "Control+Minus"]) await page.keyboard.press(key);
  await sleep(700);
  assert.notEqual(await page.evaluate(() => (document.querySelector(".note-pane[data-zoom]") as HTMLElement | null)?.style.getPropertyValue("--pane-zoom") ?? ""), "", "the pane is zoomed");
  assert.ok(Math.abs(await statusBottom()) <= 2, `zoomed out, the status bar is still on the bottom edge (off by ${await statusBottom()}px)`);
  await shot("6a-zoomed-out");
  for (const key of ["Control+0", "Control+Equal", "Control+Equal"]) await page.keyboard.press(key);
  await sleep(700);
  assert.ok(Math.abs(await statusBottom()) <= 2, `zoomed in, too (off by ${await statusBottom()}px)`);
  await page.keyboard.press("Control+0");
  await sleep(400);
  // Two panes side by side: the one that's zoomed still ends where the other does.
  // (Journal is unfolded already; a click would fold it.)
  if (!(await row("Journal/Monday.md").count())) await row("Journal").click();
  await row("Journal/Monday.md").waitFor({ timeout: 4000 });
  await row("Journal/Monday.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open to the right" }).click();
  await page.locator(".note-pane .cm-content").nth(1).waitFor({ timeout: 6000 });
  await page.locator(".note-pane .cm-content").nth(1).click();
  for (const key of ["Control+Minus", "Control+Minus", "Control+Minus"]) await page.keyboard.press(key);
  await sleep(700);
  const bottoms: { zoomed: boolean; off: number }[] = await page.evaluate(() => [...document.querySelectorAll(".note-pane")].map((p) => ({ zoomed: p.hasAttribute("data-zoom"), off: Math.round(window.innerHeight - (p.querySelector(".note-file-status") as HTMLElement).getBoundingClientRect().bottom) })));
  assert.deepEqual(bottoms.map((b) => b.zoomed).sort(), [false, true], JSON.stringify(bottoms));
  assert.ok(bottoms.every((b) => Math.abs(b.off) <= 2), `both panes end at the bottom edge: ${JSON.stringify(bottoms)}`);
  await shot("6a-zoomed-split");
  await page.keyboard.press("Control+0");
  // Back to one pane for what follows.
  await cli("view", "close", "--pane", "2");
  await until("one pane again", async () => (await page.locator(".note-pane").count()) === 1);
  await page.goto(`${base}/notes?id=${encodeURIComponent(fid("Welcome.md"))}`);
  await row("Welcome.md").waitFor({ timeout: 6000 });

  // A canvas, a board and a web file made in the folder are files too, each opened by its own editor.
  const kindOf = (name: string) => {
    try {
      return JSON.parse(readFileSync(join(vault, "Journal", name), "utf8")).kind;
    } catch {
      return null;
    }
  };
  await row("Journal").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New canvas" }).click();
  await until("the canvas is a file", () => kindOf("Untitled canvas.etude") === "canvas");
  await page.waitForFunction((id: string) => new URLSearchParams(location.search).get("id") === id, fid("Journal/Untitled canvas.etude"), { timeout: 5000 });
  await page.locator("[data-pane] .excalidraw, [data-pane] canvas").first().waitFor({ timeout: 15000 });
  // Drawn on: the drawing is saved into the file.
  const sceneOf = (name: string) => {
    try {
      return JSON.parse(readFileSync(join(vault, "Journal", name), "utf8")).scene.elements as { type: string }[];
    } catch {
      return [];
    }
  };
  const board = await page.locator("[data-pane] .excalidraw canvas.interactive, [data-pane] canvas").first().boundingBox();
  await page.mouse.click(board!.x + board!.width / 2, board!.y + board!.height / 2);
  await page.keyboard.press("r");
  await page.mouse.move(board!.x + board!.width / 2 - 120, board!.y + board!.height / 2 - 80);
  await page.mouse.down();
  await page.mouse.move(board!.x + board!.width / 2 + 60, board!.y + board!.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await until("the rectangle is in the canvas's file", () => sceneOf("Untitled canvas.etude").some((el) => el.type === "rectangle"), 9000);
  await shot("6c-canvas-file");
  await row("Journal").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New kanban" }).click();
  await until("the board is a file", () => kindOf("Untitled board.etude") === "kanban");
  await page.waitForFunction((id: string) => new URLSearchParams(location.search).get("id") === id, fid("Journal/Untitled board.etude"), { timeout: 5000 });
  const boardName = page.locator("[data-pane] input.kb-page-title").first();
  await boardName.waitFor({ timeout: 8000 });
  // Its title is its own too: the file's name is suggested, Tab takes it, and another title leaves the file's name alone.
  assert.equal(await page.locator("[data-pane] .kb-page-title-hint").first().textContent(), "Untitled board");
  await boardName.click();
  await page.keyboard.press("Tab");
  assert.equal(await boardName.inputValue(), "Untitled board");
  await boardName.fill("Sprint");
  await boardName.press("Enter");
  const boardTitle = () => {
    try {
      return JSON.parse(readFileSync(join(vault, "Journal", "Untitled board.etude"), "utf8")).title ?? null;
    } catch {
      return undefined;
    }
  };
  await until("the board's title reaches its file", () => boardTitle() === "Sprint", 8000);
  assert.equal(existsSync(join(vault, "Journal", "Sprint.etude")), false, "a title renames nothing");
  // A card added to it lands in the file.
  await page.locator("[data-pane] .kb-add").first().click().catch(() => {});
  const what = page.locator("[data-pane] textarea[placeholder='What needs doing?']").first();
  await what.waitFor({ timeout: 5000 });
  await what.fill("Write the plan");
  await what.press("Enter");
  await until("the card is in the board's file", () => {
    try {
      return Object.values(JSON.parse(readFileSync(join(vault, "Journal", "Untitled board.etude"), "utf8")).board.cards as Record<string, { title: string }>).some((c) => c.title === "Write the plan");
    } catch {
      return false;
    }
  }, 9000);
  await shot("6d-board-file");
  await row("Journal").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New web file" }).click();
  await until("the web file is a file", () => existsSync(join(vault, "Journal", "Untitled.html")));
  await page.waitForFunction((id: string) => new URLSearchParams(location.search).get("id") === id, fid("Journal/Untitled.html"), { timeout: 5000 });
  await sleep(800);
  await shot("6e-web-file");

  // Notes of the collection moved into the folder (`etude folder take`): a link between two of them opens the file,
  // and doesn't take the page for one to make.
  const pair = (await cli("note", "new", "Pair", "--folder")).json;
  await cli("note", "new", "Target page", "--parent", pair.id, "--md", "The target's text.");
  await cli("note", "new", "Linking page", "--parent", pair.id, "--md", "See [[Target page]] for more.");
  const taken = (await cli("folder", "take", "Pair", "Vault", "--yes")).json;
  assert.deepEqual([taken.moved.length, taken.links, taken.archived], [3, 1, 3]);
  await page.goto(`${base}/notes?id=${encodeURIComponent(fid("Pair/Linking page.etude"))}`);
  const moved = page.locator("[data-pane] .note-link", { hasText: "Target page" }).first();
  await moved.waitFor({ timeout: 6000 });
  assert.equal(await moved.evaluate((el: HTMLElement) => el.classList.contains("is-missing")), false, "the link isn't shown as a page that doesn't exist");
  await moved.locator("[role=link]").click();
  await page.waitForFunction((id: string) => new URLSearchParams(location.search).get("id") === id, fid("Pair/Target page.etude"), { timeout: 5000 });
  await page.locator("[data-pane] .note-prose", { hasText: "The target's text." }).first().waitFor({ timeout: 5000 });
  assert.equal((await cli("note", "list")).json.some((n: any) => n.title === "Target page"), false, "no page was made in the collection");
  await page.goto(`${base}/notes?id=${encodeURIComponent(fid("Welcome.md"))}`);
  await row("Welcome.md").waitFor({ timeout: 6000 });

  // What's in a folder can be put in an order of your own: a row dragged between two others stays there. Nothing
  // moves on disk; the folder remembers, and Sort by name forgets.
  const topLevel = () =>
    page.evaluate((prefix: string) => [...document.querySelectorAll<HTMLElement>(`[data-notes-slot] [data-note-row^="${prefix}/"]`)].map((r) => r.dataset.noteRow!.slice(prefix.length + 1)).filter((rel) => !rel.includes("/")), fid());
  assert.deepEqual((await topLevel()).slice(0, 2), ["Assets", "Journal"], "by name, folders first");
  const grab = (await row("Journal").locator("span.truncate").boundingBox())!;
  const over = (await row("Assets").boundingBox())!;
  await page.mouse.move(grab.x + 8, grab.y + grab.height / 2);
  await page.mouse.down();
  await page.mouse.move(grab.x + 12, grab.y + grab.height / 2 - 8, { steps: 3 });
  await page.mouse.move(over.x + 60, over.y + 2, { steps: 8 });
  await page.locator(".note-tree-line").waitFor({ timeout: 3000 });
  await shot("6f-reorder");
  await page.mouse.up();
  await until("Journal is first", async () => (await topLevel())[0] === "Journal");
  assert.equal(existsSync(join(vault, "Journal", "Monday.md")), true, "nothing moved on disk");
  assert.deepEqual((await cli("folder", "ls", "Vault")).json.slice(0, 2).map((r: any) => r.name), ["Journal", "Assets"], "the CLI lists it the same way");
  await page.reload();
  await row("Journal").waitFor({ timeout: 8000 });
  assert.equal((await topLevel())[0], "Journal", "the order is still there after a reload");
  // With an order of its own in place, the tree's poll finds nothing new: it doesn't list the folder again every few seconds.
  let listings = 0;
  const counted = (r: any) => void (r.url().includes("/api/folders/entries") && listings++);
  await sleep(1500);
  page.on("request", counted);
  await sleep(7000);
  page.off("request", counted);
  assert.equal(listings, 0, `the folder was listed again ${listings} times while nothing changed`);
  await row("").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Sort by name" }).click();
  await until("back by name", async () => (await topLevel())[0] === "Assets");
  await row("").click({ button: "right" });
  assert.equal(await page.getByRole("menuitem", { name: "Sort by name" }).count(), 0, "a folder that lists by name has nothing to sort back");
  await page.keyboard.press("Escape");

  // Removing a file asks first. After a yes it moves to the folder's trash and the tab that showed it closes onto
  // the start page (not an empty pane); Undo brings it back.
  await row("Journal/Tuesday.md").click();
  await page.waitForFunction((id: string) => new URLSearchParams(location.search).get("id") === id, fid("Journal/Tuesday.md"), { timeout: 5000 });
  await row("Journal/Tuesday.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to the trash" }).click();
  const ask = page.locator("[data-trash-ask]");
  await ask.waitFor({ timeout: 4000 });
  assert.match(await ask.innerText(), /Move “Tuesday\.md” to the trash\?/);
  await sleep(350);
  await shot("6g-trash-ask");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await sleep(400);
  assert.equal(existsSync(join(vault, "Journal", "Tuesday.md")), true, "Cancel leaves the file where it is");
  await row("Journal/Tuesday.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to the trash" }).click();
  await ask.getByRole("button", { name: "Move to the trash" }).click();
  // Its words stay what they were while it fades out.
  assert.doesNotMatch((await ask.innerText().catch(() => "")) || "", /Move 0 to the trash/);
  await until("Tuesday is in the trash", () => existsSync(join(vault, ".trash", "Tuesday.md")) && !existsSync(join(vault, "Journal", "Tuesday.md")));
  await page.locator("[data-pane] .ns-page").first().waitFor({ timeout: 5000 });
  assert.equal(await page.locator("[data-pane] .cm-content").count(), 0, "no editor is left on the file that's gone");
  assert.notEqual(new URL(page.url()).searchParams.get("id"), fid("Journal/Tuesday.md"));
  await shot("6h-after-trash");
  await page.getByRole("button", { name: "Undo" }).click();
  await until("Tuesday is back", () => existsSync(join(vault, "Journal", "Tuesday.md")));
  await row("Journal/Tuesday.md").waitFor({ timeout: 5000 });
  await shot("6-end");

  // Ctrl+K finds a file of the folder by its name, says where it is, and opens it.
  await page.locator("body").click({ position: { x: 700, y: 500 } });
  await page.keyboard.press("Control+k");
  const finder = page.locator("[data-deck-finder]");
  await finder.waitFor();
  await finder.locator("input").fill("wednes");
  await finder.locator("[role=option]", { hasText: "Wednesday" }).waitFor({ timeout: 5000 });
  const found = (await finder.locator("[role=option]", { hasText: "Wednesday" }).first().innerText()).replace(/\s+/g, " ");
  assert.match(found, /Vault › Journal/, `the finder says where the file is: ${found}`);
  await shot("7-finder");
  await finder.locator("[role=option]", { hasText: "Wednesday" }).first().click();
  await page.waitForFunction((id: string) => new URLSearchParams(location.search).get("id") === id, fid("Journal/Wednesday.md"), { timeout: 5000 });
  await page.locator(".cm-md-h1", { hasText: "Wednesday" }).waitFor();

  // The collection's own notes have nothing of the folder in them.
  assert.equal((await cli("note", "list")).json.some((n: any) => String(n.id).startsWith("fs:")), false);
  assert.deepEqual(errors, []);
  console.log("ok: folders, shots in", SHOTS);
} catch (e) {
  failed = true;
  console.error(e);
  // What the screen showed when it went wrong.
  await page?.screenshot({ path: join(SHOTS, "failed.png") }).catch(() => {});
  console.error("save state:", await page?.locator(".note-save").allInnerTexts().catch(() => null), "toasts:", await page?.locator("[data-sonner-toast]").allInnerTexts().catch(() => null));
  console.error("shots in", SHOTS);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
