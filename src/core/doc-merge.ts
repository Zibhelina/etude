// Merging two edits of one page made from the same starting point: the editor open on a screen and
// something else (the CLI, an agent, another window) that saved in between. Blocks are compared
// whole, at the top level. A block only one side changed takes that side's version; when both
// changed the same stretch differently, both are kept (the open editor's first), so nothing is lost.

type Doc = { type: "doc"; content?: unknown[] };

/** Pairs of indices (in a and in b) of a longest common subsequence, in order. */
function common(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) out.push([i++, j++]);
    else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return out;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);

/** A three-way merge of lists: what `mine` and `theirs` each changed since `base`. */
export function merge3(base: string[], mine: string[], theirs: string[]): { result: string[]; conflicts: number } {
  const toMine = new Map(common(base, mine));
  const toTheirs = new Map(common(base, theirs));
  // Base blocks both sides kept, in order on both sides: the fixed points between changed stretches.
  const anchors: [number, number, number][] = [];
  let lastM = -1;
  let lastT = -1;
  for (let i = 0; i < base.length; i++) {
    const m = toMine.get(i);
    const t = toTheirs.get(i);
    if (m === undefined || t === undefined || m <= lastM || t <= lastT) continue;
    anchors.push([i, m, t]);
    lastM = m;
    lastT = t;
  }
  anchors.push([base.length, mine.length, theirs.length]);
  const result: string[] = [];
  let conflicts = 0;
  let b0 = 0;
  let m0 = 0;
  let t0 = 0;
  for (const [b1, m1, t1] of anchors) {
    const b = base.slice(b0, b1);
    const m = mine.slice(m0, m1);
    const t = theirs.slice(t0, t1);
    if (same(m, b)) result.push(...t);
    else if (same(t, b) || same(m, t)) result.push(...m);
    else {
      conflicts++;
      result.push(...m, ...t.filter((x) => !m.includes(x)));
    }
    if (b1 < base.length) result.push(base[b1]);
    b0 = b1 + 1;
    m0 = m1 + 1;
    t0 = t1 + 1;
  }
  return { result, conflicts };
}

/** The page with both sides' changes since `base`. All three should be in the same normal form (as the editor writes them). */
export function mergeDocs(base: Doc, mine: Doc, theirs: Doc): { doc: Doc; conflicts: number } {
  const key = (d: Doc) => (d.content ?? []).map((n) => JSON.stringify(n));
  const { result, conflicts } = merge3(key(base), key(mine), key(theirs));
  return { doc: { ...mine, type: "doc", content: result.map((s) => JSON.parse(s)) }, conflicts };
}
