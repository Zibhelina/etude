import { test } from "node:test";
import assert from "node:assert/strict";
import { scrollFor } from "../web/src/lib/field-on-screen.ts";

// The screen left between a 64px header and a strip from 700 down, with the 12px kept at each edge.
const span = { top: 64, bottom: 700 };
const BOTTOM = 700 - 12;

test("a field under the keyboard or a bar comes up to rest on the bottom of what shows", () => {
  const field = { top: 760, bottom: 800 };
  assert.equal(scrollFor(field, { top: 100, bottom: 900 }, span), 800 - BOTTOM);
  assert.equal(800 - scrollFor(field, { top: 100, bottom: 900 }, span), BOTTOM);
});

test("a card that fits stays where it is", () => {
  assert.equal(scrollFor({ top: 300, bottom: 340 }, { top: 90, bottom: 400 }, span), 0);
});

test("in a tall card the field goes as low as it shows whole, with the card above it", () => {
  // The card's top is 500px above the screen; the field sits near the header.
  assert.equal(scrollFor({ top: 120, bottom: 160 }, { top: -500, bottom: 900 }, span), 160 - BOTTOM);
});

test("but not so low that the screen above the card's top is left empty", () => {
  // Only 40px of the card is out of view above: it comes into view, and the field stops there.
  const d = scrollFor({ top: 120, bottom: 160 }, { top: 36, bottom: 900 }, span);
  assert.equal(d, 36 - (64 + 12));
  assert.ok(160 - d <= BOTTOM);
});

test("a field out of view above comes down onto the bottom", () => {
  assert.equal(scrollFor({ top: -200, bottom: -160 }, { top: -900, bottom: 400 }, span), -160 - BOTTOM);
});

test("a field taller than the screen shows its top", () => {
  assert.equal(scrollFor({ top: 300, bottom: 1300 }, { top: 0, bottom: 1400 }, span), 300 - (64 + 12));
});
