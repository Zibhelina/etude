const given = Array.isArray(answer) ? answer : [];
const pos = Object.fromEntries(key.order.map((id, i) => [id, i]));
const seq = given.map((id) => pos[id]).filter((p) => p !== undefined);
const exact = seq.length === key.order.length && seq.every((p, i) => p === i);
// Longest increasing subsequence: the blocks that are already in a correct relative order.
const tails = [], prev = [], idx = [];
seq.forEach((x, i) => {
  let lo = 0, hi = tails.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < x) lo = m + 1; else hi = m; }
  tails[lo] = x; idx[lo] = i; prev[i] = lo > 0 ? idx[lo - 1] : -1;
});
const run = [];
for (let i = idx[tails.length - 1]; i !== undefined && i >= 0; i = prev[i]) run.unshift(given[i]);
const score = exact ? 1 : tails.length / key.order.length;
return { score: exact ? 1 : Math.min(score, 0.9), details: { inOrder: run } };
