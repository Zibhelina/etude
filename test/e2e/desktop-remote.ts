// The desktop app opening another computer's Etude (`remote` in desktop.json, or $ETUDE_REMOTE): it shows that
// collection while it answers, says so when it stops answering, and uses this computer's own collection when it
// isn't there at the start. The real Electron app, headless; the "other computer" is `etude serve` on localhost
// (an origin that isn't 127.0.0.1 counts as another computer). Not part of `npm test`. From an etude2 worktree:
//   npm run build && node test/e2e/desktop-remote.ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Etude } from "../../src/core/engine.ts";
const require = createRequire(join(process.env.PLAYWRIGHT_FROM ?? process.cwd(), "package.json"));
const { _electron } = require("playwright-core");

const WT = resolve(import.meta.dirname, "../..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

// The other computer: its own collection, with a page this one doesn't have.
const there = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "desktop-remote-there-"));
const here = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "desktop-remote-here-"));
for (const [home, title] of [[there, "Only on the other computer"], [here, "Only on this computer"]]) {
  const e = await Etude.open(join(home, "etude.db"), { home });
  e.updateSettings({ onboarding: { ...e.settings().onboarding, done: true } });
  e.notes.create({ title, kind: "page" });
  e.close();
}
const port = await freePort();
let server: ChildProcess | null = null;
const serve = async () => {
  server = spawn(process.execPath, [join(WT, "src/cli/main.ts"), "--db", join(there, "etude.db"), "serve", "--port", String(port)], { cwd: WT, env: { ...process.env, ETUDE_HOME: there }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 100; i++) { if (await fetch(`http://127.0.0.1:${port}/api/notes`).then((r) => r.ok, () => false)) return; await sleep(150); }
  throw new Error("the other computer's Etude didn't start");
};
const launch = (remote: string) =>
  _electron.launch({
    executablePath: join(WT, "desktop/node_modules/electron/dist/electron"),
    args: ["--ozone-platform=headless", join(WT, "desktop")],
    env: Object.fromEntries(Object.entries({ ...process.env, ETUDE_HOME: here, ETUDE_PORT: String(port + 1), ETUDE_REMOTE: remote, XDG_CONFIG_HOME: join(here, "config") }).filter(([k]) => k !== "ETUDE_DB")),
    cwd: join(WT, "desktop"),
  });
// The engine this app starts has a password, which the page keeps (lib/transport.ts).
const titles = (w: any) =>
  w.evaluate(async () => {
    const t = localStorage.getItem("etude.token");
    return (await (await fetch("/api/notes", { headers: t ? { authorization: `Bearer ${t}` } : {} })).json()).map((n: any) => n.title);
  });

let failed = false;
let app: any = null;
try {
  await serve();
  // 1. The other computer answers: its collection, at its address.
  app = await launch(`http://localhost:${port}`);
  let w = await app.firstWindow();
  for (let i = 0; i < 200 && !w.url().startsWith(`http://localhost:${port}/`); i++) await sleep(100);
  assert.ok(w.url().startsWith(`http://localhost:${port}/`), `the window shows ${w.url()}`);
  await w.waitForLoadState();
  assert.ok((await titles(w)).includes("Only on the other computer"));
  // 2. It stops answering: the window says so (after a few misses, so a blink doesn't close it).
  server!.kill();
  for (let i = 0; i < 60 && !w.url().includes("error.html"); i++) await sleep(500);
  assert.match(w.url(), /error\.html/, "no error page after the other computer stopped");
  assert.match(decodeURIComponent(w.url().replace(/\+/g, " ")), /doesn.t answer/);
  await app.close();
  // 3. Not there at the start: this computer's own collection.
  app = await launch(`http://localhost:${port}`);
  w = await app.firstWindow();
  for (let i = 0; i < 300 && !/^http:\/\/127\.0\.0\.1:/.test(w.url()); i++) await sleep(100);
  assert.match(w.url(), /^http:\/\/127\.0\.0\.1:/, `the window shows ${w.url()}`);
  await w.waitForLoadState();
  assert.ok((await titles(w)).includes("Only on this computer"));
  console.log("ok desktop remote");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await app?.close().catch(() => {});
  (server as ChildProcess | null)?.kill();
}
process.exit(failed ? 1 : 0);
