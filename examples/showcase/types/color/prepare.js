// The hex code is the question, so it's in the view; its HSL breakdown stays in the key.
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}
const hex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

let rgb;
const fixed = typeof fields.hex === "string" && /^#?[0-9a-f]{6}$/i.test(fields.hex.trim()) ? fields.hex.trim().replace("#", "") : null;
if (fixed) rgb = [0, 2, 4].map((i) => parseInt(fixed.slice(i, i + 2), 16));
else rgb = hslToRgb(rng.int(0, 359), rng.int(35, 95), rng.int(28, 72));

return {
  view: { prompt: fields.prompt || "Build this color.", hex: hex(rgb) },
  key: { rgb, hsl: rgbToHsl(rgb), explanation: fields.explanation ?? "" },
};
