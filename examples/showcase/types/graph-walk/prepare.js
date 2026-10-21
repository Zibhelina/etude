// A connected graph on a jittered 3×3 grid. Edges only join neighbouring cells (and at most one
// diagonal per square), so no edge crosses a node or another edge.
const W = 3, H = 3;
const want = Number(fields.size);
const n = want >= 6 && want <= 9 ? Math.round(want) : rng.int(6, 9);
const cell = (c, r) => r * W + c;
const neigh = (i) => {
  const c = i % W, r = Math.floor(i / W), out = [];
  for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const cc = c + dc, rr = r + dr;
    if (cc >= 0 && cc < W && rr >= 0 && rr < H) out.push(cell(cc, rr));
  }
  return out;
};
// Grow a connected set of n cells from a random one.
const cells = [rng.int(0, W * H - 1)];
while (cells.length < n) {
  const frontier = [...new Set(cells.flatMap(neigh))].filter((x) => !cells.includes(x));
  cells.push(rng.pick(frontier));
}
const used = new Set(cells);
const cand = [];
for (const a of cells) {
  const c = a % W, r = Math.floor(a / W);
  if (c + 1 < W && used.has(cell(c + 1, r))) cand.push([a, cell(c + 1, r)]);
  if (r + 1 < H && used.has(cell(c, r + 1))) cand.push([a, cell(c, r + 1)]);
  // One diagonal per square at most.
  if (c + 1 < W && r + 1 < H) {
    const d1 = [a, cell(c + 1, r + 1)], d2 = [cell(c + 1, r), cell(c, r + 1)];
    const ok1 = used.has(d1[1]), ok2 = used.has(d2[0]) && used.has(d2[1]);
    if (ok1 && ok2) cand.push(rng.bool() ? d1 : d2);
    else if (ok1) cand.push(d1);
    else if (ok2) cand.push(d2);
  }
}
// Random spanning tree over the candidates (Kruskal on a shuffle), then a few extra edges.
const parent = {};
const find = (x) => (parent[x] === undefined || parent[x] === x ? x : (parent[x] = find(parent[x])));
const edges = [], extra = [];
for (const e of rng.shuffle(cand)) {
  const a = find(e[0]), b = find(e[1]);
  if (a !== b) { parent[a] = b; edges.push(e); } else extra.push(e);
}
const extras = Math.min(extra.length, rng.int(1, 3));
edges.push(...extra.slice(0, extras));

// Letters are assigned at random so alphabetical order isn't left-to-right.
const letters = rng.shuffle("ABCDEFGHI".slice(0, n).split(""));
const label = Object.fromEntries(cells.map((c, i) => [c, letters[i]]));
const nodes = cells.map((c) => ({
  id: label[c],
  x: 66 + (c % W) * 120 + rng.int(-14, 14),
  y: 48 + Math.floor(c / W) * 102 + rng.int(-12, 12),
})).sort((a, b) => a.id.localeCompare(b.id));
const edgeList = edges.map(([a, b]) => [label[a], label[b]].sort()).sort((p, q) => (p[0] + p[1]).localeCompare(q[0] + q[1]));

const adj = Object.fromEntries(nodes.map((v) => [v.id, []]));
for (const [a, b] of edgeList) { adj[a].push(b); adj[b].push(a); }
for (const k in adj) adj[k].sort();

let algo = String(fields.algorithm ?? "bfs").toLowerCase();
if (algo !== "bfs" && algo !== "dfs") algo = rng.pick(["bfs", "dfs"]);
const start = rng.pick(nodes).id;
const order = [], tree = [], seen = new Set([start]);
if (algo === "bfs") {
  const q = [start];
  while (q.length) {
    const v = q.shift();
    order.push(v);
    for (const w of adj[v]) if (!seen.has(w)) { seen.add(w); tree.push([v, w]); q.push(w); }
  }
} else {
  const visit = (v) => {
    order.push(v);
    for (const w of adj[v]) if (!seen.has(w)) { seen.add(w); tree.push([v, w]); visit(w); }
  };
  visit(start);
}
return {
  view: { algorithm: algo, start, nodes, edges: edgeList, note: fields.note ?? "" },
  key: { order, tree, explanation: fields.explanation ?? "" },
};
