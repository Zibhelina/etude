const given = answer && typeof answer === "object" ? answer : {};
const marks = {};
let right = 0;
for (const [l, r] of Object.entries(key.pairs)) {
  marks[l] = given[l] === r;
  if (marks[l]) right++;
}
return { score: right / Object.keys(key.pairs).length, details: { marks } };
