// Builds what a card frame needs when there is no server to load it from: the card runtime (with
// marked, KaTeX and mathexpr) as one classic script, and one stylesheet with KaTeX's fonts inlined.
// Output: src/browser/gen/frame-runtime.js and frame.css (both gitignored, rebuilt by build:browser).
import { build } from "vite";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const out = join(here, "..", "gen");
const require = createRequire(import.meta.url);
const katexDist = join(dirname(require.resolve("katex/package.json")), "dist");
mkdirSync(out, { recursive: true });

await build({
  configFile: false,
  logLevel: "warn",
  resolve: {
    alias: [
      { find: /^\.\/vendor\/marked\.js$/, replacement: join(dirname(require.resolve("marked/package.json")), "lib", "marked.esm.js") },
      { find: /^\.\/vendor\/katex\.js$/, replacement: join(katexDist, "katex.mjs") },
    ],
  },
  build: {
    outDir: out,
    emptyOutDir: false,
    write: true,
    minify: true,
    lib: { entry: join(root, "runtime", "runtime.js"), formats: ["iife"], name: "EtudeRuntime", fileName: () => "frame-runtime.js" },
  },
});

// KaTeX's CSS with only the woff2 fonts, as data: URLs (a sandboxed frame can't fetch them).
let katexCss = readFileSync(join(katexDist, "katex.min.css"), "utf8");
katexCss = katexCss.replace(/src:url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)(,url\([^)]*\) format\("[^"]*"\))*/g, (_, f) => {
  const b64 = readFileSync(join(katexDist, "fonts", `${f}.woff2`)).toString("base64");
  return `src:url(data:font/woff2;base64,${b64}) format("woff2")`;
});
const css = [katexCss, readFileSync(join(root, "runtime", "card.css"), "utf8"), readFileSync(join(root, "runtime", "code.css"), "utf8")].join("\n");
writeFileSync(join(out, "frame.css"), css);
const js = readFileSync(join(out, "frame-runtime.js"), "utf8");
console.log(`frame runtime ${(js.length / 1024).toFixed(0)} KB, css ${(css.length / 1024).toFixed(0)} KB, fonts left as urls: ${(katexCss.match(/url\(fonts/g) ?? []).length}`);
