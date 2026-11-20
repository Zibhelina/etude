// Sharing a Notebook folder or page with other Etude accounts (docs/sharing.md). One client per collection, on the
// Etude account (not the Sync config): it keeps this device's own keypair (made here, never sent anywhere), the shared
// spaces' keys and, for each space, the notes under its root in step with the space's event log on the server. Any
// device holding a space's key hands it to member devices that lack it. Runs in Node and in the browser worker.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Etude } from "../engine.ts";
import { EtudeError } from "../engine.ts";
import { accountFor, AccountError } from "../account.ts";
import { mergeDocs } from "../doc-merge.ts";
import { decryptBlob, decryptEvent, encryptBlob, encryptEvent, randomBytes, sha256Hex, syncKeys, toB64, fromB64, type SyncKeys } from "../sync/crypto.ts";
import { writeAtomic } from "../sync/client.ts";
import { presenceColor } from "./colors.ts";
import { decryptMeta, encryptMeta, generateIdentity, newSpaceKey, unwrapSpaceKey, wrapSpaceKey, type Identity } from "./crypto.ts";
import { canonical, installShareTables, mediaOf, SHARE_AUTHOR_SCHEMA, shareIndex, shareTables, spaceNotes, stateHash, stateOf, type NoteState } from "./local.ts";

export type Role = "owner" | "edit" | "view";
/** One of a member's signed-in devices with a sharing key, and whether it holds the space's current key. */
export type MemberDevice = { id: string; publicKey: string; hasKey: boolean };
/** `hasKey`: every one of the member's devices (at least one) holds the current key. */
export type Member = { id: string; email: string; name: string | null; role: Role; status: "invited" | "active"; accountId: string | null; devices: MemberDevice[]; hasKey: boolean; created: string | null };
export type RemoteSpace = { id: string; role: Role; status: string; epoch: number; owner: { email: string | null; name: string | null }; meta: { epoch: number; ct: string }; key: { epoch: number; wrapped: string } | null; keys: Record<string, string>; lastSeq: number; created: string | null; updated: string | null; members?: Member[] };
export type RemoteInvite = { spaceId: string; memberId: string; role: Role; owner: { email: string | null; name: string | null }; meta: { epoch: number; ct: string }; key: { epoch: number; wrapped: string } | null; created: string | null };
export type RemoteEvent = { seq: number; id: string; epoch: number; author: string | null; ciphertext: string; at?: string };
/** Someone else's device in a space right now, as the server lists it (`ct` encrypted with the space key). */
export type RemotePresence = { device: string; accountId: string; email: string | null; name: string | null; ct: string; epoch: number; at: string };
/** What a device says about itself in a space, inside the encrypted presence `ct`. Nothing identifying beyond what the server knows. */
export type PresencePayload = { v: 1; note: string | null; kind: string | null; sel: { anchor: number; head: number } | { x: number; y: number } | null; block: number[] | null; typing: boolean; at: string };
/** Someone else's device in a space, decrypted. */
export type Presence = { device: string; accountId: string; email: string | null; name: string | null; at: string } & Omit<PresencePayload, "v" | "at">;
/** Someone else in a space, as the app shows them: their color and the note they're on. */
export type Person = Presence & { space: string; color: string; title: string | null; here: boolean };
export type ActivityMember = { memberId: string; accountId: string; email: string; name: string | null; color: string; lastSeen: string | null; lastEdit: string | null; edits7d: number; edits30d: number; editsTotal: number };
export type Activity = { members: ActivityMember[]; days: { day: string; edits: Record<string, number> }[] };
/**
 * A space as this device keeps it. `status` is "removed" once the server no longer lists it: a read-only copy.
 * `waitingKey`: this device hasn't got the space's key yet; another device of the space hands it over on its next pass.
 */
export type LocalSpace = { id: string; rootId: string | null; name: string | null; role: Role; status: "active" | "removed"; owner: { email: string | null; name: string | null }; members?: Member[]; lastSync: string | null; error: string | null; pending: number; waitingKey: boolean };

/** The server's sharing routes. The cloud one talks to the Etude account's server; tests swap in their own. */
export interface ShareTransport {
  /** This device's public key on the server, or null when it has none. */
  getIdentity(): Promise<{ deviceId: string; publicKey: string } | null>;
  putIdentity(body: { publicKey: string }): Promise<void>;
  list(): Promise<{ spaces: RemoteSpace[]; invites: RemoteInvite[] }>;
  detail(id: string): Promise<RemoteSpace & { members: Member[] }>;
  create(body: { meta: { epoch: number; ct: string }; key: string }): Promise<RemoteSpace>;
  remove(id: string): Promise<void>;
  invite(id: string, body: { email: string; role: "edit" | "view"; keys?: Record<string, string> }): Promise<Member>;
  setRole(id: string, memberId: string, role: "edit" | "view"): Promise<Member>;
  removeMember(id: string, memberId: string): Promise<void>;
  accept(id: string): Promise<RemoteSpace>;
  decline(id: string): Promise<void>;
  putKeys(id: string, epoch: number, keys: Record<string, string>): Promise<void>;
  rotate(id: string, body: { epoch: number; meta: { epoch: number; ct: string }; keys: Record<string, string> }): Promise<RemoteSpace>;
  push(id: string, events: { id: string; epoch: number; ciphertext: string }[]): Promise<{ events: { id: string; seq: number; duplicate: boolean }[] }>;
  pull(id: string, after: number, limit?: number): Promise<{ events: RemoteEvent[]; cursor: number; more: boolean }>;
  putBlob(id: string, hash: string, bytes: Uint8Array): Promise<void>;
  getBlob(id: string, hash: string): Promise<Uint8Array>;
  /** Presence and activity (docs/sharing.md); a transport without them simply has nobody else around. */
  putPresence?(id: string, body: { ct: string; epoch: number }): Promise<void>;
  deletePresence?(id: string): Promise<void>;
  getPresence?(id: string): Promise<RemotePresence[]>;
  activity?(id: string): Promise<{ members: Omit<ActivityMember, "name" | "color">[]; days: Activity["days"] }>;
}

class CloudShareTransport implements ShareTransport {
  private readonly e: Etude;
  constructor(e: Etude) {
    this.e = e;
  }
  private a = () => accountFor(this.e);
  private sp = (id: string) => `/v1/spaces/${encodeURIComponent(id)}`;
  async getIdentity() {
    try {
      return await this.a().json("GET", "/v1/identity");
    } catch (err) {
      if (err instanceof AccountError && err.code === "no_identity") return null;
      throw err;
    }
  }
  putIdentity = async (body: { publicKey: string }) => void (await this.a().json("PUT", "/v1/identity", body));
  list = () => this.a().json("GET", "/v1/spaces");
  detail = async (id: string) => (await this.a().json("GET", this.sp(id))).space;
  create = async (body: unknown) => (await this.a().json("POST", "/v1/spaces", body)).space;
  remove = async (id: string) => void (await this.a().json("DELETE", this.sp(id)));
  invite = async (id: string, body: unknown) => (await this.a().json("POST", `${this.sp(id)}/members`, body)).member;
  setRole = async (id: string, m: string, role: string) => (await this.a().json("PATCH", `${this.sp(id)}/members/${encodeURIComponent(m)}`, { role })).member;
  removeMember = async (id: string, m: string) => void (await this.a().json("DELETE", `${this.sp(id)}/members/${encodeURIComponent(m)}`));
  accept = async (id: string) => (await this.a().json("POST", `${this.sp(id)}/accept`, {})).space;
  decline = async (id: string) => void (await this.a().json("POST", `${this.sp(id)}/decline`, {}));
  putKeys = async (id: string, epoch: number, keys: Record<string, string>) => void (await this.a().json("PUT", `${this.sp(id)}/keys`, { epoch, keys }));
  rotate = async (id: string, body: unknown) => (await this.a().json("POST", `${this.sp(id)}/rotate`, body)).space;
  push = (id: string, events: unknown) => this.a().json("POST", `${this.sp(id)}/events`, { events });
  pull = (id: string, after: number, limit = 200) => this.a().json("GET", `${this.sp(id)}/events?after=${after}&limit=${limit}`);
  putBlob = async (id: string, hash: string, bytes: Uint8Array) => void (await this.a().request("PUT", `${this.sp(id)}/blobs/${hash}`, { raw: bytes }));
  getBlob = async (id: string, hash: string) => new Uint8Array(await (await this.a().request("GET", `${this.sp(id)}/blobs/${hash}`)).arrayBuffer());
  putPresence = async (id: string, body: unknown) => void (await this.a().json("PUT", `${this.sp(id)}/presence`, body));
  deletePresence = async (id: string) => void (await this.a().json("DELETE", `${this.sp(id)}/presence`));
  getPresence = async (id: string) => (await this.a().json("GET", `${this.sp(id)}/presence`)).presence;
  activity = (id: string) => this.a().json("GET", `${this.sp(id)}/activity`);
}

