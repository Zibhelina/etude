const hidden = fields.hidden && typeof fields.hidden === "object" ? fields.hidden : {};
const list = (v) => (Array.isArray(v) ? v.map(String) : []);
const h = { match: list(hidden.match), reject: list(hidden.reject) };
return {
  view: {
    prompt: fields.prompt,
    match: list(fields.match),
    reject: list(fields.reject),
    mode: fields.mode === "find" ? "find" : "full",
    flags: String(fields.flags ?? "").replace(/[^imsu]/g, ""),
    hiddenCount: h.match.length + h.reject.length,
  },
  key: { hidden: h, solution: fields.solution ?? "", explanation: fields.explanation ?? "" },
};
