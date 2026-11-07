import type { Etude } from "../engine.ts";
import type { Db, Row } from "../db.ts";
import { muted, referring, rowFor, rows, safeSettings, TABLES } from "./log.ts";
import { emptyCard } from "../scheduler.ts";

/** Bump when the projection or the canonical replay changes what it writes, so every device rebuilds once. 2: FSRS replay keeps the deck's fuzz. 3: a script's random draws depend on the card. */
export const VERSION = 3;

/** What the relational view was last built against: this code and the shipped types and schedulers. */
function fingerprint(db: Db) {
  const shipped = db.all("SELECT 't' k,id,updated FROM types WHERE builtin=1 UNION ALL SELECT 's',id,updated FROM schedulers WHERE builtin=1 ORDER BY 1,2");
  return JSON.stringify([VERSION, shipped.map(r => [r.k, r.id, r.updated])]);
}

/** Inserts or replaces a row with every column set: values it lacks get the column default, as on a fresh insert. */
function writer(db: Db) {
  const info = new Map<string, { name: string; dflt: string | null }[]>();
  const columns = (table: string) => {
    let c = info.get(table);
    if (!c) { c = db.all(`PRAGMA table_info("${table}")`).map(r => ({ name: r.name, dflt: r.dflt_value })); info.set(table, c); }
    return c;
  };
  return (table: string, raw: Record<string, any>) => {
    const cols = columns(table), given = cols.filter(c => Object.hasOwn(raw, c.name)), rest = cols.filter(c => !Object.hasOwn(raw, c.name));
    db.run(`INSERT INTO "${table}" (${given.map(c => `"${c.name}"`).join(",")}) VALUES (${given.map(() => "?").join(",")}) ON CONFLICT DO UPDATE SET ${[...given.map(c => `"${c.name}"=excluded."${c.name}"`), ...rest.map(c => `"${c.name}"=${c.dflt ?? "NULL"}`)].join(",")}`, ...given.map(c => raw[c.name]));
  };
}
const jsonCols = (r: any) => Object.fromEntries(Object.entries(r).map(([k,v]) => [k,["fields","config","def"].includes(k) ? JSON.stringify(clean(v)) : v]));
const itemTags = (r: Row) => Object.keys(r.tags ?? {}).filter(t => r.tags[t] === true).sort();

/** Another device (or anyone holding the vault key) wrote these settings: only the synced keys are taken, each through the checks a local change gets. */
function applySettings(e: Etude, r: Row) {
  // Provider URLs, key names and the Market catalog stay this device's own, and theme CSS is sanitized again.
  const incoming = safeSettings(clean(r.value));
  for (const k of ["themes","theme","dayStartHour","learnAheadMinutes","typePrefs","fun","minimi","accent","avatar","name"]) {
    if (!(k in incoming)) continue;
    const v = incoming[k];
    if (k === "learnAheadMinutes" && !(typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 24 * 60)) continue;
    if (k === "dayStartHour" && !(typeof v === "number" && Number.isInteger(v))) continue;
    if (k === "fun" && typeof v !== "boolean") continue;
    if ((k === "minimi" || k === "name") && typeof v !== "string") continue;
    try { e.updateSettings({[k]:v}); } catch { /* an invalid value from another device is ignored */ }
  }
}

/** Dirty keys the projection handles: the tables, and cards whose schedule changed here. Media keys are the media step's. */
const PROJECTED = [...TABLES, "replay"];

/** A type asset's synced bytes. A missing one hasn't been downloaded, or its blob event hasn't arrived. */
const syncedBytes = (db: Db, hash: string): Uint8Array | undefined => db.get("SELECT bytes FROM sync_blobs WHERE hash=? AND bytes IS NOT NULL", hash)?.bytes;

