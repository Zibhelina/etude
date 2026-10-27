// Source images for `npx capacitor-assets generate` (icons and splash screens for android/ and ios/),
// drawn from the ε in web/public/logo.svg on black.   node scripts/app-icons.mjs
import sharp from "sharp";
import { readFileSync, mkdirSync } from "node:fs";

const svg = readFileSync(new URL("../web/public/logo.svg", import.meta.url), "utf8");
const path = /<path d="([^"]+)"/.exec(svg)[1];
const PINK = "#f472b6";
const BG = "#000000";
// The glyph's box in the 24-unit logo: x ≈ 3.5–20.5, y ≈ 2–22. Scale it to `size` px, centred, at `frac` of the side.
const mark = (size, frac, bg) => {
  const s = (size * frac) / 24;
  const off = (size - 24 * s) / 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : ""}
<g transform="translate(${off} ${off}) scale(${s})"><path d="${path}" fill="${PINK}" transform="translate(2.324 21.144) scale(0.04253 -0.04253)"/></g></svg>`);
};
const out = new URL("../assets/", import.meta.url);
mkdirSync(out, { recursive: true });
const png = (buf, name) => sharp(buf).png().toFile(new URL(name, out).pathname);
await png(mark(1024, 0.62, BG), "icon-only.png"); // iOS and legacy Android icons: full square
await png(mark(1024, 0.42, null), "icon-foreground.png"); // Android adaptive: inside the 66% safe zone
await png(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${BG}"/></svg>`), "icon-background.png");
await png(mark(2732, 0.16, BG), "splash.png");
await png(mark(2732, 0.16, BG), "splash-dark.png");
console.log("assets/ written");
