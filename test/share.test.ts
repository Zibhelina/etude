import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Etude } from "../src/core/engine.ts";
import { docFromText, docText } from "../src/core/notes.ts";
import { decryptMeta, encryptMeta, generateIdentity, newSpaceKey, unwrapSpaceKey, wrapSpaceKey } from "../src/core/share/crypto.ts";
import { mediaOf, stateHash, stateOf } from "../src/core/share/local.ts";
import { mergeStates, shareFor, type Member, type RemoteSpace, type ShareTransport } from "../src/core/share/client.ts";
import { syncKeys, encryptEvent, decryptEvent } from "../src/core/sync/crypto.ts";
import { run } from "../src/cli/run.ts";
import { AccountError } from "../src/core/account.ts";
import { createServer } from "node:http";

const temp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "share-"));

test("share crypto: space keys and meta round-trip, and refuse the wrong key or binding", async () => {
  const a = await generateIdentity(), b = await generateIdentity();
  const key = newSpaceKey();
  const wrapped = await wrapSpaceKey(key, a.publicKey, "spc_1", 2, "dev_a");
  assert.deepEqual(Object.keys(JSON.parse(wrapped)).sort(), ["ct", "eph", "nonce", "v"]);
  assert.deepEqual(await unwrapSpaceKey(wrapped, a.privateKey, "spc_1", 2, "dev_a"), key);
  await assert.rejects(unwrapSpaceKey(wrapped, b.privateKey, "spc_1", 2, "dev_a"), /decryption failed/);
  // Bound to the space, the epoch and the device: moved anywhere else it doesn't open.
  await assert.rejects(unwrapSpaceKey(wrapped, a.privateKey, "spc_2", 2, "dev_a"), /decryption failed/);
  await assert.rejects(unwrapSpaceKey(wrapped, a.privateKey, "spc_1", 3, "dev_a"), /decryption failed/);
  await assert.rejects(unwrapSpaceKey(wrapped, a.privateKey, "spc_1", 2, "dev_b"), /decryption failed/);

  const keys = await syncKeys(key);
  const ct = await encryptMeta(keys, "spc_1", { name: "CMPT 307", root: "n1" });
  assert.deepEqual(await decryptMeta(keys, "spc_1", ct), { name: "CMPT 307", root: "n1" });
  await assert.rejects(decryptMeta(keys, "spc_2", ct));
  await assert.rejects(decryptMeta(await syncKeys(newSpaceKey()), "spc_1", ct));
  const ev = await encryptEvent(keys, "t.n1.x", { v: 1, note: "n1" });
  await assert.rejects(decryptEvent(await syncKeys(newSpaceKey()), "t.n1.x", ev));
});

test("share state: hash ignores media and pins, and media lists every file the note names", async (t) => {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  const pic = `files/${"a".repeat(64)}.png`;
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }, { type: "image", attrs: { src: `/media/${pic}` } }] };
  const n = e.notes.create({ title: "Week 1", doc });
  const s = stateOf(e.db.get("SELECT * FROM notes WHERE id = ?", n.id), "root");
  assert.equal(s.parent, null);
  assert.equal(s.title, "Week 1");
  assert.ok(mediaOf(s).includes(pic));
  const h = stateHash(s);
  assert.equal(stateHash({ ...s, media: { [pic]: { blob: "x", epoch: 2 } } }), h);
  e.notes.pin(n.id);
  assert.equal(stateHash(stateOf(e.db.get("SELECT * FROM notes WHERE id = ?", n.id), "root")), h);
  e.notes.update(n.id, { title: "Week 1!" });
  assert.notEqual(stateHash(stateOf(e.db.get("SELECT * FROM notes WHERE id = ?", n.id), "root")), h);
  // The root's own parent and position are each member's.
  assert.equal(stateOf(e.db.get("SELECT * FROM notes WHERE id = ?", n.id), n.id).parent, null);
});

test("mergeStates: one side's field wins, both sides' fields take the later, pages merge by block", () => {
  const p = (...lines: string[]) => docFromText(lines.join("\n\n"));
  const base: any = { kind: "page", parent: "r", title: "T", icon: null, look: {}, position: 0, archived: false, doc: p("a", "b", "c"), scene: null, content: null, file: null };
  const first = { ...base, title: "T1", doc: p("A", "b", "c") };
  const second = { ...base, icon: "📘", doc: p("a", "b", "C") };
  const m = mergeStates(base, first, second);
  assert.equal(m.title, "T1");
  assert.equal(m.icon, "📘");
  assert.equal(docText(m.doc), "A\nb\nC");
  const both = mergeStates(base, { ...base, title: "x", doc: p("a", "B1", "c") }, { ...base, title: "y", doc: p("a", "B2", "c") });
  assert.equal(both.title, "y");
  assert.equal(docText(both.doc), "a\nB1\nB2\nc");
});

