const points = (Array.isArray(fields.points) ? fields.points : []).map((p) => [Number(p[0]), Number(p[1])]);
const r = Array.isArray(fields.range) && fields.range.length === 4 ? fields.range.map(Number) : [-5, 5, -5, 5];
return {
  view: {
    prompt: fields.prompt,
    count: points.length,
    range: r,
    snap: typeof fields.snap === "number" ? fields.snap : 0.5,
  },
  key: {
    points,
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    tolerance: typeof fields.tolerance === "number" ? fields.tolerance : 0.25,
    curve: fields.curve ?? "",
    explanation: fields.explanation ?? "",
  },
};
