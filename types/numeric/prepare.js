const parts = Array.isArray(fields.parts) && fields.parts.length
  ? fields.parts
  : [{ label: "", answer: fields.answer, unit: fields.unit, tolerance: fields.tolerance }];
return {
  view: {
    prompt: fields.prompt,
    parts: parts.map((p, i) => ({ id: i, label: p.label ?? "", unit: p.unit ?? fields.unit ?? "" })),
  },
  key: {
    parts: parts.map((p) => ({ answer: p.answer, tolerance: p.tolerance ?? fields.tolerance ?? 0.01, unit: p.unit ?? fields.unit ?? "" })),
    explanation: fields.explanation ?? "",
  },
};
