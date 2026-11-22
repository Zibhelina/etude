import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_ZOOM_MAX, APP_ZOOM_MIN, clampAppZoom, stepAppZoom } from "../web/src/lib/app-zoom-math.ts";

test("app-zoom clamps, rounds and falls back cleanly", () => {
  assert.equal(clampAppZoom(1), 1);
  assert.equal(clampAppZoom(0.1), APP_ZOOM_MIN);
  assert.equal(clampAppZoom(5), APP_ZOOM_MAX);
  assert.equal(clampAppZoom(1.126), 1.13);
  assert.equal(clampAppZoom("1.25"), 1.25);
  assert.equal(clampAppZoom(NaN), 1);
  assert.equal(clampAppZoom(undefined), 1);
});

test("app-zoom steps cleanly up, down and back to 100%", () => {
  assert.equal(stepAppZoom(1, 1), 1.1);
  assert.equal(stepAppZoom(1.1, 1), 1.25);
  assert.equal(stepAppZoom(1, -1), 0.9);
  assert.equal(stepAppZoom(0.9, -1), 0.8);
  assert.equal(stepAppZoom(1.15, 1), 1.25);
  assert.equal(stepAppZoom(1.15, -1), 1.1);
  assert.equal(stepAppZoom(1.5, 0), 1);
  assert.equal(stepAppZoom(APP_ZOOM_MAX, 1), APP_ZOOM_MAX);
  assert.equal(stepAppZoom(APP_ZOOM_MIN, -1), APP_ZOOM_MIN);
});
