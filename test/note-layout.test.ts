import { test } from "node:test";
import assert from "node:assert/strict";
import { activate, closeTab, count, editGroup, findPane, groupOf, groupTabs, groupTint, isPinned, moveGroup, moveTab, nextZoom, normalizeLayout, paneZoom, setPaneZoom, openIn, openSplit, panes, pinTab, prune, rects, setTabIcon, single, ungroup, ungroupTab, visibleTabs, MAX_PANES } from "../web/src/lib/note-layout.ts";

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

test("pinned tabs start at the front, are never replaced by a click on a page, and survive storage", () => {
  let l = single(["a", "b", "c"], "c");
  const p = l.focus;
  const pane = () => findPane(l.root, p)!;
  l = pinTab(l, p, "c", true);
  assert.deepEqual(pane().tabs, ["c", "a", "b"]);
  l = pinTab(l, p, "b", true);
  assert.deepEqual(pane().tabs, ["c", "b", "a"]);
  assert.deepEqual(pane().pinned, ["c", "b"]);
  // The front tab is pinned: opening a page doesn't take its place.
  l = activate(l, p, "c");
  l = openIn(l, p, "x");
  assert.deepEqual(pane().tabs, ["c", "b", "x", "a"]);
  assert.equal(pane().active, "x");
  // Tabs go wherever they're dragged: an ordinary one in front of the pins, a pin to the far end, still a pin.
  l = moveTab(l, p, "a", { pane: p, before: "c" })!;
  assert.deepEqual(pane().tabs, ["a", "c", "b", "x"]);
  l = moveTab(l, p, "c", { pane: p, before: null })!;
  assert.deepEqual(pane().tabs, ["a", "b", "x", "c"]);
  assert.ok(isPinned(pane(), "c"));
  const back = normalizeLayout(JSON.parse(JSON.stringify(l)))!;
  assert.deepEqual(findPane(back.root, p)!.tabs, ["a", "b", "x", "c"]);
  assert.deepEqual(findPane(back.root, p)!.pinned, ["b", "c"]);
  // Unpinned, it stays where it is. Closed, it's forgotten.
  l = pinTab(l, p, "b", false);
  assert.deepEqual(pane().tabs, ["a", "b", "x", "c"]);
  l = closeTab(l, p, "c");
  assert.equal(pane().pinned, undefined);
});

test("pinned tabs move anywhere along the strip, and to another pane with their pin and icon", () => {
  let l = single(["a", "b", "c", "d", "e"], "d");
  const p = l.focus;
  const pane = () => findPane(l.root, p)!;
  for (const t of ["a", "b", "c"]) l = pinTab(l, p, t, true);
  l = setTabIcon(l, p, "a", "emoji:🧪");
  // Among the pins: to the end, to the front, to the middle.
  l = moveTab(l, p, "a", { pane: p, before: "d", group: null })!;
  assert.deepEqual(pane().pinned, ["b", "c", "a"]);
  l = moveTab(l, p, "a", { pane: p, before: "b", group: null })!;
  assert.deepEqual(pane().pinned, ["a", "b", "c"]);
  l = moveTab(l, p, "c", { pane: p, before: "b", group: null })!;
  assert.deepEqual(pane().tabs, ["a", "c", "b", "d", "e"]);
  // Anywhere among the other tabs too: between two of them, or last. It stays pinned, icon and all.
  l = moveTab(l, p, "a", { pane: p, before: "e", group: null })!;
  assert.deepEqual(pane().tabs, ["c", "b", "d", "a", "e"]);
  l = moveTab(l, p, "a", { pane: p, before: null })!;
  assert.deepEqual(pane().tabs, ["c", "b", "d", "e", "a"]);
  assert.ok(isPinned(pane(), "a"));
  assert.equal(pane().icons!.a, "emoji:🧪");
  // A page opened from a pinned tab lands right after it, wherever it is.
  l = activate(l, p, "b");
  l = openIn(l, p, "x");
  assert.deepEqual(pane().tabs, ["c", "b", "x", "d", "e", "a"]);
  l = closeTab(l, p, "x");
  l = activate(l, p, "d");
  // Split off to the right: still pinned there, icon and all.
  l = moveTab(l, p, "a", { pane: p, side: "right" })!;
  const right = l.focus;
  assert.deepEqual(findPane(l.root, right)!.pinned, ["a"]);
  assert.deepEqual(findPane(l.root, right)!.icons, { a: "emoji:🧪" });
  assert.deepEqual(pane().pinned, ["c", "b"]);
  assert.equal(pane().icons, undefined);
  // Onto another pane's tabs: pinned there, in the place it was dropped among the pins.
  l = moveTab(l, p, "c", { pane: right, before: "a" })!;
  assert.deepEqual(findPane(l.root, right)!.tabs, ["c", "a"]);
  assert.deepEqual(findPane(l.root, right)!.pinned, ["c", "a"]);
  // Into a group over there, it's a grouped tab and no longer pinned.
  l = moveTab(l, p, "d", { pane: right, before: null })!;
  l = groupTabs(l, right, ["d"], "g1");
  l = moveTab(l, p, "b", { pane: right, before: null, group: "g1" })!;
  assert.equal(isPinned(findPane(l.root, right), "b"), false);
  assert.deepEqual(findPane(l.root, right)!.groups![0].tabs, ["d", "b"]);
});

