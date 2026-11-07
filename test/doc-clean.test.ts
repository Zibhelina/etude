import { test } from "node:test";
import assert from "node:assert/strict";
import { dropEmptyText } from "../src/core/doc-clean.ts";
import { checkDoc } from "../src/core/notes.ts";

// An empty table cell written by a script or an import used to make the editor show the whole page empty.
const cell = (text: string) => ({ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const page = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }, { type: "text", text: "" }] }, { type: "table", content: [{ type: "tableRow", content: [cell(""), cell("x")] }] }] };

test("empty text nodes are removed at every depth, everything else stays", () => {
  const out = dropEmptyText(page as any) as any;
  assert.deepEqual(out.content[0].content, [{ type: "text", text: "hi" }]);
  assert.deepEqual(out.content[1].content[0].content[0].content[0], { type: "paragraph", content: [] });
  assert.equal(out.content[1].content[0].content[1].content[0].content[0].text, "x");
  assert.equal(JSON.stringify(page).includes('"text":""'), true, "the input isn't changed");
});

test("a clean tree comes back as the same object", () => {
  const clean = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] };
  assert.equal(dropEmptyText(clean), clean);
});

test("saving a page drops them too", () => {
  assert.equal(JSON.stringify(checkDoc(page)).includes('"text":""'), false);
});
