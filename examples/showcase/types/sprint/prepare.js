const seconds = Math.min(120, Math.max(10, Math.round(Number(fields.seconds) || 30)));
const target = Math.max(1, Math.round(Number(fields.target) || 12));
const mode = ["sums", "times", "percent", "mixed"].includes(fields.mode) ? fields.mode : "mixed";
const make = {
  sums() {
    if (rng.bool(0.6)) { const a = rng.int(12, 89), b = rng.int(11, 99 - a > 11 ? 99 - a : 11); return [`${a} + ${b}`, a + b]; }
    const a = rng.int(31, 99), b = rng.int(11, a - 5); return [`${a} − ${b}`, a - b];
  },
  times() { const a = rng.int(3, 12), b = rng.int(3, 12); return [`${a} × ${b}`, a * b]; },
  percent() {
    const p = rng.pick([10, 20, 25, 50, 75, 5, 30, 40]);
    // Bases that keep the answer a whole number.
    const step = { 10: 10, 20: 5, 25: 4, 50: 2, 75: 4, 5: 20, 30: 10, 40: 5 }[p];
    const n = step * rng.int(2, Math.floor(400 / step));
    return [`${p}% of ${n}`, (p * n) / 100];
  },
};
// Enough problems that nobody runs out: about one per second.
const count = seconds + 10;
const problems = [], answers = [];
// No repeats inside a round (times tables only have so many, so give up after enough tries).
const seen = new Set();
let tries = 0;
while (problems.length < count) {
  const kind = mode === "mixed" ? rng.pick(["sums", "sums", "times", "times", "percent"]) : mode;
  const [q, a] = make[kind]();
  if (seen.has(q) && tries++ < 400) continue;
  seen.add(q);
  problems.push(q);
  answers.push(a);
}
return {
  view: { seconds, target, mode, problems, note: fields.note ?? "" },
  key: { answers },
};
