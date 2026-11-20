import { test } from "node:test";
import assert from "node:assert/strict";
import { dragScrollStep } from "../web/src/editor/drag-scroll.ts";

test("drag autoscroll: still in the middle, faster toward each edge, fastest past it", () => {
  const top = 48;
  const bottom = 900;
  assert.equal(dragScrollStep(450, top, bottom), 0);
  assert.equal(dragScrollStep(top + 73, top, bottom), 0);
  const near = dragScrollStep(top + 60, top, bottom);
  const edge = dragScrollStep(top + 2, top, bottom);
  const past = dragScrollStep(10, top, bottom);
  assert.ok(near < 0 && edge < near && past < edge, `${near} ${edge} ${past}`);
  assert.ok(dragScrollStep(bottom - 60, top, bottom) > 0);
  assert.ok(dragScrollStep(bottom + 40, top, bottom) > dragScrollStep(bottom - 2, top, bottom));
  // Capped, so a pointer far outside the pane doesn't fling the page.
  assert.equal(dragScrollStep(-5000, top, bottom), dragScrollStep(-6000, top, bottom));
  // A short pane gets a band a quarter of its height, so the middle still holds still.
  assert.equal(dragScrollStep(150, 100, 200), 0);
  assert.equal(dragScrollStep(150, 100, 100), 0);
});
