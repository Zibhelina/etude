import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { choose, collectionPath, lastError, samePath, usualPort } from "../desktop/find.ts";
import { parseShellEnv } from "../desktop/shell-env.ts";

test("desktop: the collection is the one the CLI would open", () => {
  assert.equal(collectionPath({}), join(homedir(), ".etude", "etude.db"));
  assert.equal(collectionPath({ ETUDE_HOME: "/data/etude" }), resolve("/data/etude", "etude.db"));
  assert.equal(collectionPath({ ETUDE_HOME: "/data/etude", ETUDE_DB: "/elsewhere/x.db" }), resolve("/elsewhere/x.db"));
  assert.equal(usualPort({}), 4610);
  assert.equal(usualPort({ ETUDE_PORT: "4700" }), 4700);
});

test("desktop: an engine is reused only when it opens this same collection", () => {
  const mine = "/home/ana/.etude/etude.db";
  assert.deepEqual(choose({ kind: "etude", db: mine, version: "2.5.0" }, mine), { reuse: true });
  // Another account's engine, or another collection: start our own beside it.
  assert.deepEqual(choose({ kind: "etude", db: "/home/bia/.etude/etude.db", version: "2.5.0" }, mine), { reuse: false, port: "any" });
  // Something else on the port, or an engine with a password (it answers 401).
  assert.deepEqual(choose({ kind: "other" }, mine), { reuse: false, port: "any" });
  assert.deepEqual(choose({ kind: "free" }, mine), { reuse: false, port: "usual" });
  assert.ok(samePath("/Users/Ana/.etude/etude.db", "/users/ana/.etude/etude.db", "darwin"));
  assert.ok(!samePath("/home/Ana/.etude/etude.db", "/home/ana/.etude/etude.db", "linux"));
});

test("desktop: the error page shows the engine's own error line", () => {
  const out = "node:internal/modules/package_json_reader:331\n  throw new ERR_MODULE_NOT_FOUND(packageName)\n        ^\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'hash-wasm'\n    at resolve (node:internal)\n\nNode.js v24.22.1\n";
  assert.equal(lastError(out), "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'hash-wasm'");
  assert.equal(lastError("listening\n"), "listening");
  assert.equal(lastError(""), null);
});

test("desktop: the login shell's environment is read between the marks, whatever the shell printed around it", () => {
  const env = { PATH: "/opt/homebrew/bin:/usr/bin", ETUDE_HOME: "/data/etude", ELECTRON_RUN_AS_NODE: "1", SHLVL: "2" };
  const got = parseShellEnv(`Welcome back!\n__ETUDE_ENV__${JSON.stringify(env)}__ETUDE_ENV__\nbye`);
  assert.deepEqual(got, { PATH: "/opt/homebrew/bin:/usr/bin", ETUDE_HOME: "/data/etude" });
  assert.equal(parseShellEnv("no marks here"), null);
  assert.equal(parseShellEnv("__ETUDE_ENV__{broken__ETUDE_ENV__"), null);
});
