// Two changes to Excalidraw's own code. First, it falls back to esm.sh for its fonts. Etude serves them itself (web/public/excalidraw), so the
// fallback points there too: no third-party requests, and it works offline and under the app's CSP.
import type { Plugin } from "vite";

export const excalidrawLocalFonts = (): Plugin => ({
  name: "etude-excalidraw-local-fonts",
  enforce: "pre",
  transform(code, id) {
    if (!/[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/]/.test(id)) return null;
    let out = code;
    if (code.includes("https://esm.sh/")) {
      // The URL is a template with another template inside (`https://esm.sh/${a ? `${a}@${v}` : "…"}/dist/prod/`).
      out = out.replace(/`https:\/\/esm\.sh\/\$\{.*?\/dist\/prod\/`/gs, '(window.EXCALIDRAW_ASSET_PATH || "/excalidraw/")');
      if (out === code) this.warn("Excalidraw's font fallback wasn't found; fonts may try esm.sh");
    }
    // Excalidraw switches to its phone layout (no zoom, the menu moved to the bottom) whenever the board is under
    // 730 px wide, as a canvas in a split pane is. Etude decides: window.EXCALIDRAW_IS_MOBILE(width, height).
    const mobile = /"isMobileBreakpoint",\(([a-z]),([a-z])\)=>/;
    if (mobile.test(out)) out = out.replace(mobile, (_m, a, b) => `"isMobileBreakpoint",(${a},${b})=>window.EXCALIDRAW_IS_MOBILE?window.EXCALIDRAW_IS_MOBILE(${a},${b}):`);
    return out === code ? null : { code: out, map: null };
  },
});
