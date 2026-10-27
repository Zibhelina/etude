// Builds the Etude core for the browser: the same src/core, with node:* modules swapped for the
// shims in ./shims, plus the web app wired to it (index.html). `npm run build:browser` writes
// dist-browser/: the whole app as static files, and harness.html, a test page for the core alone.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const unavailable = here("./shims/unavailable.ts");

// Tailwind scans for class names from the Vite root (src/browser here). Point the app's stylesheet
// at the web app's sources too, without editing web/src/index.css.
const scanWebApp = {
  name: "etude-scan-web-app",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (id.split("?")[0].endsWith("/web/src/index.css")) return `${code}\n@source "./";\n`;
  },
};

export default defineConfig({
  root: here("."),
  base: "./",
  plugins: [scanWebApp, react(), tailwindcss()],
  publicDir: here("../../web/public"),
  resolve: {
    alias: [
      { find: /^@\//, replacement: here("../../web/src") + "/" },
      { find: /^node:fs$/, replacement: here("./shims/fs.ts") },
      { find: /^node:path$/, replacement: "pathe" },
      { find: /^node:url$/, replacement: here("./shims/url.ts") },
      { find: /^node:os$/, replacement: here("./shims/os.ts") },
      { find: /^node:crypto$/, replacement: here("./shims/crypto.ts") },
      { find: /^node:zlib$/, replacement: here("./shims/zlib.ts") },
      { find: /^node:module$/, replacement: here("./shims/module.ts") },
      { find: /^node:(child_process|http|net|sqlite)$/, replacement: unavailable },
    ],
  },
  // Vite swaps a bare `process.env` for `{}`, so the core's `process.env[name]` (API keys, see
  // worker.ts) would always be empty. Point it at the object shims/globals.ts creates instead.
  define: { "process.env": "globalThis.process.env", "process.env.NODE_ENV": JSON.stringify("production") },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  server: { fs: { allow: [here("../..")] }, headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
  build: {
    outDir: here("../../dist-browser"),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { index: here("./index.html"), harness: here("./harness.html") } },
  },
});
