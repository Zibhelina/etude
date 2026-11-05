const num = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const base = Math.round(num(fields.base, 2, 16, 16));
const speed = num(fields.speed, 0.25, 4, 1);
const target = Math.round(num(fields.target, 1, 999, 20));
return {
  view: {
    note: fields.note ?? "",
    base,
    speed,
    target,
    hints: fields.hints !== false,
    sound: fields.sound !== false,
  },
  key: {},
};
