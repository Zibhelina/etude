// Sharing and presence through the real UI: a fake Etude cloud, two `etude serve` (João, Victor) and Chromium.
// Not part of `npm test` (it needs Chromium, playwright-core and a built web app). From an etude2 worktree:
//   npm run build && node test/e2e/share-ui.ts [<etude-cloud worktree>] [<screenshot dir>]
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
const require = createRequire(join(process.env.PLAYWRIGHT_FROM ?? process.cwd(), "package.json"));
const { chromium } = require("playwright-core");

const WT = resolve(import.meta.dirname, "../..");
const CLOUD = process.argv[2] ?? process.env.ETUDE_CLOUD_DIR ?? "";
const SHOTS = process.argv[3] ?? "";
mkdirSync(SHOTS, { recursive: true });
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "share-ui-"));
const free = () => new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const kids: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cport = await free();
const curl = `http://127.0.0.1:${cport}`;
const data = join(scratch, "cloud");
kids.push(spawn(process.execPath, ["src/main.ts"], { cwd: CLOUD, env: { ...process.env, ETUDE_CLOUD_PORT: String(cport), ETUDE_CLOUD_PUBLIC_URL: curl, ETUDE_CLOUD_PROVIDERS: "fake", ETUDE_CLOUD_BILLING: "off", ETUDE_CLOUD_RATE_LIMIT: "off", ETUDE_CLOUD_DATA_DIR: data, ETUDE_CLOUD_VAULT_SECRET: randomBytes(32).toString("base64"), NODE_ENV: "development" }, stdio: "ignore" }));

async function device(name: string, email: string) {
  const port = await free();
  const home = join(scratch, name);
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, ETUDE_HOME: home };
  const db = join(scratch, `${name}.db`);
  kids.push(spawn(process.execPath, ["src/cli/main.ts", "--db", db, "serve", "--port", String(port)], { cwd: WT, env, stdio: ["ignore", "ignore", "inherit"] }));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/notes").then((r) => r.ok, () => false)) break; await sleep(150); }
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${name} ${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  await api("PUT", "/api/account/server", { server: curl });
  await api("POST", "/api/account/signin", { email });
  let code: string | null = null;
  for (let i = 0; i < 50 && !code; i++) {
    const dir = join(data, "outbox");
    const mails = existsSync(dir) ? readdirSync(dir).sort().reverse().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : [];
    const m = mails.find((x: any) => x.to === email && /\b\d{3} ?\d{3}\b/.test(x.text));
    code = m ? /\b(\d{3}) ?(\d{3})\b/.exec(m.text)!.slice(1).join("") : null;
    if (!code) await sleep(100);
  }
  await api("POST", "/api/account/verify", { code, email });
  return { base, api, db, env };
}

