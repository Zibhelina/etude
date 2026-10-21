const given = Array.isArray(answer) ? answer : [];
const marks = key.answers.map((alts, i) => alts.some((a) => std.looseEqual(given[i], a)));
return { score: marks.filter(Boolean).length / marks.length, details: { marks } };
