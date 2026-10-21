const given = Array.isArray(answer) ? answer : [];
const marks = key.answers.map((alts, i) => String(given[i] ?? "").trim() !== "" && alts.some((a) => a && std.looseEqual(given[i], a)));
return { score: marks.filter(Boolean).length / marks.length, details: { marks } };