/** One note's change in a space's log, encrypted under the space key of its epoch. */
/** A state too big for one event (a self-contained web file, a long page) rides in an encrypted space blob instead. */
type ShareEvent = { v: 1; note: string; op: "put" | "delete"; state?: NoteState; stateBlob?: { blob: string; epoch: number }; base: string | null };
/** `device`: this device's keypair, for the server and device id in `slot` (a new sign-in is a new device, with a new one). */
type Secrets = { device?: Identity & { slot: string }; keys?: Record<string, Record<string, string>> };
type SpaceRow = { id: string; root_id: string | null; role: Role; status: string; owner_email: string | null; owner_name: string | null; epoch: number; cursor: number; name: string | null; last_sync: string | null; error: string | null; rotate: number };
type StateRow = { note_id: string; hash: string; base: string | null; seq: number | null };

const NOTE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FILE = /^files\/([0-9a-f]{64})\.[A-Za-z0-9]{1,10}$/;
const LIST_EVERY = 30_000;
/** While a key is on its way (an invite without one, a member still waiting for theirs), the list is read this often. */
const LIST_FAST = 4_000;
const SYNC_EVERY = 3_000;
/** While someone else is on a note this device has open, that space syncs this often. */
const SYNC_TOGETHER = 1_000;
/** Presence: at most one update this often, and a heartbeat while a shared note stays open (the server forgets after 40 s). */
const PRESENCE_MIN_MS = 300;
const PRESENCE_BEAT_MS = 15_000;
/** The app says what's open every 10 s; nothing for this long means the window went without saying so, and presence goes. */
const PRESENCE_STALE_MS = 25_000;
/** How often the heartbeat looks (it sends only every 15 s, but notices a gone window sooner). */
const PRESENCE_TICK_MS = 5_000;
const PRESENCE_CACHE_MS = 800;
const MAX_BATCH = 200;
/** The server's limit is 1 MiB of ciphertext per event; base64 and the envelope take some of it. */
const MAX_EVENT_B64 = Math.floor((1024 * 1024 * 4) / 3) - 64;
/** Errors an automatic pass keeps quiet: the device is offline or the server can't be reached. */
const offline = (e: unknown) => (e instanceof AccountError && (e.code === "offline" || e.status >= 500)) || e instanceof TypeError || /fetch failed|network|timeout/i.test((e as Error)?.message ?? "");
const eq = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const isoNow = () => new Date().toISOString();

/** A space whose key this device hasn't been handed yet: not an error, it shows as waiting. */
class KeyWaiting extends EtudeError {
  constructor() {
    super("getting the key from another device", 409);
  }
}

/**
 * The 3-way merge of two edits of one note made from `anc`. `first` is the one the server ordered first; a field both
 * changed takes `second`'s, so every device computes the same result. Pages merge block by block (both kept on a clash).
 */
export function mergeStates(anc: NoteState, first: NoteState, second: NoteState): NoteState {
  const out = { ...anc } as Record<string, unknown>;
  const a = anc as Record<string, unknown>, f = first as Record<string, unknown>, s = second as Record<string, unknown>;
  for (const k of new Set([...Object.keys(first), ...Object.keys(second)])) {
    if (k === "media") continue;
    out[k] = !eq(s[k], a[k]) ? s[k] : !eq(f[k], a[k]) ? f[k] : a[k];
  }
  if (first.kind === "page" && second.kind === "page" && !eq(first.doc, anc.doc) && !eq(second.doc, anc.doc))
    out.doc = mergeDocs(anc.doc as any, first.doc as any, second.doc as any).doc;
  return out as NoteState;
}

const clients = new WeakMap<Etude, ShareClient>();
export function shareFor(e: Etude): ShareClient {
  let c = clients.get(e);
  if (!c) {
    c = new ShareClient(e);
    clients.set(e, c);
  }
  return c;
}

export class ShareClient {
  readonly e: Etude;
  transport: ShareTransport;
  /** A tag on this collection's event ids, so its own events coming back are skipped. */
  private tag: string | null = null;
  private listedAt = 0;
  private syncedAt = new Map<string, number>();
  private prints = new Map<string, string>();
  private pending = new Map<string, number>();
  private members = new Map<string, Member[]>();
  /** A remote change this pass had to skip, shown as the space's error. */
  private skipped = new Map<string, string>();
  private running: Promise<any> | null = null;
  /** Someone's key is on its way: read the list often until it lands, for ten minutes after the last invite seen. */
  private keyPending = false;
  private fastUntil = 0;
  private seenInvites = new Set<string>();
  /** Spaces this device has no key for yet, and the ones already seen that way (each starts the fast window once). */
  private noKey = new Set<string>();
  private seenNoKey = new Set<string>();
  /** The device slot whose public key the server was seen to have, this process. */
  private identityOn: string | null = null;
  private hurry = () => (this.fastUntil = Date.now() + 10 * 60_000);
  /** Notes written from other members since this process started; the app refreshes the tree when it grows. */
  received = 0;
  /** Presence: what the app last said is open here, and what was last sent per space. */
  private here: { space: string; payload: Omit<PresencePayload, "at">; told: number } | null = null;
  private presenceSent: { space: string; key: string; at: number } | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceBeat: ReturnType<typeof setInterval> | null = null;
  private presenceCache = new Map<string, { at: number; list: Promise<Presence[]> }>();
  /** Spaces where someone else was last seen on the note open here, until when (they sync every second meanwhile). */
  private together = new Map<string, number>();
  constructor(e: Etude) {
    this.e = e;
    this.transport = new CloudShareTransport(e);
  }

