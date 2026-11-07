// Snapshots: the merged registers and tombstones up to a server seq, in parts, so a new device downloads the state
// instead of replaying the whole log (docs/sync-snapshots.md). The registers are a state-based CRDT, so merging a
// snapshot over registers that already hold some of its events changes nothing, and the events after it merge as usual.
import type { Db } from "../db.ts";
import { compare, tick, TABLES } from "./log.ts";

/** Registers per part: about 8 MB of JSON for a typical collection, so a phone holds one part at a time. */
export const PART_REGISTERS = 50_000;

const ALLOWED = [...TABLES, "media", "blob"];

/**
 * The parts' JSON texts. Read without a pause, so they agree with each other and with the cursor read beside them.
 * Registers go in key order; the tombstones go in the first part.
 */
export function snapshotParts(db: Db, per = PART_REGISTERS): string[] {
  const deleted = db.get("SELECT json_group_array(json_array(tbl,key,stamp)) j FROM (SELECT tbl,key,stamp FROM sync_deleted ORDER BY tbl,key)")!.j as string;
  const chunks: string[] = [];
  let after: string[] = [];
  for (;;) {
    const from = after.length ? "WHERE (tbl,key,field) > (?,?,?)" : "WHERE 1";
    const end = db.get(`SELECT tbl,key,field FROM sync_registers ${from} ORDER BY tbl,key,field LIMIT 1 OFFSET ?`, ...after, per - 1);
    const upto = end ? [end.tbl, end.key, end.field] : [];
    chunks.push(db.get(`SELECT json_group_array(json_array(tbl,key,field,value,stamp)) j FROM (SELECT tbl,key,field,value,stamp FROM sync_registers ${from}${end ? " AND (tbl,key,field) <= (?,?,?)" : ""} ORDER BY tbl,key,field)`, ...after, ...upto)!.j as string);
    if (!end) break;
    after = upto;
  }
  return chunks.map((registers, i) => `{"v":1,"part":${i},"last":${i === chunks.length - 1},"registers":${registers},"deleted":${i === 0 ? deleted : "[]"}}`);
}

const ready = new WeakSet<object>();
/** `etude_sync_newer(a, b)`: stamp a wins over stamp b, as in apply(). */
function newer(db: Db) {
  if (ready.has(db.sql)) return;
  db.sql.function("etude_sync_newer", { deterministic: true }, (a, b) => (compare(JSON.parse(String(a)), JSON.parse(String(b))) > 0 ? 1 : 0));
  ready.add(db.sql);
}

/** Merges one part into the registers and tombstones, the newest stamp winning. Run it in a transaction. */
export function mergeSnapshotPart(db: Db, json: string): { part: number; last: boolean; registers: number } {
  const head = db.get("SELECT json_extract(?1,'$.v') v, json_extract(?1,'$.part') part, json_extract(?1,'$.last') last, json_array_length(?1,'$.registers') n", json);
  if (!head || head.v !== 1 || !Number.isInteger(head.part)) throw new Error("unsupported snapshot part");
  // An older app refuses a table it doesn't know, as it does for an event.
  const marks = ALLOWED.map(() => "?").join(",");
  if (db.get(`SELECT 1 FROM json_each(?,'$.registers') WHERE json_extract(value,'$[0]') NOT IN (${marks}) UNION ALL SELECT 1 FROM json_each(?,'$.deleted') WHERE json_extract(value,'$[0]') NOT IN (${marks}) LIMIT 1`, json, ...ALLOWED, json, ...ALLOWED))
    throw new Error("unsupported sync table in the snapshot");
  newer(db);
  // "WHERE true" lets SQLite tell the ON CONFLICT clause from a join.
  db.run(`INSERT INTO sync_registers(tbl,key,field,value,stamp) SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]') FROM json_each(?,'$.registers') WHERE true
    ON CONFLICT(tbl,key,field) DO UPDATE SET value=excluded.value,stamp=excluded.stamp WHERE etude_sync_newer(excluded.stamp,sync_registers.stamp)`, json);
  db.run(`INSERT INTO sync_deleted(tbl,key,stamp) SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?,'$.deleted') WHERE true
    ON CONFLICT(tbl,key) DO UPDATE SET stamp=excluded.stamp WHERE etude_sync_newer(excluded.stamp,sync_deleted.stamp)`, json);
  // Registers came in without their events' marks: the next projection rebuilds everything.
  db.run("INSERT INTO sync_meta VALUES('unprojected','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  return { part: head.part, last: head.last === 1, registers: head.n };
}

/** After the last part: the clock moves past every stamp merged, so this device's next change wins over them. */
export function finishSnapshot(db: Db) {
  const max = db.get("SELECT stamp FROM (SELECT stamp FROM sync_registers UNION ALL SELECT stamp FROM sync_deleted) ORDER BY json_extract(stamp,'$[0]') DESC, json_extract(stamp,'$[1]') DESC LIMIT 1");
  if (!max) return;
  const c = db.get("SELECT * FROM sync_control WHERE id=1")!;
  const stamp = tick([c.wall, c.counter, c.device], JSON.parse(max.stamp));
  db.run("UPDATE sync_control SET wall=?,counter=? WHERE id=1", stamp[0], stamp[1]);
}
