// Copies the new Market decks' card types and a few of their items into site/decks/, and the
// assets those items use into site/src/type-assets/, so the landing page can run them.
// The deck folders are only read.
//   node site/tools/new-decks.mjs [etude-projects-dir=~/main/projects/etude]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] ?? join(homedir(), "main/projects/etude");
const out = join(here, "../decks");
mkdirSync(out, { recursive: true });

const PACKS = {
  "country-map": ["market-decks/countries/dist/pack.json", ["geo.country.can", "geo.country.jpn", "geo.country.ita", "geo.country.egy", "geo.country.per", "geo.country.mng"]],
  element: ["market/periodic-table/pack.json", ["pt.locate.fe", "pt.identify.ne", "pt.name.au", "pt.family.w", "pt.config.c", "pt.numbers.c"]],
  flippy: ["market/flippy-bit/dist/pack.json", ["flippy.hex"]],
};
const summary = {};
for (const [type, [file, ids]] of Object.entries(PACKS)) {
  const pack = JSON.parse(readFileSync(join(src, file), "utf8"));
  const def = pack.types.find((t) => t.id === type);
  const { assets, ...rest } = def;
  const items = ids.map((id) => {
    const it = pack.items.find((i) => i.id === id);
    if (!it) throw new Error(`${type}: no item ${id}`);
    return { id: it.id, type: it.type, deck: it.deck, fields: it.fields };
  });
  // Only the assets the chosen items load ship with the site.
  const scenes = [...new Set(items.map((i) => i.fields.scene).filter(Boolean))];
  if (assets && scenes.length) {
    const dir = join(here, "../src/type-assets", type);
    mkdirSync(dir, { recursive: true });
    for (const s of scenes) writeFileSync(join(dir, `scene-${s}.bin`), Buffer.from(assets[`scene-${s}.bin`], "base64"));
  }
  const decks = pack.decks.map((d) => d.name);
  writeFileSync(join(out, `${type}.json`), JSON.stringify({ type: rest, items, assets: scenes.map((s) => `scene-${s}.bin`), deck: { name: pack.name, cards: pack.items.length, decks: decks.length, config: pack.decks[0]?.config ?? null } }));
  summary[type] = { items: items.length, scenes, cards: pack.items.length };
}
console.log(JSON.stringify(summary));
