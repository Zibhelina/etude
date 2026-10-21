const r = std.math.check(answer, key.answers ?? [], { form: view.form || "any", ordered: !!view.ordered });
return { score: r.score, feedback: r.feedback, details: { latex: r.latex } };
