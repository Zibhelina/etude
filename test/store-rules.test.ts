import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { storeSafeMessage } from "../web/src/lib/platform.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the store apps reword the Sync server's purchase messages; desktop and web keep them", () => {
  const syncRequired = "Etude Sync needs an active subscription. Your local data is untouched.";
  assert.equal(storeSafeMessage(syncRequired, "sync_required", false), syncRequired);
  assert.equal(storeSafeMessage(syncRequired, "sync_required", true), "Sync isn't active on this account. Your local data is untouched.");
  // Sync run errors arrive without a code.
  assert.equal(storeSafeMessage(syncRequired, undefined, true), "Sync isn't active on this account. Your local data is untouched.");
  assert.equal(storeSafeMessage("Sync is paused: the subscription payment failed and the grace period is over.", null, true), "Sync is paused on this account. Your local data is untouched.");
  assert.equal(storeSafeMessage("Buy this deck to download it.", "not_owned", true), "This deck isn't on your account.");
  assert.equal(storeSafeMessage("Buy this deck to download it.", undefined, true), "This isn't available on this account.");
  // Anything that isn't about paying stays as the server wrote it.
  assert.equal(storeSafeMessage("couldn't reach https://sync.etude.study: fetch failed", "offline", true), "couldn't reach https://sync.etude.study: fetch failed");
  assert.equal(storeSafeMessage("That code expired. Ask for a new one.", "invalid_code", true), "That code expired. Ask for a new one.");
});

test("no native screen offers to subscribe on etude.study", () => {
  const onboarding = read("web/src/components/onboarding.tsx");
  assert.doesNotMatch(onboarding, /onDone\("subscribe on etude\.study"\)/);
  // The plan page (prices, Subscribe) is gated: the store apps check the account instead.
  assert.match(onboarding, /stage === "plan" && !canShowPurchases\(\)/);
});

test("the iOS project's version follows package.json", () => {
  const { version } = JSON.parse(read("package.json"));
  const [major, minor, patch] = version.split(".").map(Number);
  const pbx = read("ios/App/App.xcodeproj/project.pbxproj");
  assert.deepEqual([...new Set(pbx.match(/MARKETING_VERSION = [^;]+;/g))], [`MARKETING_VERSION = ${major}.${minor}.${patch};`]);
  assert.deepEqual([...new Set(pbx.match(/CURRENT_PROJECT_VERSION = [^;]+;/g))], [`CURRENT_PROJECT_VERSION = ${major * 10000 + minor * 100 + patch};`]);
  const out = execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/native-version.mjs", import.meta.url)), "--check"], { encoding: "utf8" });
  assert.match(out, /matches package\.json/);
});

test("the iOS app declares the camera and photo strings its image inputs need", () => {
  const plist = read("ios/App/App/Info.plist");
  for (const key of ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription", "NSPhotoLibraryAddUsageDescription"])
    assert.match(plist, new RegExp(`<key>${key}</key>\\s*<string>[^<]{10,}</string>`), key);
});

test("App Store purchase errors reach the iOS app as written", () => {
  const m = "This App Store subscription belongs to another Etude account. Sign in to that account to use it.";
  assert.equal(storeSafeMessage(m, "apple_other_account", true), m);
});

test("the iOS app sells Sync only through StoreKit, with prices from the App Store and Apple's required pieces", () => {
  const plans = read("web/src/components/app-store-plans.tsx");
  // No hard-coded prices or currency: everything shown comes from StoreKit's displayPrice.
  assert.doesNotMatch(plans, /US\$|\$\d|\d+\.\d\d/);
  assert.match(plans, /displayPrice/);
  for (const piece of [/Restore Purchases/, /renews automatically/, /24 hours before/, /etude\.study\/terms/, /etude\.study\/privacy/]) assert.match(plans, piece);
  // Nothing about the website or its prices in the App Store screens.
  assert.doesNotMatch(plans, /etude\.study\/(sync|account|app)|on the web|website|cheaper/i);
  const swift = read("ios/App/App/EtudeStorePlugin.swift");
  for (const api of ["Product.products", ".appAccountToken(", "Transaction.updates", "Transaction.unfinished", "AppStore.sync()", "showManageSubscriptions", "jwsRepresentation"]) assert.ok(swift.includes(api), api);
  // A transaction is finished only after the server answered.
  const kit = read("web/src/lib/storekit.ts");
  assert.match(kit, /await account\.appleTransaction\(t\.jws\);\s*await p\?\.finish/);
});
