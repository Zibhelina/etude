// Builds the Etude core for the browser: the same src/core, with node:* modules swapped for the
// shims in ./shims, plus the web app wired to it (index.html). `npm run build:browser` writes
// dist-browser/: the whole app as static files, and harness.html, a test page for the core alone.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const unavailable = here("./shims/unavailable.ts");
// The web edition on the site is served from a path (VITE_APP_BASE=/app → etude.study/app/); the
// phone apps load the same build from the bundle root, with relative asset URLs.
const webBase = (process.env.VITE_APP_BASE ?? "").replace(/\/+$/, "");

// Tailwind scans for class names from the Vite root (src/browser here). Point the app's stylesheet
// at the web app's sources too, without editing web/src/index.css.
const scanWebApp = {
  name: "etude-scan-web-app",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (id.split("?")[0].endsWith("/web/src/index.css")) return `${code}\n@source "./";\n`;
  },
};

// The web edition is also an installable app (Add to Home Screen) that opens offline: a manifest
// scoped to its path, and the service worker in ./sw.js, stamped with this build's id.
const webEdition = {
  name: "etude-web-edition",
  apply: "build" as const,
  transformIndexHtml(html: string) {
    if (!webBase) return html;
    const links = `<link rel="manifest" href="${webBase}/app.webmanifest" />\n    <link rel="apple-touch-icon" href="${webBase}/apple-touch-icon.png" />\n  </head>`;
    return html.replace("</head>", () => links);
  },
  generateBundle(_: unknown, bundle: Record<string, unknown>) {
    if (!webBase) return;
    const build = createHash("sha256").update(Object.keys(bundle).sort().join("\n")).digest("hex").slice(0, 12);
    const sw = readFileSync(here("./sw.js"), "utf8").replace(/__BASE__/g, webBase).replace(/__BUILD__/g, build);
    (this as any).emitFile({ type: "asset", fileName: "sw.js", source: sw });
    const manifest = {
      name: "Etude",
      short_name: "Etude",
      description: "Practice anything: flashcards that check your answers.",
      id: `${webBase}/`,
      start_url: `${webBase}/`,
      scope: `${webBase}/`,
      display: "standalone",
      background_color: "#000000",
      theme_color: "#000000",
      icons: [
        { src: `${webBase}/apple-touch-icon.png`, sizes: "180x180", type: "image/png" },
        { src: `${webBase}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      ],
    };
    (this as any).emitFile({ type: "asset", fileName: "app.webmanifest", source: JSON.stringify(manifest, null, 2) + "\n" });
  },
};

export default defineConfig({
  root: here("."),
  base: webBase ? `${webBase}/` : "./",
  plugins: [scanWebApp, react(), tailwindcss(), webEdition],
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
      { find: /^node:util$/, replacement: here("./shims/util.ts") },
      { find: /^node:(child_process|http|net|sqlite)$/, replacement: unavailable },
      { find: /^@jitl\/quickjs-wasmfile-(debug-sync|debug-asyncify|release-asyncify)$/, replacement: here("./shims/quickjs-unused.ts") },
    ],
  },
  // Vite swaps a bare `process.env` for `{}`, so the core's `process.env[name]` (API keys, see
  // worker-core.ts) would always be empty. Point it at the object shims/globals.ts creates instead.
  define: { "process.env": "globalThis.process.env", "process.env.NODE_ENV": JSON.stringify("production"), "import.meta.env.VITE_APP_BASE": JSON.stringify(webBase) },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  server: { fs: { allow: [here("../..")] }, headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
  build: {
    outDir: process.env.ETUDE_BROWSER_OUT ?? here("../../dist-browser"),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: webBase ? { index: here("./index.html") } : { index: here("./index.html"), harness: here("./harness.html") } },
  },
});