test("a group takes a named colour or any colour of your own", () => {
  let l = single(["a", "b"], "a");
  const p = l.focus;
  l = groupTabs(l, p, ["a"], "g1");
  l = editGroup(l, p, "g1", { color: "#12abEF" });
  assert.equal(findPane(l.root, p)!.groups![0].color, "#12abEF");
  assert.equal(findPane(normalizeLayout(JSON.parse(JSON.stringify(l)))!.root, p)!.groups![0].color, "#12abEF");
  l = editGroup(l, p, "g1", { color: "url(evil)" as any });
  assert.equal(findPane(l.root, p)!.groups![0].color, "#12abEF", "anything else is refused");
  assert.equal(groupTint("pink"), "var(--nc-pink)");
  assert.equal(groupTint("#12abEF"), "#12abEF");
  const bad = JSON.parse(JSON.stringify(l));
  bad.root.groups[0].color = "red; background: url(x)";
  assert.equal(findPane(normalizeLayout(bad)!.root, p)!.groups![0].color, "gray");
});

test("tab groups: made, named, coloured, folded, joined by a drop, dissolved", () => {
  let l = single(["a", "b", "c", "d", "e"], "a");
  const p = l.focus;
  const pane = () => findPane(l.root, p)!;
  l = groupTabs(l, p, ["b", "d"], "g1");
  assert.deepEqual(pane().tabs, ["a", "b", "d", "c", "e"], "its tabs sit side by side");
  assert.deepEqual(pane().groups, [{ id: "g1", name: "", color: "blue", tabs: ["b", "d"] }]);
  l = editGroup(l, p, "g1", { name: "Course", color: "pink" });
  l = groupTabs(l, p, ["e"], "g2");
  assert.equal(groupOf(pane(), "e")!.color, "blue", "a new group takes a colour not in use");
  // Dropped between a group's tabs: it joins. Dropped before the group: it doesn't.
  l = moveTab(l, p, "c", { pane: p, before: "d" })!;
  assert.deepEqual(groupOf(pane(), "c")?.tabs, ["b", "c", "d"]);
  l = moveTab(l, p, "c", { pane: p, before: "b" })!;
  assert.equal(groupOf(pane(), "c"), undefined);
  assert.deepEqual(pane().tabs, ["a", "c", "b", "d", "e"]);
  // Folding hides its tabs; the front tab moves out of a group that folds.
  l = activate(l, p, "d");
  l = editGroup(l, p, "g1", { collapsed: true });
  assert.equal(pane().active, "e");
  assert.deepEqual(visibleTabs(pane()), ["a", "c", "e"]);
  // Going to a folded tab (from the sidebar) unfolds its group.
  l = activate(l, p, "b");
  assert.equal(groupOf(pane(), "b")!.collapsed, undefined);
  // A page opened over a grouped tab stays in the group; a tab opened from one joins it.
  l = openIn(l, p, "x");
  assert.deepEqual(groupOf(pane(), "x")?.tabs, ["x", "d"]);
  l = openIn(l, p, "y", "new");
  assert.deepEqual(groupOf(pane(), "y")?.tabs, ["x", "y", "d"]);
  assert.deepEqual(pane().tabs, ["a", "c", "x", "y", "d", "e"]);
  // Storage keeps name, colour and fold.
  l = activate(l, p, "a");
  l = editGroup(l, p, "g1", { collapsed: true });
  const back = findPane(normalizeLayout(JSON.parse(JSON.stringify(l)))!.root, p)!;
  assert.deepEqual(back.groups![0], { id: "g1", name: "Course", color: "pink", tabs: ["x", "y", "d"], collapsed: true });
  // Out of the group, pinned (which also leaves a group), closed, dissolved.
  l = ungroupTab(l, p, "d");
  assert.deepEqual(pane().tabs, ["a", "c", "x", "y", "d", "e"]);
  l = pinTab(l, p, "y", true);
  assert.deepEqual(groupOf(pane(), "x")?.tabs, ["x"]);
  l = closeTab(l, p, "x");
  assert.deepEqual(pane().groups!.map((g) => g.id), ["g2"], "a group with no tabs left is gone");
  l = ungroup(l, p, "g2");
  assert.equal(pane().groups, undefined);
  assert.deepEqual(pane().tabs, ["y", "a", "c", "d", "e"]);
  // A group that holds every tab in view can't fold.
  l = groupTabs(l, p, ["a", "c", "d", "e"], "g3");
  l = pinTab(l, p, "y", false);
  l = groupTabs(l, p, ["y"], "g3");
  l = editGroup(l, p, "g3", { collapsed: true });
  assert.equal(pane().groups![0].collapsed, undefined);
  // Archived pages leave their group.
  l = prune(l, (id) => id !== "a");
  assert.deepEqual(pane().groups![0].tabs, ["c", "d", "e", "y"]);
});

