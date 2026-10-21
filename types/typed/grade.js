const given = String(answer ?? "");
const mode = view.match || "loose";
const ok = key.answers.some((a) => {
  if (mode === "exact") return given.trim() === String(a).trim();
  if (mode === "regex") return new RegExp(`^(?:${a})$`, "i").test(given.trim());
  return std.looseEqual(given, a);
});
return { score: ok ? 1 : 0 };
