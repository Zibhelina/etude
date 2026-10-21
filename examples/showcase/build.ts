// Builds examples/showcase.pack.json from the type directories and item files next to this script.
// node examples/showcase/build.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTypeDir } from "../../src/core/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const meta = JSON.parse(readFileSync(join(here, "pack.json"), "utf8"));

const typesDir = join(here, "types");
const types = existsSync(typesDir)
  ? readdirSync(typesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(typesDir, d.name, "type.json")))
      .map((d) => loadTypeDir(join(typesDir, d.name)))
      .sort((a, b) => a.id.localeCompare(b.id))
  : [];

const itemsDir = join(here, "items");
const items: { id: string }[] = [];
for (const f of existsSync(itemsDir) ? readdirSync(itemsDir).filter((f) => f.endsWith(".json")).sort() : []) {
  const list = JSON.parse(readFileSync(join(itemsDir, f), "utf8"));
  if (!Array.isArray(list)) throw new Error(`${f}: expected an array of items`);
  items.push(...list);
}
const seen = new Set<string>();
for (const it of items) {
  if (seen.has(it.id)) throw new Error(`duplicate item id ${it.id}`);
  seen.add(it.id);
}
// Exhibits appear in the order the deck lists them, then by file.
const order: string[] = meta.order ?? [];
const rank = (id: string) => {
  const i = order.findIndex((p) => id.startsWith(p));
  return i < 0 ? order.length : i;
};
items.sort((a, b) => rank(a.id) - rank(b.id));
delete meta.order;

const out = join(here, "..", "showcase.pack.json");
writeFileSync(out, JSON.stringify({ ...meta, types, items }, null, 2) + "\n");
console.log(`${out}: ${types.length} types, ${items.length} items`);