test("a tab dropped on a group's label or on one of its tabs joins the group, wherever it sat", () => {
  let l = single(["a", "b", "c", "d", "e"], "a");
  const p = l.focus;
  const pane = () => findPane(l.root, p)!;
  l = groupTabs(l, p, ["b", "c"], "g1");
  // On the label: after the group's last tab. It works for a folded group too.
  l = moveTab(l, p, "e", { pane: p, before: null, group: "g1" })!;
  assert.deepEqual(pane().tabs, ["a", "b", "c", "e", "d"]);
  assert.deepEqual(groupOf(pane(), "e")!.tabs, ["b", "c", "e"]);
  l = editGroup(l, p, "g1", { collapsed: true });
  l = moveTab(l, p, "d", { pane: p, before: null, group: "g1" })!;
  assert.deepEqual(groupOf(pane(), "d")!.tabs, ["b", "c", "e", "d"]);
  assert.equal(groupOf(pane(), "d")!.collapsed, true, "the group stays folded");
  assert.equal(pane().active, "a");
  // On the left half of its first tab: first in the group. On the right half of its last: last.
  l = editGroup(l, p, "g1", { collapsed: false });
  l = ungroupTab(l, p, "d");
  l = moveTab(l, p, "d", { pane: p, before: "b", group: "g1" })!;
  assert.deepEqual(groupOf(pane(), "d")!.tabs, ["d", "b", "c", "e"]);
  l = moveTab(l, p, "a", { pane: p, before: null, group: "g1" })!;
  assert.deepEqual(pane().tabs, ["d", "b", "c", "e", "a"]);
  assert.equal(pane().groups![0].tabs.length, 5);
  // On a tab outside any group, right before the group: it leaves.
  l = single(["a", "b", "c"], "a");
  const q = l.focus;
  l = groupTabs(l, q, ["b", "c"], "g1");
  assert.equal(moveTab(l, q, "a", { pane: q, before: "b", group: null }), null, "already there, in no group");
  l = moveTab(l, q, "c", { pane: q, before: null, group: null })!;
  assert.deepEqual(findPane(l.root, q)!.groups![0].tabs, ["b"]);
  // A pinned tab dropped on a group joins it and stops being pinned.
  l = pinTab(l, q, "a", true);
  l = moveTab(l, q, "a", { pane: q, before: null, group: "g1" })!;
  assert.equal(isPinned(findPane(l.root, q), "a"), false);
  assert.deepEqual(findPane(l.root, q)!.groups![0].tabs, ["b", "a"]);
});

