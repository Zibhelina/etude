const w = Math.min(12, Math.max(4, Math.round(Number(fields.width) || 8)));
const signed = fields.signed === true;
const lo = signed ? -(2 ** (w - 1)) : 0;
const hi = signed ? 2 ** (w - 1) - 1 : 2 ** w - 1;
let target = Number(fields.target);
if (!Number.isInteger(target) || target < lo || target > hi) {
  // Unsigned: avoid trivial targets with only one or two bits set. Signed: always negative.
  if (signed) target = -rng.int(2, 2 ** (w - 1));
  else {
    const ones = (v) => v.toString(2).split("").filter((c) => c === "1").length;
    do target = rng.int(Math.ceil(hi / 8), hi - 1); while (ones(target) < 3);
  }
}
const pattern = ((target + 2 ** w) % 2 ** w).toString(2).padStart(w, "0");
return {
  view: { width: w, signed, target, showTotal: fields.showTotal === true, note: fields.note ?? "" },
  key: { pattern, explanation: fields.explanation ?? "" },
};
