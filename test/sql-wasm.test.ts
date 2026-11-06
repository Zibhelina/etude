import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWasm } from "../src/core/sql-wasm.ts";

// Under Node the wasm driver keeps the collection in memory and writes the file back after each
// commit. A second connection to the same file (the CLI next to an open collection) must not be
// invisible to the first, or the first overwrites its writes on its next commit.
test("wasm driver: two connections to one file see each other's writes and don't undo them", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-wasm-two-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "x.db");
  const a = await openWasm(path);
  a.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
  a.prepare("INSERT INTO t VALUES (?)").run("x");

  const b = await openWasm(path);
  b.prepare("DELETE FROM t WHERE id = ?").run("x");
  b.close();

  assert.deepEqual(a.prepare("SELECT id FROM t").all().map((r: any) => r.id), [], "a sees b's delete");
  a.prepare("INSERT INTO t VALUES (?)").run("y");
  a.close();

  const c = await openWasm(path);
  assert.deepEqual(c.prepare("SELECT id FROM t ORDER BY id").all().map((r: any) => r.id), ["y"], "x stays deleted");
  c.close();
});

// Db and the wasm driver keep compiled statements. A statement must come back clean after an
// error, keep the error's code, and work when SQL running inside it (an SQL function) asks for it again.
for (const driver of ["node", "wasm"] as const) {
  test(`${driver} driver: reused statements keep errors, bindings and nested use apart`, async () => {
    const { Db } = await import("../src/core/db.ts");
    const db = await Db.open(":memory:", driver);
    try {
      db.sql.exec("CREATE TABLE u (id TEXT PRIMARY KEY)");
      db.run("INSERT INTO u VALUES (?)", "a");
      assert.throws(() => db.run("INSERT INTO u VALUES (?)", "a"), (e: any) => e.code === "ERR_SQLITE_ERROR" && /UNIQUE/.test(e.message));
      db.run("INSERT INTO u VALUES (?)", "b");
      assert.deepEqual(db.all("SELECT id FROM u ORDER BY id").map((r) => r.id), ["a", "b"]);
      assert.equal(db.get("SELECT count(*) n FROM u WHERE id = ?", "a")!.n, 1);
      assert.equal(db.get("SELECT count(*) n FROM u WHERE id = ?", "zz")!.n, 0);
      db.sql.function("depth", { deterministic: false }, (n: any) => (Number(n) > 0 ? db.get("SELECT depth(?) + 1 AS v", Number(n) - 1)!.v : 0));
      assert.equal(db.get("SELECT depth(?) + 1 AS v", 3)!.v, 4);
      // A schema change recompiles what was cached for the table.
      db.sql.exec("ALTER TABLE u ADD COLUMN note TEXT DEFAULT 'x'");
      assert.deepEqual({ ...db.get("SELECT * FROM u WHERE id = ?", "a")! }, { id: "a", note: "x" });
    } finally {
      db.close();
    }
  });
}
