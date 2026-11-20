// fieldInView decides whether native-shell.ts scrolls the focused field above the on-screen keyboard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { fieldInView } from "../src/browser/field-in-view.ts";

/** A page whose screen shows `height` px (the visual viewport above the keyboard), with one field at `top`..`bottom`. */
function page(height: number, top: number, bottom: number) {
  const dom = new JSDOM(`<!doctype html><body><label id="wrap"><input id="f"></label><nav id="bar"></nav></body>`);
  const win = dom.window as unknown as Window;
  Object.defineProperty(win, "visualViewport", { value: { offsetTop: 0, height } });
  const field = win.document.getElementById("f")!;
  field.getBoundingClientRect = () => ({ top, bottom, left: 20, right: 300, width: 280, height: bottom - top, x: 20, y: top, toJSON() {} }) as DOMRect;
  let over: Element | null = field;
  win.document.elementFromPoint = () => over;
  return { win, field, cover: (el: Element | null) => (over = el), doc: win.document };
}

test("a field in the part of the page above the keyboard is in view", () => {
  const { win, field } = page(420, 200, 240);
  assert.equal(fieldInView(field, win), true);
});

test("a field under the keyboard or too close to it is out of view", () => {
  const under = page(420, 380, 440);
  assert.equal(fieldInView(under.field, under.win), false);
  const close = page(420, 370, 410); // 10 px above the keyboard: less than the room kept
  assert.equal(fieldInView(close.field, close.win), false);
});

test("a field above the top of the screen is out of view", () => {
  const p = page(420, -30, 10);
  assert.equal(fieldInView(p.field, p.win), false);
});

test("a bar fixed over the field hides it; the field's own wrapper doesn't", () => {
  const p = page(420, 200, 240);
  p.cover(p.doc.getElementById("bar"));
  assert.equal(fieldInView(p.field, p.win), false);
  p.cover(p.doc.getElementById("wrap"));
  assert.equal(fieldInView(p.field, p.win), true);
  p.cover(null);
  assert.equal(fieldInView(p.field, p.win), true);
});
