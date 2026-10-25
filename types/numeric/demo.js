// An example answer for watch mode: each part's value, with its unit as a person would type it.
return (key.parts ?? []).map((p) => `${+Number(p.answer).toPrecision(6)}${p.unit ? " " + p.unit : ""}`);
