// Folders on this computer that Sync carries to the other devices, file by file (src/core/folders.ts opens them).
//
// A folder marked here has an id of its own in the vault. Each file in it travels as it is, encrypted, through the
// same channel as the collection's media: its bytes are a blob named by their hash, and a register says which hash
// sits at which path. Another device puts the folder where its owner says, as real files, and from then on a pass
// on each device compares three things per file: what's on disk, what the vault says, and what the two last agreed on.
//
//   changed here only        → sent
//   changed there only       → written here
//   removed here             → removed from the other devices (a lot at once waits for a go-ahead)
//   removed there            → moved to this folder's trash here (never deleted)
//   changed on both          → the home device's version keeps the name; the other is kept beside it as "name (conflict …)"
//
// The home device is the one that marked the folder. A folder that isn't on disk (a drive not plugged in) is left alone.
//
// On the wire these are registers of the `media` table under keys no media file can have: "//<id>" is the folder,
// "//<id>/<path>" a file in it. A device running an Etude from before this keeps those registers and does nothing
// with them (its media task skips a path with an empty part), so it goes on syncing. Which blob holds a file's bytes
// is a register of the `blob` table under "f:<hash>", apart from the media's own "<hash>": when no synced file is
// those bytes any more, the device that made it so clears the register and deletes the blob (`garbage`), and no
// media file's blob can be touched by that.
import fs from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Db } from "../db.ts";
import { EtudeError } from "../engine.ts";
import { freeName, fsId, HEAVY, parseFsId, type Folders, type LocalFolder } from "../folders.ts";
import { randomBytes, sha256Hex } from "./crypto.ts";
import { localEvent, rowFor } from "./log.ts";

/** Media keys that start with this are a synced folder's. */
export const FOLDER_KEY = "//";
const ID = /^[0-9a-f]{32}$/;
/** The biggest file a synced folder carries, the same as a media file. Bigger ones stay on the computer they're on. */
export const MAX_SYNCED_FILE_BYTES = 100 * 1024 * 1024;
/** More removals than this in one pass, and more than half of what's carried, are held until someone says go ahead. */
const MASS = 20;
/** A download being written, renamed into place when it's whole. */
const PARTIAL = ".etude-partial-";
const TRANSFERS = 4;

/** A folder the vault carries, as every device sees it. */
export interface SyncedFolder {
  syncId: string;
  name: string;
  /** The device that marked it: its files win when the same one changed in two places. */
  home: string;
  created: string;
  files: number;
  bytes: number;
}
/** A synced folder that has a place on this computer. */
export interface FolderLink extends SyncedFolder {
  /** Where it is here, as the Notebook names it (an fs: id) and on disk. */
  id: string;
  path: string;
  isHome: boolean;
  /** Its folder isn't on disk right now. */
  missing: boolean;
  /** Set when the last pass held removals back: why. `goAhead` lets them through. */
  paused: string | null;
  last: PassReport | null;
}
export interface PassReport {
  syncId: string;
  name: string;
  at: string;
  sent: number;
  received: number;
  /** Files moved to this folder's trash because they were removed on another device. */
  removedHere: number;
  /** Files removed here, and so from the other devices. */
  removedThere: number;
  /** Files another device renamed or moved, renamed here instead of fetched again. */
  renamed: number;
  /** Files changed in two places: "path (the other version is in …)". */
  conflicts: string[];
  /** Left alone, with why. */
  skipped: string[];
  paused?: string;
  /** Sync of this folder was ended on another device: this computer keeps its files and stops carrying them. */
  ended?: boolean;
}
/** What a pass needs from Sync: a blob up (returns its name in the vault) and a blob down. */
export interface FolderIo {
  put(bytes: Uint8Array): Promise<string>;
  get(name: string): Promise<Uint8Array>;
  stop?: AbortSignal;
}

interface LinkRow {
  sync_id: string;
  folder: string;
  rel: string;
  created: string;
  paused: string | null;
  go: number;
  last: string | null;
}
type OnDisk = { size: number; mtime: number };
type Base = { hash: string; size: number; mtime: number };
type Remote = { hash: string | null; size: number };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const under = (rel: string, top: string) => !top || rel === top || rel.startsWith(top + "/");
const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const statOrNull = (path: string): fs.Stats | null => {
  try {
    return fs.statSync(path);
  } catch {
    return null;
  }
};
const isDir = (path: string) => !!statOrNull(path)?.isDirectory();
const folderKey = (syncId: string) => `${FOLDER_KEY}${syncId}`;
const fileKey = (syncId: string, rel: string) => `${FOLDER_KEY}${syncId}/${rel}`;
/** The blob register of a synced file's bytes. */
const BLOB_KEY = "f:";
const emptyReport = (syncId: string, name: string): PassReport => ({ syncId, name, at: new Date().toISOString(), sent: 0, received: 0, removedHere: 0, removedThere: 0, renamed: 0, conflicts: [], skipped: [] });

