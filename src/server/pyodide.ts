// Pyodide (Python in the browser) for runnable code blocks in Notes. The interpreter's files ship in
// node_modules/pyodide; a package is downloaded from Pyodide's CDN the first time a block imports it, checked
// against the sha256 in pyodide-lock.json and kept under $ETUDE_HOME/pyodide/<version>/. Only names that are in
// the lock file are ever fetched, so the route can't be used to reach anything else.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const CORE = new Set(["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]);

let dir: string | null | undefined;
let lock: { version: string; files: Map<string, string> } | null = null;
const pending = new Map<string, Promise<string | null>>();

function pyodideDir(): string | null {
  if (dir !== undefined) return dir;
  try {
    dir = dirname(require.resolve("pyodide/package.json"));
  } catch {
    dir = null;
  }
  return dir;
}

function readLock() {
  if (lock) return lock;
  const d = pyodideDir();
  if (!d) return null;
  const version = JSON.parse(readFileSync(join(d, "package.json"), "utf8")).version as string;
  const l = JSON.parse(readFileSync(join(d, "pyodide-lock.json"), "utf8")) as { packages: Record<string, { file_name: string; sha256: string }> };
  lock = { version, files: new Map(Object.values(l.packages).map((p) => [p.file_name, p.sha256])) };
  return lock;
}

/** The file to serve for /runtime/pyodide/<name>, downloading a package the first time; null when there's none. */
export async function pyodideFile(name: string, home: string): Promise<string | null> {
  if (!/^[\w.+-]+$/.test(name)) return null;
  const d = pyodideDir();
  if (!d) return null;
  if (CORE.has(name)) return existsSync(join(d, name)) ? join(d, name) : null;
  const l = readLock();
  const sha = l?.files.get(name);
  if (!l || !sha) return null;
  const cache = join(home, "pyodide", l.version);
  const path = join(cache, name);
  if (existsSync(path)) return path;
  let p = pending.get(name);
  if (!p) {
    p = (async () => {
      const res = await fetch(`https://cdn.jsdelivr.net/pyodide/v${l.version}/full/${name}`, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== sha) return null;
      mkdirSync(cache, { recursive: true });
      const temp = join(cache, `.${name}-${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, bytes, { flag: "wx" });
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
      return path;
    })()
      .catch(() => null)
      .finally(() => pending.delete(name));
    pending.set(name, p);
  }
  return p;
}
