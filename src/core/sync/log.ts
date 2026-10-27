import type { Db, Row } from "../db.ts";

export type Stamp = [number, number, string];
export function tick(last: Stamp, remote?: Stamp, now = Date.now()): Stamp {
  const wall = Math.max(now, last[0], remote?.[0] ?? 0);
  const count = wall === last[0] && wall === remote?.[0] ? Math.max(last[1], remote[1]) + 1 : wall === last[0] ? last[1] + 1 : wall === remote?.[0] ? remote[1] + 1 : 0;
  return [wall, count, last[2]];
}
export const compare = (a: Stamp, b: Stamp) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
export type Change = { v: 1; table: string; key: string; stamp: Stamp; fields: Record<string, unknown>; deleted?: boolean };
export const TABLES = ["presets", "decks", "types", "schedulers", "type_folders", "type_placement", "items", "cards", "attempts", "reviews", "tag_meta", "settings", "type_assets"];
const UUID_TABLES = ["decks", "cards", "attempts", "reviews"];
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const id = (s: string) => `"${s}"`;
const SETTINGS = new Set(["dayStartHour", "learnAheadMinutes", "theme", "themes"]);
export const safeSettings = (s: any) => Object.fromEntries(Object.entries(s ?? {}).filter(([k]) => SETTINGS.has(k)));

function keyExpr(table: string, prefix: string) {
  if (UUID_TABLES.includes(table)) return `${prefix}.sync_id`;
  if (table === "cards") return `json_array(${prefix}.item_id,${prefix}.face)`;
  if (table === "type_assets") return `json_array(${prefix}.type_id,${prefix}.name)`;
  return `${prefix}.${({ type_folders: "path", type_placement: "type_id", tag_meta: "tag", settings: "key" } as any)[table] ?? "id"}`;
}
function rowExpr(db: Db, table: string, prefix: string) {
  const cols = db.all(`PRAGMA table_info(${id(table)})`).map(r => r.name as string).filter(c => c !== "sync_id" && !(UUID_TABLES.includes(table) && c === "id") && !(table === "cards" && c === "id") && !(table === "type_assets" && c === "bytes"));
  return `json_object(${cols.flatMap(c => {
    let expr = `${prefix}.${id(c)}`;
    if (c === "deck_id") expr = `(SELECT sync_id FROM decks WHERE id=${expr})`;
    if (c === "card_id") expr = `(SELECT sync_id FROM cards WHERE id=${expr})`;
    if (c === "attempt_id") expr = `(SELECT sync_id FROM attempts WHERE id=${expr})`;
    if (c === "review_id") expr = `(SELECT sync_id FROM reviews WHERE id=${expr})`;
    return [q(c), expr];
  }).join(",")})`;
}
function allowed(table: string, p: string) {
  if (table === "settings") return `${p}.key='settings'`;
  if (table === "types" || table === "schedulers") return `${p}.builtin=0`;
  return "1";
}

