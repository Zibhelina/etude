const guess = answer && typeof answer === "object" ? answer : {};
const ids = view.chips.map((c) => c.id);
const placed = ids.filter((id) => Number.isFinite(guess[id]));
if (!placed.length) return { score: 0, feedback: "Nothing placed." };
const span = view.to - view.from;
const tol = key.tolerance;
// Closeness: full within the tolerance, falling to 0 at a fifth of the timeline away.
const close = (id) => {
  if (!Number.isFinite(guess[id])) return 0;
  const off = Math.abs(guess[id] - key.years[id]);
  return off <= tol ? 1 : Math.max(0, 1 - (off - tol) / (span / 5));
};
// Order: the longest run of placed events already in true order.
const byGuess = placed.slice().sort((a, b) => guess[a] - guess[b]);
const order = std.lis(byGuess.map((id) => key.years[id])) / ids.length;
const closeness = ids.reduce((s, id) => s + close(id), 0) / ids.length;
const score = Math.round((0.5 * order + 0.5 * closeness) * 100) / 100;
const off = Object.fromEntries(ids.map((id) => [id, Number.isFinite(guess[id]) ? Math.round(guess[id] - key.years[id]) : null]));
const worst = ids.filter((id) => off[id] !== null).sort((a, b) => Math.abs(off[b]) - Math.abs(off[a]))[0];
let feedback;
if (score < 1) {
  const parts = [];
  if (placed.length < ids.length) parts.push(`${ids.length - placed.length} not placed`);
  if (order < placed.length / ids.length) parts.push("some are out of order");
  const far = ids.filter((id) => off[id] !== null && Math.abs(off[id]) > tol).length;
  if (worst && Math.abs(off[worst]) > tol) parts.push(`${far > 1 ? `${far} events are more than ${tol} years off; the furthest, ` : ""}${view.chips.find((c) => c.id === worst).label}, is ${Math.abs(off[worst])} years ${off[worst] > 0 ? "too late" : "too early"}`);
  feedback = parts.length ? parts.join("; ").replace(/^./, (ch) => ch.toUpperCase()) + "." : undefined;
}
return { score, feedback, details: { off } };
