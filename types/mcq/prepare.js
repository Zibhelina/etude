const opts = fields.options.map((o, i) => ({ ...o, id: "o" + i }));
const shown = fields.shuffle === false ? opts : rng.shuffle(opts);
const correct = opts.filter((o) => o.correct).map((o) => o.id);
return {
  view: {
    prompt: fields.prompt,
    multiple: fields.multiple ?? correct.length > 1,
    options: shown.map((o) => ({ id: o.id, text: o.text })),
  },
  key: {
    correct,
    why: Object.fromEntries(opts.filter((o) => o.why).map((o) => [o.id, o.why])),
    explanation: fields.explanation ?? "",
  },
};
