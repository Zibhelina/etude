// Two log files in the system's log folder (Help → Show Logs): main.log for the app, engine.log for
// what the engine prints. Each starts over once it passes 2 MB, keeping the previous one as .old.
import { app } from "electron";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;

export const logDir = () => app.getPath("logs");

function file(name: string): string {
  const dir = logDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  try {
    if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, path + ".old");
  } catch {}
  return path;
}

let mainLog: string | null = null;
let engineLog: string | null = null;

export function log(line: string) {
  const text = `${new Date().toISOString()} ${line}\n`;
  if (!app.isPackaged) process.stdout.write(text);
  try {
    appendFileSync((mainLog ??= file("main.log")), text);
  } catch {}
}

export function logEngine(chunk: string) {
  if (!app.isPackaged) process.stdout.write(chunk.replace(/^(?=.)/gm, "[engine] "));
  try {
    appendFileSync((engineLog ??= file("engine.log")), chunk);
  } catch {}
}
