import { test } from "node:test";
import assert from "node:assert/strict";
import { wheelFactor, zoomKey } from "../web/src/lib/pane-zoom.ts";

test("a pinch zooms by the fingers' own scale, a mouse notch by one step", () => {
  // Chromium sends a pinch as ctrl+wheel with deltaY = −100·ln(scale).
  const scale = 1.3;
  assert.ok(Math.abs(wheelFactor(-100 * Math.log(scale)) - scale) < 1e-9);
  let z = 1;
  for (let i = 0; i < 10; i++) z *= wheelFactor(-100 * Math.log(1.5) / 10);
  assert.ok(Math.abs(z - 1.5) < 1e-9);
  assert.equal(wheelFactor(-120), 1.1);
  assert.equal(wheelFactor(100), 1 / 1.1);
  assert.equal(wheelFactor(-3, 1), 1.1);
});

test("Ctrl/⌘ with + = − 0 are the zoom keys, with Alt they aren't", () => {
  const k = (key: string, o: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; code: string }> = {}) => zoomKey({ key, ctrlKey: true, metaKey: false, altKey: false, ...o });
  assert.equal(k("="), 1);
  assert.equal(k("+"), 1);
  assert.equal(k("-"), -1);
  assert.equal(k("0"), 0);
  assert.equal(k("=", { ctrlKey: false, metaKey: true }), 1);
  assert.equal(k("=", { altKey: true }), null);
  assert.equal(k("a"), null);
  assert.equal(zoomKey({ key: "=", ctrlKey: false, metaKey: false, altKey: false }), null);
});
