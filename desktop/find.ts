// Finding the engine: which collection, which port, and whether the engine already running there can
// be reused. No Electron here, so the tests and the repo's type check run without it installed.
import { createServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Where `etude serve` listens unless told otherwise: $ETUDE_PORT, else 4610. */
export const usualPort = (env: Record<string, string | undefined>) => Number(env.ETUDE_PORT) || 4610;

/** The collection the CLI opens: $ETUDE_DB, else $ETUDE_HOME/etude.db, else ~/.etude/etude.db. */
export function collectionPath(env: Record<string, string | undefined>): string {
  const home = resolve(env.ETUDE_HOME ?? join(homedir(), ".etude"));
  return resolve(env.ETUDE_DB ?? join(home, "etude.db"));
}

/** Mac and Windows file names ignore case. */
export function samePath(a: string, b: string, platform: string = process.platform): boolean {
  const norm = (p: string) => (platform === "darwin" || platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

export type Probe = { kind: "free" } | { kind: "etude"; db: string; version: string } | { kind: "other" };

/** What answers on this port: nothing, an Etude engine (and which collection it has open), or anything else. */
export async function probe(port: number, token?: string): Promise<Probe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { kind: "other" };
    const body = (await res.json().catch(() => null)) as { dbPath?: unknown; version?: unknown } | null;
    return typeof body?.dbPath === "string" ? { kind: "etude", db: body.dbPath, version: String(body.version ?? "") } : { kind: "other" };
  } catch (e) {
    return (e as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED" ? { kind: "free" } : { kind: "other" };
  }
}

/**
 * Reuse the engine on the usual port only if it opens this same collection: another account's
 * engine, or one with a password, is someone else's. Otherwise start one, on the usual port if free.
 */
export function choose(found: Probe, collection: string): { reuse: true } | { reuse: false; port: "usual" | "any" } {
  if (found.kind === "etude" && samePath(found.db, collection)) return { reuse: true };
  return { reuse: false, port: found.kind === "free" ? "usual" : "any" };
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => done(port));
    });
  });
}

/** The line of the engine's output that says what went wrong, for the error page. */
export function lastError(output: string): string | null {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = [...lines].reverse().find((l) => /error/i.test(l)) ?? lines.at(-1);
  return line ? line.slice(0, 300) : null;
}
