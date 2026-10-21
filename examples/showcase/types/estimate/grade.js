// Full credit inside the tolerance, falling linearly to zero at five times it.
const g = Number(answer);
if (!Number.isFinite(g)) return { score: 0, feedback: "No estimate given.", details: {} };
const t = key.tolerance;
let err, words;
if (view.scale === "log") {
  if (g <= 0) return { score: 0, details: { error: Infinity } };
  err = Math.abs(Math.log10(g / key.answer));
  const ratio = g > key.answer ? g / key.answer : key.answer / g;
  const r = ratio < 10 ? Math.round(ratio * 10) / 10 : Math.round(ratio);
  words = ratio < 1.05 ? "essentially exact" : `${g > key.answer ? "too high" : "too low"} by a factor of ${r}` + (err >= 1.15 ? ` (${Math.round(err * 10) / 10} ${Math.round(err * 10) === 10 ? "order" : "orders"} of magnitude)` : "");
} else {
  err = Math.abs(g - key.answer) / (view.max - view.min);
  const pct = Math.round((Math.abs(g - key.answer) / Math.abs(key.answer)) * 1000) / 10;
  words = pct < 0.5 ? "essentially exact" : `${pct}% ${g > key.answer ? "too high" : "too low"}`;
}
const zero = 5 * t;
const score = err <= t ? 1 : err >= zero ? 0 : 1 - (err - t) / (zero - t);
return { score: Math.round(score * 100) / 100, feedback: score < 1 ? words.charAt(0).toUpperCase() + words.slice(1) + "." : undefined, details: { error: err, words } };
