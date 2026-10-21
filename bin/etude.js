#!/usr/bin/env node
// Runs the TypeScript CLI on the current Node, which strips types natively.
// Node refuses to strip files under node_modules (a global or npx install), so for
// those this hook does the same type stripping itself before the module loads.
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (Number(process.versions.node.split(".")[0]) < 24) {
  process.stderr.write(`etude needs Node 24 or newer (this is ${process.version})\n`);
  process.exit(1);
}

const src = new URL("../src/", import.meta.url).href;

if (fileURLToPath(src).split(/[\\/]/).includes("node_modules")) {
  // Keep stdout and stderr clean for scripts: this one warning is expected.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes("stripTypeScriptTypes") ? undefined : emit.call(process, w, ...rest));
  registerHooks({
    load(url, context, next) {
      if (url.startsWith(src) && url.endsWith(".ts")) {
        const code = readFileSync(fileURLToPath(url), "utf8");
        return { format: "module", source: stripTypeScriptTypes(code, { mode: "strip" }), shortCircuit: true };
      }
      return next(url, context);
    },
  });
}

await import("../src/cli/main.ts");
