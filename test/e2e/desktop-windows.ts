// The desktop app's New window: from the right-click menu, from a tab's menu and from File, each window with tabs of
// its own that survive its reload and don't leak into the others, and `etude view` answered by the window used last.
// The real Electron app (desktop/) on a scratch collection, its own engine and its own app data, headless. Not part
// of `npm test`. From an etude2 worktree:
//   npm run build && node test/e2e/desktop-windows.ts [<screenshot dir>]
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Etude } from "../../src/core/engine.ts";
import { run } from "../../src/cli/run.ts";
const require = createRequire(join(process.env.PLAYWRIGHT_FROM ?? process.cwd(), "package.json"));
const { _electron } = require("playwright-core");

const WT = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "desktop-windows-"));
const SHOTS = process.argv[2] ?? join(scratch, "shots");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const db = join(scratch, "etude.db");
const env = { ...process.env, ETUDE_HOME: scratch, ETUDE_PORT: String(port), XDG_CONFIG_HOME: join(scratch, "config") } as Record<string, string>;
delete env.ETUDE_DB;
const cli = async (...argv: string[]) => {
  let out = "", err = "";
  const code = await run(["--db", db, ...argv, "--json"], { stdout: (x) => (out += x), stderr: (x) => (err += x), stdin: () => "", isTTY: false, env });
  return { code, json: out.trim() ? JSON.parse(out) : null, err };
};
const ids: Record<string, string> = {};
{
  const e = await Etude.open(db, { home: scratch });
  e.updateSettings({ onboarding: { ...e.settings().onboarding, done: true } });
  e.close();
  for (const [k, t] of [["a", "Lecture one"], ["b", "Reading list"], ["c", "Problem set"], ["d", "Formula sheet"], ["e", "Old exams"]]) ids[k] = (await cli("note", "new", t, "--text", "Hi.")).json.id;
}

