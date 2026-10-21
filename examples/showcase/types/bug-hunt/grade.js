const given = [...new Set((Array.isArray(answer) ? answer : []).map(Number))].sort((a, b) => a - b);
const bugs = new Set(key.bugs);
const right = given.filter((n) => bugs.has(n));
const wrong = given.filter((n) => !bugs.has(n));
const missed = key.bugs.filter((n) => !given.includes(n));
const score = right.length / Math.max(key.bugs.length, given.length, 1);
const lines = (xs) => (xs.length === 1 ? `line ${xs[0]}` : `lines ${xs.join(", ")}`);
let feedback;
if (!given.length) feedback = "No line picked.";
else if (score < 1) {
  const parts = [];
  if (right.length) parts.push(`${lines(right)} ${right.length === 1 ? "is" : "are"} right`);
  if (wrong.length) parts.push(`${lines(wrong)} ${wrong.length === 1 ? "is" : "are"} fine as written`);
  if (missed.length) parts.push(`the bug is on ${lines(missed)}`);
  feedback = parts.join("; ") + ".";
  feedback = feedback[0].toUpperCase() + feedback.slice(1);
}
return { score, feedback, details: { right, wrong, missed } };
