// An example test for watch mode: a steady typist around 70 WPM with a couple of slips.
const words = (view.words ?? []).map(String);
const wpm = 64 + rng.int(0, 14);
const cps = (wpm * 5) / 60;
const limit = view.seconds ? view.seconds * 1000 : Infinity;
const typed = [];
let chars = 0;
for (const w of words) {
  const c = w.length + (typed.length ? 1 : 0);
  if (((chars + c) / cps) * 1000 > limit) break;
  typed.push(w);
  chars += c;
}
const ms = view.seconds ? limit : Math.round((chars / cps) * 1000);
const history = [];
for (let s = 1; s <= Math.ceil(ms / 1000); s++) {
  const w = wpm * (0.86 + 0.14 * Math.min(1, s / 4)) + (rng.next() - 0.5) * 8;
  history.push([s, Math.round(w * 100) / 100, Math.round((w * 1.05 + (rng.next() - 0.5) * 16) * 100) / 100, rng.bool(0.15) ? 1 : 0]);
}
return { typed, ms, complete: !view.seconds, keys: { correct: chars, incorrect: rng.int(1, 3) }, history };
