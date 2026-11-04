import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { storageNote } from "../web/src/lib/billing-ui.ts";

const sync = readFileSync(new URL("../web/src/components/settings-sync.tsx", import.meta.url), "utf8");

test("Sync storage: no fake 0 KB when the server gave no number", () => {
  assert.equal(storageNote({ offline: null }, false), "shown while Sync is active");
  assert.equal(storageNote({ offline: "ECONNREFUSED" }, false), "the server can't be reached right now");
  assert.equal(storageNote({ offline: null }, true), "the server didn't say how much is used");
  assert.doesNotMatch(sync, /st\.vault\?\.usedBytes \?\? 0/);
  assert.match(sync, /used == null \?/);
  assert.match(sync, /data-storage="unknown"/);
});