// ── an in-memory sharing server, enough for two accounts and their devices ──
type Acc = { id: string; email: string };
type Dev = Acc & { device: string };
type Row = { id: string; email: string; name: null; role: "owner" | "edit" | "view"; status: "invited" | "active"; accountId: string | null; created: null };
class FakeServer {
  /** Each device's public key, by device id. */
  identities = new Map<string, { account: string; publicKey: string }>();
  /** Wraps by space, then device, then epoch. */
  spaces = new Map<string, { id: string; owner: Acc; epoch: number; meta: { epoch: number; ct: string }; members: Row[]; keys: Map<string, Record<string, string>>; events: any[]; blobs: Map<string, Uint8Array> }>();
  /** Presence by space, then device, as the real server keeps it (in memory, 40 s). */
  presence = new Map<string, Map<string, { account: Acc; ct: string; epoch: number; at: number }>>();
  presencePuts = 0;
  now = () => Date.now();
  accounts: Acc[] = [];
  seq = 0;
  n = 0;
  sync = new Set<string>();
  id = (p: string) => `${p}_${String(++this.n).padStart(22, "0")}`;
  err(status: number, code: string): never {
    throw new AccountError(code, status, code);
  }
  devicesOf = (account: string | null) => [...this.identities].filter(([, i]) => account && i.account === account).map(([id, i]) => ({ id, publicKey: i.publicKey }));
  /** Signs a device out: its key and wraps go, as on the real server. */
  signOut(device: string) {
    this.identities.delete(device);
    for (const sp of this.spaces.values()) sp.keys.delete(device);
  }
  transport(me: Dev): ShareTransport {
    const s = this;
    const space = (id: string, roles = ["owner", "edit", "view"]) => {
      const sp = s.spaces.get(id);
      const m = sp?.members.find((x) => x.accountId === me.id && x.status === "active");
      if (!sp || !m) return s.err(404, "space_not_found");
      if (!roles.includes(m.role)) return s.err(403, "forbidden");
      return { sp, m };
    };
    const view = (sp: any, m: any): RemoteSpace => {
      const mine = sp.keys.get(me.device) ?? {};
      const cur = mine[sp.epoch] ? { epoch: sp.epoch, wrapped: mine[sp.epoch] } : null;
      return { id: sp.id, role: m.role, status: m.status, epoch: sp.epoch, owner: { email: sp.owner.email, name: null }, meta: sp.meta, key: cur, keys: { ...mine }, lastSeq: sp.events.length ? sp.events.at(-1).seq : 0, created: null, updated: null };
    };
    const member = (sp: any, m: Row): Member => {
      const devices = s.devicesOf(m.accountId).map((d) => ({ ...d, hasKey: !!sp.keys.get(d.id)?.[sp.epoch] }));
      return { ...m, devices, hasKey: devices.length > 0 && devices.every((d) => d.hasKey) };
    };
    const link = () => {
      for (const sp of s.spaces.values()) for (const m of sp.members) if (!m.accountId && m.email === me.email) m.accountId = me.id;
    };
    const holds = (sp: any) => !!sp.keys.get(me.device)?.[sp.epoch];
    const addKeys = (sp: any, epoch: number, keys: Record<string, string>) => {
      for (const d of Object.keys(keys)) {
        const acc = s.identities.get(d)?.account;
        if (!acc) s.err(422, "unknown_device");
        if (!sp.members.some((m: Row) => m.accountId === acc)) s.err(422, "not_member");
      }
      for (const [d, w] of Object.entries(keys)) {
        const k = sp.keys.get(d) ?? {};
        k[epoch] ??= w;
        sp.keys.set(d, k);
      }
    };
    return {
      async getIdentity() {
        const i = s.identities.get(me.device);
        return i ? { deviceId: me.device, publicKey: i.publicKey } : null;
      },
      async putIdentity(body) {
        const old = s.identities.get(me.device);
        if (old && old.publicKey !== body.publicKey) s.signOut(me.device);
        s.identities.set(me.device, { account: me.id, publicKey: body.publicKey });
      },
      async list() {
        link();
        const spaces: RemoteSpace[] = [], invites: any[] = [];
        for (const sp of s.spaces.values()) {
          const m = sp.members.find((x) => x.accountId === me.id);
          if (!m) continue;
          if (m.status === "active") spaces.push(view(sp, m));
          else invites.push({ spaceId: sp.id, memberId: m.id, role: m.role, owner: { email: sp.owner.email, name: null }, meta: sp.meta, key: view(sp, m).key, created: null });
        }
        return { spaces, invites };
      },
      async detail(id) {
        const { sp, m } = space(id);
        return { ...view(sp, m), members: sp.members.map((x) => member(sp, x)) };
      },
      async create(body) {
        if (!s.sync.has(me.id)) s.err(402, "sync_required");
        if (!s.identities.has(me.device)) s.err(409, "no_identity");
        const id = s.id("spc");
        const sp = { id, owner: me, epoch: 1, meta: body.meta, members: [{ id: s.id("mem"), email: me.email, name: null, role: "owner" as const, status: "active" as const, accountId: me.id, created: null }], keys: new Map([[me.device, { 1: body.key }]]), events: [], blobs: new Map() };
        s.spaces.set(id, sp);
        return view(sp, sp.members[0]);
      },
      async remove(id) {
        space(id, ["owner"]);
        s.spaces.delete(id);
      },
      async invite(id, body) {
        const { sp } = space(id, ["owner", "edit"]);
        const acc = s.accounts.find((a) => a.email === body.email) ?? null;
        const m: Row = { id: s.id("mem"), email: body.email, name: null, role: body.role, status: "invited", accountId: acc?.id ?? null, created: null };
        sp.members.push(m);
        if (body.keys) addKeys(sp, sp.epoch, body.keys);
        return member(sp, m);
      },
      async setRole(id, mid, role) {
        const { sp } = space(id, ["owner"]);
        const m = sp.members.find((x) => x.id === mid)!;
        m.role = role;
        return member(sp, m);
      },
      async removeMember(id, mid) {
        const { sp, m: me_ } = space(id);
        const m = mid === "me" ? me_ : sp.members.find((x) => x.id === mid)!;
        sp.members = sp.members.filter((x) => x !== m);
        for (const d of s.devicesOf(m.accountId)) sp.keys.delete(d.id);
      },
      async accept(id) {
        link();
        const sp = s.spaces.get(id)!;
        const m = sp.members.find((x) => x.accountId === me.id)!;
        m.status = "active";
        return view(sp, m);
      },
      async decline(id) {
        const sp = s.spaces.get(id)!;
        sp.members = sp.members.filter((x) => x.accountId !== me.id);
      },
      async putKeys(id, epoch, keys) {
        const { sp, m } = space(id);
        if (epoch !== sp.epoch) s.err(409, "epoch_mismatch");
        if (m.role === "view" && Object.keys(keys).some((d) => s.identities.get(d)?.account !== me.id)) s.err(403, "forbidden");
        if (!holds(sp)) s.err(409, "no_current_key");
        addKeys(sp, epoch, keys);
      },
      async rotate(id, body) {
        const { sp, m } = space(id, ["owner"]);
        if (body.epoch !== sp.epoch + 1) s.err(409, "epoch_mismatch");
        for (const x of sp.members) if (x.status === "active") for (const d of s.devicesOf(x.accountId)) if (!body.keys[d.id]) s.err(409, "missing_keys");
        addKeys(sp, body.epoch, body.keys);
        sp.epoch = body.epoch;
        sp.meta = body.meta;
        return view(sp, m);
      },
      async push(id, events) {
        const { sp } = space(id, ["owner", "edit"]);
        return { events: events.map((e) => {
          const old = sp.events.find((x) => x.id === e.id);
          if (old) return { id: e.id, seq: old.seq, duplicate: true };
          const seq = ++s.seq;
          sp.events.push({ ...e, seq, author: me.email, at: new Date(s.now()).toISOString() });
          return { id: e.id, seq, duplicate: false };
        }) };
      },
      async pull(id, after, limit = 200) {
        const { sp } = space(id);
        const page = sp.events.filter((e) => e.seq > after).slice(0, limit);
        return { events: page, cursor: page.length ? page.at(-1).seq : after, more: sp.events.filter((e) => e.seq > after).length > page.length };
      },
      async putBlob(id, hash, bytes) {
        const { sp } = space(id, ["owner", "edit"]);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
        sp.blobs.set(hash, bytes);
      },
      async getBlob(id, hash) {
        const { sp } = space(id);
        return sp.blobs.get(hash) ?? s.err(404, "not_found");
      },
      async putPresence(id, body) {
        space(id);
        s.presencePuts++;
        const m = s.presence.get(id) ?? new Map();
        m.set(me.device, { account: me, ct: body.ct, epoch: body.epoch, at: s.now() });
        s.presence.set(id, m);
      },
      async deletePresence(id) {
        space(id);
        s.presence.get(id)?.delete(me.device);
      },
      async getPresence(id) {
        space(id);
        return [...(s.presence.get(id) ?? new Map())].filter(([d, e]) => d !== me.device && s.now() - e.at < 40_000).map(([device, e]) => ({ device, accountId: e.account.id, email: e.account.email, name: null, ct: e.ct, epoch: e.epoch, at: new Date(e.at).toISOString() }));
      },
      async activity(id) {
        const { sp } = space(id);
        const members = sp.members.filter((m) => m.status === "active").map((m) => {
          const mine = sp.events.filter((e) => e.author === m.email);
          return { memberId: m.id, accountId: m.accountId!, email: m.email, lastSeen: null, lastEdit: mine.at(-1)?.at ?? null, edits7d: mine.length, edits30d: mine.length, editsTotal: mine.length };
        });
        return { members, days: [] };
      },
    };
  }
}

