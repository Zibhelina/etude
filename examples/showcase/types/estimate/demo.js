// An example answer for watch mode: a good estimate, not quite the exact value.
const a = Number(key.answer);
const off = (rng.next() * 2 - 1) * (key.tolerance ?? 0.05) * 0.4;
const g = view.scale === "log" ? a * Math.pow(10, off) : a * (1 + off);
const step = Number(view.step) || 0;
return step ? Math.round(g / step) * step : g;
