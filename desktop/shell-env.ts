// Apps opened from the Dock or a launcher don't get the settings a terminal has (PATH, ETUDE_HOME,
// API keys exported in ~/.zshrc). Ask the login shell once, the way a terminal would start, so the
// engine finds `gh`, a custom collection folder and the rest just as `etude serve` would.
import { spawn } from "node:child_process";

const MARK = "__ETUDE_ENV__";
const DROP = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "SHLVL", "PWD", "OLDPWD", "_"];

/** The environment printed between the two marks, or null if the output doesn't hold one. */
export function parseShellEnv(output: string): Record<string, string> | null {
  const start = output.indexOf(MARK);
  const end = output.indexOf(MARK, start + MARK.length);
  if (start < 0 || end < 0) return null;
  try {
    const env = JSON.parse(output.slice(start + MARK.length, end));
    if (!env || typeof env !== "object") return null;
    for (const k of DROP) delete env[k];
    return env;
  } catch {
    return null;
  }
}

/**
 * The login shell's environment, or null when there's no need (Windows, or started from a terminal,
 * which already passed its own) or the shell didn't answer within the timeout.
 */
export function loginShellEnv(timeoutMs = 10_000): Promise<Record<string, string> | null> {
  if (process.platform === "win32" || process.env.TERM || process.execPath.includes("'")) return Promise.resolve(null);
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  // This same program, in Node mode, prints the environment the shell set up.
  const print = `'${process.execPath}' -e 'process.stdout.write("${MARK}" + JSON.stringify(process.env) + "${MARK}")'`;
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawn(shell, ["-ilc", print], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" }, stdio: ["ignore", "pipe", "ignore"], detached: true });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      done(null);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.on("error", () => (clearTimeout(timer), done(null)));
    child.on("close", () => (clearTimeout(timer), done(parseShellEnv(out))));
  });
}
