// After desktop/build.ts: the packaged app, copied to an empty folder outside the repo (where a
// missing package can't be found in the repo's own node_modules), runs its engine and its etude
// command. Exits non-zero on the first thing that fails.
//
//   node desktop/smoke.ts
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "dist", "out");
const version: string = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version;

const layouts = {
  linux: { from: "linux-unpacked", exe: "etude-desktop", resources: "resources" },
  win32: { from: "win-unpacked", exe: "Etude.exe", resources: "resources" },
  darwin: { from: join(process.arch === "arm64" ? "mac-arm64" : "mac", "Etude.app"), exe: join("Contents", "MacOS", "Etude"), resources: join("Contents", "Resources") },
} as const;
const layout = layouts[process.platform as keyof typeof layouts];
if (!layout) throw new Error(`no packaged app for ${process.platform}`);

const scratch = mkdtempSync(join(tmpdir(), "etude-smoke-"));
const appDir = join(scratch, "Etude");
cpSync(join(OUT, layout.from), appDir, { recursive: true, verbatimSymlinks: true });
const exe = join(appDir, layout.exe);
const app = join(appDir, layout.resources, "app");
const env = { ...process.env, ETUDE_HOME: join(scratch, "home"), ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1" };
const etude = (...args: string[]) => execFileSync(exe, [join(app, "bin", "etude.js"), ...args], { env, encoding: "utf8" });

function check(what: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exit(1);
}

check(`the app's Node runs the CLI (${version})`, JSON.parse(etude("version")).version === version);
check("a pack imports", JSON.parse(etude("pack", "import", join(app, "examples", "showcase.pack.json"), "--compact"))[0].decks > 0);

const port = 4699;
const server = spawn(exe, [join(app, "bin", "etude.js"), "serve", "--port", String(port)], { env, stdio: "inherit" });
const get = async (path: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, text: await res.text() };
};
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await get("/api/decks").then((r) => r.status === 200, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  check("the engine serves the API", up);
  check("the engine serves the web app", (await get("/")).text.includes('<div id="root"'));
  check("cards get KaTeX and marked", (await get("/runtime/vendor/katex.js")).status === 200 && (await get("/runtime/vendor/marked.js")).status === 200);
} finally {
  server.kill();
}

// The etude command as the packages install it.
const launcher = join(app, "desktop", "bin", process.platform === "win32" ? "etude.cmd" : "etude");
check("the etude launcher is there", existsSync(launcher));
const plainEnv: NodeJS.ProcessEnv = { ...env };
delete plainEnv.ELECTRON_RUN_AS_NODE;
const out =
  process.platform === "win32"
    ? execFileSync("cmd.exe", ["/d", "/c", launcher, "version"], { env: plainEnv, encoding: "utf8" })
    : execFileSync(launcher, ["version"], { env: plainEnv, encoding: "utf8" });
check("the etude command runs the app's engine", JSON.parse(out).version === version);

// Kept when something fails, to look into.
rmSync(scratch, { recursive: true, force: true });
