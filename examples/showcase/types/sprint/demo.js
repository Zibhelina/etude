// An example round for watch mode: a few more right answers than the target, and one slip.
const n = Math.min((key.answers ?? []).length, Number(view.target) + 2);
const answers = (key.answers ?? []).slice(0, n).map(String);
if (n > 4) answers[Math.floor(n / 2)] = String(Number(answers[Math.floor(n / 2)]) + 1);
return { answers };