/** `waiting`: type asset keys whose bytes aren't here yet. They stay marked, for the sync that brings them. */
function projected(e: Etude, waiting: string[] = []) {
  const db = e.db;
  db.run(`DELETE FROM sync_dirty WHERE tbl IN (${PROJECTED.map(() => "?").join(",")})`, ...PROJECTED);
  for (const key of waiting) db.run("INSERT OR IGNORE INTO sync_dirty VALUES('type_assets',?,'')", key);
  db.run("INSERT INTO sync_meta VALUES('projection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(fingerprint(db)));
  db.run("DELETE FROM sync_meta WHERE key='unprojected'");
}

/** Rebuilds the whole relational view from the registers. The reference the incremental projection must match. Local integer handles survive. */
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
  const insert = writer(db);
  db.sql.exec("PRAGMA foreign_keys=OFF");
  try {
    db.tx(() => muted(db, () => {
      // This device's own asset bytes, which wait for their upload before they are in sync_blobs.
      const own = new Map<string, Uint8Array>(db.all("SELECT hash,bytes FROM type_assets").map(r => [r.hash, r.bytes]));
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
        const tags = itemTags(r);
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
      for (const [key,r] of data.get("settings")!) if (key === "settings") applySettings(e, r);
      const waiting: string[] = [];
      for (const [key,r] of data.get("type_assets")!) {
        const bytes = syncedBytes(db, r.hash) ?? own.get(r.hash);
        if (bytes) insert("type_assets",{...r,bytes});
        else waiting.push(key);
      }
      e.invalidateCaches();
      e.replaySyncedCards();
      const violations = db.all("PRAGMA foreign_key_check");
      if (violations.length) throw new Error("sync merge has broken references");
      projected(e, waiting);
    }));
  } finally { db.sql.exec("PRAGMA foreign_keys=ON"); }
}

/**
 * Projects only the keys whose registers changed (`sync_dirty`), plus the rows that depend on them: the
 * items of a deck or type that appears or goes, the cards of such an item, the history of such a card.
 * Writes what `project` would write for those rows, in one transaction with capture muted.
 */
