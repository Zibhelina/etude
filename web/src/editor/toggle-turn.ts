// Toggles and toggle headings, like Notion. A toggle heading is a toggle (a `details` block) whose title (its
// `detailsSummary`) has a `level` (1-3) that makes it look like that heading. The level sits on the title because
// TipTap's arrow rewrites the toggle's own attributes when it opens or closes. Turning a heading or a line of text into a toggle heading takes in the blocks
// after it, up to the next heading of its level or bigger, so the whole section folds; a plain toggle starts empty.
// Turning a toggle back into a heading or text puts what was inside right after it.
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";

export type ToggleLevel = 1 | 2 | 3 | null;

/** The heading level a block stands for when deciding where a section ends: a heading's, or a toggle heading's. */
const levelOf = (n: PMNode): number | null => (n.type.name === "heading" ? n.attrs.level : n.type.name === "details" ? toggleLevel(n) : null);
/** A toggle's heading level, null for a plain toggle. */
export const toggleLevel = (details: PMNode): ToggleLevel => (details.firstChild?.attrs.level as ToggleLevel) || null;
const isBlank = (n: PMNode) => n.type.name === "paragraph" && n.content.size === 0;

/** A toggle's title holds plain text with its marks; anything else inline (a formula) keeps its text. */
function titleOf(block: PMNode): Fragment {
  const schema = block.type.schema;
  const out: PMNode[] = [];
  block.content.forEach((c) => {
    if (c.isText) out.push(c);
    else if (c.textContent) out.push(schema.text(c.textContent, c.marks));
  });
  return Fragment.from(out);
}

/**
 * Turns the text block at `pos` into a toggle (`level` null) or a toggle heading. Returns false (and leaves `tr`
 * alone) when the block can't be one there.
 */
export function blockToToggle(tr: Transaction, pos: number, level: ToggleLevel): boolean {
  const block = tr.doc.nodeAt(pos);
  if (!block?.isTextblock || block.type.spec.code) return false;
  const $pos = tr.doc.resolve(pos);
  const parent = $pos.parent, index = $pos.index();
  const { details, detailsSummary, detailsContent, paragraph } = tr.doc.type.schema.nodes;
  if (!details || !detailsSummary || !detailsContent) return false;
  const taken: PMNode[] = [];
  let end = index + 1;
  if (level) {
    for (; end < parent.childCount; end++) {
      const n = parent.child(end);
      const l = levelOf(n);
      if (l !== null && l <= level) break;
      taken.push(n);
    }
    // Empty lines at the very end of the page stay outside, so there's still a line to click below the toggle.
    if (end === parent.childCount) while (taken.length && isBlank(taken[taken.length - 1])) (taken.pop(), end--);
  }
  let node: PMNode;
  try {
    node = details.createChecked({ open: true }, [detailsSummary.create({ level }, titleOf(block)), detailsContent.createChecked(null, taken.length ? taken : [paragraph.create()])]);
  } catch {
    return false;
  }
  if (!parent.canReplace(index, end, Fragment.from(node))) return false;
  let to = pos + block.nodeSize;
  for (const n of taken) to += n.nodeSize;
  tr.replaceWith(pos, to, node);
  tr.setSelection(TextSelection.create(tr.doc, pos + 2 + node.child(0).content.size));
  return true;
}

/**
 * Turns the toggle at `pos` into the text block `make` builds from its title, with what was inside right after it
 * (an inside that's only an empty line is dropped). The cursor goes to the end of the new line.
 */
export function toggleToBlock(tr: Transaction, pos: number, make: (title: Fragment) => PMNode): boolean {
  const node = tr.doc.nodeAt(pos);
  if (node?.type.name !== "details" || node.childCount < 2) return false;
  const head = make(node.child(0).content);
  const inside: PMNode[] = [];
  node.child(1).forEach((k) => inside.push(k));
  const rest = inside.length === 1 && isBlank(inside[0]) ? [] : inside;
  const $pos = tr.doc.resolve(pos);
  if (!$pos.parent.canReplace($pos.index(), $pos.index() + 1, Fragment.from([head, ...rest]))) return false;
  tr.replaceWith(pos, pos + node.nodeSize, [head, ...rest]);
  tr.setSelection(TextSelection.create(tr.doc, pos + 1 + head.content.size));
  return true;
}

/** A toggle becomes a toggle heading (or back to a plain toggle) without moving anything in or out of it. */
export function setToggleLevel(tr: Transaction, pos: number, level: ToggleLevel): boolean {
  const node = tr.doc.nodeAt(pos);
  if (node?.type.name !== "details" || node.firstChild?.type.name !== "detailsSummary") return false;
  tr.setNodeMarkup(pos + 1, undefined, { ...node.firstChild.attrs, level });
  return true;
}

/** The text line the cursor is in, with its position, when it's a heading or a paragraph a toggle can replace. */
export function lineAt(tr: Transaction): { pos: number; node: PMNode } | null {
  const { $from } = tr.selection;
  const node = $from.parent;
  if (!node.isTextblock || node.type.spec.code || !["paragraph", "heading"].includes(node.type.name)) return null;
  // A list item's first line: the toggle would have to replace the item, which "Turn into" doesn't do.
  if ($from.depth > 1 && ["listItem", "taskItem"].includes($from.node(-1).type.name)) return null;
  return { pos: $from.before(), node };
}
