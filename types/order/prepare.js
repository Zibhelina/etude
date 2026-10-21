const steps = fields.steps.map((text, i) => ({ id: "s" + i, text }));
let shown = rng.shuffle(steps);
// Never start already solved.
for (let tries = 0; tries < 5 && shown.every((s, i) => s.id === steps[i].id); tries++) shown = rng.shuffle(steps);
return {
  view: { prompt: fields.prompt, blocks: shown },
  key: { order: steps.map((s) => s.id), steps: steps.map((s) => s.text), explanation: fields.explanation ?? "" },
};
