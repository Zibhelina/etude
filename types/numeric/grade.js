const given = Array.isArray(answer) ? answer : [answer];
const parts = key.parts.map((p, i) => {
  const raw = String(given[i] ?? "").trim().replace(/\s*[a-zA-Zµμ%]+(?:\/[a-zA-Z]+)?$/, (m) => (/^\s*e$/i.test(m) ? m : ""));
  const value = std.parseNumber(raw);
  return { given: given[i] ?? "", value: Number.isFinite(value) ? value : null, correct: std.within(value, p.answer, p.tolerance) };
});
const score = parts.filter((p) => p.correct).length / parts.length;
return { score, details: { parts } };
