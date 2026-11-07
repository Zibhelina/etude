// Excalidraw falls back to esm.sh for its fonts. Etude serves them itself (web/public/excalidraw), so the
// fallback points there too: no third-party requests, and it works offline and under the app's CSP.
import type { Plugin } from "vite";

export const excalidrawLocalFonts = (): Plugin => ({
  name: "etude-excalidraw-local-fonts",
  enforce: "pre",
  transform(code, id) {
    if (!/[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/]/.test(id) || !code.includes("https://esm.sh/")) return null;
    // The URL is a template with another template inside (`https://esm.sh/${a ? `${a}@${v}` : "…"}/dist/prod/`).
    const out = code.replace(/`https:\/\/esm\.sh\/\$\{.*?\/dist\/prod\/`/gs, '(window.EXCALIDRAW_ASSET_PATH || "/excalidraw/")');
    if (out === code) this.warn("Excalidraw's font fallback wasn't found; fonts may try esm.sh");
    return { code: out, map: null };
  },
});
