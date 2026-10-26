// Builds examples/showcase.pack.json from the type directories and item files next to this script.
// node examples/showcase/build.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
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
// Item fields may say "@inline:images/x.webp": the file next to this script, inlined as a data URL,
// so the pack carries its own images.
const MIME: Record<string, string> = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
for (const it of items as { fields?: Record<string, unknown> }[])
  for (const [k, v] of Object.entries(it.fields ?? {}))
    if (typeof v === "string" && v.startsWith("@inline:")) {
      const rel = v.slice(8);
      const mime = MIME[extname(rel).toLowerCase()];
      if (!mime) throw new Error(`${rel}: unknown image type`);
      it.fields![k] = `data:${mime};base64,${readFileSync(join(here, rel)).toString("base64")}`;
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
