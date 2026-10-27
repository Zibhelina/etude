import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PUBLIC_DEMO_TYPES = ["country-map", "element", "flippy"] as const;

/** Only explicitly approved free demos and their assets may enter the website. */
export function checkPublicContent(site: string) {
  const allowed = new Set<string>(PUBLIC_DEMO_TYPES);
  for (const entry of readdirSync(join(site, "decks"), { withFileTypes: true })) {
    const id = entry.name.replace(/\.json$/, "");
    if (!entry.isFile() || !entry.name.endsWith(".json") || !allowed.has(id)) throw new Error(`unapproved public demo: ${entry.name}`);
    const demo = JSON.parse(readFileSync(join(site, "decks", entry.name), "utf8"));
    if (demo.type?.id !== id) throw new Error(`public demo type mismatch: ${entry.name}`);
  }
  const assets = join(site, "src/type-assets");
  if (existsSync(assets)) {
    for (const entry of readdirSync(assets, { withFileTypes: true })) {
      if (!entry.isDirectory() || !allowed.has(entry.name)) throw new Error(`unapproved public assets: ${entry.name}`);
    }
  }
}
