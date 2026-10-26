// Saves a snapshot of the Market for the website: the index (trimmed to what the page shows) and
// the cover pictures, so the section works offline and before the live index answers.
//   node site/tools/market-snapshot.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const RAW = "https://raw.githubusercontent.com/Zibhelina/etude-market/main";
const out = join(dirname(fileURLToPath(import.meta.url)), "../src/assets/market");
mkdirSync(join(out, "covers"), { recursive: true });
const index = await (await fetch(`${RAW}/index.json`)).json();
const entries = [];
for (const e of index.entries) {
  const row = { id: e.id, kind: e.kind, name: e.name, description: e.description, tags: e.tags ?? [] };
  if (e.kind === "theme") row.theme = { scheme: e.summary.theme.scheme, vars: e.summary.theme.vars };
  if (e.cover) {
    const buf = Buffer.from(await (await fetch(`${RAW}/${e.cover}`)).arrayBuffer());
    const file = `${e.kind}-${e.id}.webp`;
    writeFileSync(join(out, "covers", file), buf);
    row.cover = `assets/market/covers/${file}`;
  }
  if (e.kind !== "theme") row.items = e.summary?.items ?? null;
  entries.push(row);
}
writeFileSync(join(out, "market.json"), JSON.stringify({ generated: index.generated, entries }));
console.log(JSON.stringify({ entries: entries.length, covers: entries.filter((e) => e.cover).length }));
