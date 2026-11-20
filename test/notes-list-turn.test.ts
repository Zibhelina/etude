import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { backspaceAtStart, turnItem, wrapInTodo } from "../web/src/editor/list-turn.ts";

const schema = getSchema([StarterKit, TaskList, TaskItem.configure({ nested: true })]);
const p = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const li = (text: string, ...kids: any[]) => ({ type: "listItem", content: [p(text), ...kids] });
const ti = (text: string, checked = false, ...kids: any[]) => ({ type: "taskItem", attrs: { checked }, content: [p(text), ...kids] });
const ul = (...items: any[]) => ({ type: "bulletList", content: items });
const tl = (...items: any[]) => ({ type: "taskList", content: items });
const ol = (...items: any[]) => ({ type: "orderedList", content: items });

/** A state with the cursor `at` characters into the paragraph whose text is `line`. */
function stateAt(content: any[], line: string, at = 0) {
  const doc = schema.nodeFromJSON({ type: "doc", content });
  let pos = -1;
  doc.descendants((n, q) => {
    if (pos < 0 && n.type.name === "paragraph" && n.textContent === line) pos = q + 1 + at;
    return pos < 0;
  });
  assert.ok(pos >= 0, `found ${line}`);
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}
/** The page as a nested outline: list kind, then each item's text and its sub-lists. */
function shape(n: any): any {
  if (n.type.name === "doc") return n.content.content.map(shape);
  if (n.type.name === "paragraph") return n.textContent;
  if (n.type.name === "listItem" || n.type.name === "taskItem") {
    const [first, ...rest] = n.content.content;
    const mark = n.type.name === "taskItem" ? (n.attrs.checked ? "[x] " : "[ ] ") : "";
    return rest.length ? [mark + first.textContent, ...rest.map(shape)] : mark + first.textContent;
  }
  return { [n.type.name]: n.content.content.map(shape) };
}
const lineAtCursor = (s: EditorState) => s.selection.$from.parent.textContent;

// A bullet item with sub-bullets, between to-dos.
const page = () => [
  ul(
    li("University", tl(ti("CMPT 307 lecture", true)), ul(li("CMPT 361", ul(li("G7"), li("lecure"), li("")))), tl(ti("CMPT 371"))),
  ),
];

test("a nested bullet becomes a to-do in place; the bullets around it stay", () => {
  const s = stateAt(page(), "G7", 1);
  const tr = s.tr;
  assert.equal(turnItem(tr, "taskList"), "done");
  const out = shape(tr.doc);
  assert.deepEqual(out[0].bulletList[0][2].bulletList[0], ["CMPT 361", { taskList: ["[ ] G7"] }, { bulletList: ["lecure", ""] }]);
  assert.equal(lineAtCursor(s.apply(tr)), "G7");
  assert.equal(tr.selection.$from.parentOffset, 1, "the cursor keeps its place in the text");
});

test("a bullet between to-do lists joins them into one list, keeping its sub-items", () => {
  const s = stateAt(page(), "CMPT 361");
  const tr = s.tr;
  assert.equal(turnItem(tr, "taskList"), "done");
  assert.deepEqual(shape(tr.doc)[0].bulletList[0], ["University", { taskList: ["[x] CMPT 307 lecture", ["[ ] CMPT 361", { bulletList: ["G7", "lecure", ""] }], "[ ] CMPT 371"] }]);
});

test("a to-do becomes a bullet, a numbered item, or text, and comes back ticked when asked", () => {
  let s = stateAt([tl(ti("a"), ti("b", true), ti("c"))], "b");
  let tr = s.tr;
  assert.equal(turnItem(tr, "bulletList"), "done");
  assert.deepEqual(shape(tr.doc), [{ taskList: ["[ ] a"] }, { bulletList: ["b"] }, { taskList: ["[ ] c"] }]);
  s = s.apply(tr);
  tr = s.tr;
  assert.equal(turnItem(tr, "taskList", { checked: true }), "done");
  assert.deepEqual(shape(tr.doc), [{ taskList: ["[ ] a", "[x] b", "[ ] c"] }], "joined back into one list");

  tr = stateAt([tl(ti("a"), ti("b"))], "b").tr;
  assert.equal(turnItem(tr, "text"), "done");
  assert.deepEqual(shape(tr.doc), [{ taskList: ["[ ] a"] }, "b"]);
  assert.equal(tr.selection.$from.parent.textContent, "b");

  tr = stateAt([ul(li("a", ul(li("x"), li("y"))))], "y").tr;
  assert.equal(turnItem(tr, "text"), "done");
  assert.deepEqual(shape(tr.doc), [{ bulletList: [["a", { bulletList: ["x"] }, "y"]] }], "a nested item turned to text stays under its parent");
});

