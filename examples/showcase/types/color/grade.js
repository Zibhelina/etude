function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
// sRGB 0..255 to OKLab (Björn Ottosson's matrices).
function oklab(rgb) {
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
if (!answer || ![answer.h, answer.s, answer.l].every(Number.isFinite)) return { score: 0, feedback: "No color made.", details: {} };
const mine = hslToRgb(answer.h, answer.s, answer.l);
const A = oklab(mine), B = oklab(key.rgb);
const dE = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);

// About 0.02 is a just-noticeable difference side by side; matching from a hex code by eye is harder.
const FULL = 0.05, ZERO = 0.22;
const score = dE <= FULL ? 1 : dE >= ZERO ? 0 : 1 - (dE - FULL) / (ZERO - FULL);

// Describe the difference in the terms of the sliders.
const [th, ts, tl] = key.hsl;
const notes = [];
const hueName = (h) => {
  h = ((h % 360) + 360) % 360;
  return h < 15 ? "red" : h < 45 ? "orange" : h < 70 ? "yellow" : h < 160 ? "green" : h < 195 ? "cyan" : h < 255 ? "blue" : h < 290 ? "purple" : h < 345 ? "pink" : "red";
};
const dh = ((answer.h - th + 540) % 360) - 180;
if (ts > 12 && tl > 8 && tl < 92 && Math.abs(dh) >= 8) {
  const toward = hueName(th + Math.sign(dh) * 40);
  notes.push(`hue ${Math.round(Math.abs(dh))}° off, toward ${toward === hueName(th) ? hueName(th + Math.sign(dh) * 80) : toward}`);
}
const ds = answer.s - ts;
if (Math.abs(ds) >= 10) notes.push(ds > 0 ? `${Math.abs(Math.round(ds))}% too saturated` : `${Math.abs(Math.round(ds))}% too grey`);
const dl = answer.l - tl;
if (Math.abs(dl) >= 6) notes.push(dl > 0 ? `${Math.abs(Math.round(dl))}% too light` : `${Math.abs(Math.round(dl))}% too dark`);
const verdict = dE <= 0.025 ? "Spot on" : dE <= FULL ? "Very close" : dE <= 0.12 ? "Close" : dE <= ZERO ? "In the neighbourhood" : "Far off";
return {
  score: Math.round(score * 100) / 100,
  feedback: score < 1 && notes.length ? `${verdict}: ${notes.join(", ")}.` : undefined,
  details: { dE: Math.round(dE * 1000) / 1000, verdict, notes, dh: Math.round(dh), ds: Math.round(ds), dl: Math.round(dl) },
};
