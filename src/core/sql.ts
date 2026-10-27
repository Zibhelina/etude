/**
 * The SQLite connection the core talks to. `node:sqlite`'s DatabaseSync already has this shape;
 * `sql-wasm.ts` gives the same shape over SQLite compiled to WebAssembly, so the core runs in a browser.
 */

export type SqlValue = null | number | bigint | string | Uint8Array;

export interface SqlRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
  run(...params: SqlValue[]): SqlRunResult;
}

export interface SqlConnection {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  function(name: string, options: { deterministic?: boolean }, fn: (...args: any[]) => SqlValue): void;
  close(): void;
  /** WebAssembly only: the database as an SQLite file image (it has no file of its own). */
  serialize?(): Uint8Array;
  /** WebAssembly only: attach an SQLite file image under `schema`. */
  attachImage?(schema: string, bytes: Uint8Array): void;
}

export type SqlDriver = "node" | "wasm";

/** `ETUDE_SQL=wasm` runs the core on the WebAssembly build; the default is node:sqlite. */
export function defaultDriver(): SqlDriver {
  // Outside Node (a browser, a worker) only the WebAssembly build exists.
  if (typeof process === "undefined" || !process.versions?.node) return "wasm";
  return process.env.ETUDE_SQL === "wasm" ? "wasm" : "node";
}

/** Opens a collection file (or ":memory:") with the given driver. */
export async function openSql(path: string, driver: SqlDriver = defaultDriver()): Promise<SqlConnection> {
  if (driver === "wasm") {
    const { openWasm } = await import("./sql-wasm.ts");
    return openWasm(path);
  }
  const { openNode } = await import("./sql-node.ts");
  return openNode(path);
}