test("a group moves as one: along the strip, around other groups, to another pane", () => {
  let l = single(["a", "b", "c", "d", "e", "f"], "a");
  const p = l.focus;
  const pane = () => findPane(l.root, p)!;
  l = groupTabs(l, p, ["b", "c"], "g1", { name: "One" });
  l = groupTabs(l, p, ["e", "f"], "g2", { name: "Two" });
  l = moveGroup(l, p, "g1", { pane: p, before: null })!;
  assert.deepEqual(pane().tabs, ["a", "d", "e", "f", "b", "c"]);
  l = moveGroup(l, p, "g1", { pane: p, before: "a" })!;
  assert.deepEqual(pane().tabs, ["b", "c", "a", "d", "e", "f"]);
  assert.equal(moveGroup(l, p, "g1", { pane: p, before: "a" }), null, "already there");
  // Dropped inside another group, it lands beside it.
  l = moveGroup(l, p, "g1", { pane: p, before: "f" })!;
  assert.deepEqual(pane().tabs, ["a", "d", "e", "f", "b", "c"]);
  assert.deepEqual(pane().groups!.map((g) => g.tabs), [["b", "c"], ["e", "f"]]);
  // In front of a pinned tab too.
  l = pinTab(l, p, "a", true);
  l = moveGroup(l, p, "g1", { pane: p, before: "a" })!;
  assert.deepEqual(pane().tabs, ["b", "c", "a", "d", "e", "f"]);
  // To another pane, keeping its name and colour; the front tab it took with it is replaced here.
  l = activate(l, p, "b");
  l = moveTab(l, p, "d", { pane: p, side: "right" })!;
  const right = l.focus;
  l = moveGroup(l, p, "g1", { pane: right, before: "d" })!;
  assert.deepEqual(findPane(l.root, right)!.tabs, ["b", "c", "d"]);
  assert.equal(findPane(l.root, right)!.groups![0].name, "One");
  assert.deepEqual(pane().tabs, ["a", "e", "f"]);
  assert.ok(pane().active && pane().tabs.includes(pane().active!));
  // The last tabs of a pane leaving with their group close the pane.
  l = pinTab(l, p, "a", false);
  l = groupTabs(l, p, ["a"], "g2");
  l = moveGroup(l, p, "g2", { pane: right, before: null })!;
  assert.equal(count(l.root), 1);
  assert.deepEqual(panes(l.root)[0].tabs, ["b", "c", "d", "e", "f", "a"]);
});

test("a pinned tab can carry its own icon", () => {
  let l = single(["a", "b"], "a");
  const p = l.focus;
  assert.equal(setTabIcon(l, p, "a", "emoji:🧪"), l, "only pinned tabs");
  l = pinTab(l, p, "a", true);
  l = setTabIcon(l, p, "a", "emoji:🧪");
  assert.deepEqual(findPane(l.root, p)!.icons, { a: "emoji:🧪" });
  assert.deepEqual(findPane(normalizeLayout(JSON.parse(JSON.stringify(l)))!.root, p)!.icons, { a: "emoji:🧪" });
  l = setTabIcon(l, p, "a", null);
  assert.equal(findPane(l.root, p)!.icons, undefined);
  l = setTabIcon(l, p, "a", "art:x");
  l = pinTab(l, p, "a", false);
  assert.equal(findPane(l.root, p)!.icons, undefined, "unpinned, it shows the page's own icon again");
});

