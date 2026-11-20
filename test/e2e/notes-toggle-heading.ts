// Toggle headings through the real editor, on a page in a folder: "> " at the start of a heading (it takes in its
// section), folding it, the grip's "Turn into" both ways, "### " in a toggle's title, and "/toggle" → Toggle heading 2.
// Not part of `npm test` (it needs Chromium, playwright-core and a built web app). From a worktree:
//   npm run build && node test/e2e/notes-toggle-heading.ts [<screenshot dir>]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Etude } from "../../src/core/engine.ts";
import { run } from "../../src/cli/run.ts";
const WT = resolve(import.meta.dirname, "../..");
const require = createRequire(join(process.env.PLAYWRIGHT_FROM ?? process.cwd(), "package.json"));
const { chromium } = require("playwright-core");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "toggle-heading-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const vault = join(scratch, "vault"); mkdirSync(vault);
const P = (t: string) => ({ type: "paragraph", content: t ? [{ type: "text", text: t }] : [] });
const H = (l: number, t: string) => ({ type: "heading", attrs: { level: l }, content: [{ type: "text", text: t }] });
const ti = (t: string) => ({ type: "taskItem", attrs: { checked: true }, content: [P(t)] });
writeFileSync(join(vault, "day.etude"), JSON.stringify({ etude: 1, kind: "page", title: "Journal", doc: { type: "doc", content: [
  P(""), H(2, "TODO"), { type: "horizontalRule" }, { type: "taskList", content: [ti("Marcar optometrista pros primos"), ti("Marcar English examination pros primos")] }, P(""),
  H(2, "University"), { type: "bulletList", content: [{ type: "listItem", content: [P("Algorithms")] }, { type: "listItem", content: [P("Networks")] }] }, P(""),
  P("Notas soltas"), P(""),
] } }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const db = join(scratch, "etude.db");
let id = "";
{ const e = await Etude.open(db, { home: scratch }); e.updateSettings({ onboarding: { ...e.settings().onboarding, done: true } });
  let out = ""; assert.equal(await run(["folder", "open", vault, "--json"], { stdout: (x: string) => (out += x), stderr: (x: string) => process.stderr.write(x), stdin: () => "", isTTY: false, env: { ...process.env, ETUDE_HOME: scratch } }, { etude: e }), 0);
  id = "fs:" + JSON.parse(out).id + "/day.etude"; e.close(); }
const server = spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port), ...(process.env.WEB ? ["--web", process.env.WEB] : [])], { cwd: WT, env: { ...process.env, ETUDE_HOME: scratch }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/settings").then((r) => r.ok, () => false)) break; await sleep(150); }
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium" });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, colorScheme: "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(`${base}/notes?id=${encodeURIComponent(id)}`);
  await page.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  const ed = page.locator("[data-pane] .ProseMirror").first(); await ed.waitFor(); await sleep(600);
  const shape = () => ed.evaluate((el: any) => {
    const f = (n: any): any => n.type.name === "heading" ? "#".repeat(n.attrs.level) + " " + n.textContent : n.type.name === "details" ? { [`▸${n.child(0).attrs.level ?? ""}${n.attrs.open ? "" : "(closed)"} ${n.child(0).textContent}`]: n.child(1).content.content.map(f) } : n.type.name === "horizontalRule" ? "---" : n.type.name === "paragraph" ? n.textContent : n.type.name;
    return el.editor.state.doc.content.content.map(f);
  });
  const cursorAt = (text: string, where: "start" | "end") => ed.evaluate((el: any, [t, w]: string[]) => {
    const e = el.editor; let at = -1;
    e.state.doc.descendants((n: any, p: number) => { if (at < 0 && n.isTextblock && n.textContent === t) at = w === "start" ? p + 1 : p + 1 + n.content.size; return at < 0; });
    e.commands.focus(at);
  }, [text, where]);
  const step = async (name: string, expect: any) => {
    await sleep(250);
    const got = await shape();
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    try { assert.deepEqual(got, expect); console.log("✔", name); } catch { failed = true; console.log("✖", name, "\n  got:", JSON.stringify(got)); }
  };

  // 1. "> " at the start of a heading: a toggle heading with its section inside.
  await cursorAt("TODO", "start");
  await page.keyboard.type("> ", { delay: 40 });
  await step("1-gt-on-heading", ["", { "▸2 TODO": ["---", "taskList", ""] }, "## University", "bulletList", "", "Notas soltas", ""]);
  // fold it with the arrow, then open again
  await page.locator(".note-toggle:has(summary[data-level='2']) > button").first().click();
  await step("2-folded", ["", { "▸2(closed) TODO": ["---", "taskList", ""] }, "## University", "bulletList", "", "Notas soltas", ""]);
  await page.locator(".note-toggle:has(summary[data-level='2']) > button").first().click();

  // 3. Block menu on the toggle heading: Turn into → Heading 2 gives the section back.
  const togg = page.locator(".note-toggle:has(summary[data-level='2'])").first();
  await togg.locator("summary").hover();
  await sleep(200);
  const grip = page.locator(".note-handle-grip").first();
  await grip.click({ timeout: 3000 });
  await page.getByRole("menu", { name: "Block options" }).getByTitle("Heading 2", { exact: true }).click();
  await step("3-turn-back-heading", ["", "## TODO", "---", "taskList", "", "## University", "bulletList", "", "Notas soltas", ""]);

  // 4. Block menu on a heading: Turn into → Toggle heading 1.
  await page.locator(".ProseMirror h2", { hasText: "University" }).hover(); await sleep(200);
  await grip.click({ timeout: 3000 });
  await page.getByRole("menu", { name: "Block options" }).getByTitle("Toggle heading 1", { exact: true }).click();
  await step("4-menu-to-toggle-h1", ["", "## TODO", "---", "taskList", "", { "▸1 University": ["bulletList", "", "Notas soltas"] }, ""]);

  // 5. "### " at the start of a toggle's title makes it a toggle heading 3; "/toggle heading 2" on a paragraph.
  await cursorAt("University", "start");
  await page.keyboard.type("### ", { delay: 40 });
  await step("5-hashes-in-summary", ["", "## TODO", "---", "taskList", "", { "▸3 University": ["bulletList", "", "Notas soltas"] }, ""]);
  await cursorAt("", "end"); // first empty paragraph at the top
  await page.keyboard.type("Plano", { delay: 30 });
  await page.keyboard.type(" /toggle", { delay: 30 }); await sleep(300);
  await page.screenshot({ path: join(SHOTS, "6a-slash.png") });
  await page.locator(".note-slash").getByText("Toggle heading 2", { exact: true }).click();
  await step("6-slash-toggle-h2", [{ "▸2 Plano ": [""] }, "## TODO", "---", "taskList", "", { "▸3 University": ["bulletList", "", "Notas soltas"] }, ""]);
  if (errors.length) { failed = true; console.log("page errors:", errors); }
  // The level is saved in the file, on the toggle's title.
  await sleep(1500);
  const saved = JSON.parse(readFileSync(join(vault, "day.etude"), "utf8")).doc.content[0];
  try { assert.equal(saved.type, "details"); assert.equal(saved.content[0].attrs.level, 2); console.log("✔ saved"); } catch (e) { failed = true; console.log("✖ saved", JSON.stringify(saved).slice(0, 200)); }
} finally { await browser.close(); server.kill(); }
process.exit(failed ? 1 : 0);
