// Electron's main process doesn't strip TypeScript types by itself, so the desktop code loads
// through the same hook bin/etude.js uses for installs under node_modules.
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = new URL("./", import.meta.url).href;

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes("stripTypeScriptTypes") ? undefined : emit.call(process, w, ...rest));
registerHooks({
  load(url, context, next) {
    if (url.startsWith(here) && url.endsWith(".ts")) {
      const code = readFileSync(fileURLToPath(url), "utf8");
      return { format: "module", source: stripTypeScriptTypes(code, { mode: "strip" }), shortCircuit: true };
    }
    return next(url, context);
  },
});

await import("./app.ts");