/** A few at a time. The first failure rejects, and the others stop after what they're on. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const item = items[next++];
        try {
          await fn(item);
        } catch (e) {
          failed = true;
          throw e;
        }
      }
    }),
  );
}

export class FolderFiles {
  private readonly db: Db;
  private readonly folders: Folders;
  private ready = false;

  constructor(db: Db, folders: Folders) {
    this.db = db;
    this.folders = folders;
  }

  private schema() {
    if (this.ready) return;
    this.db.sql.exec(`CREATE TABLE IF NOT EXISTS local_sync_links (sync_id TEXT PRIMARY KEY, folder TEXT NOT NULL, rel TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, paused TEXT, go INTEGER NOT NULL DEFAULT 0, last TEXT);
      CREATE TABLE IF NOT EXISTS local_sync_files (sync_id TEXT NOT NULL, rel TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, PRIMARY KEY(sync_id, rel)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS local_sync_garbage (hash TEXT PRIMARY KEY, name TEXT);`);
    this.ready = true;
  }
  private table(name: string): boolean {
    return !!this.db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);
  }
  /** Whether this computer has a place for any synced folder. Reading never makes tables. */
  private has(): boolean {
    return this.folders.available && (this.ready || this.table("local_sync_links"));
  }
  /** Sync is set up on this collection: there are registers to read and a device to speak as. */
  private configured(): boolean {
    if (!this.table("sync_control")) return false;
    const cfg = this.db.get("SELECT value FROM sync_meta WHERE key = 'config'");
    try {
      return !!cfg && JSON.parse(String(cfg.value))?.enabled === true;
    } catch {
      return false;
    }
  }
  private device(): string {
    if (!this.folders.available) throw new EtudeError("folders on a computer sync in the desktop app or `etude serve`");
    if (!this.configured()) throw new EtudeError("set up Sync first (Settings → Sync): a folder travels through it to your other devices");
    return String(this.db.get("SELECT device FROM sync_control WHERE id = 1")!.device);
  }
  /** One of this device's own changes, on its way to the others. Its mark is this pass's to answer for, not the media task's. */
  private event(table: "media" | "blob", key: string, fields: Record<string, unknown>) {
    localEvent(this.db, table, key, fields);
    this.db.run("DELETE FROM sync_dirty WHERE tbl = ? AND key = ?", table, key);
  }

  // ---------------------------------------------------------------- what the vault carries

  private metaOf(syncId: string): { name: string; home: string; created: string; off: boolean } | null {
    if (!this.table("sync_registers")) return null;
    const r = rowFor(this.db, "media", folderKey(syncId));
    if (!r || typeof r.name !== "string" || !r.name) return null;
    return { name: r.name, home: String(r.home ?? ""), created: String(r.created ?? ""), off: r.off === true };
  }
  /** The vault's say on each file of a folder: its hash, or null once it was removed. */
  private filesOf(syncId: string): Map<string, Remote> {
    const out = new Map<string, Remote>();
    const prefix = `${FOLDER_KEY}${syncId}/`;
    // "0" is the character after "/": every key that starts with the prefix, and no other.
    for (const r of this.db.all("SELECT key, field, value FROM sync_registers WHERE tbl = 'media' AND key >= ? AND key < ? AND field IN ('/hash', '/size')", prefix, `${FOLDER_KEY}${syncId}0`)) {
      const rel = String(r.key).slice(prefix.length);
      const at = out.get(rel) ?? { hash: null, size: 0 };
      const v = JSON.parse(String(r.value));
      if (r.field === "/hash") at.hash = typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null;
      else at.size = typeof v === "number" && v >= 0 ? v : 0;
      out.set(rel, at);
    }
    return out;
  }
  /** Every folder the vault carries (not the ones whose sync was ended). */
  remote(): SyncedFolder[] {
    if (!this.table("sync_registers")) return [];
    const ids = new Set<string>();
    for (const r of this.db.all("SELECT DISTINCT key FROM sync_registers WHERE tbl = 'media' AND key >= '//' AND key < '//~' AND field = '/name'")) {
      const id = String(r.key).slice(FOLDER_KEY.length);
      if (ID.test(id)) ids.add(id);
    }
    const out: SyncedFolder[] = [];
    for (const syncId of ids) {
      const m = this.metaOf(syncId);
      if (!m || m.off) continue;
      let files = 0;
      let bytes = 0;
      for (const f of this.filesOf(syncId).values()) if (f.hash) files++, (bytes += f.size);
      out.push({ syncId, name: m.name, home: m.home, created: m.created, files, bytes });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.created.localeCompare(b.created));
  }

  // ---------------------------------------------------------------- this computer's places

  private linkRows(): LinkRow[] {
    if (!this.has()) return [];
    this.schema();
    return this.db.all("SELECT * FROM local_sync_links ORDER BY created").map((r) => ({ sync_id: String(r.sync_id), folder: String(r.folder), rel: String(r.rel), created: String(r.created), paused: (r.paused as string) ?? null, go: Number(r.go) || 0, last: (r.last as string) ?? null }));
  }
  private placeOf(row: LinkRow): { folder: LocalFolder; root: string } | null {
    let folder: LocalFolder;
    try {
      folder = this.folders.folder(row.folder);
    } catch {
      return null;
    }
    if (folder.elsewhere) return null;
    const top = resolve(folder.path);
    return { folder, root: row.rel ? join(top, ...row.rel.split("/")) : top };
  }
  /** The synced folders that have a place on this computer. */
  links(): FolderLink[] {
    const rows = this.linkRows();
    if (!rows.length) return [];
    const device = this.configured() ? String(this.db.get("SELECT device FROM sync_control WHERE id = 1")!.device) : "";
    const remote = new Map(this.remote().map((r) => [r.syncId, r]));
    return rows.map((row) => {
      const place = this.placeOf(row);
      const r = remote.get(row.sync_id);
      const m = this.metaOf(row.sync_id);
      let last: PassReport | null = null;
      try {
        last = row.last ? JSON.parse(row.last) : null;
      } catch {}
      return {
        syncId: row.sync_id,
        name: r?.name ?? m?.name ?? (row.rel ? basename(row.rel) : place?.folder.name ?? ""),
        home: r?.home ?? m?.home ?? "",
        created: r?.created ?? row.created,
        files: r?.files ?? 0,
        bytes: r?.bytes ?? 0,
        id: fsId(row.folder, row.rel),
        path: place?.root ?? "",
        isHome: !!device && (r?.home ?? m?.home) === device,
        missing: !place || !isDir(place.root),
        paused: row.paused,
        last,
      };
    });
  }
  /** The places here and what a pass is holding back, without counting anything: what the tree asks for every few seconds. */
  marks(): { id: string; syncId: string; name: string; paused: string | null }[] {
    return this.cachedRows().map((row) => ({ id: fsId(row.folder, row.rel), syncId: row.sync_id, name: this.metaOf(row.sync_id)?.name ?? (row.rel ? basename(row.rel) : ""), paused: row.paused }));
  }
  /** What the Notebook and `etude folder sync list` show: what's here, and what other devices carry that isn't here yet. */
  status(): { available: boolean; configured: boolean; here: FolderLink[]; elsewhere: SyncedFolder[] } {
    const available = this.folders.available;
    const configured = available && this.configured();
    const here = available ? this.links() : [];
    const have = new Set(here.map((l) => l.syncId));
    return { available, configured, here, elsewhere: configured ? this.remote().filter((r) => !have.has(r.syncId)) : [] };
  }
  /** How a path stands: the synced folder itself, something inside one, or not carried. For the tree. */
  stateOf(id: string): "root" | "inside" | null {
    if (!this.has()) return null;
    const { folder, rel } = parseFsId(id);
    for (const row of this.cachedRows()) {
      if (row.folder !== folder) continue;
      if (row.rel === rel) return "root";
      if (under(rel, row.rel)) return "inside";
    }
    return null;
  }
  private rowsCache: LinkRow[] | null = null;
  private cachedRows(): LinkRow[] {
    return (this.rowsCache ??= this.linkRows());
  }
  private changed() {
    this.rowsCache = null;
  }
  /** A folder renamed or moved in the Notebook: a synced folder that is it, or is inside it, has a new place. */
  moved(from: string, to: string | null) {
    if (!this.has() || to === null) return;
    const a = parseFsId(from);
    const b = parseFsId(to);
    for (const row of this.linkRows()) {
      if (row.folder !== a.folder || !row.rel || !under(row.rel, a.rel) || !a.rel) continue;
      this.db.run("UPDATE local_sync_links SET folder = ?, rel = ? WHERE sync_id = ?", b.folder, b.rel + row.rel.slice(a.rel.length), row.sync_id);
    }
    this.changed();
  }
  /** Before a folder leaves the Notebook: nothing in it may still be carried (the pass would have nowhere to look). */
  assertNoneIn(folderId: string) {
    if (this.linkRows().some((r) => r.folder === folderId)) throw new EtudeError("Sync carries folders in it: stop syncing them on this computer first (their files stay on disk)", 409);
  }
  private find(ref: string): LinkRow | null {
    const rows = this.linkRows();
    const r = String(ref ?? "").trim();
    const byId = rows.find((x) => x.sync_id === r);
    if (byId) return byId;
    try {
      const { folder, rel } = parseFsId(this.folders.ref(r));
      const at = rows.find((x) => x.folder === folder && x.rel === rel);
      if (at) return at;
    } catch {}
    const named = this.links().filter((l) => l.name.toLowerCase() === r.toLowerCase());
    return named.length === 1 ? rows.find((x) => x.sync_id === named[0].syncId) ?? null : null;
  }
  /** No synced folder may sit inside another: each file has one place in the vault. */
  private assertFree(root: string, what: string) {
    for (const row of this.linkRows()) {
      const other = this.placeOf(row)?.root;
      if (!other) continue;
      if (other === root) throw new EtudeError(`${what} is already synced`, 409);
      if (inside(root, other)) throw new EtudeError(`${what} is already synced: it's inside ${other}`, 409);
      if (inside(other, root)) throw new EtudeError(`${other}, inside it, is already synced: stop syncing that one first, or leave this one as it is`, 409);
    }
  }

  /** What marking a folder would send: how many files and bytes, and how many are too big to travel. */
  estimate(dirRef: string): { id: string; path: string; files: number; bytes: number; tooBig: number } {
    const id = this.folders.ref(dirRef);
    const { folder: fid, rel } = parseFsId(id);
    const folder = this.folders.folder(fid);
    const root = this.folders.pathOf(id);
    if (!isDir(root)) throw new EtudeError(`${rel || folder.name} isn't a folder`, 404);
    const scan = this.scan(folder, root);
    let bytes = 0;
    for (const f of scan.files.values()) bytes += f.size;
    return { id, path: root, files: scan.files.size, bytes, tooBig: scan.big.size };
  }

  /** Starts carrying a folder of this computer. This device becomes its home. Its files go up on the sync that follows. */
  mark(dirRef: string, opts: { name?: string } = {}): FolderLink {
    const device = this.device();
    const id = this.folders.ref(dirRef);
    const { folder: fid, rel } = parseFsId(id);
    const folder = this.folders.folder(fid);
    const root = this.folders.pathOf(id);
    if (!isDir(root)) throw new EtudeError(`${rel || folder.name} isn't a folder`, 404);
    this.schema();
    this.assertFree(root, rel || folder.name);
    const syncId = hex(randomBytes(16));
    const name = String(opts.name ?? "").trim() || (rel ? basename(rel) : folder.name);
    const created = new Date().toISOString();
    this.db.tx(() => {
      this.event("media", folderKey(syncId), { "/name": name, "/home": device, "/created": created });
      this.db.run("INSERT INTO local_sync_links (sync_id, folder, rel, created) VALUES (?, ?, ?, ?)", syncId, fid, rel, created);
    });
    this.changed();
    return this.links().find((l) => l.syncId === syncId)!;
  }

  /**
   * Gives a folder another device carries a place on this computer. The directory is made when it isn't there, and
   * opened in the Notebook when it isn't inside a folder that's already open. Files already in it are kept: one that
   * differs from the vault's becomes a "(conflict …)" copy beside the vault's.
   */
  link(ref: string, dirPath: string): FolderLink {
    this.device();
    const r = String(ref ?? "").trim();
    const all = this.remote();
    const named = all.filter((x) => x.name.toLowerCase() === r.toLowerCase());
    const remote = all.find((x) => x.syncId === r) ?? (named.length === 1 ? named[0] : null);
    if (!remote) throw new EtudeError(named.length > 1 ? `${named.length} synced folders are called "${r}": give the id (etude folder sync list)` : `no synced folder "${r}" on your other devices (etude folder sync list)`, 404);
    this.schema();
    const have = this.linkRows().find((x) => x.sync_id === remote.syncId);
    if (have) throw new EtudeError(`"${remote.name}" is already on this computer, at ${this.placeOf(have)?.root ?? "a folder that isn't open"}`, 409);
    let p = String(dirPath ?? "").trim();
    if (!p) throw new EtudeError("say where it goes on this computer: a folder's path (it's made when it isn't there)");
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = join(os.homedir(), p.slice(2));
    p = resolve(p);
    const st = statOrNull(p);
    if (st && !st.isDirectory()) throw new EtudeError(`${p} is a file`, 409);
    fs.mkdirSync(p, { recursive: true });
    p = fs.realpathSync(p);
    this.assertFree(p, p);
    const id = this.folders.idOf(p) ?? fsId(this.folders.open(p, { name: remote.name }).id);
    const { folder, rel } = parseFsId(id);
    this.db.run("INSERT INTO local_sync_links (sync_id, folder, rel, created) VALUES (?, ?, ?, ?)", remote.syncId, folder, rel, new Date().toISOString());
    this.changed();
    return this.links().find((l) => l.syncId === remote.syncId)!;
  }

  /**
   * Stops carrying a folder on this computer; its files stay as they are. `everywhere` ends it for every device:
   * each keeps the files it has, and the folder leaves the vault's list.
   */
  unlink(ref: string, opts: { everywhere?: boolean } = {}): { syncId: string; name: string; everywhere: boolean; path: string | null } {
    const row = this.find(ref);
    const r = String(ref ?? "").trim();
    const remote = row ? null : this.remote().find((x) => x.syncId === r) ?? null;
    if (!row && !(opts.everywhere && remote)) throw new EtudeError(`"${r}" isn't a synced folder on this computer (etude folder sync list)`, 404);
    const syncId = row?.sync_id ?? remote!.syncId;
    const name = this.metaOf(syncId)?.name ?? remote?.name ?? "";
    const path = row ? this.placeOf(row)?.root ?? null : null;
    if (opts.everywhere) this.device();
    this.db.tx(() => {
      if (opts.everywhere) {
        this.event("media", folderKey(syncId), { "/off": true });
        // Nothing needs its files' bytes in the vault any more: they leave it on the sync that follows.
        this.schema();
        for (const f of this.filesOf(syncId).values()) if (f.hash) this.db.run("INSERT OR IGNORE INTO local_sync_garbage (hash) VALUES (?)", f.hash);
      }
      this.dropLink(syncId);
    });
    return { syncId, name, everywhere: !!opts.everywhere, path };
  }

  // ---------------------------------------------------------------- old versions

  /** The blob that holds each synced file's bytes, by the bytes' hash. */
  private blobNames(): Map<string, string> {
    const out = new Map<string, string>();
    // ";" is the character after ":": every key that starts with "f:", and no other.
    for (const r of this.db.all("SELECT key, value FROM sync_registers WHERE tbl = 'blob' AND key >= 'f:' AND key < 'f;' AND field = '/name'")) {
      const v = JSON.parse(String(r.value));
      if (typeof v === "string" && v) out.set(String(r.key).slice(BLOB_KEY.length), v);
    }
    return out;
  }
  /** Whether old versions are waiting to leave the vault. */
  hasGarbage(): boolean {
    return this.has() && this.table("local_sync_garbage") && !!this.db.get("SELECT 1 FROM local_sync_garbage LIMIT 1");
  }
  /**
   * Bytes the vault still keeps though no synced file is them any more: a version this device replaced or removed, or
   * the files of a folder whose sync it ended. Their blob registers are cleared here, and the blobs to delete are
   * returned. Call it once this device's events are sent; send again (the cleared registers), delete the blobs, and
   * say which went with `cleared`. A blob whose delete didn't happen is offered again next time.
   *
   * Another device may hold a file with those very bytes that this one doesn't know of yet. It finds the register
   * cleared on its next pass and sends the bytes again (`mend` in the pass).
   */
  garbage(): { hash: string; name: string }[] {
    if (!this.hasGarbage() || !this.configured()) return [];
    const waiting = this.db.all("SELECT hash, name FROM local_sync_garbage").map((r) => ({ hash: String(r.hash), name: (r.name as string) ?? null }));
    // Every hash a synced file still is, in a folder whose sync is on.
    const off = new Set<string>();
    const used = new Set<string>();
    const rows = this.db.all("SELECT key, field, value FROM sync_registers WHERE tbl = 'media' AND key >= '//' AND key < '//~' AND field IN ('/hash', '/off')");
    for (const r of rows) if (r.field === "/off" && JSON.parse(String(r.value)) === true) off.add(String(r.key).slice(FOLDER_KEY.length));
    for (const r of rows) {
      if (r.field !== "/hash") continue;
      const v = JSON.parse(String(r.value));
      if (typeof v === "string" && !off.has(String(r.key).slice(FOLDER_KEY.length, FOLDER_KEY.length + 32))) used.add(v);
    }
    const names = this.blobNames();
    const out: { hash: string; name: string }[] = [];
    this.db.tx(() => {
      for (const w of waiting) {
        // Its register was cleared on an earlier try: only the blob is left to delete.
        if (w.name) {
          out.push({ hash: w.hash, name: w.name });
          continue;
        }
        const name = names.get(w.hash);
        // A file is those bytes again, or the vault never had them: nothing to clear.
        if (used.has(w.hash) || !name) {
          this.db.run("DELETE FROM local_sync_garbage WHERE hash = ?", w.hash);
          continue;
        }
        this.event("blob", `${BLOB_KEY}${w.hash}`, { "/name": null });
        this.db.run("UPDATE local_sync_garbage SET name = ? WHERE hash = ?", name, w.hash);
        out.push({ hash: w.hash, name });
      }
    });
    return out;
  }
  /** The blobs of these hashes are out of the vault. */
  cleared(hashes: string[]) {
    for (const h of hashes) this.db.run("DELETE FROM local_sync_garbage WHERE hash = ?", h);
  }
  private dropLink(syncId: string) {
    if (!this.has()) return;
    this.schema();
    this.db.run("DELETE FROM local_sync_links WHERE sync_id = ?", syncId);
    this.db.run("DELETE FROM local_sync_files WHERE sync_id = ?", syncId);
    this.changed();
  }
  /** Lets the removals a pass held back go through on the next one. */
  goAhead(ref: string): FolderLink {
    const row = this.find(ref);
    if (!row) throw new EtudeError(`"${ref}" isn't a synced folder on this computer`, 404);
    this.db.run("UPDATE local_sync_links SET go = 1 WHERE sync_id = ?", row.sync_id);
    this.changed();
    return this.links().find((l) => l.syncId === row.sync_id)!;
  }

  // ---------------------------------------------------------------- the pass

  /** Whether a pass has anything to look at. */
  active(): boolean {
    return this.has() && this.configured() && this.linkRows().length > 0;
  }
  /** One pass over every synced folder that has a place here. The events it makes still have to be pushed. */
  async pass(io: FolderIo): Promise<PassReport[]> {
    if (!this.active()) return [];
    const out: PassReport[] = [];
    for (const row of this.linkRows()) {
      this.looked = false;
      const report = await this.passOne(row, io);
      out.push(report);
      if (report.ended) continue;
      // A go-ahead is used up only by a pass that looked at the folder; one that found it missing keeps it, and what was held.
      if (this.looked) this.db.run("UPDATE local_sync_links SET paused = ?, go = 0, last = ? WHERE sync_id = ?", report.paused ?? null, JSON.stringify(report), row.sync_id);
      else this.db.run("UPDATE local_sync_links SET last = ? WHERE sync_id = ?", JSON.stringify(report), row.sync_id);
    }
    this.changed();
    return out;
  }

  private looked = false;
  /** When each folder was last looked at, how long it took, and what the vault said then. */
  private seen = new Map<string, { at: number; took: number; sig: string }>();
  /** The vault's say on a folder as one value: it changes when any of its registers does. */
  private signature(syncId: string): string {
    const r = this.db.get("SELECT count(*) AS n, max(stamp) AS s FROM sync_registers WHERE tbl = 'media' AND key >= ? AND key < ?", `${FOLDER_KEY}${syncId}/`, `${FOLDER_KEY}${syncId}0`);
    return `${r?.n ?? 0}:${r?.s ?? ""}`;
  }

  /** The files of a folder that travel: everything the Notebook shows, but the trash, what's too big, and code's heavy folders. */
  private scan(folder: LocalFolder, root: string): { files: Map<string, OnDisk>; big: Set<string>; blind: string[] } {
    const files = new Map<string, OnDisk>();
    const big = new Set<string>();
    const blind: string[] = [];
    const trash = resolve(resolve(folder.path), ...folder.trash.split("/"));
    const todo = [""];
    while (todo.length) {
      const rel = todo.pop()!;
      const dir = rel ? join(root, ...rel.split("/")) : root;
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        // A folder that can't be read isn't an empty one: nothing under it is taken for removed.
        blind.push(rel);
        continue;
      }
      for (const d of names) {
        const name = String(d.name);
        if (!this.folders.shown(folder, name) || name.startsWith(PARTIAL) || HEAVY.includes(name) || name === ".git") continue;
        const p = rel ? `${rel}/${name}` : name;
        const full = join(dir, name);
        // Links aren't carried: one could lead out of the folder, and what comes back would replace the link with a file.
        if (d.isDirectory()) {
          if (full !== trash) todo.push(p);
          continue;
        }
        if (!d.isFile()) continue;
        const st = statOrNull(full);
        if (!st?.isFile()) continue;
        if (st.size > MAX_SYNCED_FILE_BYTES) big.add(p);
        else files.set(p, { size: st.size, mtime: st.mtimeMs });
      }
    }
    return { files, big, blind };
  }
  /** Whether a path another device named can be a file here: inside the folder, and nothing the folder doesn't show. */
  private safeRel(folder: LocalFolder, rel: string): boolean {
    if (!rel || rel.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(rel)) return false;
    return rel.split("/").every((p) => p !== "" && p !== "." && p !== ".." && p.length <= 255 && this.folders.shown(folder, p) && !p.startsWith(PARTIAL) && !HEAVY.includes(p) && p !== ".git");
  }

  private async passOne(row: LinkRow, io: FolderIo): Promise<PassReport> {
    const db = this.db;
    const syncId = row.sync_id;
    const meta = this.metaOf(syncId);
    const report = emptyReport(syncId, meta?.name ?? "");
    if (!meta || meta.off) {
      // Ended on another device (or the vault was started over): the files here stay, and are carried no more.
      this.dropLink(syncId);
      report.ended = true;
      return report;
    }
    const place = this.placeOf(row);
    if (!place) return { ...report, skipped: ["its folder isn't open in the Notebook on this computer: open it again, or stop syncing it here"] };
    const { folder, root } = place;
    // Not there (a drive not plugged in, the folder moved): nothing is taken for removed.
    if (folder.missing || !isDir(root)) return { ...report, skipped: [`${root} isn't on disk right now: left as it is`] };
    const realRoot = fs.realpathSync(root);
    const trash = resolve(resolve(folder.path), ...folder.trash.split("/"));
    const home = meta.home === String(db.get("SELECT device FROM sync_control WHERE id = 1")!.device);
    const abs = (rel: string) => join(root, ...rel.split("/"));
    const go = () => {
      if (io.stop?.aborted) throw new Error("folder sync stopped");
    };

    // Listing a very big folder takes seconds: it's looked at no more often than twenty times as long as that took,
    // unless another device changed something in it or a go-ahead is waiting.
    const sig = this.signature(syncId);
    const was = this.seen.get(syncId);
    if (was && was.took >= 250 && !row.go && was.sig === sig && Date.now() - was.at < was.took * 20) return { ...(row.last ? (JSON.parse(row.last) as PassReport) : report), at: report.at };
    this.looked = true;
    const t0 = Date.now();
    const scan = this.scan(folder, root);
    const took = Date.now() - t0;
    const disk = scan.files;
    const base = new Map<string, Base>(db.all("SELECT rel, hash, size, mtime FROM local_sync_files WHERE sync_id = ?", syncId).map((r) => [String(r.rel), { hash: String(r.hash), size: Number(r.size), mtime: Number(r.mtime) }]));
    const remote = this.filesOf(syncId);
    const unseen = (rel: string) => scan.big.has(rel) || scan.blind.some((b) => under(rel, b));
    if (scan.big.size) report.skipped.push(`${scan.big.size} ${scan.big.size === 1 ? "file is" : "files are"} bigger than 100 MB and stay on this computer`);

    const settle = (rel: string, hash: string | null, st?: OnDisk | null) => {
      if (hash === null) {
        db.run("DELETE FROM local_sync_files WHERE sync_id = ? AND rel = ?", syncId, rel);
        base.delete(rel);
        return;
      }
      let s = st;
      if (!s) {
        const now = statOrNull(abs(rel));
        if (!now) return;
        s = { size: now.size, mtime: now.mtimeMs };
      }
      const b = { hash, size: s.size, mtime: s.mtime };
      db.run("INSERT INTO local_sync_files (sync_id, rel, hash, size, mtime) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sync_id, rel) DO UPDATE SET hash = excluded.hash, size = excluded.size, mtime = excluded.mtime", syncId, rel, b.hash, b.size, b.mtime);
      base.set(rel, b);
    };
    // A version the vault had and this device replaces or removes: its bytes are checked later, and leave the vault
    // when no synced file is them any more (`garbage`).
    const drop = (hash: string | null | undefined) => void (hash && db.run("INSERT OR IGNORE INTO local_sync_garbage (hash) VALUES (?)", hash));
    const say = (rel: string, hash: string | null, size: number) => {
      const was = remote.get(rel)?.hash;
      if (was && was !== hash) drop(was);
      this.event("media", fileKey(syncId, rel), { "/hash": hash, "/size": size });
    };
    // In step with the vault, which doesn't have the bytes (see `garbage`): sent again below.
    const mend: string[] = [];
    const blobs = this.blobNames();

    // ---- What each file needs.
    const up: { rel: string; hash: string }[] = [];
    let down: { rel: string; hash: string }[] = [];
    let goneHere: string[] = [];
    let goneThere: string[] = [];
    const clash: { rel: string; mine: string; theirs: string }[] = [];
    let odd = 0;
    const names = new Set<string>([...disk.keys(), ...base.keys()]);
    for (const [rel, r] of remote) if (r.hash !== null) names.add(rel);
    const diskHash = new Map<string, string>();
    for (const rel of names) {
      if (unseen(rel)) continue;
      const d = disk.get(rel);
      const b = base.get(rel);
      let D: string | null = null;
      if (d) {
        if (b && b.size === d.size && b.mtime === d.mtime) D = b.hash;
        else {
          go();
          try {
            D = await sha256Hex(new Uint8Array(await fs.promises.readFile(abs(rel))));
          } catch {
            continue;
          }
        }
        diskHash.set(rel, D);
      }
      const B = b?.hash ?? null;
      const R = remote.get(rel)?.hash ?? null;
      if (D === R) {
        if (D === null) settle(rel, null);
        else if (!b || b.hash !== D || b.size !== d!.size || b.mtime !== d!.mtime) settle(rel, D, d);
        if (D !== null && !blobs.has(D)) mend.push(rel);
        continue;
      }
      if (!d && !this.safeRel(folder, rel)) {
        odd++;
        continue;
      }
      if (D === B) R === null ? goneHere.push(rel) : down.push({ rel, hash: R });
      else if (R === B) D === null ? goneThere.push(rel) : up.push({ rel, hash: D });
      else if (D === null) down.push({ rel, hash: R! });
      else if (R === null) up.push({ rel, hash: D });
      else clash.push({ rel, mine: D, theirs: R });
    }
    if (odd) report.skipped.push(`${odd} ${odd === 1 ? "name" : "names"} from another device can't be ${odd === 1 ? "a file" : "files"} in this folder (hidden here, or not a name this computer takes)`);

    // ---- A lot removed here at once waits for a go-ahead: a folder emptied by mistake doesn't empty the other
    // devices. What another device removed isn't held: here it only goes to the folder's trash.
    const carried = base.size;
    if (!row.go && goneThere.length > MASS && goneThere.length > carried / 2) {
      report.paused = `${goneThere.length} of the ${carried} files synced here are gone from this folder. The other devices keep theirs until you say go ahead.`;
      goneThere = [];
    }

    // ---- Bytes, down and up.
    const blobName = (hash: string) => blobs.get(hash);
    // Two files with the same bytes sent at once share one upload: a second blob for them would never be named, or cleared.
    const going = new Map<string, Promise<void>>();
    const keep = (hash: string, bytes: Uint8Array): Promise<void> => {
      if (blobs.has(hash)) return Promise.resolve();
      let up = going.get(hash);
      if (!up) {
        up = (async () => {
          const name = await io.put(bytes);
          blobs.set(hash, name);
          db.tx(() => this.event("blob", `${BLOB_KEY}${hash}`, { "/name": name }));
        })().finally(() => going.delete(hash));
        going.set(hash, up);
      }
      return up;
    };
    /** A file's bytes by their hash: from a file already here that has them, else from the vault. Null when the vault doesn't have them yet. */
    const local = new Map<string, string>();
    for (const [rel, h] of diskHash) if (!local.has(h)) local.set(h, rel);
    const fetch = async (hash: string): Promise<Uint8Array | null> => {
      const from = local.get(hash);
      if (from) {
        try {
          const bytes = new Uint8Array(await fs.promises.readFile(abs(from)));
          if ((await sha256Hex(bytes)) === hash) return bytes;
        } catch {}
      }
      const name = blobName(hash);
      if (!name) return null;
      const bytes = await io.get(name);
      if ((await sha256Hex(bytes)) !== hash) throw new Error("a synced file's bytes don't match its hash");
      return bytes;
    };
    /** Verifies the deepest existing ancestor of `dir` resolves inside `realRoot` (and outside `trash`) before creating directories. */
    const safeAncestors = (dir: string): boolean => {
      let cur = dir;
      for (;;) {
        try {
          const real = fs.realpathSync(cur);
          return inside(real, realRoot) && !inside(real, trash);
        } catch {
          const parent = dirname(cur);
          if (parent === cur) return false;
          cur = parent;
        }
      }
    };
    /** Writes a file whole, inside the folder for sure. False when it can't go there. */
    const write = (rel: string, bytes: Uint8Array): boolean => {
      const full = abs(rel);
      try {
        if (!safeAncestors(dirname(full))) return false;
        fs.mkdirSync(dirname(full), { recursive: true });
        const parent = fs.realpathSync(dirname(full));
        if (!inside(parent, realRoot) || inside(parent, trash)) return false;
        const temp = join(parent, PARTIAL + Math.random().toString(36).slice(2));
        try {
          fs.writeFileSync(temp, bytes);
          fs.renameSync(temp, full);
        } catch (e) {
          fs.rmSync(temp, { force: true });
          throw e;
        }
        return true;
      } catch (e) {
        report.skipped.push(`${rel}: ${String((e as { code?: string })?.code ?? (e as Error).message)}`);
        return false;
      }
    };
    const send = async (rel: string): Promise<boolean> => {
      go();
      const st = statOrNull(abs(rel));
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await fs.promises.readFile(abs(rel)));
      } catch {
        return false;
      }
      // Written to while it was read: the next pass takes it, whole.
      const after = statOrNull(abs(rel));
      if (!st || !after || after.size !== st.size || after.mtimeMs !== st.mtimeMs || bytes.length > MAX_SYNCED_FILE_BYTES) return false;
      const hash = await sha256Hex(bytes);
      // The blob goes up before the event that names it.
      await keep(hash, bytes);
      db.tx(() => {
        say(rel, hash, bytes.length);
        settle(rel, hash, { size: st.size, mtime: st.mtimeMs });
      });
      return true;
    };
    const conflictName = (rel: string) => {
      const name = basename(rel);
      const dot = name.lastIndexOf(".");
      const stamp = new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, "");
      const copy = freeName(dirname(abs(rel)), `${dot > 0 ? name.slice(0, dot) : name} (conflict ${stamp})${dot > 0 ? name.slice(dot) : ""}`);
      return rel.includes("/") ? `${rel.slice(0, rel.lastIndexOf("/"))}/${copy}` : copy;
    };

    const emptied = new Set<string>();
    // A file another device renamed or moved shows as one gone and one new with the same bytes: renamed here too.
    const leaving = new Map<string, string>();
    for (const rel of goneHere) if (!leaving.has(base.get(rel)!.hash)) leaving.set(base.get(rel)!.hash, rel);
    down = down.filter((d) => {
      const from = leaving.get(d.hash);
      if (!from || disk.has(d.rel) || fs.existsSync(abs(d.rel))) return true;
      try {
        if (!safeAncestors(dirname(abs(d.rel)))) return true;
        fs.mkdirSync(dirname(abs(d.rel)), { recursive: true });
        if (!inside(fs.realpathSync(dirname(abs(d.rel))), realRoot)) return true;
        fs.renameSync(abs(from), abs(d.rel));
      } catch {
        return true;
      }
      leaving.delete(d.hash);
      emptied.add(dirname(abs(from)));
      goneHere = goneHere.filter((x) => x !== from);
      local.set(d.hash, d.rel);
      db.tx(() => {
        settle(from, null);
        settle(d.rel, d.hash);
      });
      report.renamed++;
      return false;
    });

    let waiting = 0;
    await pool(down, TRANSFERS, async ({ rel, hash }) => {
      go();
      // A name that's on disk though the listing didn't have it differs only by its capitals or accents on this
      // computer's disk: writing it would land on the other file.
      if (!disk.has(rel) && fs.existsSync(abs(rel))) {
        report.skipped.push(`${rel}: this computer's disk takes it for the same name as a file that's already here`);
        return;
      }
      const bytes = await fetch(hash);
      if (!bytes) {
        waiting++;
        return;
      }
      go();
      // Changed here while its bytes came down: left for the next pass, which sees both.
      const now = statOrNull(abs(rel));
      const was = disk.get(rel);
      if ((now && !was) || (now && was && (now.size !== was.size || now.mtimeMs !== was.mtime))) return;
      if (!write(rel, bytes)) return;
      local.set(hash, rel);
      settle(rel, hash);
      report.received++;
    });
    if (waiting) report.skipped.push(`${waiting} ${waiting === 1 ? "file is" : "files are"} still on the way from another device`);

    // ---- Changed in two places: the home device's version keeps the name, the other is kept beside it. Both travel.
    for (const c of clash) {
      go();
      const copy = conflictName(c.rel);
      if (home) {
        const theirs = await fetch(c.theirs);
        if (!theirs) {
          report.skipped.push(`${c.rel}: the other version is still on the way`);
          continue;
        }
        if (!write(copy, theirs)) continue;
        db.tx(() => {
          say(copy, c.theirs, theirs.length);
          settle(copy, c.theirs);
        });
        if (!(await send(c.rel))) continue;
      } else {
        const theirs = await fetch(c.theirs);
        if (!theirs) {
          report.skipped.push(`${c.rel}: the other version is still on the way`);
          continue;
        }
        try {
          fs.renameSync(abs(c.rel), abs(copy));
        } catch (e) {
          report.skipped.push(`${c.rel}: ${String((e as { code?: string })?.code ?? (e as Error).message)}`);
          continue;
        }
        if (!write(c.rel, theirs)) {
          fs.renameSync(abs(copy), abs(c.rel));
          continue;
        }
        settle(c.rel, c.theirs);
        await send(copy);
      }
      report.conflicts.push(`${c.rel} (the other version is in "${basename(copy)}")`);
    }

    await pool(up, TRANSFERS, async ({ rel }) => {
      if (await send(rel)) report.sent++;
    });
    await pool(mend, TRANSFERS, async (rel) => {
      go();
      const want = diskHash.get(rel);
      try {
        const bytes = new Uint8Array(await fs.promises.readFile(abs(rel)));
        if (want && bytes.length <= MAX_SYNCED_FILE_BYTES && (await sha256Hex(bytes)) === want) await keep(want, bytes);
      } catch {}
    });

    go();
    db.tx(() => {
      for (const rel of goneThere) {
        // Back on disk since the listing: it isn't gone.
        if (fs.existsSync(abs(rel))) continue;
        say(rel, null, 0);
        settle(rel, null);
        report.removedThere++;
      }
    });
    for (const rel of goneHere) {
      const st = statOrNull(abs(rel));
      const b = base.get(rel);
      // Changed here since the listing: the next pass sends it back instead.
      if (st && b && (st.size !== b.size || st.mtimeMs !== b.mtime)) continue;
      if (st) {
        try {
          this.folders.trash(fsId(folder.id, row.rel ? `${row.rel}/${rel}` : rel));
        } catch (e) {
          report.skipped.push(`${rel}: ${(e as Error).message}`);
          continue;
        }
        report.removedHere++;
        emptied.add(dirname(abs(rel)));
      }
      settle(rel, null);
    }
    // Folders this pass emptied go too (a folder removed on another device doesn't stay behind as an empty one).
    for (const start of emptied) {
      for (let dir = start; dir !== root && inside(dir, root); dir = dirname(dir)) {
        try {
          fs.rmdirSync(dir);
        } catch {
          break;
        }
      }
    }
    this.seen.set(syncId, { at: Date.now(), took, sig: this.signature(syncId) });
    return report;
  }
}
