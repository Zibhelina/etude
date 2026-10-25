const words = Array.isArray(view.words) ? view.words.map(String) : [];
const typed = (Array.isArray(answer?.typed) ? answer.typed : []).slice(0, words.length).map((s) => String(s ?? ""));
while (typed.length && typed[typed.length - 1] === "") typed.pop();
const ms = Math.min(3600000, Math.max(0, Number(answer?.ms) || 0));
const complete = answer?.complete === true;
const history = (Array.isArray(answer?.history) ? answer.history : [])
  .slice(0, 900)
  .filter((h) => Array.isArray(h) && h.length >= 4 && h.slice(0, 4).every((x) => Number.isFinite(Number(x))))
  .map((h) => h.slice(0, 4).map(Number));
if (!typed.length || ms < 300) {
  return { score: 0, feedback: "Nothing was typed.", details: { wpm: 0, raw: 0, acc: 0, correct: 0, incorrect: 0, extra: 0, missed: 0, consistency: null, ms, history: [], typed: [], complete } };
}
const last = typed.length - 1;
// Without `complete`, the last word was still being typed when the clock stopped.
let correct = 0, incorrect = 0, extra = 0, missed = 0, wordChars = 0, spaces = 0;
typed.forEach((t, i) => {
  const w = Array.from(words[i]), a = Array.from(t);
  const partial = i === last && !complete;
  for (let j = 0; j < Math.max(w.length, a.length); j++) {
    if (j >= w.length) extra++;
    else if (j >= a.length) { if (!partial) missed++; }
    else if (a[j] === w[j]) correct++;
    else incorrect++;
  }
  if (t === words[i]) { wordChars += w.length; if (i < last) spaces++; }
  else if (partial && words[i].startsWith(t)) wordChars += a.length;
});
const min = ms / 60000;
// Monkeytype's definitions: a word is 5 characters; WPM counts only correctly typed words and the spaces after them.
const wpm = (wordChars + spaces) / 5 / min;
const raw = (correct + incorrect + extra + last) / 5 / min;
const k = answer?.keys;
const kc = Number(k?.correct), ki = Number(k?.incorrect);
const acc = Number.isFinite(kc) && Number.isFinite(ki) && kc + ki > 0
  ? (100 * kc) / (kc + ki)
  : (100 * correct) / Math.max(1, correct + incorrect + extra);
// Consistency: how steady the per-second raw speed was (Monkeytype's kogasa of the coefficient of variation).
let consistency = null;
const raws = history.map((h) => h[2]);
if (raws.length >= 2) {
  const mean = raws.reduce((s, x) => s + x, 0) / raws.length;
  const sd = Math.sqrt(raws.reduce((s, x) => s + (x - mean) ** 2, 0) / raws.length);
  const cov = mean > 0 ? sd / mean : 1;
  consistency = 100 * (1 - Math.tanh(cov + cov ** 3 / 3 + cov ** 5 / 5));
}
const r2 = (x) => Math.round(x * 100) / 100;
const target = Number(view.target) || 60;
const score = Math.min(1, wpm / target);
let feedback;
if (wpm < target) {
  feedback = `${Math.ceil(target - wpm)} WPM short of ${target}.`;
  if (acc < 94) feedback += ` Accuracy was ${Math.round(acc)}%: a wrong word counts for nothing, so a little less speed would score more.`;
}
return {
  score,
  feedback,
  details: { wpm: r2(wpm), raw: r2(raw), acc: r2(acc), correct, incorrect, extra, missed, consistency: consistency === null ? null : r2(consistency), ms, history, typed, complete },
};
