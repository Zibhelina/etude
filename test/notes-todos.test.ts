import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { cascade, flips, tickFlips, todos } from "../web/src/editor/todo-logic.ts";

const schema = getSchema([StarterKit, TaskList, TaskItem.configure({ nested: true })]);
type T = [string, boolean, T[]?];
const item = ([text, checked, kids]: T): any => ({
  type: "taskItem",
  attrs: { checked },
  content: [{ type: "paragraph", content: [{ type: "text", text }] }, ...(kids ? [{ type: "taskList", content: kids.map(item) }] : [])],
});
const doc = (...lists: T[][]) => schema.nodeFromJSON({ type: "doc", content: lists.flatMap((l) => [{ type: "paragraph" }, { type: "taskList", content: l.map(item) }]) });
const ticked = (d: ReturnType<typeof doc>) => todos(d).items.map((i) => i.checked);

test("todos: finds each to-do with its parent, sub-items and list", () => {
  const t = todos(doc([["a", false], ["b", false, [["b1", true], ["b2", false, [["b2x", false]]]]]], [["c", true]]));
  assert.equal(t.items.length, 6);
  assert.deepEqual(t.items.map((i) => i.parent), [-1, -1, 1, 1, 3, -1]);
  assert.deepEqual(t.items[1].kids, [2, 3]);
  assert.deepEqual(t.roots, [[0, 1, 2, 3, 4], [5]]);
});

test("flips: which ticks changed, and none when the to-dos themselves changed", () => {
  const a = todos(doc([["a", false], ["b", false]])).items;
  assert.deepEqual(flips(a, todos(doc([["a", true], ["b", false]])).items), [0]);
  assert.equal(flips(a, todos(doc([["a", false], ["b", false], ["c", false]])).items), null);
});

test("cascade: ticking a parent ticks everything under it", () => {
  const t = todos(doc([["p", true, [["k1", false], ["k2", true, [["g", false]]]]]])).items;
  assert.deepEqual([...cascade(t, [0])].sort(), [[1, true], [3, true]]);
});

test("cascade: the last sub-item ticks its parent, and the parent above that", () => {
  const t = todos(doc([["top", false, [["p", false, [["k1", true], ["k2", true]]], ["q", true]]]])).items;
  assert.deepEqual(new Map(cascade(t, [3])), new Map([[1, true], [0, true]]));
});

test("cascade: unticking one sub-item unticks the parents above it, not its siblings", () => {
  const t = todos(doc([["top", true, [["p", true, [["k1", false], ["k2", true]]]]]])).items;
  assert.deepEqual(new Map(cascade(t, [2])), new Map([[1, false], [0, false]]));
});

test("cascade: unticking a parent unticks its sub-items", () => {
  const t = todos(doc([["p", false, [["k1", true], ["k2", true]]]])).items;
  assert.deepEqual(new Map(cascade(t, [0])), new Map([[1, false], [2, false]]));
});

test("cascade: a tick with nothing under or above it changes nothing else", () => {
  const t = todos(doc([["a", true], ["b", false]])).items;
  assert.equal(cascade(t, [0]).size, 0);
  assert.deepEqual(ticked(doc([["a", true], ["b", false]])), [true, false]);
});

test("tickFlips: only a change that just ticks counts, not a new page with the same shape", () => {
  const a = doc([["a", false], ["b", true]]);
  const ticked = doc([["a", true], ["b", true]]);
  const other = doc([["x", true], ["y", false]]);
  assert.deepEqual(tickFlips(a, ticked, todos(a).items, todos(ticked).items), [0]);
  assert.equal(tickFlips(a, other, todos(a).items, todos(other).items), null);
});
