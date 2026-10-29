import type { Etude } from "../engine.ts";
import { muted, rows, safeSettings, TABLES } from "./log.ts";
import { emptyCard } from "../scheduler.ts";

/** Rebuild the relational view of the registers. Local integer handles survive each rebuild. */
export function project(e: Etude) {
  const db = e.db;
  const data = new Map(TABLES.map(t => [t, rows(db,t)]));
  const prior = new Map<string, Map<string, number>>();
  for (const t of ["decks", "cards", "attempts", "reviews"]) prior.set(t, new Map(db.all(`SELECT id,sync_id FROM ${t}`).map(r => [r.sync_id,r.id])));
  const ids = new Map<string, Map<string, number>>();
  for (const t of ["decks", "cards", "attempts", "reviews"]) {
    let max = Math.max(0,...prior.get(t)!.values());
    ids.set(t,new Map([...data.get(t)!.keys()].map(k => [k,prior.get(t)!.get(k) ?? ++max])));
  }
  const insert = (table: string, raw: Record<string, any>) => {
    const cols = new Set(db.all(`PRAGMA table_info("${table}")`).map(r => r.name));
    const entries = Object.entries(raw).filter(([k]) => cols.has(k));
    db.run(`INSERT INTO "${table}" (${entries.map(([k]) => `"${k}"`).join(",")}) VALUES (${entries.map(() => "?").join(",")}) ON CONFLICT DO UPDATE SET ${entries.map(([k]) => `"${k}"=excluded."${k}"`).join(",")}`, ...entries.map(([,v]) => v));
  };
  const jsonCols = (r: any) => Object.fromEntries(Object.entries(r).map(([k,v]) => [k,["fields","config","def"].includes(k) ? JSON.stringify(clean(v)) : v]));
  db.sql.exec("PRAGMA foreign_keys=OFF");
  try {
    db.tx(() => muted(db, () => {
      // Keep shipped definitions and device settings; all collection content comes from the log.
      for (const t of ["reviews","attempts","cards","item_tags","items","decks","presets","type_assets","type_folders","type_placement","tag_meta"]) db.run(`DELETE FROM ${t}`);
      for (const t of ["types","schedulers"]) db.run(`DELETE FROM ${t} WHERE builtin=0`);
      for (const t of ["presets","types","schedulers","type_folders","type_placement","tag_meta"]) for (const [key,r] of data.get(t)!) {
        if (t === "types" || t === "schedulers") r.id = key;
        insert(t,jsonCols(r));
      }
      const names = new Set<string>();
      for (const [k,r] of data.get("decks")!) {
        let name = r.name;
        if (names.has(name)) name += ` [${k.slice(0,8)}]`;
        names.add(name);
        insert("decks",{...jsonCols(r),id:ids.get("decks")!.get(k),sync_id:k,name,preset_id:r.preset_id && data.get("presets")!.has(r.preset_id) ? r.preset_id : null});
      }
      const liveItems = new Set<string>();
      for (const [k,r] of data.get("items")!) {
        if (!ids.get("decks")!.has(r.deck_id) || !db.get("SELECT 1 FROM types WHERE id=?",r.type)) continue;
        const tags = Object.keys(r.tags ?? {}).filter(t => r.tags[t] === true).sort();
        insert("items",{...jsonCols(r),id:k,deck_id:ids.get("decks")!.get(r.deck_id),tags:JSON.stringify(tags),updated:r.updated ?? r.created,title:"",search:""});
        liveItems.add(k);
        for (const tag of tags) insert("item_tags",{item_id:k,tag});
      }
      const liveCards = new Set<string>();
      for (const [k,r] of data.get("cards")!) {
        if (!liveItems.has(r.item_id)) continue;
        const created = data.get("items")!.get(r.item_id)!.created;
        insert("cards",{...emptyCard(new Date(created)),...r,id:ids.get("cards")!.get(k),sync_id:k,sched_state:null});
        liveCards.add(k);
      }
      const liveAttempts = new Set<string>();
      for (const [k,r] of data.get("attempts")!) {
        if (!liveCards.has(r.card_id)) continue;
        insert("attempts",{...r,id:ids.get("attempts")!.get(k),sync_id:k,card_id:ids.get("cards")!.get(r.card_id),review_id:ids.get("reviews")!.get(r.review_id) ?? null});
        liveAttempts.add(k);
      }
      for (const [k,r] of data.get("reviews")!) {
        if (!liveCards.has(r.card_id)) continue;
        insert("reviews",{...r,id:ids.get("reviews")!.get(k),sync_id:k,card_id:ids.get("cards")!.get(r.card_id),attempt_id:liveAttempts.has(r.attempt_id) ? ids.get("attempts")!.get(r.attempt_id) : null,state:0,card_before:"{}",due_after:r.ts});
      }
      for (const [key,r] of data.get("settings")!) if (key === "settings") {
        // Another device (or anyone holding the vault key) wrote these. Only the synced keys are
        // taken, and each goes through the same checks as a local change: provider URLs, key
        // names and the Market catalog stay this device's own, and theme CSS is sanitized again.
        const incoming = safeSettings(clean(r.value));
        for (const k of ["themes","theme","dayStartHour","learnAheadMinutes","typePrefs"]) {
          if (!(k in incoming)) continue;
          const v = incoming[k];
          if (k === "learnAheadMinutes" && !(typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 24 * 60)) continue;
          if (k === "dayStartHour" && !(typeof v === "number" && Number.isInteger(v))) continue;
          try { e.updateSettings({[k]:v}); } catch { /* an invalid value from another device is ignored */ }
        }
      }
      for (const r of data.get("type_assets")!.values()) {
        const bytes = db.get("SELECT bytes FROM sync_blobs WHERE hash=?",r.hash)?.bytes;
        if (!bytes) throw new Error(`missing local asset ${r.hash}`);
        insert("type_assets",{...r,bytes});
      }
      e.invalidateCaches();
      e.replaySyncedCards();
      const violations = db.all("PRAGMA foreign_key_check");
      if (violations.length) throw new Error("sync merge has broken references");
    }));
  } finally { db.sql.exec("PRAGMA foreign_keys=ON"); }
}
function clean(value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,clean(v)]));
}
