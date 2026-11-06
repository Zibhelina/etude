// The answer is { value, paths, w }: only the typed value is graded; the scratch work rides along.
// { stuck: true } means "show me the solution": it scores 0 like a wrong answer.
const value = typeof answer === "string" ? answer : String(answer?.value ?? "");
if (answer?.stuck || !value.trim()) return { score: 0, feedback: "You asked to see the solution.", details: { stuck: true } };
const r = std.math.check(value, key.answers ?? [], { form: view.form || "any" });
return { score: r.score, feedback: r.feedback, details: { latex: r.latex } };
