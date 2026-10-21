const given = Array.isArray(answer) ? answer.map(String) : [];
const order = key.order;
let k = 0;
while (k < order.length && given[k] === order[k]) k++;
// The start node is placed for the learner, so it doesn't earn credit.
const score = order.length > 1 ? Math.max(0, k - 1) / (order.length - 1) : 1;
let feedback;
const name = view.algorithm === "bfs" ? "BFS" : "DFS";
if (k < order.length) {
  if (k >= given.length) feedback = `Correct for the first ${k} nodes, then the order stopped. ${name} visits ${order[k]} next.`;
  else feedback = `Correct for the first ${k} node${k === 1 ? "" : "s"}. Step ${k + 1} is ${order[k]}, not ${given[k]}. (${Math.max(0, k - 1)} of ${order.length - 1} moves after the start.)`;
}
return { score, feedback, details: { prefix: k, given } };
