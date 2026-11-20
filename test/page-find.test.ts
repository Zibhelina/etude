import { test } from "node:test";
import assert from "node:assert/strict";
import { findPages, fold, pagePaths, recentPages } from "../web/src/lib/page-find.ts";

const P = (id: string, title: string, parentId: string | null = null, more: Record<string, unknown> = {}) => ({ id, title, parentId, ...more });
const pages = [
  P("c", "CMPT 307", null, { kind: "folder" }),
  P("w", "Week 3", "c"),
  P("g", "Greedy algorithms", "w", { opened: "2026-11-10T10:00:00Z" }),
  P("d", "Dynamic programming", "w", { opened: "2026-11-09T10:00:00Z" }),
  P("r", "Revisão de álgebra", null, { opened: "2026-11-08T10:00:00Z" }),
  P("x", "Greedy (old)", null, { archived: true, opened: "2026-11-11T10:00:00Z" }),
  P("u", "", null),
];
const titles = (q: string) => findPages(pages, q).map((h) => h.n.title);

test("pages are found by title like decks: start, piece, words of the path, letters in order", () => {
  assert.deepEqual(titles("greedy"), ["Greedy algorithms"], "an archived page stays out");
  assert.deepEqual(titles("prog"), ["Dynamic programming"]);
  assert.deepEqual(titles("307 greedy"), ["Greedy algorithms"], "a folder above it counts");
  assert.deepEqual(titles("week 3")[0], "Week 3");
  assert.ok(titles("week").includes("Greedy algorithms"), "everything in Week 3 is found by its folder");
  assert.deepEqual(titles("grdy"), ["Greedy algorithms"]);
  assert.deepEqual(titles("dyn pro"), ["Dynamic programming"]);
  assert.deepEqual(titles("zzz"), []);
  assert.deepEqual(titles("untitled"), ["Untitled"].map(() => ""), "a page with no title is found as Untitled");
});

test("accents and case don't matter, and the bold letters stay on the right characters", () => {
  assert.equal(fold("Revisão de Álgebra"), "revisao de algebra");
  assert.deepEqual(titles("revisao"), ["Revisão de álgebra"]);
  assert.deepEqual(titles("ALGEBRA"), ["Revisão de álgebra"]);
  const h = findPages(pages, "álgebra")[0];
  assert.equal(h.marks.map((i) => [...h.n.title][i]).join(""), "álgebra");
});

test("paths and the pages opened last", () => {
  assert.equal(pagePaths(pages).get("g"), "CMPT 307 › Week 3");
  assert.equal(pagePaths(pages).get("c"), "");
  assert.deepEqual(recentPages(pages).map((h) => h.n.id), ["g", "d", "r"], "newest first, no folders, nothing archived");
  assert.deepEqual(findPages(pages, "  "), []);
  // A loop in the tree (bad data) doesn't hang it.
  assert.equal(pagePaths([P("a", "A", "b"), P("b", "B", "a")]).get("a"), "B");
});