test("an ordered list cut in two starts again after the cut", () => {
  const tr = stateAt([ol(li("one"), li("two"), li("three"))], "two").tr;
  assert.equal(turnItem(tr, "taskList"), "done");
  const lists = tr.doc.content.content;
  assert.deepEqual(lists.map((n) => n.type.name), ["orderedList", "taskList", "orderedList"]);
  assert.equal(lists[2].attrs.start, 1);
});

test("same kind, a line that isn't an item's own, and plain paragraphs", () => {
  assert.equal(turnItem(stateAt(page(), "G7").tr, "bulletList"), "same");
  assert.equal(turnItem(stateAt([p("hello")], "hello").tr, "taskList"), null);
  assert.equal(turnItem(stateAt([ul(li("a", p("second line")))], "second line").tr, "taskList"), null, "a second paragraph of an item isn't its line");
  const tr = stateAt([p("buy milk")], "buy milk").tr;
  assert.equal(wrapInTodo(tr, false), true);
  assert.deepEqual(shape(tr.doc), [{ taskList: ["[ ] buy milk"] }]);
  assert.equal(wrapInTodo(stateAt(page(), "G7").tr, false), false, "never wraps an item's line in a second list");
});

/** Backspace pressed `n` times, each on the state the last one left; the outline after each. */
function backspaces(s: EditorState, n: number) {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const tr = s.tr;
    if (!backspaceAtStart(tr)) {
      out.push("(editor's own)");
      break;
    }
    s = s.apply(tr);
    out.push({ page: shape(s.doc), at: `${s.selection.$from.parent.textContent}@${s.selection.$from.parentOffset}` });
  }
  return out;
}

test("backspace on an empty nested to-do: plain text where it was, then gone, the cursor at the end of the line above", () => {
  const steps = backspaces(stateAt([ul(li("CMPT 361", tl(ti("G7"), ti("")), ul(li("lecure"))))], ""), 2);
  assert.deepEqual(steps[0].page, [{ bulletList: [["CMPT 361", { taskList: ["[ ] G7"] }, "", { bulletList: ["lecure"] }]] }]);
  assert.deepEqual(steps[1].page, [{ bulletList: [["CMPT 361", { taskList: ["[ ] G7"] }, { bulletList: ["lecure"] }]] }]);
  assert.equal(steps[1].at, "G7@2");
});

test("backspace at the start of a written item: text in place, then it joins the line above", () => {
  const steps = backspaces(stateAt([ul(li("CMPT 361", ul(li("G7"), li("lecure"))))], "G7"), 2);
  assert.deepEqual(steps[0].page, [{ bulletList: [["CMPT 361", "G7", { bulletList: ["lecure"] }]] }]);
  assert.equal(steps[0].at, "G7@0");
  assert.deepEqual(steps[1].page, [{ bulletList: [["CMPT 361G7", { bulletList: ["lecure"] }]] }]);
  assert.equal(steps[1].at, "CMPT 361G7@8");
});

test("backspace on a line under a list joins its last line; elsewhere the editor does its usual thing", () => {
  const steps = backspaces(stateAt([ul(li("a"), li("b")), p("more")], "more"), 1);
  assert.deepEqual(steps[0].page, [{ bulletList: ["a", "bmore"] }]);
  assert.deepEqual(backspaces(stateAt([p("one"), p("two")], "two"), 1), ["(editor's own)"]);
  assert.deepEqual(backspaces(stateAt([ul(li("a"))], "a", 1), 1), ["(editor's own)"], "not at the start of the line");
});

test("an item's turn keeps the cursor on its text, through the cut and the join", () => {
  const s = stateAt([tl(ti("a")), ul(li("b"), li("c"), li("d"))], "c", 1);
  const tr = s.tr;
  turnItem(tr, "taskList");
  assert.deepEqual(shape(tr.doc), [{ taskList: ["[ ] a"] }, { bulletList: ["b"] }, { taskList: ["[ ] c"] }, { bulletList: ["d"] }]);
  assert.equal(`${tr.selection.$from.parent.textContent}@${tr.selection.$from.parentOffset}`, "c@1");
  const t2 = stateAt([tl(ti("a")), ul(li("b"))], "b", 1).tr;
  turnItem(t2, "taskList");
  assert.deepEqual(shape(t2.doc), [{ taskList: ["[ ] a", "[ ] b"] }]);
  assert.equal(`${t2.selection.$from.parent.textContent}@${t2.selection.$from.parentOffset}`, "b@1");
});