/** A collection signed in as `acc` on its own device (`device` names it; the default is the account's first one). */
async function device(t: any, server: FakeServer, acc: Acc, device = "dev_" + acc.id.slice(4)) {
  const home = temp();
  writeFileSync(join(home, "account.json"), JSON.stringify({ server: "https://example.test", token: "tok-" + device, email: acc.email, accountId: acc.id, deviceId: device }));
  const e = await Etude.open(":memory:", { home });
  t.after(() => {
    e.close();
    rmSync(home, { recursive: true, force: true });
  });
  const sh = shareFor(e);
  sh.transport = server.transport({ ...acc, device });
  return { e, sh, home, device };
}
async function pair(t: any) {
  const server = new FakeServer();
  const ann = { id: "acc_ann", email: "ann@example.com" }, bob = { id: "acc_bob", email: "bob@example.com" };
  server.accounts.push(ann, bob);
  server.sync.add(ann.id);
  const A = await device(t, server, ann), B = await device(t, server, bob);
  return { server, A, B, ann, bob };
}
const text = (e: Etude, id: string) => e.notes.get(id).text;

test("sharing between two collections: invite, accept, edits both ways, merges, deletes, media", async (t) => {
  const { server, A, B } = await pair(t);
  const course = A.e.notes.create({ title: "CMPT 307", kind: "folder" });
  const w1 = A.e.notes.create({ title: "Week 1", parentId: course.id, doc: docFromText("intro\n\nmiddle\n\nend") });
  const bytes = new TextEncoder().encode("a picture");
  const pic = A.e.storeMedia("p.png", bytes).file;
  const w2 = A.e.notes.create({ title: "Week 2", parentId: course.id, doc: { type: "doc", content: [{ type: "image", attrs: { src: `/media/${pic}` } }] } });

  const space = await A.sh.create(course.id);
  assert.equal(space.role, "owner");
  assert.equal(server.spaces.get(space.id)!.epoch, 2);
  assert.equal(A.e.notes.get(course.id).share?.root, true);
  assert.equal(A.e.notes.get(w1.id).share?.space, space.id);
  // Keys live in the share secrets file, 0600.
  const sec = join(A.home, "share", "acc_ann.json");
  if (process.platform !== "win32") assert.equal(statSync(sec).mode & 0o777, 0o600);
  assert.ok(JSON.parse(readFileSync(sec, "utf8")).keys[space.id]["2"]);

  await A.sh.invite(space.id, "bob@example.com", "edit");
  await B.sh.refresh();
  assert.equal(B.sh.status().invites.length, 1);
  // Bob had no identity when invited: his name is unknown until a key is wrapped for him.
  assert.equal(B.sh.status().invites[0].name, null);
  await B.sh.ensureIdentity();
  await A.sh.refresh(); // Ann's device wraps the key for him
  await B.sh.refresh();
  assert.equal(B.sh.status().invites[0].name, "CMPT 307");
  const { rootId } = await B.sh.accept(space.id);
  assert.equal(rootId, course.id);
  assert.equal(text(B.e, w1.id), "intro\nmiddle\nend");
  assert.equal(B.e.notes.get(w1.id).parentId, course.id);
  assert.equal(B.e.notes.get(course.id).kind, "folder");
  // The picture came along, checked against its name.
  assert.deepEqual(new Uint8Array(readFileSync(join(B.e.mediaDir, pic))), bytes);
  assert.equal(B.e.notes.get(w2.id).share?.readonly, false);

  // No local edit: the remote state wins, and `updated` moves so an open editor merges it.
  const before = B.e.notes.get(w1.id).updated;
  await new Promise((r) => setTimeout(r, 5));
  A.e.notes.update(w1.id, { title: "Week 1 · Greedy" });
  await A.sh.syncSpace(space.id);
  await B.sh.syncSpace(space.id);
  assert.equal(B.e.notes.get(w1.id).title, "Week 1 · Greedy");
  assert.ok(B.e.notes.get(w1.id).updated > before);

  // Both edit different blocks: merged on both.
  A.e.notes.update(w1.id, { doc: docFromText("INTRO\n\nmiddle\n\nend") });
  B.e.notes.update(w1.id, { doc: docFromText("intro\n\nmiddle\n\nEND") });
  await A.sh.syncSpace(space.id);
  await B.sh.syncSpace(space.id);
  await A.sh.syncSpace(space.id);
  await B.sh.syncSpace(space.id);
  assert.equal(text(A.e, w1.id), "INTRO\nmiddle\nEND");
  assert.equal(text(B.e, w1.id), "INTRO\nmiddle\nEND");

  // Both edit the same block: both versions kept, the same on both devices.
  A.e.notes.update(w1.id, { doc: docFromText("INTRO\n\nann's middle\n\nEND") });
  B.e.notes.update(w1.id, { doc: docFromText("INTRO\n\nbob's middle\n\nEND") });
  await A.sh.syncSpace(space.id);
  await B.sh.syncSpace(space.id);
  await A.sh.syncSpace(space.id);
  await B.sh.syncSpace(space.id);
  assert.match(text(A.e, w1.id), /ann's middle/);
  assert.match(text(A.e, w1.id), /bob's middle/);
  assert.equal(text(A.e, w1.id), text(B.e, w1.id));

  // Bob makes a page; Ann gets it.
  const mine = B.e.notes.create({ title: "Bob's notes", parentId: course.id, doc: docFromText("hello") });
  await B.sh.syncSpace(space.id);
  await A.sh.syncSpace(space.id);
  assert.equal(text(A.e, mine.id), "hello");

  // Remote delete against a local edit: the edit wins and goes up again.
  A.e.notes.delete(w2.id);
  B.e.notes.update(w2.id, { title: "Week 2 (kept)" });
  await A.sh.syncSpace(space.id);
  await B.sh.syncSpace(space.id);
  await A.sh.syncSpace(space.id);
  assert.equal(B.e.notes.get(w2.id).title, "Week 2 (kept)");
  assert.equal(A.e.notes.get(w2.id).title, "Week 2 (kept)");
  // A plain remote delete goes through.
  A.e.notes.delete(mine.id);
  await A.sh.syncSpace(space.id);
  await B.sh.syncSpace(space.id);
  assert.throws(() => B.e.notes.get(mine.id), /no note/);

  // A private note of Bob's is never touched; pins stay per device.
  B.e.notes.pin(w1.id);
  await B.sh.syncSpace(space.id);
  await A.sh.syncSpace(space.id);
  assert.equal(A.e.notes.get(w1.id).pinned ?? null, null);

  // View only: Bob's writes are refused, from Notes itself (the CLI and agents go through it).
  await A.sh.setRole(space.id, "bob@example.com", "view");
  await B.sh.refresh();
  assert.equal(B.e.notes.get(w1.id).share?.readonly, true);
  assert.throws(() => B.e.notes.update(w1.id, { title: "nope" }), /view only/);
  assert.throws(() => B.e.notes.create({ title: "x", parentId: course.id }), /view only/);
  assert.throws(() => B.e.notes.move(w1.id, null), /view only/);
  assert.throws(() => B.e.notes.delete(w1.id), /view only/);
  assert.throws(() => B.e.notes.importMarkdown([{ path: "a.md", text: "# a" }], { parentId: course.id }), /view only/);
  // …but what Ann writes still arrives.
  A.e.notes.update(w1.id, { title: "From Ann" });
  await A.sh.syncSpace(space.id);
  await B.sh.syncSpace(space.id);
  assert.equal(B.e.notes.get(w1.id).title, "From Ann");

  // Removal: Ann's device rotates the key; Bob keeps a read-only copy.
  await A.sh.removeMember(space.id, "bob@example.com");
  assert.equal(server.spaces.get(space.id)!.epoch, 3);
  assert.equal(server.spaces.get(space.id)!.keys.has(B.device), false);
  await B.sh.refresh();
  assert.equal(B.sh.spaces()[0].status, "removed");
  assert.equal(B.e.notes.get(w1.id).share?.readonly, true);
  assert.throws(() => B.e.notes.update(w1.id, { title: "x" }), /no longer have access/);
  B.e.notes.setArchived(w1.id, true); // a removed copy can still be tidied away
  await B.sh.leave(space.id);
  assert.equal(B.e.notes.get(w1.id).share, undefined);
  // Ann keeps syncing at the new epoch.
  A.e.notes.update(w1.id, { title: "After" });
  await A.sh.syncSpace(space.id);
  assert.equal(server.spaces.get(space.id)!.events.at(-1).epoch, 3);

  // Stop sharing: the notes stay, unshared.
  await A.sh.stop(space.id);
  assert.equal(server.spaces.size, 0);
  assert.equal(A.e.notes.get(w1.id).title, "After");
  assert.equal(A.e.notes.get(w1.id).share, undefined);
});

test("devices: a member's new device gets the key from their other device or the owner, with nothing to click", async (t) => {
  const { server, A, B, ann, bob } = await pair(t);
  const root = A.e.notes.create({ title: "Root", kind: "folder" });
  const page = A.e.notes.create({ title: "Page", parentId: root.id, doc: docFromText("hello") });
  const space = await A.sh.create(root.id);
  await B.sh.refresh();
  await A.sh.invite(space.id, bob.email, "view");
  await B.sh.accept(space.id);
  assert.equal(text(B.e, page.id), "hello");
  // Each wrap is for one device: the owner's and Bob's laptop, nothing per account.
  assert.deepEqual([...server.spaces.get(space.id)!.keys.keys()].sort(), [A.device, B.device].sort());

  // Bob signs in on a phone (a third collection): it sees the space at once, waiting for its key.
  const P = await device(t, server, bob, "dev_bob_phone");
  await P.sh.refresh();
  assert.deepEqual(P.sh.status().invites, []);
  // Access is per account, so there's no invite on the phone: the space just shows up in its tree.
  const waiting = P.sh.spaces()[0];
  assert.equal(waiting.waitingKey, true);
  assert.equal(waiting.error, null);
  assert.throws(() => P.e.notes.get(page.id), /no note/);
  // Bob's laptop is a viewer, and still hands the key to his own phone on its next pass.
  await B.sh.refresh();
  await P.sh.auto(true);
  assert.equal(P.sh.spaces()[0].waitingKey, false);
  assert.equal(text(P.e, page.id), "hello");
  // …but a viewer never wraps for anyone else's device.
  const annPhone = await device(t, server, ann, "dev_ann_phone");
  await annPhone.sh.refresh();
  await B.sh.refresh();
  assert.equal(server.spaces.get(space.id)!.keys.has(annPhone.device), false);
  // The owner's laptop does it for her new phone (and would for anyone's).
  await A.sh.refresh();
  assert.ok(server.spaces.get(space.id)!.keys.get(annPhone.device)?.["2"]);

  // Signing a device out drops its wraps; a sign-in again is a new device with a new keypair, handed the key again.
  const before = JSON.parse(readFileSync(join(P.home, "share", "acc_bob.json"), "utf8")).device;
  server.signOut(P.device);
  writeFileSync(join(P.home, "account.json"), JSON.stringify({ server: "https://example.test", token: "tok-2", email: bob.email, accountId: bob.id, deviceId: "dev_bob_phone2" }));
  P.sh.transport = server.transport({ ...bob, device: "dev_bob_phone2" });
  await P.sh.refresh();
  const after = JSON.parse(readFileSync(join(P.home, "share", "acc_bob.json"), "utf8")).device;
  assert.notEqual(after.publicKey, before.publicKey);
  assert.equal(after.slot, "https://example.test|dev_bob_phone2");
  assert.equal(server.identities.get("dev_bob_phone2")?.publicKey, after.publicKey);
  await A.sh.refresh();
  assert.ok(server.spaces.get(space.id)!.keys.get("dev_bob_phone2")?.["2"]);

  // Rotation after a removal covers every device of everyone left.
  const cem = { id: "acc_cem", email: "cem@example.com" };
  server.accounts.push(cem);
  const C = await device(t, server, cem);
  await C.sh.refresh();
  await A.sh.invite(space.id, cem.email, "edit");
  await C.sh.accept(space.id);
  await A.sh.removeMember(space.id, cem.email);
  const sp = server.spaces.get(space.id)!;
  assert.equal(sp.epoch, 3);
  for (const d of [A.device, annPhone.device, B.device, "dev_bob_phone2"]) assert.ok(sp.keys.get(d)?.["3"], d);
  assert.equal(sp.keys.has(C.device), false);
});

test("a child that arrives before its parent waits under the root, then moves in", async (t) => {
  const { server, A, B } = await pair(t);
  const root = A.e.notes.create({ title: "Root", kind: "folder" });
  const space = await A.sh.create(root.id);
  await B.sh.ensureIdentity();
  await A.sh.invite(space.id, "bob@example.com", "edit");
  await B.sh.accept(space.id);
  const sub = A.e.notes.create({ title: "Sub", parentId: root.id, kind: "folder" });
  const leaf = A.e.notes.create({ title: "Leaf", parentId: sub.id, doc: docFromText("x") });
  await A.sh.syncSpace(space.id);
  // Swap the two events in the log: the child comes first.
  const evs = server.spaces.get(space.id)!.events;
  const [i, j] = [evs.length - 2, evs.length - 1];
  [evs[i].seq, evs[j].seq] = [evs[j].seq, evs[i].seq];
  evs.sort((a, b) => a.seq - b.seq);
  const real = B.sh.transport;
  // One event per pass: the child is written before its parent exists.
  B.sh.transport = { ...real, pull: async (id: string, after: number) => ({ ...(await real.pull(id, after, 1)), more: false }) } as ShareTransport;
  await B.sh.syncSpace(space.id);
  assert.equal(B.e.notes.get(leaf.id).parentId, root.id);
  assert.throws(() => B.e.notes.get(sub.id), /no note/);
  await B.sh.syncSpace(space.id);
  assert.equal(B.e.notes.get(sub.id).parentId, root.id);
  assert.equal(B.e.notes.get(leaf.id).parentId, sub.id);
  // Nothing went up from Bob: the move was the space's own state, not an edit of his.
  B.sh.transport = real;
  const n = server.spaces.get(space.id)!.events.length;
  await B.sh.syncSpace(space.id);
  assert.equal(server.spaces.get(space.id)!.events.length, n);
  assert.equal(text(B.e, leaf.id), "x");
});

test("a remote change this device can't take is skipped and named, and the rest still arrives", async (t) => {
  const { server, A, B } = await pair(t);
  const root = A.e.notes.create({ title: "Root", kind: "folder" });
  const page = A.e.notes.create({ title: "Page", parentId: root.id });
  const space = await A.sh.create(root.id);
  await B.sh.ensureIdentity();
  await A.sh.invite(space.id, "bob@example.com", "edit");
  await B.sh.accept(space.id);
  const key = JSON.parse(readFileSync(join(A.home, "share", "acc_ann.json"), "utf8")).keys[space.id]["2"];
  const keys = await syncKeys(Uint8Array.from(Buffer.from(key, "base64")));
  const bad = { v: 1, note: "bad-note", op: "put", base: null, state: { kind: "<script>", parent: root.id, title: "x", icon: null, look: {}, position: 0, archived: false, doc: { type: "doc", content: [] }, scene: null, content: null, file: null } };
  await server.transport({ id: "acc_ann", email: "ann@example.com", device: A.device }).push(space.id, [{ id: "zz.bad-note.1", epoch: 2, ciphertext: await encryptEvent(keys, "zz.bad-note.1", bad) }]);
  A.e.notes.update(page.id, { title: "Page 2" });
  await A.sh.syncSpace(space.id);
  await B.sh.syncSpace(space.id);
  assert.equal(B.e.notes.get(page.id).title, "Page 2");
  assert.throws(() => B.e.notes.get("bad-note"), /no note/);
  assert.match(B.sh.spaces()[0].error ?? "", /couldn't be applied/);
});

/** The fake server over HTTP, for the CLI: each bearer token is one account. */
async function httpServer(server: FakeServer, tokens: Record<string, Dev>) {
  const h = createServer(async (req, res) => {
    const acc = tokens[(req.headers.authorization ?? "").replace(/^Bearer /, "")] as Dev | undefined;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const body = raw.length && req.headers["content-type"] === "application/json" ? JSON.parse(raw.toString()) : {};
    const send = (status: number, v: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (!acc) return send(401, { error: { code: "unauthorized", message: "no" } });
    const t = server.transport(acc);
    const u = new URL(req.url!, "http://x");
    const p = u.pathname.split("/").slice(1);
    try {
      const m = req.method;
      if (u.pathname === "/v1/me") return send(200, { id: acc.id, email: acc.email, device: { id: acc.device } });
      if (u.pathname === "/v1/identity") {
        if (m === "GET") {
          const i = await t.getIdentity();
          return i ? send(200, i) : send(404, { error: { code: "no_identity", message: "none" } });
        }
        await t.putIdentity(body);
        return send(201, { ok: true });
      }
      if (u.pathname === "/v1/spaces") return m === "GET" ? send(200, await t.list()) : send(201, { space: await t.create(body) });
      const [, , id, sub, x] = p;
      if (!sub) return m === "GET" ? send(200, { space: await t.detail(id) }) : send(200, (await t.remove(id), { ok: true }));
      if (sub === "members" && !x) return send(201, { member: await t.invite(id, body) });
      if (sub === "members") return m === "PATCH" ? send(200, { member: await t.setRole(id, x, body.role) }) : send(200, (await t.removeMember(id, x), { ok: true }));
      if (sub === "accept") return send(200, { space: await t.accept(id) });
      if (sub === "decline") return send(200, (await t.decline(id), { ok: true }));
      if (sub === "keys") return send(200, (await t.putKeys(id, body.epoch, body.keys), { ok: true }));
      if (sub === "rotate") return send(200, { space: await t.rotate(id, body) });
      if (sub === "events") return m === "GET" ? send(200, await t.pull(id, Number(u.searchParams.get("after")), Number(u.searchParams.get("limit")))) : send(200, await t.push(id, body.events));
      if (sub === "presence") return m === "PUT" ? send(200, (await t.putPresence!(id, body), { ok: true })) : m === "DELETE" ? send(200, (await t.deletePresence!(id), { ok: true })) : send(200, { presence: await t.getPresence!(id) });
      if (sub === "activity") return send(200, await t.activity!(id));
      if (sub === "blobs") {
        if (m === "PUT") return send(201, (await t.putBlob(id, x, new Uint8Array(raw)), { ok: true }));
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(Buffer.from(await t.getBlob(id, x)));
      }
      send(404, { error: { code: "not_found", message: "no route" } });
    } catch (e) {
      const err = e as AccountError;
      send(err.status ?? 500, { error: { code: err.code ?? "error", message: err.message } });
    }
  });
  await new Promise<void>((r) => h.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(h.address() as any).port}`, close: () => new Promise<void>((r) => h.close(() => r())) };
}

test("share CLI: every command answers JSON, over HTTP to a stub server", async (t) => {
  const dir = temp();
  const server = new FakeServer();
  const ann = { id: "acc_ann", email: "ann@example.com" }, bob = { id: "acc_bob", email: "bob@example.com" };
  server.accounts.push(ann, bob);
  server.sync.add(ann.id);
  const http = await httpServer(server, { ta: { ...ann, device: "dev_a" }, tb: { ...bob, device: "dev_b" } });
  t.after(async () => {
    await http.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const homes = { a: join(dir, "a"), b: join(dir, "b") };
  async function cli(who: "a" | "b", args: string[], code = 0) {
    let out = "", err = "";
    const got = await run(["--db", join(dir, `${who}.db`), ...args, "--json"], { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => "", isTTY: false, env: { ETUDE_HOME: homes[who] } });
    assert.equal(got, code, err || out);
    return JSON.parse(out || err);
  }
  const signedOut = await cli("a", ["share", "list"]);
  assert.deepEqual({ signedIn: signedOut.signedIn, spaces: signedOut.spaces, invites: signedOut.invites }, { signedIn: false, spaces: [], invites: [] });
  await cli("a", ["note", "new", "Course", "--folder"]);
  assert.match(JSON.stringify(await cli("a", ["share", "create", "Course"], 2)), /sign in/);
  for (const [w, tok, a] of [["a", "ta", ann], ["b", "tb", bob]] as const) {
    mkdirSync(homes[w], { recursive: true });
    writeFileSync(join(homes[w], "account.json"), JSON.stringify({ server: http.url, token: tok, email: a.email }));
  }
  // Bob has no Sync: making a space is refused with the plan's code.
  await cli("b", ["note", "new", "Mine", "--folder"]);
  assert.equal((await cli("b", ["share", "create", "Mine"], 7)).code, "sync_required");

  const page = await cli("a", ["note", "new", "Week 1", "--parent", "Course"]);
  const made = await cli("a", ["share", "create", "Course"]);
  assert.deepEqual(Object.keys(made.space).sort(), ["error", "id", "lastSync", "name", "owner", "pending", "role", "rootId", "status", "waitingKey"]);
  assert.equal(made.space.name, "Course");
  const sid = made.space.id;
  assert.equal((await cli("a", ["share", "invite", "Course", "bob@example.com", "--role", "view"])).member.role, "view");
  const members = (await cli("a", ["share", "members", sid])).members;
  assert.deepEqual(members.map((m: any) => [m.email, m.role, m.status]), [["ann@example.com", "owner", "active"], ["bob@example.com", "view", "invited"]]);
  const blist = await cli("b", ["share", "list"]);
  assert.equal(blist.invites[0].spaceId, sid);
  await cli("b", ["share", "sync"]); // Bob's device has its key now; Ann's next list wraps the space key for it
  await cli("a", ["share", "list"]);
  assert.equal((await cli("b", ["share", "list"])).invites[0].name, "Course");
  const acc = await cli("b", ["share", "accept", sid]);
  assert.equal(acc.rootId, made.space.rootId);
  const read = await cli("b", ["note", "show", page.id]);
  assert.equal(read.share.readonly, true);
  assert.equal((await cli("b", ["note", "edit", page.id, "--title", "x"], 5)).error, "this is shared with you as view only");
  assert.equal((await cli("a", ["share", "role", sid, "bob@example.com", "edit"])).member.role, "edit");
  await cli("b", ["share", "sync"]);
  await cli("b", ["note", "edit", page.id, "--title", "Week 1 by Bob"]);
  const synced = await cli("b", ["share", "sync"]);
  assert.equal(synced.spaces[0].error, null);
  await cli("a", ["share", "sync"]);
  assert.equal((await cli("a", ["note", "show", page.id])).title, "Week 1 by Bob");
  // Who's here: Bob opens the page; Ann's CLI sees him on it, and the activity counts his edit.
  const { shareFor: sf } = await import("../src/core/share/client.ts");
  const eb = await Etude.open(join(dir, "b.db"), { home: homes.b });
  sf(eb).setPresence(page.id, { anchor: 1, head: 3 });
  await new Promise((r) => setTimeout(r, 50));
  const who = await cli("a", ["share", "who", "Course/Week 1 by Bob"]);
  assert.deepEqual(who.people.map((p: any) => [p.email, p.here, p.title, p.sel]), [["bob@example.com", true, "Week 1 by Bob", { anchor: 1, head: 3 }]]);
  assert.equal((await cli("a", ["share", "who", sid])).people[0].here, false);
  assert.equal((await cli("b", ["share", "who"])).people.length, 0);
  await sf(eb).clearPresence();
  eb.close();
  assert.deepEqual((await cli("a", ["share", "who"])).people, []);
  const act = await cli("a", ["share", "activity", sid]);
  assert.deepEqual(act.members.map((m: any) => [m.email, m.editsTotal > 0]), [["ann@example.com", true], ["bob@example.com", true]]);
  assert.match(act.members[1].color, /^#[0-9a-f]{6}$/);
  assert.deepEqual(await cli("a", ["share", "remove", sid, "bob@example.com"]), { ok: true, removed: "bob@example.com" });
  assert.equal(server.spaces.get(sid)!.epoch, 3);
  assert.equal((await cli("b", ["share", "list"])).spaces[0].status, "removed");
  assert.equal((await cli("b", ["share", "leave", sid])).ok, true);
  assert.equal((await cli("a", ["share", "stop", "Course"])).ok, true);
  assert.deepEqual((await cli("a", ["share", "list"])).spaces, []);
});

// ── presence, activity, who changed what ────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function together(t: any, role: "edit" | "view" = "edit") {
  const p = await pair(t);
  const { A, B } = p;
  const course = A.e.notes.create({ title: "Course", kind: "folder" });
  const page = A.e.notes.create({ title: "Agora", parentId: course.id, doc: docFromText("one\n\ntwo\n\nthree") });
  const space = await A.sh.create(course.id);
  await A.sh.invite(space.id, "bob@example.com", role);
  await B.sh.ensureIdentity();
  await A.sh.refresh();
  await B.sh.refresh();
  await B.sh.accept(space.id);
  t.after(() => (A.sh.clearPresence(), B.sh.clearPresence()));
  return { ...p, course, page, space };
}

test("presence: encrypted, throttled, read by the others with a color, cleared when nothing shared is open", async (t) => {
  const { server, A, B, page, space, course } = await together(t);
  A.sh.setPresence(page.id, { anchor: 5, head: 9 }, { block: [1], typing: true });
  await sleep(20);
  const held = server.presence.get(space.id)!.get("dev_ann")!;
  // The server holds only ciphertext: nothing about the page or the cursor.
  assert.equal(held.epoch, 2);
  assert.doesNotMatch(Buffer.from(held.ct, "base64").toString("latin1"), new RegExp(page.id));
  const seen = await B.sh.who({ noteId: page.id });
  assert.equal(seen.length, 1);
  const p = seen[0];
  assert.deepEqual({ email: p.email, note: p.note, title: p.title, kind: p.kind, sel: p.sel, block: p.block, typing: p.typing, here: p.here, space: p.space }, { email: "ann@example.com", note: page.id, title: "Agora", kind: "page", sel: { anchor: 5, head: 9 }, block: [1], typing: true, here: true, space: space.id });
  assert.match(p.color, /^#[0-9a-f]{6}$/);
  assert.equal((await B.sh.who({ noteId: course.id }))[0].here, false);
  // Your own device isn't in your list.
  assert.deepEqual(await A.sh.who({ noteId: page.id }), []);

  // Moving fast: the first move goes at once, the rest at most every 300 ms, and repeating the same says nothing.
  await sleep(350);
  const before = server.presencePuts;
  for (let i = 0; i < 10; i++) A.sh.setPresence(page.id, { anchor: 10 + i, head: 10 + i });
  await sleep(30);
  assert.equal(server.presencePuts - before, 1);
  await sleep(350);
  assert.equal(server.presencePuts - before, 2);
  A.sh.setPresence(page.id, { anchor: 19, head: 19 });
  await sleep(350);
  assert.equal(server.presencePuts - before, 2);
  await sleep(500); // past B's 800 ms cache
  assert.deepEqual((await B.sh.who({ noteId: page.id }))[0].sel, { anchor: 19, head: 19 });

  // A private page (or nothing) open: presence goes.
  const mine = A.e.notes.create({ title: "Private" });
  A.sh.setPresence(mine.id, { anchor: 1, head: 1 });
  await sleep(20);
  assert.equal(server.presence.get(space.id)!.size, 0);
  A.sh.setPresence(page.id, null);
  await sleep(20);
  assert.equal(server.presence.get(space.id)!.size, 1);
  A.sh.setPresence(null);
  await sleep(20);
  assert.equal(server.presence.get(space.id)!.size, 0);
  // A window that went without saying so (crashed, killed): 25 s without a word from the app and presence goes.
  A.sh.setPresence(page.id, { anchor: 4, head: 4 });
  await sleep(350);
  assert.equal(server.presence.get(space.id)!.size, 1);
  (A.sh as any).here.told = Date.now() - 26_000;
  (A.sh as any).flushPresence();
  await sleep(20);
  assert.equal(server.presence.get(space.id)!.size, 0);
  // Not shared, not open, junk: never an error.
  A.sh.setPresence("no-such-note", { anchor: -1, head: "x" } as any);
});

test("presence: viewers have cursors too; being together on a page makes that space sync every second", async (t) => {
  const { A, B, page, space } = await together(t, "view");
  B.sh.setPresence(page.id, { anchor: 2, head: 2 });
  A.sh.setPresence(page.id, { anchor: 3, head: 3 });
  await sleep(20);
  assert.equal((await A.sh.who({ noteId: page.id }))[0].email, "bob@example.com");
  assert.equal((B.sh as any).together.size, 0);
  await B.sh.who({ noteId: page.id });
  assert.ok((B.sh as any).together.get(space.id) > Date.now());
  // Someone on another page of the space doesn't count.
  const other = A.e.notes.create({ title: "Other", parentId: page.parentId });
  await A.sh.syncSpace(space.id);
  await B.sh.syncSpace(space.id);
  (A.sh as any).together.clear();
  B.sh.setPresence(other.id, null);
  await sleep(900);
  await A.sh.who({ noteId: page.id });
  assert.equal((A.sh as any).together.size, 0);
});

test("who changed it last: a member's edit shows on the note with their email, your own as you; activity has names and colors", async (t) => {
  const { A, B, page, space, bob } = await together(t);
  B.e.notes.update(page.id, { title: "Agora!" });
  await B.sh.syncSpace(space.id);
  await A.sh.syncSpace(space.id);
  const le = A.e.notes.get(page.id).share?.lastEdit;
  assert.equal(le?.email, "bob@example.com");
  assert.equal(le?.you, undefined);
  assert.ok(Date.now() - Date.parse(le!.at) < 5000);
  assert.equal(A.e.notes.list().find((n) => n.id === page.id)?.share?.lastEdit?.email, "bob@example.com");
  assert.equal(B.e.notes.get(page.id).share?.lastEdit?.you, true);
  A.e.notes.update(page.id, { title: "Agora" });
  await A.sh.syncSpace(space.id);
  assert.deepEqual({ ...A.e.notes.get(page.id).share!.lastEdit, at: "" }, { email: "ann@example.com", name: "you", at: "", you: true });

  const act = await A.sh.activity(space.id);
  const b = act.members.find((m) => m.accountId === bob.id)!;
  assert.equal(b.editsTotal, 1);
  assert.match(b.color, /^#[0-9a-f]{6}$/);
  assert.equal(b.color, (await B.sh.activity(space.id)).members.find((m) => m.accountId === bob.id)!.color);
});

test("presence colors: 8, stable per account, none near the accent", async () => {
  const { presenceColor, presencePalette } = await import("../src/core/share/colors.ts");
  for (const accent of [null, "green", "blue", "pink", "graphite", "#e0508e"]) {
    const p = presencePalette(accent);
    assert.equal(p.length, 8);
    assert.equal(new Set(p).size, 8);
  }
  assert.ok(!presencePalette("pink").includes("#d6467f"));
  assert.ok(!presencePalette(null).includes("#33994a"));
  assert.equal(presenceColor("acc_victor", "blue"), presenceColor("acc_victor", "blue"));
  assert.ok(presencePalette("blue").includes(presenceColor("acc_victor", "blue")));
});