  private get db() {
    return this.e.db;
  }
  private account = () => accountFor(this.e);
  signedIn = () => !!this.account().token();
  private tables() {
    void this.e.notes; // makes the notes table when this collection has none yet
    if (!shareTables(this.db)) installShareTables(this.db);
    this.db.sql.exec("CREATE TABLE IF NOT EXISTS share_history (space_id TEXT NOT NULL, note_id TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (space_id, note_id, hash))");
    const cols = this.db.all<{ name: string }>("PRAGMA table_info(share_state)").map((c) => c.name);
    if (!cols.includes("seq")) this.db.sql.exec("ALTER TABLE share_state ADD COLUMN seq INTEGER");
    this.db.sql.exec("CREATE TABLE IF NOT EXISTS share_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.sql.exec(SHARE_AUTHOR_SCHEMA);
    if (!this.tag) {
      this.tag = this.db.get("SELECT value FROM share_meta WHERE key = 'tag'")?.value ?? null;
      if (!this.tag) {
        this.tag = toHex(randomBytes(6));
        this.db.run("INSERT INTO share_meta VALUES ('tag', ?)", this.tag);
      }
    }
  }
  private spaceRows(): SpaceRow[] {
    return shareTables(this.db) ? this.db.all<SpaceRow>("SELECT * FROM share_spaces ORDER BY rowid") : [];
  }
  private spaceRow(id: string): SpaceRow {
    const r = shareTables(this.db) ? this.db.get<SpaceRow>("SELECT * FROM share_spaces WHERE id = ?", id) : undefined;
    if (!r) throw new EtudeError(`no shared space "${id}" on this device`, 404);
    return r;
  }
  hasSpaces = () => shareTables(this.db) && !!this.db.get("SELECT 1 FROM share_spaces WHERE status = 'active' LIMIT 1");

  // ── secrets ──────────────────────────────────────────────────
  private async secretFile() {
    return join(this.e.home, "share", `${await this.account().accountId()}.json`);
  }
  private async secrets(): Promise<Secrets> {
    const f = await this.secretFile();
    try {
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
    } catch {
      return {};
    }
  }
  private async saveSecrets(s: Secrets) {
    const f = await this.secretFile();
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    writeFileSync(f + ".tmp", JSON.stringify(s), { mode: 0o600 });
    try {
      chmodSync(f + ".tmp", 0o600);
    } catch {}
    renameSync(f + ".tmp", f);
  }

  /**
   * This device's keypair, made here on first use and kept only in the secrets file. The server gets the public key
   * (again whenever it doesn't show this one, e.g. after a sign-in made this a new device).
   */
  async ensureIdentity(): Promise<Identity & { deviceId: string }> {
    const a = this.account();
    const deviceId = await a.deviceId();
    const slot = `${a.server()}|${deviceId}`;
    let sec = await this.secrets();
    if (sec.device?.slot !== slot) {
      const made = await generateIdentity();
      // Kept before the server hears of it, so a crash in between can't leave the server with a key nobody holds.
      sec = { ...sec, device: { slot, ...made } };
      await this.saveSecrets(sec);
    }
    const { publicKey, privateKey } = sec.device!;
    if (this.identityOn !== slot) {
      const found = await this.transport.getIdentity();
      if (found?.publicKey !== publicKey) await this.transport.putIdentity({ publicKey });
      this.identityOn = slot;
    }
    return { publicKey, privateKey, deviceId };
  }

  /** The space key of `epoch`, from the secrets file or unwrapped from the server's `wraps` (and kept). */
  private async keyOf(spaceId: string, epoch: number, wraps?: Record<string, string>): Promise<Uint8Array | null> {
    const sec = await this.secrets();
    const have = sec.keys?.[spaceId]?.[String(epoch)];
    if (have) return fromB64(have);
    const wrapped = wraps?.[String(epoch)];
    if (!wrapped) return null;
    const id = await this.ensureIdentity();
    const key = await unwrapSpaceKey(wrapped, id.privateKey, spaceId, epoch, id.deviceId);
    await this.keepKey(spaceId, epoch, key);
    return key;
  }
  private async keepKey(spaceId: string, epoch: number, key: Uint8Array) {
    const sec = await this.secrets();
    await this.saveSecrets({ ...sec, keys: { ...sec.keys, [spaceId]: { ...sec.keys?.[spaceId], [String(epoch)]: toB64(key) } } });
  }
  private async forgetKeys(spaceId: string) {
    const sec = await this.secrets();
    if (!sec.keys?.[spaceId]) return;
    const { [spaceId]: _, ...rest } = sec.keys;
    await this.saveSecrets({ ...sec, keys: rest });
  }
  private keyCache = new Map<string, SyncKeys>();
  private async keys(spaceId: string, epoch: number, wraps?: Record<string, string>): Promise<SyncKeys | null> {
    // Epoch 1 is bound to no space id (the server picks the id), so nothing is ever written or read under it.
    if (epoch < 2) return null;
    const k = `${spaceId}:${epoch}`;
    const hit = this.keyCache.get(k);
    if (hit) return hit;
    const raw = await this.keyOf(spaceId, epoch, wraps);
    if (!raw) return null;
    const keys = await syncKeys(raw);
    this.keyCache.set(k, keys);
    return keys;
  }

  // ── status ───────────────────────────────────────────────────
  private local(r: SpaceRow): LocalSpace {
    const active = r.status === "active";
    return { id: r.id, rootId: r.root_id, name: r.name, role: r.role, status: active ? "active" : "removed", owner: { email: r.owner_email, name: r.owner_name }, lastSync: r.last_sync, error: r.error, pending: this.pending.get(r.id) ?? 0, waitingKey: active && this.noKey.has(r.id) };
  }
  spaces(): LocalSpace[] {
    return this.spaceRows().map((r) => this.local(r));
  }
  private invites: (RemoteInvite & { name: string | null })[] = [];
  status() {
    const a = this.account();
    return { signedIn: this.signedIn(), email: a.email() ?? null, server: a.server(), received: this.received, spaces: this.spaces(), invites: this.signedIn() ? this.invites : [] };
  }
  /** The space a note is in, with its people fresh from the server when it can be reached. */
  async forNote(noteId: string): Promise<LocalSpace | null> {
    const id = this.e.notes.get(noteId).id;
    const s = shareIndex(this.db, [id]).get(id);
    if (!s) return null;
    const r = this.spaceRow(s.space);
    if (r.status === "active" && this.signedIn())
      try {
        const d = await this.transport.detail(r.id);
        this.members.set(r.id, d.members);
      } catch (err) {
        if (!offline(err) && !(err instanceof AccountError && err.status === 404)) throw err;
      }
    return { ...this.local(r), members: this.members.get(r.id) };
  }
  /** A space id, or a note in one. */
  spaceFor(ref: string): string {
    if (shareTables(this.db) && this.db.get("SELECT 1 FROM share_spaces WHERE id = ?", ref)) return ref;
    const id = this.e.notes.resolve(ref).id;
    const s = shareIndex(this.db, [id]).get(id);
    if (!s) throw new EtudeError("that note isn't shared", 404);
    return s.space;
  }

  // ── making and joining spaces ────────────────────────────────
  private requireSignedIn() {
    if (!this.signedIn()) throw new AccountError("sign in to your Etude account to share", 401, "signed_out");
  }
  /** Shares a folder or page: a new space with this note as its root. Spaces don't nest. */
  async create(noteId: string): Promise<LocalSpace> {
    this.requireSignedIn();
    this.tables();
    const note = this.e.notes.get(noteId);
    const inside = shareIndex(this.db, [note.id]).get(note.id);
    if (inside) throw new EtudeError(inside.root ? "this is shared already" : "this is inside a shared folder already", 409);
    const sub = new Set(spaceNotes(this.db, note.id));
    if (this.spaceRows().some((r) => r.root_id && sub.has(r.root_id))) throw new EtudeError("something inside this is shared already; shared folders don't nest", 409);
    const id = await this.ensureIdentity();
    const meta = { name: note.title, root: note.id };
    // The server picks the space's id, and keys and meta are bound to it: epoch 1 is a placeholder, rotated at once.
    const k1 = newSpaceKey();
    const made = await this.transport.create({ meta: { epoch: 1, ct: await encryptMeta(await syncKeys(k1), "new", meta) }, key: await wrapSpaceKey(k1, id.publicKey, "new", 1, id.deviceId) });
    // Epoch 2 goes to every device of the owner's at once (the server wants them all), this one included.
    const k2 = newSpaceKey();
    const keys: Record<string, string> = { [id.deviceId]: await wrapSpaceKey(k2, id.publicKey, made.id, 2, id.deviceId) };
    for (const m of (await this.transport.detail(made.id)).members) for (const d of m.devices) keys[d.id] ??= await wrapSpaceKey(k2, d.publicKey, made.id, 2, d.id);
    const space = await this.transport.rotate(made.id, { epoch: 2, meta: { epoch: 2, ct: await encryptMeta(await syncKeys(k2), made.id, meta) }, keys });
    await this.keepKey(made.id, 2, k2);
    this.db.run(
      "INSERT INTO share_spaces (id, root_id, role, status, owner_email, owner_name, epoch, cursor, name) VALUES (?, ?, 'owner', 'active', ?, ?, ?, 0, ?)",
      made.id, note.id, space.owner?.email ?? this.account().email() ?? null, space.owner?.name ?? null, space.epoch, note.title,
    );
    await this.syncSpace(made.id).catch((err) => this.fail(made.id, err));
    return this.local(this.spaceRow(made.id));
  }

  /** Joins a space you were invited to: its root comes in at the top level (or under `parentId`), then everything in it. */
  async accept(spaceId: string, opts: { parentId?: string | null } = {}): Promise<{ space: LocalSpace; rootId: string | null }> {
    this.requireSignedIn();
    this.tables();
    const parent = opts.parentId ? this.e.notes.get(opts.parentId).id : null;
    if (parent && shareIndex(this.db, [parent]).has(parent)) throw new EtudeError("shared folders don't nest: pick a folder that isn't shared", 409);
    await this.ensureIdentity();
    const s = await this.transport.accept(spaceId);
    if (!this.db.get("SELECT 1 FROM share_spaces WHERE id = ?", s.id))
      this.db.run("INSERT INTO share_spaces (id, role, status, owner_email, owner_name, epoch, cursor) VALUES (?, ?, 'active', ?, ?, ?, 0)", s.id, s.role, s.owner?.email ?? null, s.owner?.name ?? null, s.epoch);
    await this.adopt(s, parent);
    if (!(await this.keys(s.id, s.epoch, s.keys))) this.waitingFor(s.id);
    this.invites = this.invites.filter((i) => i.spaceId !== s.id);
    await this.syncSpace(s.id).catch((err) => this.fail(s.id, err));
    const r = this.spaceRow(s.id);
    return { space: this.local(r), rootId: r.root_id };
  }

  /** Reads the space's meta once its key is here, and makes the root note when it isn't yet. */
  private async adopt(s: RemoteSpace, parent: string | null = null) {
    const r = this.spaceRow(s.id);
    const keys = await this.keys(s.id, s.meta.epoch, s.keys);
    if (!keys) return;
    const meta = await decryptMeta(keys, s.id, s.meta.ct);
    if (!NOTE_ID.test(meta.root)) throw new EtudeError("this shared space's root isn't a note id", 502);
    if (r.root_id && r.root_id !== meta.root) throw new EtudeError("this shared space's root changed", 502);
    if (!r.root_id && s.role !== "owner" && this.db.get("SELECT 1 FROM notes WHERE id = ?", meta.root)) {
      throw new EtudeError("a note with this shared space's id already exists here", 409);
    }
    this.db.tx(() => {
      if (!this.db.get("SELECT 1 FROM notes WHERE id = ?", meta.root)) {
        this.e.notes.writeSynced(meta.root, { kind: "folder", parentId: parent, title: meta.name, icon: null, look: {}, archived: false, doc: null, scene: null, content: null, file: null });
        this.received++;
      }
      this.db.run("UPDATE share_spaces SET root_id = ?, name = ? WHERE id = ?", meta.root, meta.name, s.id);
    });
  }

  async decline(spaceId: string) {
    this.requireSignedIn();
    await this.transport.decline(spaceId);
    this.invites = this.invites.filter((i) => i.spaceId !== spaceId);
    return { ok: true };
  }
  /** Leaves a space (or drops a removed copy): the notes stay here as your own. */
  async leave(spaceId: string) {
    const r = this.spaceRow(spaceId);
    if (r.role === "owner" && r.status === "active") throw new EtudeError("you own this: stop sharing instead", 409);
    if (r.status === "active") {
      this.requireSignedIn();
      try {
        await this.transport.removeMember(spaceId, "me");
      } catch (err) {
        if (!(err instanceof AccountError && err.status === 404)) throw err;
      }
    }
    await this.forget(spaceId);
    return { ok: true, rootId: r.root_id };
  }
  /** Stops sharing: the space goes from the server, the notes stay here as your own. */
  async stop(spaceId: string) {
    const r = this.spaceRow(spaceId);
    if (r.role !== "owner") throw new EtudeError("only the owner can stop sharing; leave it instead", 403);
    this.requireSignedIn();
    try {
      await this.transport.remove(spaceId);
    } catch (err) {
      if (!(err instanceof AccountError && err.status === 404)) throw err;
    }
    await this.forget(spaceId);
    return { ok: true, rootId: r.root_id };
  }
  private async forget(spaceId: string) {
    this.db.tx(() => {
      this.db.sql.exec(SHARE_AUTHOR_SCHEMA);
      for (const t of ["share_state", "share_media", "share_history", "share_author"]) this.db.run(`DELETE FROM ${t} WHERE space_id = ?`, spaceId);
      this.db.run("DELETE FROM share_spaces WHERE id = ?", spaceId);
    });
    this.syncedAt.delete(spaceId);
    this.prints.delete(spaceId);
    this.pending.delete(spaceId);
    this.members.delete(spaceId);
    this.presenceCache.delete(spaceId);
    this.together.delete(spaceId);
    if (this.presenceSent?.space === spaceId) this.presenceSent = null;
    if (this.here?.space === spaceId) this.here = null;
    for (const k of [...this.keyCache.keys()]) if (k.startsWith(spaceId + ":")) this.keyCache.delete(k);
    if (this.signedIn()) await this.forgetKeys(spaceId).catch(() => {});
  }

  // ── people ───────────────────────────────────────────────────
  async invite(spaceId: string, email: string, role: "edit" | "view" = "edit"): Promise<Member> {
    this.requireSignedIn();
    const r = this.spaceRow(spaceId);
    if (r.status !== "active") throw new EtudeError("you no longer have access to this shared folder", 403);
    if (r.role === "view") throw new EtudeError("this is shared with you as view only", 403);
    if (role !== "edit" && role !== "view") throw new EtudeError('the role is "edit" or "view"');
    const member = await this.transport.invite(spaceId, { email, role });
    this.hurry();
    // No device of theirs with a key yet: watch for one, so the key goes to it within seconds of their app opening.
    if (!member.hasKey) this.keyPending = true;
    // Their devices are known already: wrap the key for them now, so they can open it as soon as they accept.
    if (member.devices.some((d) => !d.hasKey))
      try {
        const d = await this.transport.detail(spaceId);
        this.members.set(spaceId, d.members);
        await this.wrapFor({ ...r, epoch: d.epoch }, d.members);
        return d.members.find((m) => m.id === member.id) ?? member;
      } catch (err) {
        if (!offline(err)) throw err;
      }
    return member;
  }
  private async memberByEmail(spaceId: string, email: string): Promise<Member> {
    const d = await this.transport.detail(spaceId);
    this.members.set(spaceId, d.members);
    const m = d.members.find((x) => x.email.toLowerCase() === email.trim().toLowerCase() || x.id === email);
    if (!m) throw new EtudeError(`${email} isn't in this shared folder`, 404);
    return m;
  }
  async listMembers(spaceId: string): Promise<Member[]> {
    this.requireSignedIn();
    const d = await this.transport.detail(spaceId);
    this.members.set(spaceId, d.members);
    return d.members;
  }
  async setRole(spaceId: string, who: string, role: "edit" | "view"): Promise<Member> {
    this.requireSignedIn();
    if (role !== "edit" && role !== "view") throw new EtudeError('the role is "edit" or "view"');
    const m = await this.memberByEmail(spaceId, who);
    return this.transport.setRole(spaceId, m.id, role);
  }
  /** Removes someone; the owner's device then rotates the key, so what's written next is unreadable to them. */
  async removeMember(spaceId: string, who: string) {
    this.requireSignedIn();
    const r = this.spaceRow(spaceId);
    const m = await this.memberByEmail(spaceId, who);
    await this.transport.removeMember(spaceId, m.id);
    if (r.role === "owner" && m.status === "active") {
      this.db.run("UPDATE share_spaces SET rotate = 1 WHERE id = ?", spaceId);
      await this.rotate(spaceId).catch((err) => {
        if (!offline(err)) throw err;
      });
    }
    return { ok: true, removed: m.email };
  }

  /**
   * Wraps the current key for member devices that lack it, when this device holds it (the server checks that too).
   * Viewers hand it only to their own account's devices. Marks what it sent in `people`.
   */
  private async wrapFor(r: SpaceRow, people: Member[]) {
    const me = await this.ensureIdentity();
    if (!people.some((m) => m.devices.some((d) => d.id === me.deviceId && d.hasKey))) return;
    const key = await this.keyOf(r.id, r.epoch);
    if (!key) return;
    const mine = await this.account().accountId();
    const out: Record<string, string> = {};
    for (const m of people) {
      if (m.status !== "active" && m.status !== "invited") continue;
      if (r.role === "view" && m.accountId !== mine) continue;
      for (const d of m.devices) if (!d.hasKey) out[d.id] = await wrapSpaceKey(key, d.publicKey, r.id, r.epoch, d.id);
    }
    if (!Object.keys(out).length) return;
    await this.transport.putKeys(r.id, r.epoch, out);
    for (const m of people) {
      for (const d of m.devices) if (out[d.id]) d.hasKey = true;
      m.hasKey = m.devices.length > 0 && m.devices.every((d) => d.hasKey);
    }
  }
  /** A new key for every device of everyone left (invitees' devices too), after someone was removed. */
  private async rotate(spaceId: string) {
    const r = this.spaceRow(spaceId);
    const d = await this.transport.detail(spaceId);
    this.members.set(spaceId, d.members);
    const key = newSpaceKey();
    const epoch = d.epoch + 1;
    const keys: Record<string, string> = {};
    for (const m of d.members) if (m.status === "active" || m.status === "invited") for (const dev of m.devices) keys[dev.id] = await wrapSpaceKey(key, dev.publicKey, spaceId, epoch, dev.id);
    const meta = { name: r.name ?? "", root: r.root_id! };
    const s = await this.transport.rotate(spaceId, { epoch, meta: { epoch, ct: await encryptMeta(await syncKeys(key), spaceId, meta) }, keys });
    await this.keepKey(spaceId, epoch, key);
    this.db.run("UPDATE share_spaces SET epoch = ?, rotate = 0 WHERE id = ?", s.epoch, spaceId);
  }

  // ── the automatic pass ───────────────────────────────────────
  private fail(spaceId: string, err: unknown) {
    if (err instanceof KeyWaiting) {
      this.waitingFor(spaceId);
      if (shareTables(this.db)) this.db.run("UPDATE share_spaces SET error = NULL WHERE id = ?", spaceId);
      return;
    }
    const msg = offline(err) ? null : (err as Error)?.message ?? String(err);
    // Refused (made a viewer) or gone (removed, stopped): read the list on the next pass instead of in 30 s.
    if (err instanceof AccountError && (err.status === 403 || err.status === 404)) this.listedAt = 0;
    if (shareTables(this.db)) this.db.run("UPDATE share_spaces SET error = ? WHERE id = ?", msg, spaceId);
  }

  /** No key for this space on this device yet: say so, and read the list often for a while so it's picked up soon. */
  private waitingFor(spaceId: string) {
    this.noKey.add(spaceId);
    this.keyPending = true;
    if (!this.seenNoKey.has(spaceId)) this.seenNoKey.add(spaceId), this.hurry();
  }

  /** Reads the server's list: invites, new keys and roles, and spaces no longer there (access removed: a read-only copy). */
  async refresh() {
    this.requireSignedIn();
    const { spaces, invites } = await this.transport.list();
    this.listedAt = Date.now();
    this.keyPending = invites.some((i) => !i.key);
    for (const i of invites) if (!this.seenInvites.has(i.memberId)) this.seenInvites.add(i.memberId), this.hurry();
    // Every signed-in device gets its keypair right away (silently), so whoever shares with this account, or one of its
    // other devices, can hand it a key in the same pass.
    await this.ensureIdentity();
    this.invites = await Promise.all(
      invites.map(async (i) => {
        let name: string | null = null;
        try {
          const k = i.key && i.key.epoch === i.meta.epoch ? await this.keys(i.spaceId, i.meta.epoch, { [String(i.key.epoch)]: i.key.wrapped }) : null;
          if (k) name = (await decryptMeta(k, i.spaceId, i.meta.ct)).name;
        } catch {}
        return { ...i, name };
      }),
    );
    const live = new Map(spaces.map((s) => [s.id, s]));
    // A space this account joined on another device (or owns from one) comes to this one too, with nothing to click.
    const here = new Set(this.spaceRows().map((r) => r.id));
    const joined = spaces.filter((s) => !here.has(s.id));
    if (joined.length) {
      this.tables();
      for (const s of joined) this.db.run("INSERT OR IGNORE INTO share_spaces (id, role, status, owner_email, owner_name, epoch, cursor) VALUES (?, ?, 'active', ?, ?, ?, 0)", s.id, s.role, s.owner?.email ?? null, s.owner?.name ?? null, s.epoch);
    }
    if (!shareTables(this.db)) return;
    for (const r of this.spaceRows()) {
      const s = live.get(r.id);
      if (!s) {
        if (r.status === "active") this.db.run("UPDATE share_spaces SET status = 'removed', error = NULL WHERE id = ?", r.id);
        continue;
      }
      this.db.run("UPDATE share_spaces SET role = ?, status = 'active', epoch = ?, owner_email = ?, owner_name = ? WHERE id = ?", s.role, s.epoch, s.owner?.email ?? null, s.owner?.name ?? null, r.id);
      try {
        if (!r.root_id) await this.adopt(s);
        // Keep every wrap this device has, so old events stay readable after a rotation.
        for (const ep of Object.keys(s.keys ?? {})) await this.keys(r.id, Number(ep), s.keys);
        if (await this.keys(r.id, s.epoch, s.keys)) this.noKey.delete(r.id);
        else this.waitingFor(r.id);
        if (r.rotate && s.role === "owner") await this.rotate(r.id);
        // Hand the key to member devices that lack it (any role: viewers to their own other devices).
        const d = await this.transport.detail(r.id);
        this.members.set(r.id, d.members);
        const people = d.members.filter((m) => m.status === "active" || m.status === "invited");
        await this.wrapFor({ ...r, role: s.role, epoch: s.epoch }, people);
        // A device still without it (an invitee's app not opened yet, a new phone): read the list often meanwhile.
        if (people.some((m) => !m.hasKey)) this.keyPending = true;
      } catch (err) {
        this.fail(r.id, err);
      }
    }
  }

  /** One pass: the list every 30 s, and each active space every 3 s (or right away with `force`). */
  auto(force = false): Promise<ReturnType<ShareClient["status"]>> {
    if (!this.signedIn()) return Promise.resolve(this.status());
    // A forced pass (Sync now, a share action) waits for the one in flight, then runs itself.
    if (this.running) return force ? this.running.then(() => this.auto(true), () => this.auto(true)) : this.running;
    // The pass can finish without awaiting anything; clearing `running` from a .finally set after the assignment keeps
    // a pass that ended synchronously from leaving a settled promise behind that every later call would return.
    const pass: Promise<ReturnType<ShareClient["status"]>> = (async () => {
      try {
        if (force || Date.now() - this.listedAt >= (this.keyPending && Date.now() < this.fastUntil ? LIST_FAST : LIST_EVERY)) await this.refresh();
        for (const r of this.spaceRows()) {
          if (r.status !== "active" || !r.root_id) continue;
          const every = (this.together.get(r.id) ?? 0) > Date.now() ? SYNC_TOGETHER : SYNC_EVERY;
          if (!force && Date.now() - (this.syncedAt.get(r.id) ?? 0) < every) continue;
          await this.syncSpace(r.id).catch((err) => this.fail(r.id, err));
        }
      } catch (err) {
        if (!offline(err) && !(err instanceof AccountError && err.status === 401)) throw err;
      }
      return this.status();
    })();
    this.running = pass;
    pass.then(
      () => this.running === pass && (this.running = null),
      () => this.running === pass && (this.running = null),
    );
    return pass;
  }

  /** A cheap fingerprint of the space's notes: when it moves, something may need sending. */
  private fingerprint(rootId: string): { print: string; newest: string } {
    const r = this.db.get(
      `WITH RECURSIVE down(id) AS (SELECT id FROM notes WHERE id = ? UNION ALL SELECT n.id FROM notes n JOIN down ON n.parent_id = down.id)
       SELECT count(*) || ':' || coalesce(group_concat(n.id || ',' || coalesce(n.parent_id, '') || ',' || n.position || ',' || n.archived || ',' || n.updated, ';'), '') AS f, coalesce(max(n.updated), '') AS newest FROM notes n JOIN down ON n.id = down.id`,
      rootId,
    )!;
    return { print: r.f as string, newest: r.newest as string };
  }

  /** Pulls the space's new events, then sends what changed here (owner and editors). */
  async syncSpace(spaceId: string) {
    this.tables();
    const r = this.spaceRow(spaceId);
    if (r.status !== "active" || !r.root_id) return;
    this.syncedAt.set(spaceId, Date.now());
    this.skipped.delete(spaceId);
    let wraps: Record<string, string> | undefined;
    const wrapsOf = async () => (wraps ??= (await this.transport.list()).spaces.find((s) => s.id === spaceId)?.keys);
    await this.pull(r, wrapsOf);
    const now = this.spaceRow(spaceId);
    if (now.role !== "view") {
      if (this.prints.get(spaceId) !== this.fingerprint(now.root_id!).print) {
        await this.push(now, wrapsOf);
        // Kept only when taken after the newest edit's millisecond: an edit in that same millisecond would leave the
        // print as it was and never be sent.
        const after = this.fingerprint(now.root_id!);
        if (after.newest < isoNow()) this.prints.set(spaceId, after.print);
        else this.prints.delete(spaceId);
      }
    } else this.pending.set(spaceId, 0);
    this.db.run("UPDATE share_spaces SET last_sync = ?, error = ? WHERE id = ?", isoNow(), this.skipped.get(spaceId) ?? null, spaceId);
  }

  private stateRow(spaceId: string, noteId: string) {
    return this.db.get<StateRow>("SELECT note_id, hash, base, seq FROM share_state WHERE space_id = ? AND note_id = ?", spaceId, noteId);
  }
  /** Remembers `synced` as the last state both sides agree on; `hash` is the local row's, for telling local edits apart. */
  private setState(spaceId: string, noteId: string, synced: NoteState, hash: string, seq: number | null) {
    const { media: _, ...plain } = synced;
    const json = JSON.stringify(plain);
    const version = stateHash(synced);
    this.db.run(
      "INSERT INTO share_state (space_id, note_id, hash, base, seq) VALUES (?, ?, ?, ?, ?) ON CONFLICT(space_id, note_id) DO UPDATE SET hash = excluded.hash, base = excluded.base, seq = excluded.seq",
      spaceId, noteId, hash, json, seq,
    );
    this.db.run("INSERT OR REPLACE INTO share_history (space_id, note_id, hash, state, at) VALUES (?, ?, ?, ?, ?)", spaceId, noteId, version, json, Date.now());
    // A few versions back is enough to find the ancestor of an edit made at the same time as ours.
    this.db.run("DELETE FROM share_history WHERE space_id = ? AND note_id = ? AND hash NOT IN (SELECT hash FROM share_history WHERE space_id = ? AND note_id = ? ORDER BY at DESC LIMIT 8)", spaceId, noteId, spaceId, noteId);
  }
  private history(spaceId: string, noteId: string, hash: string | null): NoteState | null {
    if (!hash) return null;
    const r = this.db.get("SELECT state FROM share_history WHERE space_id = ? AND note_id = ? AND hash = ?", spaceId, noteId, hash);
    return r ? JSON.parse(r.state) : null;
  }
  private row(id: string) {
    return this.db.get("SELECT * FROM notes WHERE id = ?", id);
  }

  private async pull(r: SpaceRow, wrapsOf: () => Promise<Record<string, string> | undefined>) {
    let cursor = r.cursor;
    for (;;) {
      const page = await this.transport.pull(r.id, cursor);
      const events: Applied[] = [];
      for (const raw of page.events) {
        // Our own events: what they carry is here already.
        if (this.tag && raw.id.startsWith(this.tag + ".")) continue;
        let keys = await this.keys(r.id, raw.epoch);
        if (!keys) keys = await this.keys(r.id, raw.epoch, await wrapsOf());
        if (!keys) {
          // Not wrapped for this device yet (a new device, or invited before it had a key): stop here until it is.
          if (events.length) await this.apply(r, events);
          this.db.run("UPDATE share_spaces SET cursor = ? WHERE id = ?", raw.seq - 1, r.id);
          throw new KeyWaiting();
        }
        const ev = await decryptEvent<ShareEvent>(keys, raw.id, raw.ciphertext);
        if (ev?.op === "put" && !ev.state && ev.stateBlob && typeof ev.stateBlob.blob === "string" && /^[0-9a-f]{64}$/.test(ev.stateBlob.blob)) {
          const bk = await this.keys(r.id, ev.stateBlob.epoch, await wrapsOf());
          if (bk) ev.state = JSON.parse(new TextDecoder().decode(await decryptBlob(bk, await this.transport.getBlob(r.id, ev.stateBlob.blob), ev.stateBlob.blob)));
        }
        if (ev?.v !== 1 || typeof ev.note !== "string" || !NOTE_ID.test(ev.note) || (ev.op !== "put" && ev.op !== "delete") || (ev.op === "put" && !ev.state)) continue;
        events.push({ seq: raw.seq, ev, author: raw.author ?? null, at: raw.at ?? null });
      }
      if (events.length) await this.apply(r, events);
      cursor = page.cursor;
      this.db.run("UPDATE share_spaces SET cursor = ? WHERE id = ?", cursor, r.id);
      if (!page.more || !page.events.length) break;
    }
  }

  /** Writes a page of remote events in one transaction, then fetches the media they name. */
  private async apply(r: SpaceRow, events: Applied[]) {
    const root = r.root_id!;
    const media: Record<string, { blob: string; epoch: number }> = {};
    const notes = this.e.notes;
    let skipped: string | null = null;
    this.db.tx(() => {
      const inSpace = new Set(spaceNotes(this.db, root));
      /** The parent this device can use: the one named when it's in the space and makes no loop, else the root. */
      const parentFor = (id: string, want: string | null) => {
        if (id === root) return undefined;
        if (!want || !inSpace.has(want) || want === id) return root;
        for (let p: string | null = want, n = 0; p && n < 10_000; p = this.row(p)?.parent_id ?? null, n++) if (p === id) return root;
        return want;
      };
      const write = (id: string, s: NoteState) => {
        const parent = parentFor(id, s.parent);
        notes.writeSynced(id, { ...s, parentId: parent, position: id === root ? undefined : parent === s.parent ? s.position : undefined });
        inSpace.add(id);
        this.received++;
      };
      const localState = (id: string) => {
        const row = this.row(id);
        return row ? stateOf(row, root) : null;
      };
      const one = (seq: number, ev: ShareEvent) => {
        const id = ev.note;
        const row = this.row(id);
        if (row && !inSpace.has(id)) {
          // A note here that isn't in this space: a private note never takes a space's writes. Ours that left it stays out.
          return;
        }
        const st = this.stateRow(r.id, id);
        const local = row ? stateOf(row, root) : null;
        const lh = local ? stateHash(local) : null;
        // Edited here since the last state both sides agreed on.
        const dirty = !!local && !!st && lh !== st.hash;
        if (ev.op === "delete") {
          if (id === root) return;
          if (!row || !st) {
            if (!row) this.db.run("DELETE FROM share_state WHERE space_id = ? AND note_id = ?", r.id, id);
            return;
          }
          // An edit here outlives a delete there: it goes up again.
          if (dirty) return;
          for (const c of this.db.all<{ id: string }>("SELECT id FROM notes WHERE parent_id = ?", id)) this.db.run("UPDATE notes SET parent_id = ? WHERE id = ?", root, c.id);
          this.db.run("DELETE FROM notes WHERE id = ?", id);
          this.db.run("DELETE FROM share_state WHERE space_id = ? AND note_id = ?", r.id, id);
          inSpace.delete(id);
          this.received++;
          return;
        }
        const remote = ev.state!;
        Object.assign(media, remote.media ?? {});
        const rh = stateHash(remote);
        const syncedVersion = st?.base ? stateHash(JSON.parse(st.base)) : null;
        if (local && lh === rh) {
          this.setState(r.id, id, remote, lh, seq);
          return;
        }
        if (!local || !st || (!dirty && ev.base === syncedVersion) || (!dirty && !st.base)) {
          write(id, remote);
          this.setState(r.id, id, remote, stateHash(localState(id)!), seq);
          return;
        }
        // Edited on both sides since a common state: merge. The side the server saw first goes first.
        const anc = this.history(r.id, id, ev.base) ?? (st.base ? (JSON.parse(st.base) as NoteState) : remote);
        const mine = local;
        const mineSeq = dirty ? Infinity : (st.seq ?? 0);
        const merged = mineSeq < seq ? mergeStates(anc, mine, remote) : mergeStates(anc, remote, mine);
        write(id, remote);
        this.setState(r.id, id, remote, stateHash(localState(id)!), seq);
        if (stateHash(merged) !== rh) write(id, merged);
      };
      const names = new Map((this.members.get(r.id) ?? []).map((m) => [m.email.toLowerCase(), m.name]));
      const me = this.account().email()?.toLowerCase() ?? null;
      for (const { seq, ev, author, at } of events)
        try {
          one(seq, ev);
          // Who changed it last, for "Edited by …": a note that changed from a remote event only.
          if (author && this.row(ev.note)) this.setAuthor(r.id, ev.note, { email: author, name: names.get(author.toLowerCase()) ?? null, at: at ?? isoNow(), self: author.toLowerCase() === me });
        } catch (err) {
          // A state this version can't take (or a member's broken one) is skipped, so it can't stall the whole space.
          if (!(err instanceof EtudeError)) throw err;
          skipped = err.message;
        }
      // Notes that came before their parent sit under the root until it's here.
      for (const s of this.db.all<StateRow>("SELECT note_id, hash, base, seq FROM share_state WHERE space_id = ?", r.id)) {
        if (!s.base || s.note_id === root) continue;
        const want = (JSON.parse(s.base) as NoteState).parent;
        const row = this.row(s.note_id);
        if (!row || !want || row.parent_id === want || row.parent_id !== root || !inSpace.has(want)) continue;
        if (stateHash(stateOf(row, root)) !== s.hash || parentFor(s.note_id, want) !== want) continue;
        this.db.run("UPDATE notes SET parent_id = ?, position = ?, updated = ? WHERE id = ?", want, (JSON.parse(s.base) as NoteState).position, isoNow(), s.note_id);
        this.db.run("UPDATE share_state SET hash = ? WHERE space_id = ? AND note_id = ?", stateHash(stateOf(this.row(s.note_id), root)), r.id, s.note_id);
      }
    });
    await this.fetchMedia(r, media);
    if (skipped) this.skipped.set(r.id, `a change couldn't be applied here: ${skipped}`);
  }

  private async fetchMedia(r: SpaceRow, media: Record<string, { blob: string; epoch: number }>) {
    for (const [file, m] of Object.entries(media)) {
      const name = FILE.exec(file);
      if (!name || typeof m?.blob !== "string" || !/^[0-9a-f]{64}$/.test(m.blob)) continue;
      const path = join(this.e.mediaDir, file);
      if (!existsSync(path)) {
        const keys = await this.keys(r.id, m.epoch);
        if (!keys) continue;
        const plain = await decryptBlob(keys, await this.transport.getBlob(r.id, m.blob), m.blob);
        // The file's name is the SHA-256 of its bytes, so a member can't slip in something else under it.
        if ((await sha256Hex(plain)) !== name[1]) throw new EtudeError(`a shared file didn't match its name (${file})`, 502);
        mkdirSync(dirname(path), { recursive: true });
        writeAtomic(path, plain);
      }
      this.db.run("INSERT OR IGNORE INTO share_media (space_id, file, blob, epoch) VALUES (?, ?, ?, ?)", r.id, file, m.blob, m.epoch);
    }
  }

  private async push(r: SpaceRow, wrapsOf: () => Promise<Record<string, string> | undefined>) {
    const root = r.root_id!;
    let keys = await this.keys(r.id, r.epoch);
    if (!keys) keys = await this.keys(r.id, r.epoch, await wrapsOf());
    if (!keys) throw new KeyWaiting();
    const ids = spaceNotes(this.db, root);
    const inSpace = new Set(ids);
    const states = new Map<string, StateRow>(this.db.all<StateRow>("SELECT note_id, hash, base, seq FROM share_state WHERE space_id = ?", r.id).map((s) => [s.note_id, s]));
    const out: { id: string; note: string; ev: ShareEvent; hash: string; state?: NoteState }[] = [];
    for (const id of ids) {
      const state = stateOf(this.row(id), root);
      const hash = stateHash(state);
      const st = states.get(id);
      if (st?.hash === hash) continue;
      const files = mediaOf(state);
      if (files.length) {
        state.media = {};
        for (const f of files) {
          const m = await this.uploadMedia(r, keys, f);
          if (m) state.media[f] = m;
        }
      }
      out.push({ id: `${this.tag}.${id}.${toHex(randomBytes(6))}`, note: id, ev: { v: 1, note: id, op: "put", state, base: st?.base ? stateHash(JSON.parse(st.base)) : null }, hash, state });
    }
    // Notes that left the space (deleted or moved out): children before parents, so a parent's delete finds them gone.
    const gone = [...states.values()].filter((s) => !inSpace.has(s.note_id)).reverse();
    for (const s of gone) out.push({ id: `${this.tag}.${s.note_id}.${toHex(randomBytes(6))}`, note: s.note_id, ev: { v: 1, note: s.note_id, op: "delete", base: s.base ? stateHash(JSON.parse(s.base)) : null }, hash: "" });
    let failed = 0;
    for (let i = 0; i < out.length; i += MAX_BATCH) {
      const batch: (typeof out[number] & { ciphertext: string })[] = [];
      for (const o of out.slice(i, i + MAX_BATCH)) {
        let ciphertext = await encryptEvent(keys, o.id, o.ev);
        if (ciphertext.length > MAX_EVENT_B64 && o.ev.state) {
          // Too big for an event: the state goes up as a blob (same encryption as pictures) and the event points at it.
          const big = await encryptBlob(keys, new TextEncoder().encode(JSON.stringify(o.ev.state)));
          await this.transport.putBlob(r.id, big.hash, big.ciphertext);
          const { state: _, ...rest } = o.ev;
          ciphertext = await encryptEvent(keys, o.id, { ...rest, stateBlob: { blob: big.hash, epoch: r.epoch } });
        }
        if (ciphertext.length > MAX_EVENT_B64) {
          failed++;
          continue;
        }
        batch.push({ ...o, ciphertext });
      }
      if (!batch.length) continue;
      const res = await this.transport.push(r.id, batch.map((b) => ({ id: b.id, epoch: r.epoch, ciphertext: b.ciphertext })));
      const seqs = new Map(res.events.map((e) => [e.id, e.seq]));
      this.db.tx(() => {
        for (const b of batch) {
          if (b.ev.op === "delete") this.db.run("DELETE FROM share_state WHERE space_id = ? AND note_id = ?", r.id, b.note);
          else {
            this.setState(r.id, b.note, b.state!, b.hash, seqs.get(b.id) ?? null);
            this.setAuthor(r.id, b.note, { email: this.account().email() ?? null, name: null, at: isoNow(), self: true });
          }
        }
      });
    }
    this.pending.set(r.id, failed);
    if (failed) throw new EtudeError(`${failed} note${failed === 1 ? " is" : "s are"} too large to share`, 413);
  }

  private setAuthor(spaceId: string, noteId: string, a: { email: string | null; name: string | null; at: string; self: boolean }) {
    this.db.run("INSERT OR REPLACE INTO share_author (space_id, note_id, email, name, self, at) VALUES (?, ?, ?, ?, ?, ?)", spaceId, noteId, a.email, a.name, a.self ? 1 : 0, a.at);
  }

  // ── presence ─────────────────────────────────────────────────
  /**
   * What's open on this device: a note and the selection in it (`sel`: positions in a page, a point on a canvas),
   * the block holding the cursor, and whether someone is typing. Sent when it changes, at most every 300 ms, plus a
   * heartbeat every 15 s; nothing open that's shared (or `noteId` null) clears it. The app calls this every 10 s while
   * a page stays open; 25 s without a call and presence goes as if it closed.
   */
  setPresence(noteId: string | null, sel: PresencePayload["sel"] = null, extra: { block?: number[] | null; typing?: boolean } = {}): void {
    if (!this.signedIn()) return;
    let space: string | null = null;
    let kind: string | null = null;
    if (noteId && shareTables(this.db)) {
      const row = this.db.get<{ id: string; kind: string }>("SELECT id, kind FROM notes WHERE id = ?", noteId);
      const s = row ? shareIndex(this.db, [row.id]).get(row.id) : undefined;
      if (row && s && !s.removed) (space = s.space), (kind = row.kind ?? "page");
    }
    if (!space) {
      this.here = null;
      this.flushPresence();
      return;
    }
    const block = Array.isArray(extra.block) && extra.block.every((n) => Number.isInteger(n) && n >= 0) ? extra.block.slice(0, 16) : null;
    this.here = { space, payload: { v: 1, note: noteId, kind, sel: cleanSel(sel), block, typing: !!extra.typing }, told: Date.now() };
    this.flushPresence();
  }

  /** Sends what `here` says (or clears the space it left) now, or when the 300 ms since the last send are up. */
  private flushPresence() {
    const sent = this.presenceSent;
    const want = this.here && Date.now() - this.here.told < PRESENCE_STALE_MS ? this.here : null;
    if (!want) {
      this.stopBeat();
      if (sent) {
        this.presenceSent = null;
        this.transport.deletePresence?.(sent.space).catch(() => {});
      }
      return;
    }
    if (sent && sent.space !== want.space) {
      this.presenceSent = null;
      this.transport.deletePresence?.(sent.space).catch(() => {});
    }
    const key = canonical(want.payload);
    const cur = this.presenceSent;
    const since = cur ? Date.now() - cur.at : Infinity;
    const due = !cur || cur.key !== key || since >= PRESENCE_BEAT_MS;
    if (!due) return this.startBeat();
    if (since < PRESENCE_MIN_MS) {
      if (!this.presenceTimer) this.presenceTimer = setTimeout(() => ((this.presenceTimer = null), this.flushPresence()), PRESENCE_MIN_MS - since);
      return;
    }
    this.presenceSent = { space: want.space, key, at: Date.now() };
    void this.sendPresence(want.space, want.payload).catch(() => {
      // Offline or the key isn't here yet: the next change or heartbeat tries again.
      if (this.presenceSent?.key === key) this.presenceSent = { ...this.presenceSent, key: "" };
    });
    this.startBeat();
  }
  private async sendPresence(spaceId: string, payload: Omit<PresencePayload, "at">) {
    if (!this.transport.putPresence) return;
    const r = this.spaceRow(spaceId);
    const keys = await this.keys(spaceId, r.epoch);
    if (!keys) return;
    const id = await this.ensureIdentity();
    const ct = await encryptEvent(keys, `presence:${spaceId}:${id.deviceId}`, { ...payload, at: isoNow() } satisfies PresencePayload);
    await this.transport.putPresence(spaceId, { ct, epoch: r.epoch });
  }
  private startBeat() {
    if (this.presenceBeat) return;
    this.presenceBeat = setInterval(() => this.flushPresence(), PRESENCE_TICK_MS);
    (this.presenceBeat as any).unref?.();
  }
  private stopBeat() {
    if (this.presenceBeat) clearInterval(this.presenceBeat);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceBeat = this.presenceTimer = null;
  }
  /** Clears this device's presence (the app is quitting). */
  async clearPresence() {
    this.here = null;
    this.stopBeat();
    const sent = this.presenceSent;
    this.presenceSent = null;
    if (sent) await this.transport.deletePresence?.(sent.space).catch(() => {});
  }

  /**
   * Everyone else's devices in a space right now, decrypted (an entry this device can't read is left out). Cached for
   * 800 ms, so several windows polling every second ask the server once.
   */
  presence(spaceId: string): Promise<Presence[]> {
    const hit = this.presenceCache.get(spaceId);
    if (hit && Date.now() - hit.at < PRESENCE_CACHE_MS) return hit.list;
    const list = this.readPresence(spaceId);
    this.presenceCache.set(spaceId, { at: Date.now(), list });
    list.catch(() => this.presenceCache.delete(spaceId));
    return list;
  }
  private async readPresence(spaceId: string): Promise<Presence[]> {
    this.requireSignedIn();
    const r = this.spaceRow(spaceId);
    if (r.status !== "active" || !this.transport.getPresence) return [];
    const out: Presence[] = [];
    for (const p of await this.transport.getPresence(spaceId)) {
      try {
        const keys = await this.keys(spaceId, p.epoch);
        if (!keys) continue;
        const d = await decryptEvent<PresencePayload>(keys, `presence:${spaceId}:${p.device}`, p.ct);
        if (d?.v !== 1) continue;
        out.push({ device: p.device, accountId: p.accountId, email: p.email, name: p.name, at: p.at, note: typeof d.note === "string" && NOTE_ID.test(d.note) ? d.note : null, kind: typeof d.kind === "string" ? d.kind : null, sel: cleanSel(d.sel), block: Array.isArray(d.block) && d.block.every((n) => Number.isInteger(n) && n >= 0) ? d.block.slice(0, 16) : null, typing: !!d.typing });
      } catch {
        // Someone else's garbage, or a key this device was never given: skip it.
      }
    }
    // Together on the note open here: sync this space every second while it lasts.
    const open = this.here?.space === spaceId ? this.here.payload.note : null;
    if (open && out.some((p) => p.note === open)) this.together.set(spaceId, Date.now() + 5_000);
    return out;
  }

  /**
   * Who's online and where: everyone else's devices in the space of `noteId` (or `spaceId`, or every active space when
   * neither is given), with a stable color each, the title of the note they're on and whether it's `noteId` itself.
   */
  async who(opts: { noteId?: string | null; spaceId?: string | null } = {}): Promise<Person[]> {
    if (!this.signedIn() || !shareTables(this.db)) return [];
    let spaces: string[];
    const note = opts.noteId ? this.e.notes.get(opts.noteId).id : null;
    if (note) {
      const s = shareIndex(this.db, [note]).get(note);
      spaces = s && !s.removed ? [s.space] : [];
    } else spaces = opts.spaceId ? [this.spaceRow(opts.spaceId).id] : this.spaceRows().filter((r) => r.status === "active" && r.root_id).map((r) => r.id);
    const accent = this.e.settings().accent;
    const out: Person[] = [];
    for (const space of spaces)
      // Offline, or a server from before presence (404): nobody else around.
      for (const p of await this.presence(space).catch((err) => (offline(err) || (err instanceof AccountError && err.status === 404) ? [] : Promise.reject(err)))) {
        const t = p.note ? this.db.get<{ title: string }>("SELECT title FROM notes WHERE id = ?", p.note) : undefined;
        out.push({ ...p, space, color: presenceColor(p.accountId, accent), title: t ? t.title : null, here: !!note && p.note === note });
      }
    // The ones on this very note first, then the most recent.
    return out.sort((a, b) => Number(b.here) - Number(a.here) || b.at.localeCompare(a.at));
  }

  /** Last seen, last edit and edit counts per member, plus a 14-day strip, from the server; names from the member list. */
  async activity(spaceId: string): Promise<Activity> {
    this.requireSignedIn();
    this.spaceRow(spaceId);
    if (!this.transport.activity) return { members: [], days: [] };
    const a = await this.transport.activity(spaceId);
    if (!this.members.has(spaceId)) await this.listMembers(spaceId).catch(() => {});
    const names = new Map((this.members.get(spaceId) ?? []).map((m) => [m.id, m.name]));
    const accent = this.e.settings().accent;
    return { members: a.members.map((m) => ({ ...m, name: names.get(m.memberId) ?? null, color: presenceColor(m.accountId, accent) })), days: a.days };
  }

  private async uploadMedia(r: SpaceRow, keys: SyncKeys, file: string): Promise<{ blob: string; epoch: number } | null> {
    const have = this.db.get("SELECT blob, epoch FROM share_media WHERE space_id = ? AND file = ?", r.id, file);
    // A file sent under an older key stays readable by everyone still here; only new files use the new key.
    if (have) return { blob: have.blob, epoch: have.epoch };
    const path = join(this.e.mediaDir, file);
    if (!existsSync(path)) return null;
    const { hash, ciphertext } = await encryptBlob(keys, new Uint8Array(readFileSync(path)));
    await this.transport.putBlob(r.id, hash, ciphertext);
    this.db.run("INSERT OR REPLACE INTO share_media (space_id, file, blob, epoch) VALUES (?, ?, ?, ?)", r.id, file, hash, r.epoch);
    return { blob: hash, epoch: r.epoch };
  }
}

type Applied = { seq: number; ev: ShareEvent; author: string | null; at: string | null };

/** A selection as the app sends it: whole non-negative positions in a page, or a point on a canvas. */
function cleanSel(sel: unknown): PresencePayload["sel"] {
  const o = sel as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const pos = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1e8;
  if (pos(o.anchor) && pos(o.head)) return { anchor: o.anchor as number, head: o.head as number };
  const fin = (v: unknown) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e9;
  if (fin(o.x) && fin(o.y)) return { x: Math.round((o.x as number) * 10) / 10, y: Math.round((o.y as number) * 10) / 10 };
  return null;
}

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