export function projectDirty(e: Etude) {
  const db = e.db;
  const upsert = writer(db);
  db.tx(() => muted(db, () => {
    // References are checked at commit, so parents and children can change in any order within it.
    db.run("PRAGMA defer_foreign_keys=ON");
    const dirty = new Map<string, Set<string>>(TABLES.map(t => [t, new Set<string>()]));
    for (const r of db.all("SELECT DISTINCT tbl,key FROM sync_dirty")) dirty.get(r.tbl)?.add(r.key);
    // Keys whose scheduling fields changed, here or elsewhere: the relational row can't tell, since a local edit is already in it.
    const scheduling = new Map<string, Set<string>>();
    for (const r of db.all("SELECT tbl,key FROM sync_dirty WHERE field!=''")) scheduling.set(r.tbl, (scheduling.get(r.tbl) ?? new Set()).add(r.key));
    const moved = (table: string, key: string) => !!scheduling.get(table)?.has(key);
    const mark = (table: string, field: string, target: string) => { for (const k of referring(db, table, field, target)) dirty.get(table)!.add(k); };
    const sorted = (table: string) => [...dirty.get(table)!].sort();
    const max = (table: string) => db.get(`SELECT coalesce(max(id),0) n FROM ${table}`)!.n as number;
    const reindex = new Set<string>();
    // Cards to replay, each from its earliest changed review (time, sync id), or from the start (null).
    const replay = new Map<number, [string, string] | null>();
    const touch = (card: number, at: [string, string] | null) => {
      const cur = replay.get(card);
      if (!replay.has(card) || (cur !== null && (at === null || at[0] < cur![0] || (at[0] === cur![0] && at[1] < cur![1])))) replay.set(card, at);
    };
    // Decks whose cards (subdecks' too) may have another configuration now.
    const deckNames = new Set<string>(), schedulerTypes = new Set<string>(), presets: string[] = [];
    let replayAll = false;
    const schedulerOf = (def: string | undefined) => { const d = def ? JSON.parse(def) : null; return JSON.stringify([d?.scheduler ?? null, d?.schedulerOptions ?? null]); };

    const pk: Record<string, string> = { presets: "id", types: "id", schedulers: "id", type_folders: "path", type_placement: "type_id", tag_meta: "tag" };
    for (const t of ["presets","types","schedulers","type_folders","type_placement","tag_meta"]) for (const key of sorted(t)) {
      const r = rowFor(db, t, key);
      const where = `${pk[t]}=?${t === "types" || t === "schedulers" ? " AND builtin=0" : ""}`;
      const old = db.get(`SELECT * FROM ${t} WHERE ${pk[t]}=?`, key);
      if (r) { if (t === "types" || t === "schedulers") r.id = key; upsert(t, jsonCols(r)); }
      else db.run(`DELETE FROM ${t} WHERE ${where}`, key);
      const now = db.get(`SELECT * FROM ${t} WHERE ${pk[t]}=?`, key);
      if (t === "presets") {
        if (!!old !== !!now) mark("decks", "/preset_id", key);
        if (moved(t, key) || !!old !== !!now) {
          for (const d of db.all("SELECT name FROM decks WHERE preset_id=?", key)) deckNames.add(d.name);
          presets.push(key);
        }
      }
      if (t === "types") {
        if (!!old !== !!now) mark("items", "/type", key);
        if (old?.def !== now?.def) for (const i of db.all("SELECT id FROM items WHERE type=?", key)) reindex.add(i.id);
        if (moved(t, key) || schedulerOf(old?.def) !== schedulerOf(now?.def)) schedulerTypes.add(key);
      }
      if (t === "schedulers") replayAll = true;
    }

    // Decks: the rows first under placeholder names, then every name, since a duplicate's suffix depends on the others.
    let deckMax = max("decks");
    if (dirty.get("decks")!.size) {
      const prior = new Map<string, Row | undefined>(sorted("decks").map(k => [k, db.get("SELECT name,config,preset_id FROM decks WHERE sync_id=?", k)]));
      for (const key of sorted("decks")) {
        const r = rowFor(db, "decks", key);
        const old = db.get("SELECT id FROM decks WHERE sync_id=?", key);
        if (r) upsert("decks", { ...jsonCols(r), id: old?.id ?? ++deckMax, sync_id: key, name: "\u0001" + key, preset_id: r.preset_id && db.get("SELECT 1 FROM presets WHERE id=?", r.preset_id) ? r.preset_id : null });
        else if (old) db.run("DELETE FROM decks WHERE id=?", old.id);
        if (!!old !== !!r) mark("items", "/deck_id", key);
      }
      const names = new Set<string>(), want = new Map<string, string>();
      for (const r of db.all("SELECT key,value FROM sync_registers WHERE tbl='decks' AND field='/name' AND key NOT IN (SELECT key FROM sync_deleted WHERE tbl='decks') ORDER BY key")) {
        let name = JSON.parse(r.value);
        if (names.has(name)) name += ` [${r.key.slice(0,8)}]`;
        names.add(name);
        want.set(r.key, name);
      }
      const renamed = db.all("SELECT sync_id,name FROM decks").filter(d => want.has(d.sync_id) && want.get(d.sync_id) !== d.name);
      // Names are unique: clear the old ones before any deck takes another's.
      for (const d of renamed) db.run("UPDATE decks SET name=? WHERE sync_id=?", "\u0001" + d.sync_id, d.sync_id);
      for (const d of renamed) {
        db.run("UPDATE decks SET name=? WHERE sync_id=?", want.get(d.sync_id)!, d.sync_id);
        if (!d.name.startsWith("\u0001")) deckNames.add(d.name);
        deckNames.add(want.get(d.sync_id)!);
      }
      for (const [key, o] of prior) {
        const n = db.get("SELECT name,config,preset_id FROM decks WHERE sync_id=?", key);
        if (moved("decks", key) || !o || !n || o.name !== n.name || o.config !== n.config || o.preset_id !== n.preset_id) for (const d of [o, n]) if (d) deckNames.add(d.name as string);
      }
    }
    for (const key of presets) for (const d of db.all("SELECT name FROM decks WHERE preset_id=?", key)) deckNames.add(d.name);

    for (const key of sorted("items")) {
      const r = rowFor(db, "items", key);
      const old = db.get("SELECT deck_id,type,created FROM items WHERE id=?", key);
      const deck = r?.deck_id != null ? db.get("SELECT id FROM decks WHERE sync_id=?", r.deck_id) : undefined;
      const live = !!(deck && r!.type != null && db.get("SELECT 1 FROM types WHERE id=?", r!.type));
      if (live) {
        const tags = itemTags(r!);
        upsert("items", { ...jsonCols(r), id: key, deck_id: deck!.id, tags: JSON.stringify(tags), updated: r!.updated ?? r!.created, title: "", search: "" });
        db.run("DELETE FROM item_tags WHERE item_id=?", key);
        for (const tag of tags) upsert("item_tags", { item_id: key, tag });
        reindex.add(key);
      } else if (old) db.run("DELETE FROM items WHERE id=?", key);
      if (!!old !== live) mark("cards", "/item_id", key);
      else if (live && (moved("items", key) || old!.created !== r!.created || old!.type !== r!.type || old!.deck_id !== deck!.id)) for (const c of db.all("SELECT id FROM cards WHERE item_id=?", key)) touch(c.id, null);
    }

    let cardMax = max("cards");
    for (const key of sorted("cards")) {
      const r = rowFor(db, "cards", key);
      const old = db.get("SELECT id FROM cards WHERE sync_id=?", key);
      const item = r?.item_id != null ? db.get("SELECT created FROM items WHERE id=?", r.item_id) : undefined;
      if (item) {
        const id = old?.id ?? ++cardMax;
        upsert("cards", { ...emptyCard(new Date(item.created)), ...r, id, sync_id: key, sched_state: null });
        touch(id, null);
      } else if (old) db.run("DELETE FROM cards WHERE id=?", old.id);
      if (!!old !== !!item) { mark("reviews", "/card_id", key); mark("attempts", "/card_id", key); }
    }

    // A review's row names its attempt and the attempt's names its review: a change to either touches both.
    for (let grew = true; grew;) {
      const before = dirty.get("reviews")!.size + dirty.get("attempts")!.size;
      for (const k of [...dirty.get("reviews")!]) mark("attempts", "/review_id", k);
      for (const k of [...dirty.get("attempts")!]) mark("reviews", "/attempt_id", k);
      grew = dirty.get("reviews")!.size + dirty.get("attempts")!.size > before;
    }
    const history = (table: string) => {
      let next = max(table);
      return new Map(sorted(table).map(key => {
        const r = rowFor(db, table, key);
        const card = r?.card_id != null ? db.get("SELECT id FROM cards WHERE sync_id=?", r.card_id)?.id : undefined;
        const old = db.get(`SELECT id FROM ${table} WHERE sync_id=?`, key);
        // A deleted row keeps its registers: they still say which card's history it was in.
        const was = r ? undefined : db.get(`SELECT c.id FROM sync_registers g JOIN cards c ON c.sync_id=json_extract(g.value,'$') WHERE g.tbl=? AND g.key=? AND g.field='/card_id'`, table, key)?.id;
        return [key, { r, card, old, was, id: card ? old?.id ?? ++next : null }];
      }));
    };
    const reviews = history("reviews"), attempts = history("attempts");
    const local = (table: string, batch: typeof reviews, key: unknown) => key == null ? null : batch.has(key as string) ? batch.get(key as string)!.id : db.get(`SELECT id FROM ${table} WHERE sync_id=?`, key as string)?.id ?? null;
    for (const [key, a] of attempts) {
      if (a.card) upsert("attempts", { ...a.r, id: a.id, sync_id: key, card_id: a.card, review_id: local("reviews", reviews, a.r!.review_id) });
      else if (a.old) db.run("DELETE FROM attempts WHERE id=?", a.old.id);
    }
    for (const [key, v] of reviews) {
      if (v.card) {
        upsert("reviews", { ...v.r, id: v.id, sync_id: key, card_id: v.card, attempt_id: local("attempts", attempts, v.r!.attempt_id), state: 0, card_before: "{}", due_after: v.r!.ts });
        touch(v.card, [v.r!.ts, key]);
      } else {
        if (v.old) db.run("DELETE FROM reviews WHERE id=?", v.old.id);
        // An undone review leaves its card's later history to be replayed without it.
        if (v.was) touch(v.was, null);
      }
    }

    if (dirty.get("settings")!.has("settings")) {
      const r = rowFor(db, "settings", "settings"), day = e.settings().dayStartHour;
      if (r) applySettings(e, r);
      // Script schedulers see study days, which start at this hour.
      if (moved("settings", "settings") || e.settings().dayStartHour !== day) replayAll = true;
    }
    const waiting: string[] = [];
    for (const key of sorted("type_assets")) {
      const r = rowFor(db, "type_assets", key);
      if (r) {
        // This device's own copy until its upload puts the bytes in sync_blobs; neither: the row waits as it is.
        const bytes = syncedBytes(db, r.hash) ?? db.get("SELECT bytes FROM type_assets WHERE hash=? LIMIT 1", r.hash)?.bytes;
        if (bytes) upsert("type_assets", { ...r, bytes });
        else waiting.push(key);
      } else { const [type, name] = JSON.parse(key); db.run("DELETE FROM type_assets WHERE type_id=? AND name=?", type, name); }
    }

    e.invalidateCaches({ items: reindex });
    if (replayAll) e.replaySyncedCards();
    else {
      const like = (name: string) => name.replace(/[\\%_]/g, "\\$&") + "::%";
      for (const name of deckNames) for (const c of db.all("SELECT c.id FROM cards c JOIN items i ON i.id=c.item_id JOIN decks d ON d.id=i.deck_id WHERE d.name=? OR d.name LIKE ? ESCAPE '\\'", name, like(name))) touch(c.id, null);
      for (const type of schedulerTypes) for (const c of db.all("SELECT c.id FROM cards c JOIN items i ON i.id=c.item_id WHERE i.type=?", type)) touch(c.id, null);
      // Cards whose schedule this device changed itself: their reviews are already in the history to replay.
      for (const r of db.all("SELECT c.id FROM sync_dirty s JOIN cards c ON c.sync_id=s.key WHERE s.tbl='replay'")) touch(r.id, ["\uffff", ""]);
      e.replaySyncedCards(replay);
    }
    projected(e, waiting);
  }));
}

