// The answer is { value, paths, h }: only the typed value is graded; the scratch work rides along.
const value = typeof answer === "string" ? answer : String(answer?.value ?? "");
const r = std.math.check(value, key.answers ?? [], { form: view.form || "any" });
return { score: r.score, feedback: r.feedback, details: { latex: r.latex } };
