/**
 * SQLite compiled to WebAssembly (@sqlite.org/sqlite-wasm) behind the same shape as node:sqlite.
 *
 * The database lives in WebAssembly memory. A `persist` hook decides where its bytes go after each
 * committed write: a file under Node (so the test suite can run the whole core on this driver),
 * OPFS in a browser (added with the browser storage layer).
 */
import type { SqlConnection, SqlRunResult, SqlStatement, SqlValue } from "./sql.ts";

type Sqlite3 = any;
let sqlite3: Promise<Sqlite3> | null = null;

let loaded: Sqlite3 | null = null;

/** Loads the WebAssembly module once per process (about 40 ms). */
export function loadSqliteWasm(): Promise<Sqlite3> {
  if (!sqlite3) {
    sqlite3 = import("@sqlite.org/sqlite-wasm").then(async (m: any) => (loaded = await m.default({ print: () => {}, printErr: () => {} })));
  }
  return sqlite3;
}

/**
 * Opens an SQLite file image in memory, synchronously (the module must already be loaded, which
 * opening a collection on this driver does). `patch` runs first with the schema writable, for
 * files whose schema needs fixing before it can be read (Anki's `COLLATE unicase`).
 */
export function openImageSync(bytes: Uint8Array, patch?: string): SqlConnection {
  if (!loaded) throw new Error("the SQLite WebAssembly module isn't loaded yet");
  const conn = new WasmConnection(loaded, { bytes });
  if (patch) {
    const db = (conn as any).db;
    loaded.capi.sqlite3_db_config(db.pointer, loaded.capi.SQLITE_DBCONFIG_DEFENSIVE, 0, 0);
    db.exec("PRAGMA writable_schema = ON;" + patch + "PRAGMA writable_schema = OFF;");
    // The schema change only takes effect for statements compiled after a reload of it.
    db.exec("PRAGMA schema_version = " + (Number(db.selectValue("PRAGMA schema_version")) + 1));
  }
  return conn;
}

export interface WasmOptions {
  /** The collection's bytes to start from (an existing file). */
  bytes?: Uint8Array | null;
  /** Called with the whole database after each write that leaves no transaction open. */
  persist?: (bytes: Uint8Array) => void;
}

/** Same message node:sqlite gives ("UNIQUE constraint failed: t.a"), so callers and tests see one error text. */
function sqlError(s: Sqlite3, db: any, e: unknown): Error {
  const msg = db.pointer ? s.capi.sqlite3_errmsg(db.pointer) : null;
  const err = new Error(msg && msg !== "not an error" ? msg : e instanceof Error ? e.message : String(e));
  (err as any).code = "ERR_SQLITE_ERROR";
  if (db.pointer) (err as any).errcode = s.capi.sqlite3_extended_errcode(db.pointer);
  return err;
}

class WasmStatement implements SqlStatement {
  private readonly conn: WasmConnection;
  private readonly sql: string;
  constructor(conn: WasmConnection, sql: string) {
    this.conn = conn;
    this.sql = sql;
  }

  private step<T>(params: SqlValue[], collect: (stmt: any) => T): T {
    return this.conn.withStatement(this.sql, (stmt) => {
      if (params.length) stmt.bind(params.map(bindable));
      return collect(stmt);
    });
  }

  all(...params: SqlValue[]): unknown[] {
    return this.step(params, (stmt) => {
      const rows: unknown[] = [];
      while (stmt.step()) rows.push(row(stmt));
      return rows;
    });
  }

  get(...params: SqlValue[]): unknown {
    return this.step(params, (stmt) => (stmt.step() ? row(stmt) : undefined));
  }

  run(...params: SqlValue[]): SqlRunResult {
    const out = this.step(params, (stmt) => {
      while (stmt.step()) {}
      return this.conn.counts();
    });
    this.conn.afterWrite();
    return out;
  }
}

/** node:sqlite refuses booleans and undefined; so does this driver, with the same wording. */
function bindable(v: SqlValue, i: number): unknown {
  if (v === null || typeof v === "number" || typeof v === "bigint" || typeof v === "string" || v instanceof Uint8Array) return v;
  throw new TypeError(`Provided value cannot be bound to SQLite parameter ${i + 1}.`);
}

/** A row as node:sqlite returns it: a null-prototype object; blobs as Uint8Array, integers as numbers. */
function row(stmt: any): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  const n = stmt.columnCount;
  for (let i = 0; i < n; i++) {
    let v = stmt.get(i);
    if (typeof v === "bigint") {
      if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new RangeError(`Value is too large to be represented as a JavaScript number: ${v}`);
      }
      v = Number(v);
    }
    out[stmt.getColumnName(i)] = v;
  }
  return out;
}

class WasmConnection implements SqlConnection {
  private readonly s: Sqlite3;
  private readonly db: any;
  private readonly persist?: (bytes: Uint8Array) => void;
  private dirty = false;

  constructor(s: Sqlite3, opts: WasmOptions & { db?: any }) {
    this.s = s;
    this.db = opts.db ?? new s.oo1.DB(":memory:", "c");
    this.persist = opts.persist;
    if (opts.bytes && opts.bytes.length) this.load(opts.bytes);
  }

  /** Replaces the in-memory database with these bytes (an SQLite file image). */
  private load(bytes: Uint8Array) {
    const { capi, wasm } = this.s;
    // Header bytes 18-19 say "WAL" (2) for a file node:sqlite wrote; SQLite can't open that from
    // memory, so mark the image as a rollback-journal database (1). The pages are the same.
    if (bytes[18] === 2 || bytes[19] === 2) {
      bytes = bytes.slice();
      bytes[18] = 1;
      bytes[19] = 1;
    }
    const p = wasm.allocFromTypedArray(bytes);
    const flags = capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE;
    const rc = capi.sqlite3_deserialize(this.db.pointer, "main", p, bytes.length, bytes.length, flags);
    if (rc) throw sqlError(this.s, this.db, new Error(`could not load the database (sqlite rc ${rc})`));
    this.db.exec("PRAGMA journal_mode = MEMORY;");
  }