/**
 * What the relational view needs: the whole of it on the first run of this code, after new shipped
 * definitions, or after a run that stopped in an older version; the changed keys when registers changed.
 */
export function projectionPending(e: Etude): "full" | "changes" | null {
  const db = e.db;
  const built = db.get("SELECT value FROM sync_meta WHERE key='projection'")?.value;
  if (built !== JSON.stringify(fingerprint(db)) || db.get("SELECT 1 FROM sync_meta WHERE key='unprojected' AND value='true'")) return "full";
  return db.get(`SELECT 1 FROM sync_dirty WHERE tbl IN (${PROJECTED.map(() => "?").join(",")}) LIMIT 1`, ...PROJECTED) ? "changes" : null;
}

/** Brings the relational view up to date. A failed incremental pass rolls back and the whole view is rebuilt instead. */
export function projectChanges(e: Etude) {
  const pending = projectionPending(e);
  if (pending === "full") project(e);
  else if (pending === "changes") {
    try { projectDirty(e); }
    catch (err) {
      project(e);
      // Kept for diagnosis: the incremental path should never need this.
      e.db.run("INSERT INTO sync_meta VALUES('fallback',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(String((err as Error)?.stack ?? err)));
    }
  }
  return pending;
}

function clean(value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,clean(v)]));
}
