// Builds the live Stats panels for the website: the app's own React components (web/src) fed by
// JSON snapshots, into site/dist/live/{stats.js,stats.css}. site/build.ts runs this.
//
// The Tailwind the components need is compiled here and scoped under `.lv`, so the site's own
// styles are untouched: every selector gets the `.lv` prefix, the cascade layers are unwrapped
// (the site's CSS is unlayered and would beat any layered rule), and the app's viewport
// breakpoints become container queries on the panel's column, which is the width they lay out in.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Root } from "postcss";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "../../web/src");
const out = join(here, "../dist/live");
const ROOT = ".lv";

// App breakpoint (viewport, in the app with its sidebar) → width of the column the panel gets.
const CONTAINER: Record<string, string> = { "480px": "26rem", "30rem": "26rem", "40rem": "34rem", "48rem": "40rem", "64rem": "43rem", "80rem": "56rem" };

function scope(root: Root) {
  root.walkAtRules("layer", (at) => {
    if (at.nodes) at.replaceWith(at.nodes);
    else at.remove();
  });
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/.test((rule.parent as AtRule).name)) return;
    rule.selectors = rule.selectors.map((s) => {
      if (s.startsWith(ROOT)) return s;
      if (/^(:root|:host|html|body)$/.test(s)) return ROOT;
      return `${ROOT} ${s}`;
    });
  });
  root.walkAtRules("media", (at) => {
    const m = /^\(\s*(?:width\s*>=\s*|min-width\s*:\s*)([\d.]+(?:rem|px))\s*\)$/.exec(at.params.trim());
    if (!m) return;
    at.name = "container";
    at.params = `(min-width: ${CONTAINER[m[1]] ?? m[1]})`;
  });
}

function scoped(): Plugin {
  return {
    name: "etude-live-scope",
    apply: "build",
    enforce: "post",
    writeBundle() {
      const file = join(out, "stats.css");
      const css = postcss([{ postcssPlugin: "scope", Once: scope }]).process(readFileSync(file, "utf8"), { from: undefined }).css;
      writeFileSync(file, css);
    },
  };
}

export default defineConfig({
  root: here,
  base: "./",
  logLevel: "warn",
  plugins: [react(), tailwindcss(), scoped()],
  resolve: {
    alias: [
      { find: /^@\/lib\/router$/, replacement: join(here, "shims/router.ts") },
      { find: /^@\/lib\/api$/, replacement: join(here, "shims/api.ts") },
      { find: /^@\//, replacement: `${web}/` },
    ],
  },
  build: {
    outDir: out,
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: join(here, "main.tsx"),
      output: { entryFileNames: "stats.js", assetFileNames: "stats[extname]", codeSplitting: false },
    },
  },
});
