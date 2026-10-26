// Names are compared without case, accents or punctuation, with a typo allowance that grows
// with length. A name that belongs to another box is never accepted for this one.
const norm = (s) => String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const allowed = (n) => (n <= 4 ? 0 : n <= 8 ? 1 : 2);
function dist(a, b) {
  // Optimal string alignment (Damerau-Levenshtein with adjacent transpositions).
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[m][n];
}
const best = (given, list) => {
  let out = { d: Infinity, label: "" };
  for (const label of list) {
    const t = norm(label);
    if (!t) continue;
    const d = dist(given, t);
    if (d < out.d) out = { d, label, len: t.length };
  }
  return out;
};

const answers = key.answers ?? [];
const shown = answers[0] ?? "";
const typed = typeof answer === "string" ? answer : String(answer?.text ?? "");
const given = norm(typed);
if (!given) return { score: 0, feedback: `This one is **${shown}**.`, details: { shown: true } };

const own = best(given, answers);
// The other part is named by its own first label, whichever alternative was typed.
let other = { d: Infinity, label: "" };
for (const o of key.others ?? []) {
  const b = best(given, o.answers ?? []);
  if (b.d < other.d) other = { ...b, label: o.answers[0] };
}
const fits = (b) => b.d <= allowed(b.len ?? 0);

if (own.d === 0) return { score: 1, details: { matched: own.label } };
// Exactly another box's name, or closer to another box's name than to this one's.
if (other.d === 0 || (fits(other) && other.d <= own.d))
  return { score: 0, feedback: `That's **${other.label}**, another part of the image. This one is **${shown}**.`, details: { other: other.label } };
if (fits(own)) return { score: 1, feedback: `Accepted. It's spelled **${own.label}**.`, details: { matched: own.label, typo: own.d } };
return { score: 0, feedback: `This one is **${shown}**.` };
