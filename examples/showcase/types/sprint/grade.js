const given = Array.isArray(answer?.answers) ? answer.answers : [];
const rows = given.map((g, i) => {
  const text = String(g ?? "").trim();
  const n = text === "" ? NaN : Number(text.replace(/[−–]/g, "-").replace(/,/g, ""));
  return { q: view.problems[i], given: text, want: key.answers[i], ok: n === key.answers[i] };
}).filter((r) => r.q !== undefined);
const correct = rows.filter((r) => r.ok).length;
const answered = rows.filter((r) => r.given !== "").length;
const score = Math.min(1, correct / view.target);
// The card already shows the tally; feedback only says what stood between this round and the target.
const misses = rows.filter((r) => !r.ok && r.given !== "").length;
let feedback;
if (correct < view.target) {
  const short = view.target - correct;
  feedback = misses
    ? `${short} short of the target. ${misses} of your ${answered} answers were wrong: accuracy matters as much as speed.`
    : `${short} short of the target: every answer was right, so it's speed that needs work.`;
}
return { score, feedback, details: { rows, correct, answered } };
