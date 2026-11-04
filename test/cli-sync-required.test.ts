import { test } from "node:test";
import assert from "node:assert/strict";
import { errorCode } from "../src/cli/run.ts";
import { EXIT_CODES } from "../src/cli/registry.ts";
import { AccountError } from "../src/core/account.ts";

test("sync_required from the Sync server is its own exit code, not a bug", () => {
  assert.deepEqual(EXIT_CODES.find((c) => c.code === "sync_required")?.exit, 7);
  // What CloudTransport throws on the server's 402 (sync now, push, pull).
  const fromTransport = Object.assign(new Error("Etude Sync needs an active subscription. Your local data is untouched."), { code: "sync_required" });
  const a = errorCode(fromTransport);
  assert.equal(a.code, "sync_required");
  assert.equal(a.exit, 7);
  assert.match(a.message, /needs an active subscription.*etude account status/);
  // The same code through the account API.
  const b = errorCode(new AccountError("Etude Sync needs an active subscription.", 402, "sync_required"));
  assert.equal(b.exit, 7);
  // Other failures keep their codes.
  assert.equal(errorCode(new Error("boom")).exit, 1);
  assert.equal(errorCode(new AccountError("no such deck", 404, "not_found")).exit, 3);
});
