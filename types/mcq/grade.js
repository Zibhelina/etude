const chosen = new Set(Array.isArray(answer) ? answer : answer == null ? [] : [answer]);
const right = new Set(key.correct);
let tp = 0, fp = 0;
for (const id of chosen) right.has(id) ? tp++ : fp++;
const exact = tp === right.size && fp === 0;
const score = exact ? 1 : Math.max(0, (tp - fp) / right.size) * (view.multiple ? 1 : 0);
return { score, details: { chosen: [...chosen] } };
