import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Etude } from "../src/core/engine.ts";
import { accountFor, AccountError, checkServerUrl, paidId, signInCode } from "../src/core/account.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { patchInstall } from "../src/core/market.ts";
import { agentRefusal } from "../src/core/agent-guard.ts";
import { COMMANDS } from "../src/cli/registry.ts";
import { run } from "../src/cli/run.ts";
import { createVault } from "../src/core/sync/crypto.ts";
import "../src/cli/commands/index.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Just enough of etude-cloud for the client: sign-in, me, library, pack download, deletion. */
function stub() {
  const tokens = new Set<string>();
  let pack: any = { etude: "pack/1", name: "Pharm", decks: [{ name: "Pharm" }], items: [{ id: "p1", type: "basic", deck: "Pharm", fields: { front: "ACE inhibitor ending", back: "-pril" } }] };
  let version = "1.0.0";
  const calls: string[] = [];
  const verifyBodies: any[] = [];
  const appleBodies: any[] = [];
  let fresh = true;
  let vaultKeys: unknown = null;
  let refunded = false;
  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => (res.writeHead(status, { "content-type": "application/json", ...headers }), res.end(JSON.stringify(data)));
    const path = (req.url ?? "").split("?")[0];
    calls.push(`${req.method} ${path}`);
    if (path === "/v1/server") return send(200, { billing: true, market: true, quotaBytes: 1024 ** 3, passkeys: { rpId: "localhost" } });
    if (path === "/v1/auth/email/start") return send(200, { ok: true });
    if (path === "/v1/auth/email/verify") {
      verifyBodies.push(body);
      const good = body.token === "good-code" || (body.email === "a@example.test" && body.code === "482913" && body.token === undefined);
      if (!good) return send(401, { error: body.code ? { code: "invalid_code", message: "That code isn't right. 4 tries left.", attemptsLeft: 4 } : { code: "invalid_token", message: "bad code" } });
      fresh = true;
      if (tokens.has(auth)) return send(200, { reauth: true, account: { id: "acc_1", email: "a@example.test" } });
      tokens.add("ecd_tok");
      return send(200, { token: "ecd_tok", account: { id: "acc_1", email: "a@example.test" } });
    }
    if (!tokens.has(auth)) return send(401, { error: { code: "unauthorized", message: "Sign in first" } });
    if (path === "/v1/me" && req.method === "GET") return send(200, { id: "acc_1", email: "a@example.test", device: { id: "dev_1" }, sync: { active: false, reason: "none" }, admin: false });
    if (path === "/v1/me" && req.method === "DELETE") return tokens.delete(auth), send(200, { ok: true, deleted: "acc_1" });
    if (path === "/v1/billing/sync") return send(200, { active: false, reason: "none", billing: true });
    if (path === "/v1/library") {
      const entry = { listing: "lst_1", slug: "pharm", name: "Pharm", version, changelog: "", pack: "/v1/listings/lst_1/pack" };
      return send(200, refunded ? { library: [], revoked: [{ listing: "lst_1", slug: "pharm", name: "Pharm", cover: null, reason: "refunded", at: "2026-11-09T20:37:13.000Z" }] } : { library: [entry], revoked: [] });
    }
    if (path === "/v1/listings/lst_1/pack") return send(200, pack, { "x-etude-version": version });
    if (path === "/v1/vault") return send(200, { hasKeys: !!vaultKeys });
    if (path === "/v1/vault/keys") {
      if (!fresh) return send(403, { error: { code: "reauth_required", message: "Sign in again on this device to read the vault's keys." } });
      return vaultKeys ? send(200, vaultKeys, { etag: '"keys"' }) : send(404, { error: { code: "no_keys", message: "none" } });
    }
    if (path === "/v1/auth/logout") return tokens.delete(auth), send(200, { ok: true });
    // Admin: a house listing's App Store product (etude-cloud PUT /v1/admin/listings/:id/apple).
    if (path === "/v1/admin/listings/lst_1/apple" && req.method === "PUT") {
      appleBodies.push(body);
      if (!fresh) return send(403, { error: { code: "reauth_required", message: "Sign in again to approve, reject, hide or refund as an admin." } });
      if (body.productId === "study.etude.sync.monthly") return send(409, { error: { code: "sync_product", message: "That's an Etude Sync product, not a deck." } });
      return send(200, { listing: "lst_1", appleProductId: body.productId ?? null });
    }
    if (path === "/v1/admin/listings/lst_creator/apple" && req.method === "PUT") return send(409, { error: { code: "not_house_listing", message: "Only decks Etude sells itself are sold in the iPhone app." } });
    // A creator from before direct charges: no usable Stripe account until they set up again.
    if (path === "/v1/creator" && req.method === "GET") return send(200, { country: "CA", displayName: "Old", stripeAccount: null, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, setupRequired: true });
    // Selling needs two-step sign-in, which this account doesn't have.
    if ((path === "/v1/creator" && req.method === "POST") || (path === "/v1/listings" && req.method === "POST")) return send(403, { error: { code: "two_factor_required", message: "Selling on the Etude Market needs two-step sign-in. Turn it on with an authenticator app, or add a passkey, in Settings → Account (or at https://cloud.example/account), then set up selling again.", settingsUrl: "https://cloud.example/account" } });
    if (path === "/v1/creator/onboarding-link" || path === "/v1/creator/dashboard-link") return send(409, { error: { code: "creator_setup_required", message: "Etude now sells through your own Stripe account. Set up selling again to create it (POST /v1/creator)." } });
    return send(404, { error: { code: "not_found", message: path } });
  });
  return {
    calls,
    verifyBodies,
    appleBodies,
    expireSignin() { fresh = false; },
    setVaultKeys(keys: unknown) { vaultKeys = keys; },
    refund(on = true) { refunded = on; },
    bump(next: string) {
      version = next;
      pack = { ...pack, items: [...pack.items, { id: "p2", type: "basic", deck: "Pharm", fields: { front: "Beta blocker ending", back: "-olol" } }] };
    },
    /** A card type of the deck's own and an item with a picture, in a subdeck. */
    extras() {
      pack = {
        ...pack,
        types: [{ id: "pharm-card", name: "Pharm card", fields: [{ name: "q", kind: "markdown" }], grader: { kind: "self" }, template: { html: "<p>{{q}}</p>" } }],
        items: [...pack.items, { id: "p3", type: "pharm-card", deck: "Pharm::Pictures", fields: { q: `data:image/png;base64,${PNG}` } }],
      };
    },
    async start() {
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

test("sync: a stale shared sign-in probes metadata, asks for reauth on unlock and keeps the same device", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-reauth-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    await a.signin("a@example.test");
    await a.verify("482913");
    const originalToken = a.token();
    s.setVaultKeys((await createVault("sync-password", { m: 1024, t: 1, p: 1 })).keys);
    s.expireSignin();
    const sy = syncFor(e);
    sy.setup({ server: url });
    const st = await sy.probe();
    assert.equal(st.hasKeys, true);
    assert.equal(st.error, null);
    assert.equal(s.calls.includes("GET /v1/vault/keys"), false, "probing never downloads key wraps");
    await assert.rejects(sy.unlock({ password: "sync-password" }), (err: AccountError) => err.status === 403 && err.code === "reauth_required");
    assert.equal(sy.status().unlocked, false);
    await sy.signin("a@example.test");
    const confirmed = await sy.verify("482913");
    assert.equal(a.token(), originalToken);
    assert.equal(confirmed.account, true, "a shared account token stays shared after reauth");
    assert.equal((await sy.unlock({ password: "sync-password" })).status.unlocked, true);
    await sy.signin("a@example.test");
    assert.equal((await sy.verify("482913")).unlocked, true, "reauth preserves the saved vault key");
  } finally {
    e.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account: sign in, token file 0600, purchased deck installs and updates through the pack importer, delete needs the typed email", async () => {
  const dir = mkdtempSync(join((process.env.TMPDIR ?? tmpdir()), "account-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    assert.equal((await a.status()).signedIn, false);
    await a.signin("a@example.test");
    await assert.rejects(a.verify("bad-code"), (err: AccountError) => err.status === 401);
    assert.deepEqual(await a.verify("good-code"), { reauth: false, email: "a@example.test" });
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "home", "account.json")).mode & 0o777, 0o600);
    assert.equal((await a.verify("good-code")).reauth, true, "a second code re-confirms this device");
    assert.throws(() => a.setServer("https://other.example"), /sign out/);

    // Sync on the same server uses the account's device instead of asking for another code.
    syncFor(e).setup({ server: url });
    const st = await syncFor(e).probe();
    assert.equal(st.signedIn, true);
    assert.equal(st.account, true);

    const lib = await a.library();
    assert.equal(lib.library[0].installed, null);
    const r1 = await a.install("lst_1");
    assert.equal(r1.result, "created");
    assert.equal(e.db.get("SELECT count(*) AS n FROM items WHERE id = 'p1'")!.n, 1);
    assert.equal((await a.library()).library[0].installed, "installed");

    s.bump("1.1.0");
    assert.equal((await a.library()).library[0].installed, "update");
    const r2 = await a.install("pharm");
    assert.equal(r2.result, "updated");
    assert.equal(r2.entry.id, paidId("pharm"));
    assert.equal(e.db.get("SELECT count(*) AS n FROM items WHERE deck_id = (SELECT id FROM decks WHERE name = 'Pharm')")!.n, 2);

    await assert.rejects(a.deleteAccount("someone@else.test"), /type the account's email/);
    assert.ok(!s.calls.includes("DELETE /v1/me"));
    assert.equal((await a.deleteAccount("A@example.test")).ok, true);
    assert.equal(a.token(), undefined);
    assert.equal((await a.status()).signedIn, false);
    // Local data stays.
    assert.equal(e.db.get("SELECT count(*) AS n FROM items WHERE id = 'p1'")!.n, 1);
  } finally {
    e.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account and sync: a 6-digit code (spaces allowed) goes as {email, code}, anything else as {token}", async () => {
  assert.equal(signInCode("482913"), "482913");
  assert.equal(signInCode(" 482 913 "), "482913");
  assert.equal(signInCode("48291"), null);
  assert.equal(signInCode("ml_abcdefghijklmnop"), null);
  assert.equal(signInCode("4829134"), null);
  const dir = mkdtempSync(join((process.env.TMPDIR ?? tmpdir()), "account-code-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  const e2 = await Etude.open(join(dir, "etude2.db"), { home: join(dir, "home2") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    await assert.rejects(a.verify("482913"), (err: AccountError) => err.code === "invalid_email", "no pending sign-in: no address to send");
    await a.signin("a@example.test");
    await assert.rejects(a.verify("111 111"), (err: AccountError) => err.code === "invalid_code" && /4 tries left/.test(err.message));
    assert.deepEqual(s.verifyBodies.at(-1), { email: "a@example.test", code: "111111", deviceName: s.verifyBodies.at(-1).deviceName });
    assert.deepEqual(await a.verify("482 913"), { reauth: false, email: "a@example.test" });
    assert.equal(s.verifyBodies.at(-1).code, "482913");
    assert.equal(s.verifyBodies.at(-1).token, undefined);
    // The long token from the link still goes as {token}.
    assert.equal((await a.verify("good-code")).reauth, true);
    assert.deepEqual(Object.keys(s.verifyBodies.at(-1)).sort(), ["deviceName", "token"]);

    // Sync's own sign-in uses the address it was given in `signin`.
    const sy = syncFor(e2);
    sy.setup({ server: url });
    await sy.signin("a@example.test");
    // A wrong code is the server's 401 with its message (not a 500 from the app server).
    await assert.rejects(sy.verify("111111"), (err: AccountError) => err instanceof AccountError && err.status === 401 && err.code === "invalid_code" && /4 tries left/.test(err.message));
    const st = await sy.verify("482913");
    assert.equal(st.signedIn, true);
    assert.equal(s.verifyBodies.at(-1).email, "a@example.test");
    assert.equal(s.verifyBodies.at(-1).code, "482913");
    assert.equal(s.verifyBodies.at(-1).token, undefined);
  } finally {
    e.close();
    e2.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account: status calls at once share one answer, and a change to the account starts a fresh one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "account-status-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    const out = await a.status();
    assert.equal(out.signedIn, false);
    await a.signin("a@example.test");
    await a.verify("482913");
    s.calls.length = 0;
    const [one, two, three] = await Promise.all([a.status(), a.status(), a.status()]);
    assert.equal(one, two);assert.equal(two, three);
    assert.equal(one.me.email, "a@example.test");assert.deepEqual(one.billing, { active: false, reason: "none", billing: true });assert.equal(one.vault, null);
    assert.deepEqual(s.calls.sort(), ["GET /v1/billing/sync", "GET /v1/me", "GET /v1/server"]);
    // The account changed (a sign-in, a sign-out, a server) while an answer was on its way: the next caller gets a new one.
    const before = a.status();
    assert.equal(a.status(), before);
    a.setServer(url);
    const after = a.status();
    assert.notEqual(after, before);
    await Promise.all([before, after]);
  } finally {
    e.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("account: server URLs need https outside localhost", () => {
  assert.equal(checkServerUrl("https://sync.etude.study/"), "https://sync.etude.study");
  assert.equal(checkServerUrl("http://localhost:4870"), "http://localhost:4870");
  assert.throws(() => checkServerUrl("http://example.com"), /https/);
  assert.throws(() => checkServerUrl("https://u:p@example.com"), /user/);
});

test("account: Ask Etude may read the account but not buy, sell, sign in or delete", () => {
  const cmd = (name: string) => COMMANDS.find((c) => c.name === name)!;
  const g = (name: string) => agentRefusal({ cmd: cmd(name), values: {}, named: {}, attachmentDir: (process.env.TMPDIR ?? tmpdir()) });
  for (const ok of ["account status", "account library", "account sales"]) assert.equal(g(ok), null, ok);
  for (const no of ["account delete", "account buy", "account install", "account signin", "account list-deck", "account approve", "account revoke", "account server"]) assert.match(g(no) ?? "", /can't change the Etude account/, no);
});

test("account: selling without two-step sign-in says where to turn it on in the app", async () => {
  const dir = mkdtempSync(join((process.env.TMPDIR ?? tmpdir()), "account-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    await a.signin("a@example.test");
    await a.verify("good-code");
    const refused = (err: AccountError) => err.status === 403 && err.code === "two_factor_required" && /two-step sign-in/.test(err.message) && /Settings → Account/.test(err.message) && !/https?:/.test(err.message);
    await assert.rejects(a.becomeCreator("CA"), refused);
    await assert.rejects(a.json("POST", "/v1/listings", { name: "Deck", price: 1000 }), refused);
    // Still signed in: a refusal isn't a sign-out.
    assert.equal((await a.status()).signedIn, true);
  } finally {
    e.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account: a creator from before direct charges reads as setupRequired, and Stripe links say to set up again in plain words", async () => {
  const dir = mkdtempSync(join((process.env.TMPDIR ?? tmpdir()), "account-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    await a.signin("a@example.test");
    await a.verify("good-code");
    const cr: any = await a.creator();
    assert.equal(cr.setupRequired, true);
    assert.equal(cr.stripeAccount, null);
    for (const link of [a.onboardingLink, a.dashboardLink])
      await assert.rejects(link(), (err: AccountError) => err.status === 409 && err.code === "creator_setup_required" && /Market → Sell/.test(err.message) && !/POST/.test(err.message));
  } finally {
    e.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account: a bought deck stays out of exports; a refund takes it out of the collection with its card type and media, and buying again installs it afresh", async () => {
  const dir = mkdtempSync(join((process.env.TMPDIR ?? tmpdir()), "account-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    await a.signin("a@example.test");
    await a.verify("good-code");
    s.bump("1.1.0");
    s.extras();
    await a.install("lst_1");
    const rec = () => (e.db.setting<any>("market", {}).installed ?? {})[paidId("pharm")];
    assert.deepEqual([rec().listing, rec().items, rec().types], ["lst_1", ["p1", "p2", "p3"], ["pharm-card"]]);
    const picture = String(JSON.parse(e.db.get("SELECT fields FROM items WHERE id = 'p3'")!.fields as string).q);
    assert.match(picture, /^\/media\/files\/[0-9a-f]{64}\.png$/);
    const pictureFile = join(e.mediaDir, picture.slice("/media/".length));
    assert.ok(existsSync(pictureFile));

    // The person's own deck exports; the bought one doesn't, and the pack says how many items it left out.
    e.importPack({ etude: "pack/1", name: "Mine", decks: [{ name: "Mine" }], items: [{ id: "m1", type: "basic", deck: "Mine", fields: { front: "Q", back: "A" } }] });
    const all = e.exportPack() as any;
    assert.deepEqual(all.items.map((i: any) => i.id), ["m1"]);
    assert.deepEqual(all.meta, { withheld: { paidItems: 3 } });
    assert.equal((e.exportPack({ deck: "Pharm" }) as any).items.length, 0);
    assert.equal((e.exportPack({ deck: "Mine" }) as any).meta, undefined);

    // A refund takes the deck out: items, cards, its card type, its picture and the decks it leaves empty.
    const items = () => e.db.all("SELECT id FROM items ORDER BY id").map((r) => r.id as string);
    s.refund();
    const gone = await a.library();
    assert.deepEqual(gone.changes, { removed: ["Pharm"], unlocked: [] });
    assert.deepEqual(gone.revoked.map((r: any) => [r.slug, r.reason]), [["pharm", "refunded"]]);
    assert.deepEqual(items(), ["m1"]);
    assert.equal(e.db.get("SELECT COUNT(*) AS n FROM cards")!.n, 1);
    assert.ok(!e.db.get("SELECT 1 FROM types WHERE id = 'pharm-card'"));
    assert.ok(!existsSync(pictureFile));
    assert.deepEqual(e.db.all("SELECT name FROM decks WHERE name LIKE 'Pharm%'"), []);
    assert.equal(rec(), undefined);
    // Checking again changes nothing.
    assert.deepEqual((await a.library()).changes, { removed: [], unlocked: [] });

    // Bought again: the library offers Install, and installing brings everything back.
    s.refund(false);
    const back = await a.library();
    assert.deepEqual(back.changes, { removed: [], unlocked: [] });
    assert.equal(back.library[0].installed, null);
    await a.install("lst_1");
    assert.deepEqual(items(), ["m1", "p1", "p2", "p3"]);
    assert.ok(e.db.get("SELECT 1 FROM types WHERE id = 'pharm-card'"));
    assert.ok(existsSync(pictureFile));
  } finally {
    e.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account: a bought deck Sync deleted reads as not installed and installs again under fresh ids, which the paid list, a refund and exports follow", async () => {
  const dir = mkdtempSync(join((process.env.TMPDIR ?? tmpdir()), "account-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    await a.signin("a@example.test");
    await a.verify("good-code");
    const sy = syncFor(e);
    sy.setup({ folder: join(dir, "shared") });
    await sy.unlock({ password: "a test Sync password" });
    const rec = () => (e.db.setting<any>("market", {}).installed ?? {})[paidId("pharm")];
    const items = () => e.db.all("SELECT id FROM items ORDER BY id").map((r) => r.id as string);
    await a.install("lst_1");
    await sy.now({ waitMedia: true });
    assert.deepEqual(rec().items, ["p1"]);

    // Deleted here (or on another device): Sync keeps p1 deleted for good, and the library offers the deck again.
    e.deleteDeck("Pharm", { items: true });
    await sy.now({ waitMedia: true });
    assert.deepEqual(items(), []);
    assert.equal((await a.library()).library[0].installed, null);

    // A new version came out meanwhile: p1 comes back as p1.r1, the new p2 keeps its id.
    s.bump("1.1.0");
    const r = await a.install("lst_1");
    assert.equal(r.result, "created");
    assert.deepEqual(r.remap, { p1: "p1.r1" });
    assert.ok(!s.calls.some((c) => c.endsWith("/delivery")), "delivery confirmation stays the server's, per order");
    await sy.now({ waitMedia: true });
    assert.deepEqual(items(), ["p1.r1", "p2"]);
    assert.deepEqual([rec().items, rec().remap, rec().listing], [["p1.r1", "p2"], { p1: "p1.r1" }, "lst_1"]);
    assert.equal((await a.library()).library[0].installed, "installed");
    assert.deepEqual((e.exportPack() as any).meta, { withheld: { paidItems: 2 } });

    // A refund takes out the items under their new ids, and Sync keeps those deleted too.
    s.refund();
    assert.deepEqual((await a.library()).changes, { removed: ["Pharm"], unlocked: [] });
    assert.deepEqual(items(), []);
    assert.equal(rec(), undefined);
    await sy.now({ waitMedia: true });

    // Bought again: everything comes in under ids Sync hasn't deleted.
    s.refund(false);
    assert.equal((await a.library()).library[0].installed, null);
    const back = await a.install("lst_1");
    assert.deepEqual([back.result, back.remap], ["created", { p1: "p1.r2", p2: "p2.r1" }]);
    await sy.now({ waitMedia: true });
    assert.deepEqual(items(), ["p1.r2", "p2.r1"]);

    // Installing again keeps the map.
    const again = await a.install("lst_1");
    assert.deepEqual([again.remap, again.report.items.created], [{ p1: "p1.r2", p2: "p2.r1" }, 0]);
    assert.deepEqual(rec().items, ["p1.r2", "p2.r1"]);
  } finally {
    e.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account: a deck an earlier version locked after a refund gets its cards back when it's bought again", async () => {
  const dir = mkdtempSync(join((process.env.TMPDIR ?? tmpdir()), "account-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    await a.signin("a@example.test");
    await a.verify("good-code");
    s.bump("1.1.0");
    await a.install("lst_1");
    // What 3.1.2 to 3.2.0 left after a refund: the cards suspended and listed in the install record.
    const cards = e.db.all("SELECT id FROM cards ORDER BY id").map((r) => r.id as number);
    e.setSuspended(cards, true);
    patchInstall(e, paidId("pharm"), { locked: { at: "2026-11-11T15:08:50.000Z", reason: "refunded", cards: [cards[0]] } });
    assert.deepEqual((await a.library()).changes, { removed: [], unlocked: ["Pharm"] });
    assert.deepEqual(e.db.all("SELECT suspended FROM cards ORDER BY id").map((r) => r.suspended), [0, 1]);
    assert.equal((e.db.setting<any>("market", {}).installed ?? {})[paidId("pharm")].locked, undefined);
  } finally {
    e.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account apple-product: an admin links a house listing to its App Store product, unlinks it with none, and server refusals come through", async () => {
  const dir = mkdtempSync(join((process.env.TMPDIR ?? tmpdir()), "account-apple-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  const cli = async (...argv: string[]) => {
    let out = "";
    let err = "";
    const io = { stdout: (t: string) => (out += t), stderr: (t: string) => (err += t), stdin: () => "", isTTY: false, env: { ETUDE_HOME: join(dir, "home") } };
    const code = await run(argv, io, { etude: e });
    return { code, out: out ? JSON.parse(out) : null, err };
  };
  try {
    const a = accountFor(e);
    a.setServer(url);
    await a.signin("a@example.test");
    await a.verify("482913");

    const linked = await cli("account", "apple-product", "lst_1", "study.etude.deck.pharmacology");
    assert.equal(linked.code, 0, linked.err);
    assert.deepEqual(linked.out, { listing: "lst_1", appleProductId: "study.etude.deck.pharmacology" });
    assert.deepEqual(s.appleBodies.at(-1), { productId: "study.etude.deck.pharmacology" });
    assert.ok(s.calls.includes("PUT /v1/admin/listings/lst_1/apple"));

    const unlinked = await cli("account", "apple-product", "lst_1", "none");
    assert.equal(unlinked.code, 0, unlinked.err);
    assert.deepEqual(unlinked.out, { listing: "lst_1", appleProductId: null });
    assert.deepEqual(s.appleBodies.at(-1), { productId: null }, "none sends productId null");

    const sync = await cli("account", "apple-product", "lst_1", "study.etude.sync.monthly");
    assert.notEqual(sync.code, 0);
    assert.match(sync.err, /Etude Sync product/);
    const creator = await cli("account", "apple-product", "lst_creator", "study.etude.deck.other");
    assert.notEqual(creator.code, 0);
    assert.match(creator.err, /decks Etude sells itself/);

    s.expireSignin();
    await assert.rejects(a.appleProduct("lst_1", "study.etude.deck.pharmacology"), (err: AccountError) => err.status === 403 && err.code === "reauth_required");
  } finally {
    e.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account apple-product: Ask Etude can't run it", () => {
  const cmd = COMMANDS.find((c) => c.name === "account apple-product")!;
  assert.ok(cmd, "the command is registered");
  assert.equal(cmd.writes, true);
  assert.match(agentRefusal({ cmd, values: {}, named: {}, attachmentDir: (process.env.TMPDIR ?? tmpdir()) }) ?? "", /can't change the Etude account/);
});
