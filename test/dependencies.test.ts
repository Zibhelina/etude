import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

// The desktop app and the npm package install only "dependencies", so they must be exactly the
// packages the engine (CLI and server) loads. The web app's packages are bundled by Vite at build
// time and belong in devDependencies.
const ROOT = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.(ts|js|mjs)$/.test(d.name) ? [join(dir, d.name)] : [],
  );
}

function engineImports(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of ["src/core", "src/server", "src/cli", "bin"].flatMap(files)) {
    const src = readFileSync(join(ROOT, file), "utf8");
    const specs = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|require\.resolve\(\s*)["']([@a-z0-9][\w.@/-]*)["']/g)].map((m) => m[1]);
    for (const spec of specs) {
      if (spec.startsWith("node:") || builtinModules.includes(spec.split("/")[0])) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!found.has(name)) found.set(name, file);
    }
  }
  return found;
}

test("every package the engine loads is in dependencies", () => {
  const listed = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);
  for (const [name, file] of engineImports()) assert.ok(listed.has(name), `${file} loads ${name}, which isn't in package.json dependencies`);
});

test("dependencies holds only what the engine loads", () => {
  const used = engineImports();
  for (const name of Object.keys(pkg.dependencies ?? {}))
    assert.ok(used.has(name), `${name} is in dependencies but the engine never loads it; if only the web app uses it, move it to devDependencies`);
});
