const pairs = fields.pairs.map(([l, r], i) => ({ l: { id: "l" + i, text: l }, r: { id: "r" + i, text: r } }));
return {
  view: {
    prompt: fields.prompt,
    left: rng.shuffle(pairs.map((p) => p.l)),
    right: rng.shuffle(pairs.map((p) => p.r)),
  },
  key: {
    pairs: Object.fromEntries(pairs.map((p) => [p.l.id, p.r.id])),
    text: Object.fromEntries(pairs.flatMap((p) => [[p.l.id, p.l.text], [p.r.id, p.r.text]])),
    explanation: fields.explanation ?? "",
  },
};
