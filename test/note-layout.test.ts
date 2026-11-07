import { test } from "node:test";
import assert from "node:assert/strict";
import { activate, closeTab, count, findPane, moveTab, normalizeLayout, openIn, openSplit, panes, prune, rects, single, MAX_PANES } from "../web/src/lib/note-layout.ts";

const ids = (l: ReturnType<typeof single>) => panes(l.root).map((p) => p.tabs);

test("opening replaces the current tab, or adds one beside it", () => {
  let l = single(["a", "b"], "a");
  const p = l.focus;
  l = openIn(l, p, "c");
  assert.deepEqual(ids(l), [["c", "b"]]);
  l = openIn(l, p, "d", "new");
  assert.deepEqual(ids(l), [["c", "d", "b"]]);
  assert.equal(findPane(l.root, p)!.active, "d");
  l = openIn(l, p, "e", "background");
  assert.equal(findPane(l.root, p)!.active, "d");
});

test("dragging a tab to an edge splits, up to four panes", () => {
  let l = single(["a", "b", "c", "d", "e"], "a");
  const p0 = l.focus;
  l = moveTab(l, p0, "b", { pane: p0, side: "right" })!;
  assert.equal(count(l.root), 2);
  assert.deepEqual(ids(l), [["a", "c", "d", "e"], ["b"]]);
  const right = l.focus;
  l = moveTab(l, p0, "c", { pane: right, side: "bottom" })!;
  l = moveTab(l, p0, "d", { pane: p0, side: "bottom" })!;
  assert.equal(count(l.root), MAX_PANES);
  assert.equal(moveTab(l, p0, "e", { pane: p0, side: "left" }), null, "no fifth pane");
  const r = rects(l.root);
  const area = r.panes.reduce((s, x) => s + x.w * x.h, 0);
  assert.ok(Math.abs(area - 1) < 1e-9, "panes cover the screen");
  assert.equal(r.bars.length, 3);
});

test("a pane whose only tab moves away closes", () => {
  let l = single(["a", "b"], "a");
  const p0 = l.focus;
  l = moveTab(l, p0, "b", { pane: p0, side: "bottom" })!;
  const p1 = l.focus;
  l = moveTab(l, p1, "b", { pane: p0, before: "a" })!;
  assert.equal(count(l.root), 1);
  assert.deepEqual(ids(l), [["b", "a"]]);
  assert.equal(findPane(l.root, l.focus)!.active, "b");
  // A lone tab can't split its own pane.
  assert.equal(moveTab(single(["a"]), single(["a"]).focus, "a", { pane: "x", side: "right" }), null);
});

test("closing a pane's last tab gives its space back; reorder within a pane", () => {
  let l = single(["a", "b", "c"], "a");
  const p0 = l.focus;
  l = openSplit(l, p0, "x", "right")!;
  assert.equal(count(l.root), 2);
  l = closeTab(l, l.focus, "x");
  assert.equal(count(l.root), 1);
  assert.equal(l.focus, p0);
  l = moveTab(l, p0, "c", { pane: p0, before: "a" })!;
  assert.deepEqual(ids(l), [["c", "a", "b"]]);
  l = activate(l, p0, "b");
  assert.equal(findPane(l.root, p0)!.active, "b");
});

test("archived pages leave, empty panes close, bad storage is refused", () => {
  let l = single(["a", "b"], "a");
  l = moveTab(l, l.focus, "b", { pane: l.focus, side: "right" })!;
  l = prune(l, (x) => x !== "b");
  assert.equal(count(l.root), 1);
  assert.deepEqual(ids(l), [["a"]]);
  const back = normalizeLayout(JSON.parse(JSON.stringify(l)));
  assert.deepEqual(back, l);
  assert.equal(normalizeLayout({ root: { k: "split", dir: "diag", a: {}, b: {} } }), null);
  assert.equal(normalizeLayout(null), null);
});

test("a page dragged in from the sidebar opens where it lands", async () => {
  const { dropPage } = await import("../web/src/lib/note-layout.ts");
  let l = single(["a", "b"], "a");
  const p0 = l.focus;
  l = dropPage(l, "x", { pane: p0, before: "b" })!;
  assert.deepEqual(ids(l), [["a", "x", "b"]]);
  l = dropPage(l, "y", { pane: p0, side: "bottom" })!;
  assert.deepEqual(ids(l), [["a", "x", "b"], ["y"]]);
  // Already open: it moves from where it was.
  l = dropPage(l, "a", { pane: l.focus, before: null })!;
  assert.deepEqual(ids(l), [["x", "b"], ["y", "a"]]);
});
