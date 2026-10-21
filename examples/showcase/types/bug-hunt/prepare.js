const code = String(fields.code ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
const bugs = (Array.isArray(fields.bugs) ? fields.bugs : [fields.bugs]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const fix = fields.fix && typeof fields.fix === "object" && !Array.isArray(fields.fix) ? fields.fix : {};
const count = Math.max(1, Math.round(Number(fields.count) || bugs.length || 1));
return {
  view: { prompt: fields.prompt, code, language: String(fields.language || "text").toLowerCase(), count, lines: code.split("\n").length },
  key: { bugs: [...new Set(bugs)].sort((a, b) => a - b), fix, explanation: fields.explanation ?? "" },
};
