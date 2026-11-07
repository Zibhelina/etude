// Cleans a note's document tree before the editor or the database sees it. ProseMirror refuses a text node
// with no text, and when one is there the editor drops the whole page and shows it empty. Pages written by
// hand, by the API or by an import can have one (an empty table cell is the usual case), so they're removed.
// Shared by the server (on save) and the web editor (on load, for pages saved before this existed).

export interface CleanNode {
  type: string;
  text?: string;
  content?: CleanNode[];
}

/** The same tree without empty text nodes. Returns the input itself when there was nothing to remove. */
export function dropEmptyText<T extends CleanNode>(node: T): T {
  if (!node.content) return node;
  let changed = false;
  const kids: CleanNode[] = [];
  for (const k of node.content) {
    if (k && k.type === "text" && !k.text) {
      changed = true;
      continue;
    }
    const c = k && typeof k === "object" ? dropEmptyText(k) : k;
    if (c !== k) changed = true;
    kids.push(c);
  }
  return changed ? { ...node, content: kids } : node;
}
