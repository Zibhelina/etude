import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Details, DetailsContent } from "@tiptap/extension-details";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { NoteDetailsSummary } from "../web/src/editor/note-toggle.ts";
import { blockToToggle, setToggleLevel, toggleLevel, toggleToBlock } from "../web/src/editor/toggle-turn.ts";

const schema = getSchema([StarterKit, Details.configure({ persist: true }), NoteDetailsSummary, DetailsContent]);
const p = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const h = (level: number, text: string) => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
const toggle = (level: number | null, title: string, ...inside: any[]) => ({ type: "details", attrs: { open: true }, content: [{ type: "detailsSummary", attrs: { level }, content: title ? [{ type: "text", text: title }] : [] }, { type: "detailsContent", content: inside }] });

const state = (content: any[]) => EditorState.create({ doc: schema.nodeFromJSON({ type: "doc", content }) });
/** Position of the top-level block whose text starts with `text`. */
function posOf(s: EditorState, text: string) {
  let at = -1;
  s.doc.forEach((n, off) => {
    if (at < 0 && n.textContent.startsWith(text)) at = off;
  });
  assert.ok(at >= 0, `found ${text}`);
  return at;
}
/** The page as an outline: headings as "# x", toggles as { "▸2 title": [inside] }. */
function shape(n: any): any {
  if (n.type.name === "doc") return n.content.content.map(shape);
  if (n.type.name === "heading") return `${"#".repeat(n.attrs.level)} ${n.textContent}`;
  if (n.type.name === "details") return { [`▸${toggleLevel(n) ?? ""} ${n.child(0).textContent}`]: n.child(1).content.content.map(shape) };
  return n.textContent;
}

test("a heading becomes a toggle heading that takes in its section, up to the next heading as big or bigger", () => {
  const s = state([h(2, "TODO's"), p("a"), h(3, "sub"), p("b"), h(2, "University"), p("c")]);
  const tr = s.tr;
  assert.ok(blockToToggle(tr, posOf(s, "TODO"), 2));
  assert.deepEqual(shape(tr.doc), [{ "▸2 TODO's": ["a", "### sub", "b"] }, "## University", "c"]);
  assert.equal(tr.selection.$from.parent.type.name, "detailsSummary");
  assert.equal(tr.selection.$from.parentOffset, "TODO's".length);
});

test("a toggle heading's section also ends at a toggle heading as big or bigger, and leaves the page's last empty line out", () => {
  const s = state([h(3, "One"), p("a"), toggle(2, "Two", p("x")), p("")]);
  const t1 = s.tr;
  assert.ok(blockToToggle(t1, posOf(s, "One"), 3));
  assert.deepEqual(shape(t1.doc), [{ "▸3 One": ["a"] }, { "▸2 Two": ["x"] }, ""]);
  const s2 = state([h(1, "Last"), p("a"), p(""), p("")]);
  const t2 = s2.tr;
  assert.ok(blockToToggle(t2, posOf(s2, "Last"), 1));
  assert.deepEqual(shape(t2.doc), [{ "▸1 Last": ["a"] }, "", ""]);
});

test("a plain toggle takes nothing in and starts with an empty line inside", () => {
  const s = state([p("Fold me"), p("stays")]);
  const tr = s.tr;
  assert.ok(blockToToggle(tr, posOf(s, "Fold"), null));
  assert.deepEqual(shape(tr.doc), [{ "▸ Fold me": [""] }, "stays"]);
});

test("a toggle turned back into a line puts what was inside right after it", () => {
  const s = state([toggle(2, "TODO's", p("a"), p("b")), p("after")]);
  const tr = s.tr;
  assert.ok(toggleToBlock(tr, 0, (title) => schema.nodes.heading.create({ level: 2 }, title)));
  assert.deepEqual(shape(tr.doc), ["## TODO's", "a", "b", "after"]);
  const s2 = state([toggle(null, "Empty", p(""))]);
  const t2 = s2.tr;
  assert.ok(toggleToBlock(t2, 0, (title) => schema.nodes.paragraph.create(null, title)));
  assert.deepEqual(shape(t2.doc), ["Empty"]);
});

test("a toggle changes size in place, the level survives a round trip through JSON and opening or closing it", () => {
  const s = state([toggle(null, "T", p("x"))]);
  const tr = s.tr;
  assert.ok(setToggleLevel(tr, 0, 3));
  assert.deepEqual(shape(tr.doc), [{ "▸3 T": ["x"] }]);
  assert.equal(toggleLevel(schema.nodeFromJSON(tr.doc.toJSON()).child(0)), 3);
  // What TipTap's arrow does: it rewrites the toggle's own attributes.
  tr.setNodeMarkup(0, undefined, { open: false });
  assert.equal(toggleLevel(tr.doc.child(0)), 3);
});

test("a line inside a list item isn't turned (Turn into falls back to a plain toggle there)", () => {
  const s = state([{ type: "bulletList", content: [{ type: "listItem", content: [p("item")] }] }]);
  const tr = s.tr;
  assert.equal(blockToToggle(tr, 2, 2), false);
  assert.equal(tr.steps.length, 0);
});

test("the summary keeps the heading's marked text", () => {
  const s = state([{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Bold", marks: [{ type: "bold" }] }, { type: "text", text: " plain" }] }]);
  const tr = s.tr;
  assert.ok(blockToToggle(tr, 0, 1));
  const sum = tr.doc.child(0).child(0);
  assert.equal(sum.textContent, "Bold plain");
  assert.equal(sum.child(0).marks[0]?.type.name, "bold");
  void TextSelection;
});
