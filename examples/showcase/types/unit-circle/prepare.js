// Picks the angle (in 15° steps) and works out its exact coordinates.
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));

let D;
if (typeof fields.angle === "number" && Number.isFinite(fields.angle)) D = Math.round(fields.angle / 15) * 15;
else {
  const r = fields.wrap === false ? 1 : rng.next();
  if (r < 0.2) D = -rng.int(1, 23) * 15;
  else if (r < 0.32) D = 360 + rng.int(1, 23) * 15;
  else D = rng.int(0, 23) * 15;
}

const units = fields.units === "radians" || fields.units === "degrees" ? fields.units : rng.bool(0.65) ? "radians" : "degrees";

function radTex(deg) {
  const k = deg / 15;
  if (k === 0) return "0";
  const g = gcd(Math.abs(k), 12);
  const num = k / g, den = 12 / g;
  const sign = num < 0 ? "-" : "";
  const n = Math.abs(num);
  const top = n === 1 ? "\\pi" : n + "\\pi";
  return den === 1 ? sign + top : sign + "\\frac{" + top + "}{" + den + "}";
}
const degTex = (deg) => deg + "^\\circ";

// sin of the reference angles 0, 15, ..., 90.
const SIN = ["0", "\\frac{\\sqrt6-\\sqrt2}{4}", "\\frac12", "\\frac{\\sqrt2}{2}", "\\frac{\\sqrt3}{2}", "\\frac{\\sqrt6+\\sqrt2}{4}", "1"];
const norm = ((D % 360) + 360) % 360;
let ref = norm % 180;
if (ref > 90) ref = 180 - ref;
const sign = (v) => (Math.abs(v) < 1e-9 ? "" : v < 0 ? "-" : "");
const rad = (norm * Math.PI) / 180;
const cosTex = sign(Math.cos(rad)) + SIN[(90 - ref) / 15];
const sinTex = sign(Math.sin(rad)) + SIN[ref / 15];
const big = (t) => (t.includes("\\frac") ? "\\left(" : "(");
const close = (t) => (t.includes("\\frac") ? "\\right)" : ")");
const pair = cosTex + ", " + sinTex;

return {
  view: { prompt: fields.prompt || "Place the angle on the unit circle.", thetaTex: units === "radians" ? radTex(D) : degTex(D), units },
  key: {
    degrees: D,
    target: norm,
    targetTex: degTex(norm),
    radTex: radTex(D),
    coordsTex: big(pair) + pair + close(pair),
    cosTex,
    sinTex,
    explanation: fields.explanation ?? "",
  },
};
