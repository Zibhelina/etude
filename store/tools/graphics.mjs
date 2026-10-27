// Play feature graphic (1024×500) from a real app capture plus the site's type, and the Play icon
// (512×512) from the app icon.
//   node store/tools/graphics.mjs <shots-dir> <outdir> <app-icon-1024.png>
// <shots-dir> is the output of screens.mjs (it reads raw/android-phone/02-map.png).
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const [SHOTS, OUT, ICON] = process.argv.slice(2).map((p) => p && resolve(p));
if (!SHOTS || !OUT || !ICON) throw new Error("usage: graphics.mjs <shots-dir> <outdir> <icon.png>");
const fonts = fileURLToPath(new URL("../../site/dist/", import.meta.url));
mkdirSync(OUT, { recursive: true });

execFileSync("magick", [ICON, "-resize", "512x512", "-define", "png:color-type=6", join(OUT, "play-icon-512.png")]);

const shot = `file://${join(SHOTS, "raw", "android-phone", "02-map.png")}`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Inter"; src: url("file://${fonts}assets/fonts/inter.woff2") format("woff2"); font-weight: 100 900; }
@font-face { font-family: "KaTeX_Main"; src: url("file://${fonts}runtime/vendor/fonts/KaTeX_Main-Regular.woff2") format("woff2"); font-style: normal; }
@font-face { font-family: "KaTeX_Main"; src: url("file://${fonts}runtime/vendor/fonts/KaTeX_Main-Italic.woff2") format("woff2"); font-style: italic; }
html, body { margin: 0; width: 1024px; height: 500px; overflow: hidden; background: oklch(0.145 0.004 85); color: oklch(0.96 0.004 85); }
.text { position: absolute; left: 64px; top: 0; bottom: 0; width: 560px; display: flex; flex-direction: column; justify-content: center; }
.mark { font: italic 400 30px "KaTeX_Main", serif; color: oklch(0.7 0.19 350); margin-bottom: 18px; }
.mark b { font-weight: 400; font-style: normal; color: oklch(0.96 0.004 85); }
h1 { margin: 0; font: 400 76px/1.02 "KaTeX_Main", Georgia, serif; letter-spacing: -0.01em; }
h1 em { font-style: italic; background: linear-gradient(transparent 82%, oklch(0.7 0.19 350 / 0.85) 82%, oklch(0.7 0.19 350 / 0.85) 90%, transparent 90%); }
p { margin: 22px 0 0; font: 400 22px/1.4 "Inter", sans-serif; color: oklch(0.72 0.01 85); }
.phone { position: absolute; right: 70px; top: 46px; width: 300px; height: 520px; border-radius: 30px 30px 0 0; overflow: hidden; box-shadow: 0 0 0 3px oklch(1 0 0 / 0.1); }
.phone img { width: 300px; display: block; }
</style></head><body>
<div class="text"><div class="mark">ε<b>tude</b></div><h1>Practice <em>anything.</em></h1><p>Free flashcards that can be small apps. No ads, no account needed.</p></div>
<div class="phone"><img src="${shot}"></div>
</body></html>`;
const file = join(OUT, ".feature.html");
writeFileSync(file, html);

const profile = join(process.env.TMPDIR ?? "/tmp", `etude-store-gfx-${process.pid}`);
const out = join(OUT, "play-feature-1024x500.png");
try {
  execFileSync(process.env.CHROME ?? "chromium", ["--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--force-color-profile=srgb", "--allow-file-access-from-files", "--window-size=1024,500", "--virtual-time-budget=3000", `--screenshot=${out}`, `file://${file}`], { stdio: "ignore", timeout: 60000 });
} finally {
  rmSync(profile, { recursive: true, force: true });
  rmSync(file, { force: true });
}
// Play wants a 24-bit PNG with no alpha.
execFileSync("magick", [out, "-alpha", "off", "-define", "png:color-type=2", out]);
console.log("wrote", out, join(OUT, "play-icon-512.png"));