/** Waits until `f` is true (polled every 100 ms), returning how long it took; throws after `ms`. */
async function until(what: string, f: () => Promise<boolean>, ms: number) {
  const t0 = Date.now();
  for (;;) {
    if (await f().catch(() => false)) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms / 1000} s: ${what}`);
    await sleep(100);
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/sbin/chromium", headless: true });
try {
  for (let i = 0; i < 100; i++) { if (await fetch(curl + "/v1/health").then((r) => r.ok, () => false)) break; await sleep(100); }
  const A = await device("alice", "alice@example.com");
  const B = await device("bob", "bob@example.com");
  const team = await A.api("POST", "/api/notes", { title: "Study Group", kind: "folder" });
  const para = (t: string) => ({ type: "paragraph", content: [{ type: "text", text: t }] });
  const agora = await A.api("POST", "/api/notes", { title: "Overview", parentId: team.id, doc: { type: "doc", content: [para("First line: outline for the week."), para("Second line: review chapter notes and practice problems before Friday."), para("Third line.")] } });
  await A.api("POST", "/api/notes", { title: "Tasks", parentId: team.id, kind: "kanban" });
  await A.api("POST", "/api/notes", { title: "Private", doc: { type: "doc", content: [] } });
  console.log("ok  two devices signed in; Study Group folder with a page and a kanban");

  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const pa = await ctxA.newPage();
  await pa.goto(A.base + "/notes");
  await pa.getByText("Study Group", { exact: true }).first().click({ button: "right" });
  await pa.getByRole("menuitem", { name: /Share/ }).click();
  await pa.getByLabel("Email addresses").fill("bob@example.com");
  await pa.keyboard.press("Enter");
  await pa.getByText("bob@example.com").first().waitFor({ timeout: 10_000 });
  await pa.keyboard.press("Escape");
  console.log("ok  Alice shares Study Group with bob@example.com from the UI");

  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const pb = await ctxB.newPage();
  await pb.goto(B.base + "/notes");
  const accept = pb.getByRole("button", { name: "Accept" });
  await accept.waitFor({ timeout: 40_000 });
  await pb.getByText("Study Group").first().waitFor({ timeout: 45_000 });
  await accept.click();
  await pb.getByText("Overview", { exact: true }).first().waitFor({ timeout: 20_000 });
  console.log("ok  Bob accepts; pages arrive");

  // Both on Overview. Bob clicks into the middle of the second paragraph and types.
  await pa.goto(A.base + "/notes?id=" + agora.id);
  await pa.locator(".ProseMirror").first().waitFor();
  await pb.goto(B.base + "/notes?id=" + agora.id);
  const edB = pb.locator(".ProseMirror").first();
  await edB.waitFor();
  const p2 = edB.locator("p").nth(1);
  await p2.waitFor();
  const box = (await p2.boundingBox())!;
  await pb.mouse.click(box.x + box.width / 2, box.y + 6);
  await pb.keyboard.type(" (ok)");
  const t0 = Date.now();
  const caret = pa.locator(".note-presence-caret");
  const inBlock = async () => {
    if ((await caret.count()) !== 1) return false;
    const label = (await pa.locator(".note-presence-label").first().textContent())?.trim();
    const c = (await caret.first().boundingBox())!;
    const p = (await pa.locator(".ProseMirror p").nth(1).boundingBox())!;
    const mid = c.y + c.height / 2;
    return label === "bob" && mid > p.y && mid < p.y + p.height && c.x > p.x + 20;
  };
  await until("Bob's caret labeled bob in Alice's second paragraph", inBlock, 3000);
  console.log(`ok  Alice sees Bob's caret, labeled "bob", in the second paragraph after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await pa.getByText("(ok)").first().waitFor({ timeout: 15_000 });
  console.log(`ok  Bob's typing arrives in Alice's page after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // Bob selects back to the start of the line: Alice sees a band in his color.
  await pb.keyboard.press("Shift+Home");
  await until("Bob's selection band on Alice's page", async () => (await pa.locator(".note-presence-sel").count()) > 0, 3000);
  console.log("ok  Bob's selection shows as a band on Alice's page");
  await sleep(400); // the caret's 120 ms glide
  await pa.screenshot({ path: join(SHOTS, "01-alice-1440-dark-bob-caret.png") });
  await sleep(3400);
  if (!(await caret.first().getAttribute("class"))?.includes("is-idle")) throw new Error("the label didn't fold to a dot after 3 s");
  await pa.screenshot({ path: join(SHOTS, "02-alice-1440-dark-caret-idle.png") });
  console.log("ok  after 3 s still, the name folds into a dot");
  await pb.keyboard.press("End");

  // Top bar: Bob's avatar with the green dot; sidebar: a dot on Overview.
  await until("Bob's avatar in Alice's top bar", async () => (await pa.locator(".presence-stack .presence-stack-item").count()) === 1 && (await pa.locator(".presence-stack .presence-online").count()) === 1, 3000);
  const title = await pa.locator(".presence-stack").first().getAttribute("title");
  if (!/^bob · (editing|on) Overview · now$/.test(title ?? "")) throw new Error(`stack hover says ${title}`);
  console.log(`ok  Alice's top bar shows Bob's avatar with the green dot ("${title}")`);
  if ((await pa.locator("[data-note-row] .presence-dot").count()) < 1) throw new Error("no dot on Overview's row in the sidebar");
  console.log("ok  the sidebar has a dot on Overview's row");

  // The Share dialog: Online · in Overview, edits this week.
  await pa.locator(".presence-stack").first().click();
  const dialog = pa.getByRole("dialog");
  await dialog.getByText("Online · in Overview").waitFor({ timeout: 5000 });
  const edits = await dialog.getByText(/\d+ edits? this week/).first().textContent();
  const n = Number(/(\d+) edit/.exec(edits ?? "")?.[1] ?? 0);
  if (n < 1) throw new Error(`Bob's edit count is ${n}`);
  console.log(`ok  the Share dialog shows Bob "Online · in Overview" and "${edits}"`);
  await dialog.getByRole("button", { name: /Activity/ }).click();
  await dialog.locator(".share-activity-bars").first().waitFor();
  await sleep(500);
  await pa.screenshot({ path: join(SHOTS, "03-alice-1440-dark-dialog-online.png") });

  // Light, and 820 wide.
  const ctxL = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const pl = await ctxL.newPage();
  await pl.goto(A.base + "/notes?id=" + agora.id);
  await pl.locator(".ProseMirror").first().waitFor();
  await pb.keyboard.type(" yes");
  await until("caret in the light window", async () => (await pl.locator(".note-presence-caret").count()) === 1, 4000);
  await sleep(600);
  await pl.screenshot({ path: join(SHOTS, "04-alice-1440-light-bob-caret.png") });
  await pl.locator(".presence-stack").first().click();
  await pl.getByRole("dialog").getByText("Online · in Overview").waitFor({ timeout: 5000 });
  await pl.getByRole("dialog").getByRole("button", { name: /Activity/ }).click();
  await sleep(500);
  await pl.screenshot({ path: join(SHOTS, "05-alice-1440-light-dialog.png") });
  await pl.keyboard.press("Escape");
  await pl.setViewportSize({ width: 820, height: 1000 });
  await sleep(400);
  await pb.keyboard.type(" !");
  await sleep(1500);
  await pl.screenshot({ path: join(SHOTS, "06-alice-820-light-bob-caret.png") });
  await ctxL.close();
  // No 390 shot: Notes isn't on phones yet (App.tsx sends /notes to the Library there).
  await pa.keyboard.press("Escape");
  // Bob's side, light: Alice clicks into the first paragraph and her caret shows on Bob's page.
  await pa.locator(".ProseMirror p").first().click();
  await until("Alice's caret on Bob's page", async () => (await pb.locator(".note-presence-caret").count()) === 1, 4000);
  await pb.screenshot({ path: join(SHOTS, "07-bob-1440-light-alice-caret.png") });
  console.log("ok  light and 820 screenshots; Bob sees Alice's caret too");

  // Bob closes his page: his caret goes, and the dialog says when he was last active.
  const t1 = Date.now();
  await pb.close();
  await until("Bob's caret gone from Alice's page", async () => (await caret.count()) === 0, 45_000);
  console.log(`ok  Bob closes his page: his caret is gone from Alice's after ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  await until("Bob's avatar gone from the top bar", async () => (await pa.locator(".presence-stack").count()) === 0, 5000);
  await pa.getByRole("button", { name: /^Shared/ }).first().click();
  await pa.getByRole("dialog").getByText(/Last active (just now|\d+ min ago)/).waitFor({ timeout: 5000 });
  const last = await pa.getByRole("dialog").getByText(/Last active/).first().textContent();
  console.log(`ok  the Share dialog shows Bob "${last}"`);
  await sleep(500);
  await pa.screenshot({ path: join(SHOTS, "08-alice-1440-dark-dialog-last-active.png") });
  await pa.keyboard.press("Escape");
  await sleep(300);
  await pa.screenshot({ path: join(SHOTS, "09-alice-1440-dark-edited-by.png") });
  const editedBy = await pa.locator(".note-edited-by").first().textContent().catch(() => null);
  if (!/^Edited by bob · /.test(editedBy ?? "")) throw new Error(`corner says ${editedBy}`);
  console.log(`ok  the page's corner says "${editedBy}"`);
  await ctxA.close();
  await ctxB.close();
  console.log("PASS");
} finally {
  await browser.close();
  for (const k of kids) k.kill("SIGTERM");
  await sleep(300);
  rmSync(scratch, { recursive: true, force: true });
}
