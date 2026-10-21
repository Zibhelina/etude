const log = fields.scale === "log";
const min = Number(fields.min), max = Number(fields.max);
if (!(max > min)) throw new Error("max must be greater than min");
if (log && !(min > 0)) throw new Error("a log scale needs min > 0");
const tol = Number.isFinite(fields.tolerance) && fields.tolerance > 0 ? fields.tolerance : log ? 0.1 : 0.04;
return {
  view: {
    prompt: fields.prompt,
    min,
    max,
    scale: log ? "log" : "linear",
    isLog: log,
    isLinear: !log,
    step: Number.isFinite(fields.step) && fields.step > 0 ? fields.step : 0,
    unit: fields.unit ?? "",
  },
  key: { answer: Number(fields.answer), tolerance: tol, explanation: fields.explanation ?? "" },
};
