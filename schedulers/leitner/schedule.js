// Leitner boxes. Again: back to box 1. Hard: stay. Good: up one. Easy: up two.
const gaps = String(options.boxes).split(/[\s,;]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
if (!gaps.length) gaps.push(1);
const from = card.state?.box ?? 0;
const top = gaps.length;
let box;
if (attempt.rating === 1) box = 1;
else if (attempt.rating === 2) box = Math.max(1, from);
else if (attempt.rating === 4) box = Math.min(top, from + 2);
else box = Math.min(top, from + 1);
const days = Math.min(Math.round(gaps[box - 1]), ctx.day.length - 1);
return { due: ctx.day[days], state: { box } };
