const blanks = [];
const text = String(fields.text).replace(/\{\{([\s\S]+?)\}\}/g, (_, inner) => {
  const [ans, hint] = inner.split("::");
  const i = blanks.length;
  blanks.push({ answers: ans.split("|").map((s) => s.trim()).filter(Boolean), hint: hint?.trim() ?? "" });
  return `⟦${i}⟧`;
});
return {
  view: { text, blanks: blanks.map((b, i) => ({ id: i, hint: b.hint, size: Math.max(4, ...b.answers.map((a) => a.length)) })) },
  key: { answers: blanks.map((b) => b.answers), explanation: fields.explanation ?? "" },
};
