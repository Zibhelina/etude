const { view } = etude;
const NS = "http://www.w3.org/2000/svg";
const svg = etude.$(".gw-svg");
const seqEl = etude.$(".gw-seq");
const name = view.algorithm === "bfs" ? "breadth-first search (BFS)" : "depth-first search (DFS)";
etude.$(".gw-prompt").innerHTML =
  etude.md(`Tap the nodes in the order **${name}** visits them, starting from **${view.start}**.`) +
  `<p class="rule">When a node has several unvisited neighbours, take them in alphabetical order.</p>` +
  (view.note ? etude.md(view.note) : "");

const pos = Object.fromEntries(view.nodes.map((n) => [n.id, n]));
const nb = Object.fromEntries(view.nodes.map((n) => [n.id, []]));
for (const [a, b] of view.edges) { nb[a].push(b); nb[b].push(a); }
for (const k in nb) nb[k].sort();
const el = (tag, attrs, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};
const edgeEls = {};
const edgesG = el("g", {}, svg);
for (const [a, b] of view.edges) {
  edgeEls[[a, b].sort().join("")] = el("line", { class: "gw-edge", x1: pos[a].x, y1: pos[a].y, x2: pos[b].x, y2: pos[b].y }, edgesG);
}
const nodeEls = {};
for (const n of view.nodes) {
  const g = el("g", { class: "gw-node", tabindex: "0", role: "button", "aria-label": `Node ${n.id}`, "data-id": n.id }, svg);
  el("circle", { class: "hit", cx: n.x, cy: n.y, r: 30 }, g);
  el("circle", { class: "disc", cx: n.x, cy: n.y, r: 20 }, g);
  el("text", { class: "lbl", x: n.x, y: n.y }, g).textContent = n.id;
  // The order badge goes in the diagonal corner farthest from this node's edges.
  const angles = nb[n.id].map((m) => Math.atan2(pos[m].y - n.y, pos[m].x - n.x));
  const gap = (a) => Math.min(...angles.map((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))), Math.PI);
  const corner = [-Math.PI / 4, -3 * Math.PI / 4, Math.PI / 4, 3 * Math.PI / 4].reduce((best, a) => (gap(a) > gap(best) + 0.01 ? a : best));
  const bx = n.x + 27 * Math.cos(corner), by = n.y + 27 * Math.sin(corner);
  el("circle", { class: "badge", cx: bx, cy: by, r: 10 }, g);
  el("text", { class: "num", x: bx, y: by + 0.5 }, g);
  nodeEls[n.id] = g;
}

// The start node is given: the order always begins there.
let seq = [view.start];
if (Array.isArray(etude.answer) && etude.answer[0] === view.start) seq = etude.answer.filter((id) => pos[id]);

const paint = (marks) => {
  for (const [id, g] of Object.entries(nodeEls)) {
    const i = seq.indexOf(id);
    g.classList.toggle("picked", i >= 0);
    g.classList.toggle("start", id === view.start);
    g.classList.toggle("last", etude.mode === "answer" && i >= 1 && i === seq.length - 1);
    g.querySelector(".num").textContent = i >= 0 ? String(i + 1) : "";
    g.setAttribute("aria-label", `Node ${id}${i >= 0 ? `, visited ${i + 1}` : ""}; neighbours ${nb[id].join(" ")}`);
    if (marks) { g.classList.toggle("ok", marks[id] === "ok"); g.classList.toggle("bad", marks[id] === "bad"); g.classList.toggle("after", marks[id] === "after"); }
  }
  // Each arrow travels with the step after it, so a wrapped row never ends on an arrow.
  seqEl.innerHTML = seq.map((id, i) => {
    const cls = marks ? marks[id] ?? "" : "";
    return `<span class="hop">${i ? `<span class="arrow">→</span>` : ""}<span class="step ${cls}">${id}</span></span>`;
  }).join("") + (seq.length === 1 && etude.mode === "answer" ? `<span class="arrow">→</span><span class="empty">tap the next node</span>` : "");
  etude.setReady(etude.mode === "answer" && seq.length > 1);
};
const tap = (id) => {
  if (etude.mode !== "answer") return;
  const i = seq.indexOf(id);
  if (i < 0) seq.push(id);
  else if (i === seq.length - 1 && i > 0) seq.pop();
  else return;
  paint();
};
svg.addEventListener("click", (e) => {
  const g = e.target.closest(".gw-node");
  if (g) tap(g.dataset.id);
});
window.addEventListener("keydown", (e) => {
  if (etude.mode !== "answer" || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toUpperCase();
  if (k.length === 1 && pos[k]) { e.preventDefault(); tap(k); }
  else if (e.key === "Backspace" && seq.length > 1) { e.preventDefault(); tap(seq[seq.length - 1]); }
  else if ((e.key === "Enter" || e.key === " ") && e.target.closest?.(".gw-node")) { e.preventDefault(); tap(e.target.closest(".gw-node").dataset.id); }
});
paint();
etude.getAnswer(() => seq.slice());

// After grading: mark the attempt, then walk the real order and grow its traversal tree.
let playing = 0;
const play = async (key) => {
  const run = ++playing;
  const truth = etude.$(".gw-truth");
  truth.innerHTML = key.order.map((id, i) => `<span class="hop">${i ? `<span class="arrow">→</span>` : ""}<span class="step" data-id="${id}">${id}</span></span>`).join("");
  Object.values(edgeEls).forEach((l) => l.classList.remove("tree"));
  Object.values(nodeEls).forEach((g) => g.classList.remove("lit", "lit-now"));
  const parentOf = Object.fromEntries(key.tree.map(([p, c]) => [c, p]));
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  for (const id of key.order) {
    if (run !== playing) return;
    if (parentOf[id]) edgeEls[[parentOf[id], id].sort().join("")]?.classList.add("tree");
    Object.values(nodeEls).forEach((g) => g.classList.remove("lit-now"));
    nodeEls[id].classList.add("lit", "lit-now");
    truth.querySelector(`[data-id="${id}"]`)?.classList.add("lit");
    if (!reduce) await new Promise((r) => setTimeout(r, 520));
  }
  nodeEls[key.order[key.order.length - 1]].classList.remove("lit-now");
};
etude.onResult(({ key, answer, grade }) => {
  if (Array.isArray(answer)) seq = answer.filter((id) => pos[id]);
  const prefix = grade?.details?.prefix ?? 0;
  // Right up to the first mistake, the mistake itself, then the rest left unjudged.
  const marks = {};
  seq.forEach((id, i) => (marks[id] = i < prefix ? "ok" : i === prefix ? "bad" : "after"));
  for (const g of Object.values(nodeEls)) g.removeAttribute("tabindex");
  paint(grade?.details ? marks : null);
  etude.$(".gw-replay")?.addEventListener("click", () => play(key));
  play(key);
});
