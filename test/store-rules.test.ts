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

test("Android's versionCode leaves room for an Android-only build number above the old scheme", () => {
  const gradle = read("android/app/build.gradle");
  assert.match(gradle, /System\.getenv\('ETUDE_ANDROID_BUILD'\)/);
  assert.match(gradle, /def etudeVersionCode = vMajor \* 1000000 \+ vMinor \* 10000 \+ vPatch \* 100 \+ etudeAndroidBuild/);
  assert.match(gradle, /versionCode etudeVersionCode/);
  assert.match(gradle, /versionName etudeVersionName/);
  const code = (v: string, build = 0) => { const [a, b, c] = v.split(".").map(Number); return a * 1000000 + b * 10000 + c * 100 + build; };
  // 3.1.1 went to Play as 30101 under major*10000 + minor*100 + patch.
  assert.ok(code("3.1.1") > 30101);
  assert.equal(code("3.1.1", 1), 3010101);
  assert.ok(code("3.1.2") > code("3.1.1", 99));
  assert.ok(code("4.0.0") > code("3.99.99", 99));
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

test("the store apps' own Sync and account text makes sense on a phone and never points to the website", async () => {
  const { NATIVE_COPY } = await import("../web/src/lib/native-copy.ts");
  for (const [key, text] of Object.entries(NATIVE_COPY)) assert.doesNotMatch(text, /desktop|computer|etude\.study|website|on the web|browser|US\$|\bbuy\b|subscri|price/i, key);
  // Each native branch uses the shared text, and the desktop wording sits behind isNativeApp().
  const sync = read("web/src/components/settings-sync.tsx");
  assert.match(sync, /isNativeApp\(\) \? NATIVE_COPY\.syncSetup : "Etude syncs through a server, or through a folder on this computer in the desktop app\."/);
  assert.match(sync, /isNativeApp\(\) \? NATIVE_COPY\.syncFolder : "Syncing through a folder on this computer\."/);
  assert.match(sync, /!\(globalThis as any\)\.__etudeLocal && !isNativeApp\(\) && <TextInput label="Folder/);
  const acct = read("web/src/components/settings-account.tsx");
  assert.doesNotMatch(acct, /Creators manage their listings from the desktop app or etude\.study/);
  assert.match(acct, /isNativeApp\(\) \? NATIVE_COPY\.selling :/);
  assert.match(acct, /isNativeApp\(\) \? NATIVE_COPY\.passkeysElsewhere :/);
  // Onboarding: no "Desktop app only" folder option in the store apps.
  assert.match(read("web/src/components/onboarding.tsx"), /\{!isNativeApp\(\) && <Option\s+kind="radio"\s+icon=\{FolderSync\}/);
});

test("phone apps: a ChatGPT sign-in that can't start says so in phone words, with no CLI", () => {
  const chat = read("web/src/components/settings-chatgpt.tsx");
  assert.match(chat, /if \(inNativeShell\(\)\) setRemote\(\{ message: NATIVE_COPY\.chatGptUnavailable, cli: "" \}\)/);
  for (const f of ["web/src/components/settings-chatgpt.tsx", "web/src/components/onboarding.tsx"]) {
    const s = read(f);
    assert.doesNotMatch(s, /(?<!remote\.cli && )<CopyValue label="Run on the machine that runs Etude"/, f);
  }
});

test("Google Play purchase errors reach the Android app as written", () => {
  const m = "This Google Play subscription was bought for another Etude account. Sign in to that account to use it.";
  assert.equal(storeSafeMessage(m, "google_other_account", true), m);
});

test("the Android app sells Sync only through Play Billing, prices from Play, acknowledged after the server", () => {
  const kt = read("android/app/src/main/java/study/etude/app/EtudeStorePlugin.kt");
  // Same plugin name as iOS, so the page code is shared.
  assert.match(kt, /@CapacitorPlugin\(name = "EtudeStore"\)/);
  for (const api of ["queryProductDetailsAsync", "setObfuscatedAccountId(", "launchBillingFlow", "acknowledgePurchase", "queryPurchasesAsync", "enablePendingPurchases", "play.google.com/store/account/subscriptions", "formattedPrice"]) assert.ok(kt.includes(api), api);
  // No hard-coded prices in the plugin either.
  assert.doesNotMatch(kt, /US\$|\$\d|\d+\.\d\d/);
  assert.match(read("android/app/src/main/java/study/etude/app/MainActivity.java"), /registerPlugin\(EtudeStorePlugin\.class\)/);
  assert.match(read("android/app/build.gradle"), /com\.android\.billingclient:billing:/);
  // The page acknowledges only when the server says so (never a pending or refused purchase).
  const kit = read("web/src/lib/storekit.ts");
  assert.match(kit, /const r = await account\.googlePurchase\(t\.jws\);\s*if \(r\.acknowledge\) await p\?\.finish/);
  // The plan screen's store words for Google Play, and nothing about the website.
  const plans = read("web/src/components/app-store-plans.tsx");
  for (const piece of [/Google Play account/, /Payments & subscriptions/]) assert.match(plans, piece);
});

test("the Android ChatGPT plugin matches the iOS one and stays narrow", () => {
  const kt = read("android/app/src/main/java/study/etude/app/EtudeAuthPlugin.kt");
  const swift = read("ios/App/App/EtudeAuthPlugin.swift");
  assert.match(kt, /@CapacitorPlugin\(name = "EtudeAuth"\)/);
  // Every method the iOS plugin exposes, under the same name.
  const iosMethods = [...swift.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((m) => m[1]).sort();
  const ktMethods = [...kt.matchAll(/@PluginMethod(?:\([^)]*\))?\s+fun (\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(ktMethods, iosMethods);
  // Same allowlists: OpenAI's two hosts only, and the two credential names only.
  assert.match(kt, /allowedHosts = setOf\("auth\.openai\.com", "api\.openai\.com"\)/);
  assert.match(kt, /allowedNames = setOf\("chatgpt\.json", "chatgpt-host-id"\)/);
  assert.match(kt, /uri\.scheme == "https" && uri\.host in allowedHosts/);
  // Credentials: an AES-GCM key in the Android Keystore, ciphertext in app-private no-backup storage.
  for (const piece of ['"AndroidKeyStore"', "AES/GCM/NoPadding", "noBackupFilesDir"]) assert.ok(kt.includes(piece), piece);
  // The listener is loopback only, and the page opens in a Custom Tab.
  assert.match(kt, /InetAddress\.getByName\("127\.0\.0\.1"\)/);
  assert.match(kt, /CustomTabsIntent/);
  assert.match(read("android/app/src/main/java/study/etude/app/MainActivity.java"), /registerPlugin\(EtudeAuthPlugin\.class\)/);
  assert.match(read("android/app/build.gradle"), /androidx\.browser:browser:/);
});