const app = await _electron.launch({
  executablePath: join(WT, "desktop/node_modules/electron/dist/electron"),
  args: ["--ozone-platform=headless", join(WT, "desktop")],
  env,
  cwd: join(WT, "desktop"),
});
let failed = false;
try {
  const errors: string[] = [];
  const watch = (p: any) => p.on("pageerror", (e: Error) => errors.push(e.message));
  const w1 = await app.firstWindow();
  watch(w1);
  // The engine first (starting page), then Etude.
  for (let i = 0; i < 200 && !/127\.0\.0\.1/.test(w1.url()); i++) await sleep(150);
  await w1.waitForLoadState();
  // A headless screen is tiny; the new windows take this size from the one in front.
  await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
  await w1.evaluate((id: string) => (history.pushState(null, "", `/notes?id=${id}`), dispatchEvent(new PopStateEvent("popstate"))), ids.a);
  await w1.getByText("Skip", { exact: true }).click({ timeout: 2500 }).catch(() => {});
  // A window's tabs, from the layout it keeps (the tab bar hides itself with one tab).
  const tabsOf = (p: any): Promise<string[]> =>
    p.evaluate(() => {
      const store = sessionStorage.getItem("etude.window") === "extra" ? sessionStorage : localStorage;
      const out: string[] = [];
      const walk = (n: any) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n.tabs)) out.push(...n.tabs);
        for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
      };
      walk(JSON.parse(store.getItem("etude.notes.layout") ?? "null"));
      return out;
    });
  /** A new window has read its ?window= (and dropped it from the address). */
  const settled = async (p: any) => {
    await p.waitForLoadState();
    for (let i = 0; i < 200 && /[?&](window|token)=/.test(p.url()); i++) await sleep(100);
    assert.ok(!/[?&]window=/.test(p.url()), `${p.url()} kept ?window=`);
  };
  const hasTab = async (p: any, id: string) => {
    for (let i = 0; i < 100; i++) {
      if ((await tabsOf(p)).includes(id)) return;
      await sleep(150);
    }
    throw new Error(`no tab ${id} in ${p.url()}: ${await tabsOf(p)}`);
  };
  const title = (p: any, t: string) => p.locator("[data-pane] .note-title", { hasText: t }).first().waitFor();
  await hasTab(w1, ids.a);

  // Right-click outside a page (the app's own menu, as on an empty spot): New window.
  await w1.evaluate(() => document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 300, button: 2 })));
  const item = w1.getByRole("menuitem", { name: /New window/ });
  await item.waitFor();
  await w1.screenshot({ path: join(SHOTS, "1-menu.png") });
  const [w2] = await Promise.all([app.waitForEvent("window"), item.click()]);
  watch(w2);
  await settled(w2);
  for (let i = 0; i < 100 && !(await tabsOf(w2)).length; i++) await sleep(150);
  let t2 = await tabsOf(w2);
  assert.equal(t2.length, 1, `the new window should start with one tab, has ${t2}`);
  assert.match(t2[0], /^new:/, "the new window's tab is a New tab");
  assert.ok(!new URL(w2.url()).searchParams.has("window"), "?window= left the address");
  await w2.screenshot({ path: join(SHOTS, "2-new-window.png") });

  // A page in the second window stays there: the first doesn't get it, before or after either reloads.
  await w2.evaluate((id: string) => (history.pushState(null, "", `/notes?id=${id}`), dispatchEvent(new PopStateEvent("popstate"))), ids.b);
  await hasTab(w2, ids.b);
  await w1.reload();
  await hasTab(w1, ids.a);
  assert.ok(!(await tabsOf(w1)).includes(ids.b), "the first window got the second's tab after a reload");
  await w2.reload();
  await hasTab(w2, ids.b);
  assert.ok(!(await tabsOf(w2)).includes(ids.a), "the second window got the first's tab after a reload");

  await title(w1, "Lecture one");
  await title(w2, "Reading list");
  // A tab's own menu: Open in new window, with that page. (A second tab makes the tab bar show.)
  await w1.locator(".note-tab-plus").first().click();
  await w1.evaluate((id: string) => (history.pushState(null, "", `/notes?id=${id}`), dispatchEvent(new PopStateEvent("popstate"))), ids.e);
  await hasTab(w1, ids.e);
  await hasTab(w1, ids.a);
  await w1.locator(`.note-tab[data-tab="${ids.a}"]`).click({ button: "right" });
  const open = w1.getByText("Open in new window", { exact: true });
  await open.waitFor();
  const [w3] = await Promise.all([app.waitForEvent("window"), open.click()]);
  watch(w3);
  await settled(w3);
  await hasTab(w3, ids.a);
  t2 = await tabsOf(w3);
  assert.deepEqual(t2, [ids.a], `the tab's new window should hold only that page, has ${t2}`);
  assert.equal((await app.windows()).length, 3);

  // File → New Window (the menu's own path, as Ctrl+Shift+N runs it).
  const [w4] = await Promise.all([
    app.waitForEvent("window"),
    app.evaluate(({ Menu }: any) => Menu.getApplicationMenu().items.find((i: any) => i.label === "File").submenu.items.find((i: any) => i.label === "New Window").click()),
  ]);
  await settled(w4);
  for (let i = 0; i < 100 && !(await tabsOf(w4)).some((t) => t.startsWith("new:")); i++) await sleep(150);
  assert.equal((await tabsOf(w4)).length, 1);
  await w4.close();

  // `etude view`: the window that took the focus last answers.
  await w3.evaluate(() => dispatchEvent(new Event("focus")));
  await sleep(500);
  let v = await cli("view", "show");
  for (let i = 0; i < 30 && !JSON.stringify(v.json).includes(ids.a); i++) await sleep(200), (v = await cli("view", "show"));
  assert.ok(JSON.stringify(v.json?.view ?? v.json).includes(ids.a), "view show should report the third window");
  const opened = await cli("view", "open", ids.c);
  assert.equal(opened.code, 0, opened.err);
  await hasTab(w3, ids.c);
  await sleep(800);
  assert.ok(!(await tabsOf(w2)).includes(ids.c), "a view command ran in a window that wasn't answering");
  // Closing the answering window hands it to another.
  // Closed the way the window's own close button does it (Playwright's page.close skips the page's pagehide).
  const closeWindow = (p: any) => app.evaluate(({ BrowserWindow }: any, url: string) => BrowserWindow.getAllWindows().find((w: any) => w.webContents.getURL() === url)?.close(), p.url());
  await closeWindow(w3);
  await sleep(600);
  const again = await cli("view", "open", ids.d);
  assert.equal(again.code, 0, again.err);
  await sleep(800);
  const where = [(await tabsOf(w1)).includes(ids.d), (await tabsOf(w2)).includes(ids.d)].filter(Boolean).length;
  assert.equal(where, 1, `after the answering window closed, ${where} windows took the command`);

  // Closing the main window leaves the app running with the other.
  await closeWindow(w1);
  await sleep(800);
  assert.equal((await app.windows()).length, 1, "the app should keep the second window");
  await title(w2, "Reading list");
  await w2.screenshot({ path: join(SHOTS, "3-after-main-closed.png") });

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log(`ok desktop windows (screenshots in ${SHOTS})`);
} catch (e) {
  failed = true;
  console.error(e);
  for (const [i, w] of (await app.windows()).entries()) {
    console.error(`window ${i + 1}: ${w.url()}`);
    await w.screenshot({ path: join(SHOTS, `fail-${i + 1}.png`) }).catch(() => {});
  }
} finally {
  await app.close().catch(() => {});
}
process.exit(failed ? 1 : 0);
