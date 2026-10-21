// Best one-to-one matching of placed points to expected points (brute force; a handful of points).
const placed = (Array.isArray(answer) ? answer : []).filter((p) => Array.isArray(p) && p.every(Number.isFinite)).slice(0, 12);
const want = key.points;
const tol = key.tolerance;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

let best = { hits: -1, total: Infinity, pairs: [] };
function search(i, used, pairs, hits, total) {
  if (i === want.length) {
    if (hits > best.hits || (hits === best.hits && total < best.total)) best = { hits, total, pairs: pairs.slice() };
    return;
  }
  // leave expected point i unmatched
  pairs.push(-1);
  search(i + 1, used, pairs, hits, total);
  pairs.pop();
  for (let j = 0; j < placed.length; j++) {
    if (used & (1 << j)) continue;
    const d = dist(want[i], placed[j]);
    if (d > tol + 1e-9) continue;
    pairs.push(j);
    search(i + 1, used | (1 << j), pairs, hits + 1, total + d);
    pairs.pop();
  }
}
search(0, 0, [], 0, 0);

const hits = best.hits;
const matched = new Set(best.pairs.filter((j) => j >= 0));
const extras = placed.map((_, j) => j).filter((j) => !matched.has(j));
const score = want.length ? Math.max(0, (hits - 0.5 * extras.length) / want.length) : extras.length ? 0 : 1;
let feedback;
const missed = want.length - hits;
if (score < 1) {
  const bits = [];
  if (hits) bits.push(`${hits} of ${want.length} right`);
  if (missed) bits.push(`${missed} missed`);
  if (extras.length) bits.push(`${extras.length} extra (each costs half a point)`);
  feedback = bits.join(", ") + ".";
}
return {
  score: Math.round(score * 100) / 100,
  feedback,
  details: { placed, match: best.pairs, extras },
};