  withStatement<T>(sql: string, fn: (stmt: any) => T): T {
    let stmt: any;
    try {
      stmt = this.db.prepare(sql);
    } catch (e) {
      throw sqlError(this.s, this.db, e);
    }
    try {
      return fn(stmt);
    } catch (e) {
      if (e instanceof TypeError || e instanceof RangeError) throw e;
      throw sqlError(this.s, this.db, e);
    } finally {
      stmt.finalize();
    }
  }

  counts(): SqlRunResult {
    const { capi } = this.s;
    return { changes: capi.sqlite3_changes(this.db.pointer), lastInsertRowid: Number(capi.sqlite3_last_insert_rowid(this.db.pointer)) };
  }

  exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (e) {
      throw sqlError(this.s, this.db, e);
    }
    this.afterWrite();
  }

  prepare(sql: string): SqlStatement {
    // Compile now so a bad query fails here, the way node:sqlite does.
    this.withStatement(sql, () => undefined);
    return new WasmStatement(this, sql);
  }

  function(name: string, options: { deterministic?: boolean }, fn: (...args: any[]) => SqlValue): void {
    this.db.createFunction({
      name,
      deterministic: !!options.deterministic,
      // The wrapper's own arity would be 0; SQLite must see the function's real one (-1 = any).
      arity: fn.length || -1,
      xFunc: (_ctx: number, ...args: unknown[]) => fn(...args),
    });
  }

  /** Writes the database out once no transaction is open. */
  afterWrite() {
    this.dirty = true;
    if (!this.persist) return;
    if (!this.s.capi.sqlite3_get_autocommit(this.db.pointer)) return;
    this.flush();
  }

  flush() {
    if (!this.persist || !this.dirty || !this.db.pointer) return;
    this.dirty = false;
    this.persist(this.s.capi.sqlite3_js_db_export(this.db.pointer));
  }

  /** The whole database as an SQLite file image. */
  serialize(): Uint8Array {
    return this.s.capi.sqlite3_js_db_export(this.db.pointer);
  }

  /** `ATTACH` for an image in memory: there are no files for ATTACH to open here. */
  attachImage(schema: string, bytes: Uint8Array) {
    this.db.exec(`ATTACH DATABASE ':memory:' AS "${schema.replace(/"/g, '""')}"`);
    const { capi, wasm } = this.s;
    const p = wasm.allocFromTypedArray(bytes);
    const flags = capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE;
    const rc = capi.sqlite3_deserialize(this.db.pointer, schema, p, bytes.length, bytes.length, flags);
    if (rc) throw sqlError(this.s, this.db, new Error(`could not attach the image (sqlite rc ${rc})`));
  }

  close(): void {
    if (!this.db.pointer) return;
    this.flush();
    this.db.close();
  }
}

export async function createWasmConnection(opts: WasmOptions = {}): Promise<SqlConnection> {
  return new WasmConnection(await loadSqliteWasm(), opts);
}

const inBrowser = () => typeof process === "undefined" || !process.versions?.node;
let opfsPool: Promise<any> | null = null;

/**
 * The pool holds exclusive handles on its OPFS files. Right after a reload the previous page's
 * worker may still hold them for a moment, so wait for it (up to ~10 s) instead of failing.
 */
async function installPool(s: Sqlite3): Promise<any> {
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      // preserveOnInitFailure: without it, a failed start (the old tab's worker still holding the
      // files) deletes the pool's storage, which is the whole collection.
      return await s.installOpfsSAHPoolVfs({
        name: "etude-opfs",
        directory: "/etude-sqlite",
        initialCapacity: 8,
        preserveOnInitFailure: true,
        forceReinitIfPreviouslyFailed: i > 0,
        // Quiet: while the old worker still holds the files, each try logs NoModificationAllowedError.
        // A real failure is thrown below after the last try.
        verbosity: 0,
      });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, Math.min(100 + i * 50, 500)));
    }
  }
  opfsPool = null;
  throw new Error(`couldn't open the collection storage (is Etude open in another tab?): ${last}`);
}

/**
 * In a browser (a worker): the collection is a real SQLite file in OPFS, through SQLite's
 * "opfs-sahpool" VFS, so each commit writes only the pages it changed.
 */
async function openOpfs(path: string): Promise<SqlConnection> {
  const s = await loadSqliteWasm();
  opfsPool ??= installPool(s);
  const pool = await opfsPool;
  const db = new pool.OpfsSAHPoolDb(path);
  db.exec("PRAGMA journal_mode = DELETE;");
  return new WasmConnection(s, { db });
}

/** A collection file: OPFS in a browser; under Node, kept in WebAssembly memory and written back after every commit. */
export async function openWasm(path: string): Promise<SqlConnection> {
  if (path === ":memory:") return createWasmConnection();
  if (inBrowser()) return openOpfs(path);
  const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(path), { recursive: true });
  // node:sqlite may have left WAL sidecar files; fold them in before reading the main file.
  if (existsSync(path + "-wal")) {
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(path);
    d.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
    d.close();
  }
  const bytes = existsSync(path) ? readFileSync(path) : null;
  return createWasmConnection({
    bytes: bytes ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null,
    persist: (b) => {
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, b);
      renameSync(tmp, path);
      rmSync(path + "-wal", { force: true });
      rmSync(path + "-shm", { force: true });
    },
  });
}
