// The phone apps' native bridge answers only the app's own page: card frames run other people's code. The Swift
// can't be compiled here, so these read the source; test/fixtures/ios-bridge-probe.pack.json checks it on a device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const CAP_IOS = "node_modules/@capacitor/ios/Capacitor/Capacitor";

test("iOS: messages to Capacitor's bridge from any frame but the main one are dropped", () => {
  const swift = read("ios/App/App/EtudeBridgeViewController.swift");
  const didLoad = /override open func capacitorDidLoad\(\) \{([\s\S]*?)\n {4}\}/.exec(swift)?.[1] ?? "";
  assert.match(didLoad, /keepBridgeToMainFrame\(\)/, "set up before the page loads");
  assert.match(swift, /removeScriptMessageHandler\(forName: MainFrameOnly\.name\)/);
  assert.match(swift, /controller\.add\(MainFrameOnly\(handler\), name: MainFrameOnly\.name\)/);
  assert.match(swift, /guard message\.frameInfo\.isMainFrame else \{ return \}/);
  // The name is the one Capacitor registers its handler under and its bridge script posts to.
  const name = /static let name = "([^"]+)"/.exec(swift)?.[1];
  const handler = read(`${CAP_IOS}/WebViewDelegationHandler.swift`);
  assert.equal(/private let handlerName = "([^"]+)"/.exec(handler)?.[1], name);
  assert.match(handler, /contentController\.add\(self, name: handlerName\)/);
  assert.ok(read(`${CAP_IOS}/assets/native-bridge.js`).includes(`messageHandlers.${name}`));
});

test("Android: Capacitor's listener takes only main-frame messages, and the app doesn't opt into the legacy bridge", () => {
  const java = read("node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/MessageHandler.java");
  assert.match(java, /if \(isMainFrame\) \{\s*postMessage/);
  assert.doesNotMatch(read("capacitor.config.ts"), /useLegacyBridge/);
});

test("the device probe: a card that posts a plugin call from inside its frame", () => {
  const pack = JSON.parse(read("test/fixtures/ios-bridge-probe.pack.json"));
  const js: string = pack.types[0].template.js;
  assert.match(js, /messageHandlers\.bridge/);
  assert.match(js, /pluginId: "EtudeAuth", methodName: "open"/);
});