test("a pane zooms on its own, by a browser's steps, and keeps it in storage", () => {
  const l0 = single(["a"]);
  let l = openSplit(l0, l0.focus, "b", "right")!;
  const [p1, p2] = panes(l.root);
  assert.equal(nextZoom(1, 1), 1.1);
  assert.equal(nextZoom(1, -1), 0.9);
  assert.equal(nextZoom(1.1, 0), 1);
  assert.equal(nextZoom(3, 1), 3);
  assert.equal(nextZoom(0.5, -1), 0.5);
  assert.equal(nextZoom(1.05, 1), 1.1);
  assert.equal(nextZoom(1, { to: 9 }), 3);
  l = setPaneZoom(l, p2.id, 1.25);
  assert.equal(paneZoom(findPane(l.root, p2.id)), 1.25);
  assert.equal(paneZoom(findPane(l.root, p1.id)), 1);
  const back = normalizeLayout(JSON.parse(JSON.stringify(l)))!;
  assert.equal(findPane(back.root, p2.id)?.zoom, 1.25);
  // Back at 100% the pane carries no zoom at all; nonsense from storage is dropped.
  l = setPaneZoom(l, p2.id, 1);
  assert.equal("zoom" in findPane(l.root, p2.id)!, false);
  const odd = JSON.parse(JSON.stringify(l));
  odd.root.b.zoom = "big";
  assert.equal(findPane(normalizeLayout(odd)!.root, p2.id)?.zoom, undefined);
  // Pinning or grouping a tab keeps the pane's zoom.
  l = setPaneZoom(l, p2.id, 1.5);
  l = pinTab(l, p2.id, "b", true);
  assert.equal(findPane(l.root, p2.id)?.zoom, 1.5);
});

test("a file renamed or moved on disk keeps its tab: the tab, its pin, group and icon follow the new id", async () => {
  const { renameTab } = await import("../web/src/lib/note-layout.ts");
  let l = single(["fs:v/Journal/a.md", "page-1", "fs:v/Journal/sub/b.md", "fs:v/other.md"], "fs:v/Journal/a.md");
  const p = l.focus;
  l = pinTab(l, p, "fs:v/Journal/a.md", true);
  l = setTabIcon(l, p, "fs:v/Journal/a.md", "📓");
  l = groupTabs(l, p, ["fs:v/Journal/sub/b.md"], "g1", { name: "Sub" });
  // One file renamed.
  const one = renameTab(l, "fs:v/Journal/a.md", "fs:v/Journal/z.md");
  const pane = findPane(one.root, p)!;
  assert.equal(pane.active, "fs:v/Journal/z.md");
  assert.ok(pane.tabs.includes("fs:v/Journal/z.md") && !pane.tabs.includes("fs:v/Journal/a.md"));
  assert.ok(isPinned(pane, "fs:v/Journal/z.md"));
  assert.equal(pane.icons?.["fs:v/Journal/z.md"], "📓");
  // A folder moved: everything open from inside it follows, and nothing else does.
  const all = renameTab(l, "fs:v/Journal", "fs:v/Archive/Journal");
  const moved = findPane(all.root, p)!;
  assert.deepEqual([...moved.tabs].sort(), ["fs:v/Archive/Journal/a.md", "fs:v/Archive/Journal/sub/b.md", "fs:v/other.md", "page-1"].sort());
  assert.equal(groupOf(moved, "fs:v/Archive/Journal/sub/b.md")?.id, "g1");
  // "Journal 2" isn't inside "Journal".
  assert.deepEqual(ids(renameTab(single(["fs:v/Journal 2/a.md"], null), "fs:v/Journal", "fs:v/J")), [["fs:v/Journal 2/a.md"]]);
  // Nothing to rename: the same layout object comes back.
  assert.equal(renameTab(l, "fs:v/nope.md", "fs:v/x.md"), l);
});
