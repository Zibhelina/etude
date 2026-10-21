// Standalone pack checker for authors: node scripts/check-pack.ts pack.json [more.json]
// Same checks as `etude pack check`; kept for scripts that call it directly.
import { readFileSync } from "node:fs";
import { initSandbox } from "../src/core/sandbox.ts";
import { checkPack } from "../src/cli/pack-check.ts";

await initSandbox();
let failed = false;
for (const path of process.argv.slice(2)) {
  let pack: unknown;
  try {
    pack = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.log(`ERROR    ${path}: not valid JSON: ${(e as Error).message}`);
    failed = true;
    continue;
  }
  const r = checkPack(pack, path);
  console.log(`${path}: ${r.items} items, ${r.generated} generated, types ${JSON.stringify(r.types)}`);
  for (const w of r.warnings) console.log(`warning  ${w}`);
  for (const e of r.errors) console.log(`ERROR    ${e}`);
  if (!r.ok) failed = true;
}
console.log(failed ? "errors found" : "ok");
process.exit(failed ? 1 : 0);
