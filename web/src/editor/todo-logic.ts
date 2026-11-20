// To-do logic for Notebook pages, kept free of the DOM so it can be tested: where each to-do sits, which ones a
// change ticked or unticked, and what follows from it (a ticked parent ticks everything under it, the last sub-item
// ticks its parent, unticking one unticks the parents above it).
import { Mark, type Node as PMNode } from "@tiptap/pm/model";

export interface Todo {
  /** Position of the taskItem node in the doc. */
  pos: number;
  checked: boolean;
  /** Index of the nearest to-do it sits under, or -1. */
  parent: number;
  /** Indexes of the to-dos directly under it. */
  kids: number[];
  /** Index (in `roots`) of the top-level to-do list it belongs to. */
  root: number;
}

export interface Todos {
  items: Todo[];
  /** Each top-level to-do list (one not inside a to-do) as the indexes of every to-do in it, nested ones included. */
  roots: number[][];
}

export function todos(doc: PMNode): Todos {
  const items: Todo[] = [];
  const roots: number[][] = [];
  const walk = (node: PMNode, pos: number, parent: number, root: number) => {
    node.forEach((child, offset) => {
      const at = pos + offset;
      if (child.type.name === "taskList" && parent < 0 && root < 0) {
        roots.push([]);
        walk(child, at + 1, parent, roots.length - 1);
        return;
      }
      if (child.type.name === "taskItem" && root >= 0) {
        const i = items.length;
        items.push({ pos: at, checked: !!child.attrs.checked, parent, kids: [], root });
        roots[root].push(i);
        if (parent >= 0) items[parent].kids.push(i);
        walk(child, at + 1, i, root);
        return;
      }
      if (!child.isLeaf && !child.isTextblock) walk(child, at + 1, parent, root);
    });
  };
  walk(doc, 0, -1, -1);
  return { items, roots };
}

/** To-dos whose tick changed between two versions of a page, or null when the to-dos themselves changed (added, removed). */
export function flips(a: Todo[], b: Todo[]): number[] | null {
  if (a.length !== b.length) return null;
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].parent !== b[i].parent) return null;
    if (a[i].checked !== b[i].checked) out.push(i);
  }
  return out;
}

/** What else changes after the user ticked or unticked `direct` (already applied in `items`): index → new value. */
export function cascade(items: Todo[], direct: number[]): Map<number, boolean> {
  const val = (i: number) => (out.has(i) ? out.get(i)! : items[i].checked);
  const out = new Map<number, boolean>();
  const down = (i: number, v: boolean) => {
    for (const k of items[i].kids) {
      if (val(k) !== v) out.set(k, v);
      down(k, v);
    }
  };
  for (const i of direct) down(i, items[i].checked);
  // Then up: from every to-do that changed, settle its parents, nearest first.
  const touched = new Set<number>([...direct, ...out.keys()]);
  for (const i of touched) {
    let p = items[i].parent;
    while (p >= 0) {
      const all = items[p].kids.every((k) => val(k));
      const now = val(p);
      if (all && !now) out.set(p, true);
      else if (!all && now) out.set(p, false);
      else break;
      p = items[p].parent;
    }
  }
  for (const i of direct) out.delete(i);
  return out;
}

/** Whether two docs are the same apart from to-do ticks (so a change was only ticking, not a new page or an edit). */
export function sameButTicks(a: PMNode, b: PMNode): boolean {
  if (a === b) return true;
  if (a.type !== b.type || a.childCount !== b.childCount || a.nodeSize !== b.nodeSize || !Mark.sameSet(a.marks, b.marks)) return false;
  if (a.isText) return a.text === b.text;
  const keys = Object.keys(a.attrs).filter((k) => !(k === "checked" && a.type.name === "taskItem"));
  if (keys.some((k) => JSON.stringify(a.attrs[k]) !== JSON.stringify(b.attrs[k]))) return false;
  for (let i = 0; i < a.childCount; i++) if (!sameButTicks(a.child(i), b.child(i))) return false;
  return true;
}

/** To-dos the change between two versions of a page ticked or unticked, when ticking is all it did; otherwise null. */
export function tickFlips(a: PMNode, b: PMNode, ta: Todo[], tb: Todo[]): number[] | null {
  const f = flips(ta, tb);
  if (!f?.length) return f;
  return sameButTicks(a, b) ? f : null;
}

/** The depth of a to-do (0 at the top of its list). */
export function depth(items: Todo[], i: number): number {
  let d = 0;
  for (let p = items[i].parent; p >= 0; p = items[p].parent) d++;
  return d;
}

/** Whether a to-do sits somewhere under another one. */
export function isUnder(items: Todo[], i: number, above: number): boolean {
  for (let p = items[i].parent; p >= 0; p = items[p].parent) if (p === above) return true;
  return false;
}