/** Capture SQL writes before their foreign keys or rows disappear. Triggers join the caller's transaction. */
export function install(db: Db) {
  db.sql.exec(`CREATE TABLE IF NOT EXISTS sync_control (id INTEGER PRIMARY KEY CHECK(id=1), applying INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL, wall INTEGER NOT NULL DEFAULT 0, counter INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sync_outbox (seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, key TEXT NOT NULL, old TEXT, value TEXT, wall INTEGER, counter INTEGER);
    CREATE TABLE IF NOT EXISTS sync_events (id TEXT PRIMARY KEY, body TEXT NOT NULL, ciphertext TEXT, sent INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sync_registers (tbl TEXT, key TEXT, field TEXT, value TEXT, stamp TEXT NOT NULL, PRIMARY KEY(tbl,key,field));
    CREATE TABLE IF NOT EXISTS sync_deleted (tbl TEXT, key TEXT, stamp TEXT NOT NULL, PRIMARY KEY(tbl,key));
    CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_blobs (hash TEXT PRIMARY KEY, name TEXT NOT NULL, bytes BLOB);
    INSERT OR IGNORE INTO sync_control(id,device) VALUES(1,lower(hex(randomblob(16))));`);
  for (const table of UUID_TABLES) {
    if (!db.all(`PRAGMA table_info(${table})`).some(r => r.name === "sync_id")) db.sql.exec(`ALTER TABLE ${table} ADD COLUMN sync_id TEXT`);
    db.run(`UPDATE ${table} SET sync_id=${table === "cards" ? "json_array(item_id,face)" : "lower(hex(randomblob(16)))"} WHERE sync_id IS NULL`);
    db.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS sync_${table}_uid ON ${table}(sync_id)`);
  }
  for (const col of ["sync_reset", "sync_due", "sync_due_at"]) if (!db.all("PRAGMA table_info(cards)").some(r=>r.name===col)) db.sql.exec(`ALTER TABLE cards ADD COLUMN ${col} TEXT`);
  for (const table of TABLES) {
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      const p = op === "DELETE" ? "OLD" : "NEW";
      const key = keyExpr(table, p);
      const row = rowExpr(db, table, p);
      const uid = UUID_TABLES.includes(table);
      // INSERT assigns an identity before capturing the row. Its internal UPDATE is suppressed by the null identity.
      const assign = uid && op === "INSERT" ? `UPDATE ${table} SET sync_id=${table === "cards" ? "json_array(item_id,face)" : "lower(hex(randomblob(16)))"} WHERE id=NEW.id AND sync_id IS NULL;` : "";
      const selectRow = uid && op === "INSERT" ? rowExpr(db, table, "s") : row;
      const selectKey = uid && op === "INSERT" ? "s.sync_id" : key;
      const from = uid && op === "INSERT" ? ` FROM ${table} s WHERE s.id=NEW.id` : "";
      db.sql.exec(`CREATE TRIGGER IF NOT EXISTS sync_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}
        WHEN (SELECT applying FROM sync_control WHERE id=1)=0 AND ${op === "UPDATE" && ["types","schedulers"].includes(table) ? "(NEW.builtin=0 OR OLD.builtin=0)" : allowed(table, p)} ${uid && op === "UPDATE" ? "AND OLD.sync_id IS NOT NULL" : ""} ${op === "DELETE" && ["attempts","reviews"].includes(table) ? "AND EXISTS(SELECT 1 FROM cards WHERE id=OLD.card_id)" : ""}
        BEGIN ${assign} UPDATE sync_control SET counter=CASE WHEN wall>=CAST(unixepoch('subsec')*1000 AS INTEGER) THEN counter+1 ELSE 0 END,wall=MAX(wall,CAST(unixepoch('subsec')*1000 AS INTEGER)) WHERE id=1;
        INSERT INTO sync_outbox(tbl,key,old,value,wall,counter) SELECT ${q(table)},${selectKey},${op === "UPDATE" ? rowExpr(db, table, "OLD") : "NULL"},${op === "DELETE" ? "NULL" : selectRow},(SELECT wall FROM sync_control WHERE id=1),(SELECT counter FROM sync_control WHERE id=1)${from}; END;`);
    }
  }
}

export function muted<T>(db: Db, fn: () => T): T {
  const was = db.get("SELECT applying FROM sync_control WHERE id=1")!.applying;
  db.run("UPDATE sync_control SET applying=1 WHERE id=1");
  try { return fn(); } finally { db.run("UPDATE sync_control SET applying=? WHERE id=1", was); }
}
export function bootstrap(db: Db) {
  if (db.get("SELECT 1 FROM sync_meta WHERE key='bootstrapped'")) return;
  db.tx(() => {
    for (const table of TABLES) db.run(`INSERT INTO sync_outbox(tbl,key,old,value) SELECT ?,${keyExpr(table, "s")},NULL,${rowExpr(db, table, "s")} FROM ${table} s WHERE ${allowed(table, "s")}`, table);
    db.run("INSERT INTO sync_meta VALUES('bootstrapped','true')");
  });
}
function flatten(value: any, path = "", out: Record<string, unknown> = {}) {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) for (const [k, v] of Object.entries(value)) flatten(v, path + "/" + k.replaceAll("~", "~0").replaceAll("/", "~1"), out);
  else out[path] = value;
  return out;
}
function normal(table: string, raw: Row) {
  const r = { ...raw };
  if (Array.isArray(r.card_id)) r.card_id = JSON.stringify(r.card_id);
  for (const col of ["fields", "config", "def"]) if (typeof r[col] === "string") r[col] = JSON.parse(r[col]);
  if (table === "settings") r.value = safeSettings(JSON.parse(r.value));
  if (table === "items") {
    r.tags = Object.fromEntries((JSON.parse(r.tags) as string[]).map(t => [t, true]));
    delete r.title; delete r.search;
  }
  if (table === "cards") for (const k of Object.keys(r)) if (!["item_id", "face", "suspended", "buried_until", "sync_reset", "sync_due", "sync_due_at"].includes(k)) delete r[k];
  if (table === "reviews") { delete r.card_before; delete r.due_after; delete r.state; }
  return flatten(r);
}
export function apply(db: Db, event: Change) {
  if (event.v !== 1 || !TABLES.concat("media", "blob").includes(event.table) || !Array.isArray(event.stamp) || event.stamp.length !== 3) throw new Error("unsupported sync event");
  if (event.deleted) {
    const old = db.get("SELECT stamp FROM sync_deleted WHERE tbl=? AND key=?", event.table, event.key);
    if (!old || compare(event.stamp, JSON.parse(old.stamp)) > 0) db.run("INSERT INTO sync_deleted VALUES(?,?,?) ON CONFLICT(tbl,key) DO UPDATE SET stamp=excluded.stamp", event.table, event.key, JSON.stringify(event.stamp));
  }
  for (const [field, value] of Object.entries(event.fields)) {
    const old = db.get("SELECT stamp FROM sync_registers WHERE tbl=? AND key=? AND field=?", event.table, event.key, field);
    if (!old || compare(event.stamp, JSON.parse(old.stamp)) > 0) db.run("INSERT INTO sync_registers VALUES(?,?,?,?,?) ON CONFLICT(tbl,key,field) DO UPDATE SET value=excluded.value,stamp=excluded.stamp", event.table, event.key, field, JSON.stringify(value), JSON.stringify(event.stamp));
  }
}
export function localEvent(db: Db, table: string, key: string, fields: Record<string, unknown>, deleted = false, captured?: Stamp) {
  const c = db.get("SELECT * FROM sync_control WHERE id=1")!;
  const stamp = captured ?? tick([c.wall, c.counter, c.device]);
  const event: Change = { v: 1, table, key, stamp, fields, ...(deleted ? { deleted: true } : {}) };
  const eventId = `${c.device}:${stamp[0]}:${stamp[1]}`;
  apply(db, event);
  db.run("INSERT INTO sync_events(id,body) VALUES(?,?)", eventId, JSON.stringify(event));
  if (!captured) db.run("UPDATE sync_control SET wall=?,counter=? WHERE id=1", stamp[0], stamp[1]);
  return eventId;
}
export function drain(db: Db) {
  db.tx(() => {
    for (const r of db.all("SELECT * FROM sync_outbox ORDER BY seq")) {
      const next = r.value ? normal(r.tbl, JSON.parse(r.value)) : {};
      const old = r.old ? normal(r.tbl, JSON.parse(r.old)) : {};
      const fields: Record<string, unknown> = {};
      for (const k of new Set([...Object.keys(next), ...Object.keys(old)])) if (JSON.stringify(next[k]) !== JSON.stringify(old[k])) fields[k] = Object.hasOwn(next,k) ? next[k] : { __etude_sync_deleted__: true };
      if (r.value === null || Object.keys(fields).length) localEvent(db, r.tbl, r.key, fields, r.value === null, r.wall === null ? undefined : [r.wall,r.counter,db.get("SELECT device FROM sync_control WHERE id=1")!.device]);
    }
    db.run("DELETE FROM sync_outbox");
  });
}
export function receive(db: Db, eventId: string, event: Change) {
  if (db.get("SELECT 1 FROM sync_events WHERE id=?", eventId)) return false;
  db.tx(() => {
    apply(db, event);
    db.run("INSERT INTO sync_events(id,body,sent) VALUES(?,?,1)", eventId, JSON.stringify(event));
    const c = db.get("SELECT * FROM sync_control WHERE id=1")!;
    const stamp = tick([c.wall,c.counter,c.device], event.stamp);
    db.run("UPDATE sync_control SET wall=?,counter=? WHERE id=1", stamp[0], stamp[1]);
  });
  return true;
}
export function rows(db: Db, table: string): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const r of db.all("SELECT key,field,value FROM sync_registers WHERE tbl=? ORDER BY key,length(field),field", table)) {
    const row = out.get(r.key) ?? {};
    out.set(r.key, row);
    const parts = r.field.split("/").slice(1).map((s: string) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
    let obj = row;
    for (const p of parts.slice(0,-1)) {
      if (["__proto__", "constructor", "prototype"].includes(p)) throw new Error("invalid sync field");
      if (!obj[p] || typeof obj[p] !== "object" || Array.isArray(obj[p])) obj[p] = {};
      obj = obj[p];
    }
    const leaf = parts.at(-1)!;
    if (["__proto__", "constructor", "prototype"].includes(leaf)) throw new Error("invalid sync field");
    const value = JSON.parse(r.value);
    if (value?.__etude_sync_deleted__ === true) delete obj[leaf];
    else obj[leaf] = value;
  }
  for (const r of db.all("SELECT key FROM sync_deleted WHERE tbl=?", table)) out.delete(r.key);
  return out;
}
