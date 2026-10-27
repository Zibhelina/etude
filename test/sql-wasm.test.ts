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
