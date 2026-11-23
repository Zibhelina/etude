import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasWebPortal, storageNote, storeSource } from "../web/src/lib/billing-ui.ts";

const sync = readFileSync(new URL("../web/src/components/settings-sync.tsx", import.meta.url), "utf8");

test("Sync storage: no fake 0 KB when the server gave no number", () => {
  assert.equal(storageNote({ offline: null }, false), "shown while Sync is active");
  assert.equal(storageNote({ offline: "ECONNREFUSED" }, false), "the server can't be reached right now");
  assert.equal(storageNote({ offline: null }, true), "the server didn't say how much is used");
  assert.doesNotMatch(sync, /st\.vault\?\.usedBytes \?\? 0/);
  assert.match(sync, /used == null \?/);
  assert.match(sync, /data-storage="unknown"/);
});

test("Manage subscription: only a website (Polar) subscription has a portal", () => {
  assert.equal(hasWebPortal({ source: "polar", status: "active" }), true);
  assert.equal(hasWebPortal({ source: "manual", status: "active" }), false);
  assert.equal(hasWebPortal({ source: "apple", status: "active" }), false);
  assert.equal(hasWebPortal({ source: "google", status: "active" }), false);
  assert.equal(hasWebPortal({ source: "stripe", status: "active" }), false);
  assert.equal(hasWebPortal({ source: null, status: null }), false);
  // A server from before App Store support sends no source; everything there was Polar.
  assert.equal(hasWebPortal({ status: "active" }), true);
  assert.equal(hasWebPortal(null), false);
  assert.match(sync, /purchases && hasWebPortal\(b\) &&/);
  assert.equal(storeSource({ source: "manual" }), null);
  assert.match(storeSource({ source: "apple" }) ?? "", /Apple account/);
});

test("Checkout flow: opens tab synchronously via openOutsideAsync and renders a fallback checkout link", () => {
  const onboarding = readFileSync(new URL("../web/src/components/onboarding.tsx", import.meta.url), "utf8");
  assert.match(sync, /openOutsideAsync\(/);
  assert.match(sync, /data-checkout-link/);
  assert.match(sync, /canShowPurchases\(\)[\s\S]{0,200}US\$5\/month or US\$40\/year/);
  assert.match(onboarding, /openOutsideAsync\(/);
  assert.match(onboarding, /data-checkout-link/);
});
