// The Etude account on an etude-cloud server: sign-in, devices, passkeys, email, export, deletion,
// the Sync subscription, and the paid Market (catalog, library, selling, review).
// The device token is kept per install in $ETUDE_HOME/account.json (0600); the collection never holds it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EtudeError, type Etude } from "./engine.ts";
import { installedEntries, installFile } from "./market.ts";

export const DEFAULT_CLOUD = "https://sync.etude.study";

export class AccountError extends EtudeError {
  code: string;
  constructor(message: string, status = 400, code = "error") {
    super(message, status);
    this.code = code;
  }
}

interface Saved {
  server?: string;
  token?: string;
  email?: string;
  accountId?: string;
}

/** Server URL rules: https anywhere, http only on this machine. */
export function checkServerUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AccountError("enter a full https address for the Etude server", 400, "invalid_server");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new AccountError("the Etude server must use https (http only on localhost)", 400, "invalid_server");
  if (u.username || u.password || u.search || u.hash) throw new AccountError("the server address can't carry a user, query or fragment", 400, "invalid_server");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

const clients = new WeakMap<Etude, AccountClient>();
export function accountFor(e: Etude): AccountClient {
  let a = clients.get(e);
  if (!a) {
    a = new AccountClient(e);
    clients.set(e, a);
  }
  return a;
}

type Json = any;

export class AccountClient {
  readonly e: Etude;
  constructor(e: Etude) {
    this.e = e;
  }

  private get file() {
    return join(this.e.home, "account.json");
  }
  private load(): Saved {
    try {
      return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    } catch {
      return {};
    }
  }
  private save(s: Saved) {
    mkdirSync(this.e.home, { recursive: true, mode: 0o700 });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {}
    renameSync(tmp, this.file);
  }

  /** The server this install talks to: saved choice, then $ETUDE_CLOUD_URL, then sync.etude.study. */
  server(): string {
    return this.load().server || process.env?.ETUDE_CLOUD_URL || DEFAULT_CLOUD;
  }
  token(): string | undefined {
    return this.load().token;
  }
  /** The device token when this install is signed in to `server`. Sync uses it so one sign-in covers both. */
  tokenFor(server: string | undefined): string | undefined {
    const s = this.load();
    return s.token && server && server.replace(/\/$/, "") === this.server() ? s.token : undefined;
  }
  email(): string | undefined {
    return this.load().email;
  }

  setServer(raw: string) {
    const server = raw.trim() ? checkServerUrl(raw) : "";
    const s = this.load();
    if (s.token && server !== this.server()) throw new AccountError("sign out before switching servers", 409, "signed_in");
    this.save({ ...s, server: server || undefined });
    return { server: this.server() };
  }

  /** Adopts a token issued elsewhere (the Sync sign-in) so both share one device. */
  adopt(server: string, token: string, account: { id?: string; email?: string }) {
    const s = this.load();
    if (s.token && s.token !== token) return;
    this.save({ ...s, server: checkServerUrl(server), token, email: account.email, accountId: account.id });
  }

  async request(method: string, path: string, opts: { body?: unknown; raw?: Uint8Array; type?: string; auth?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    const auth = opts.auth ?? true;
    const token = this.token();
    if (auth) {
      if (!token) throw new AccountError("sign in to your Etude account first", 401, "signed_out");
      headers.Authorization = `Bearer ${token}`;
    }
    let body: BodyInit | undefined;
    if (opts.raw) {
      headers["Content-Type"] = opts.type ?? "application/octet-stream";
      body = opts.raw as unknown as BodyInit;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await fetch(this.server() + path, { method, headers, body, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new AccountError(`couldn't reach ${this.server()}: ${(err as Error).message}`, 502, "offline");
    }
    if (!res.ok) {
      const data: Json = await res.json().catch(() => null);
      const code = data?.error?.code ?? "error";
      const message = data?.error?.message ?? `the Etude server answered ${res.status}`;
      // A revoked or expired device: forget the token so the app shows "signed out" instead of failing forever.
      if (res.status === 401 && auth && ["unauthorized", "invalid_token", "token_expired", "signed_out"].includes(code)) this.forget();
      throw new AccountError(message, res.status, code);
    }
    return res;
  }
  async json(method: string, path: string, body?: unknown, auth = true): Promise<Json> {
    const res = await this.request(method, path, { body, auth });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  private forget() {
    const s = this.load();
    delete s.token;
    delete s.accountId;
    this.save(s);
  }

  // ── status ────────────────────────────────────────────────────
  /** What the app shows in Settings → Account. Never throws for a server that is down; reports `offline` instead. */
  async status() {
    const server = this.server();
    const saved = this.load();
    let offering: Json = null;
    let offline: string | null = null;
    try {
      offering = await this.json("GET", "/v1/server", undefined, false);
    } catch (e) {
      offline = (e as Error).message;
    }
    const base = { server, offering, offline, signedIn: !!saved.token, email: saved.email ?? null };
    if (!saved.token || offline) return { ...base, me: null, billing: null, vault: null };
    let me: Json;
    try {
      me = await this.json("GET", "/v1/me");
    } catch (e) {
      if (e instanceof AccountError && e.status === 401) return { ...base, signedIn: false, me: null, billing: null, vault: null };
      throw e;
    }
    if (me.email && me.email !== saved.email) this.save({ ...this.load(), email: me.email, accountId: me.id });
    const billing = await this.json("GET", "/v1/billing/sync").catch(() => null);
    const vault = me.sync?.active ? await this.json("GET", "/v1/vault").catch(() => null) : null;
    return { ...base, email: me.email, me, billing, vault };
  }

  // ── signing in and out ────────────────────────────────────────
  async signin(email: string) {
    if (!email?.trim()) throw new AccountError("enter your email address", 400, "invalid_email");
    await this.json("POST", "/v1/auth/email/start", { email: email.trim() }, false);
    return { ok: true, server: this.server(), email: email.trim() };
  }

  /** Redeems the code from the email. Signed in already: it re-confirms this device (needed before deleting the account). */
  async verify(code: string, deviceName?: string) {
    const token = code?.trim();
    if (!token) throw new AccountError("enter the code from the email", 400, "invalid_token");
    const signedIn = !!this.token();
    const r = await this.json("POST", "/v1/auth/email/verify", { token, deviceName: deviceName || defaultDeviceName() }, signedIn);
    if (r.reauth) return { reauth: true, email: r.account.email };
    this.save({ ...this.load(), token: r.token, email: r.account.email, accountId: r.account.id });
    return { reauth: false, email: r.account.email };
  }

  async signout() {
    if (this.token()) await this.json("POST", "/v1/auth/logout", {}).catch(() => {});
    this.forget();
    return { signedIn: false };
  }

  // ── passkeys (the WebAuthn ceremony runs in the browser; these carry its JSON) ──
  passkeys = () => this.json("GET", "/v1/me/passkeys");
  removePasskey = (id: string) => this.json("DELETE", `/v1/me/passkeys/${encodeURIComponent(id)}`);
  passkeyRegisterOptions = () => this.json("POST", "/v1/auth/passkey/register/options", {});
  passkeyRegisterVerify = (body: { challengeId: string; response: unknown; name?: string }) => this.json("POST", "/v1/auth/passkey/register/verify", body);
  passkeyLoginOptions = () => this.json("POST", "/v1/auth/passkey/login/options", {}, false);
  async passkeyLoginVerify(body: { challengeId: string; response: unknown }) {
    const signedIn = !!this.token();
    const r = await this.json("POST", "/v1/auth/passkey/login/verify", { ...body, deviceName: defaultDeviceName() }, signedIn);
    if (!r.reauth && r.token) this.save({ ...this.load(), token: r.token, email: r.account.email, accountId: r.account.id });
    return { reauth: !!r.reauth, email: r.account.email };
  }

  // ── devices ───────────────────────────────────────────────────
  devices = () => this.json("GET", "/v1/devices");
  renameDevice = (id: string, name: string) => this.json("PATCH", `/v1/devices/${encodeURIComponent(id)}`, { name });
  async revokeDevice(id: string) {
    const me = await this.json("GET", "/v1/me");
    const r = await this.json("DELETE", `/v1/devices/${encodeURIComponent(id)}`);
    if (me.device?.id === id) this.forget();
    return r;
  }

  // ── email ─────────────────────────────────────────────────────
  emailStart = (email: string) => this.json("POST", "/v1/me/email/start", { email });
  async emailVerify(code: string) {
    const r = await this.json("POST", "/v1/me/email/verify", { token: code.trim() });
    this.save({ ...this.load(), email: r.email });
    return r;
  }
  emailPending = () => this.json("GET", "/v1/me/email/pending");
  emailCancel = () => this.json("DELETE", "/v1/me/email/pending");

  // ── the account ───────────────────────────────────────────────
  exportData = () => this.json("GET", "/v1/me/export");

  /** Deletes the account on the server. `confirm` must be the account's email, typed by the user. */
  async deleteAccount(confirm: string) {
    const email = this.load().email;
    if (!email || confirm.trim().toLowerCase() !== email.toLowerCase()) throw new AccountError("type the account's email address to confirm", 400, "confirm_mismatch");
    const r = await this.json("DELETE", "/v1/me");
    this.forget();
    this.save({ server: this.load().server });
    return r;
  }

  // ── Sync subscription (Polar, on the website) ─────────────────
  billing = () => this.json("GET", "/v1/billing/sync");
  syncCheckout = (plan: "monthly" | "yearly" = "monthly") => this.json("POST", "/v1/billing/sync/checkout", { plan });
  billingPortal = () => this.json("GET", "/v1/billing/portal");

  // ── paid Market ───────────────────────────────────────────────
  async paidIndex() {
    const idx = await this.json("GET", "/v1/market/paid-index.json", undefined, false);
    const installed = installedEntries(this.e);
    let owned = new Set<string>();
    if (this.token()) owned = new Set(((await this.library().catch(() => ({ library: [] }))).library as Json[]).map((l) => l.listing));
    return { ...idx, entries: (idx.entries as Json[]).map((x) => ({ ...x, owned: owned.has(x.listing), installed: libraryState(installed[paidId(x.id)], x.version) })) };
  }
  checkout = (listing: string) => this.json("POST", "/v1/market/checkout", { listing });

  async library() {
    const r = await this.json("GET", "/v1/library");
    const installed = installedEntries(this.e);
    return { library: (r.library as Json[]).map((l) => ({ ...l, installed: libraryState(installed[paidId(l.slug)], l.version), installedVersion: installed[paidId(l.slug)]?.version ?? null })) };
  }

  /** Downloads a purchased deck and imports it the way a free Market deck is imported. Installing again updates it in place. */
  async install(listing: string, opts: { dryRun?: boolean } = {}) {
    const lib = (await this.library()).library.find((l: Json) => l.listing === listing || l.slug === listing);
    if (!lib) throw new AccountError("that deck isn't in your library", 404, "not_owned");
    const res = await this.request("GET", `/v1/listings/${encodeURIComponent(lib.listing)}/pack`);
    const pack = await res.json();
    const version = res.headers.get("x-etude-version") ?? lib.version ?? "1";
    return installFile(this.e, { etudeMarket: 1, kind: "deck", id: paidId(lib.slug), name: lib.name, author: "Etude Market", description: "", tags: [], version, updated: version, content: pack } as any, opts);
  }

  // ── selling ───────────────────────────────────────────────────
  async creator() {
    try {
      return await this.json("GET", "/v1/creator");
    } catch (e) {
      if (e instanceof AccountError && e.code === "not_creator") return null;
      throw e;
    }
  }
  becomeCreator = (country: string, displayName?: string) => this.json("POST", "/v1/creator", { country, ...(displayName ? { displayName } : {}) });
  onboardingLink = () => this.json("POST", "/v1/creator/onboarding-link", {});
  dashboardLink = () => this.json("POST", "/v1/creator/dashboard-link", {});
  sales = () => this.json("GET", "/v1/creator/sales");
  listings = () => this.json("GET", "/v1/listings");

  /** A listing from a deck in this collection: draft, cover, first version (the deck exported as a pack). */
  async createListing(input: { deck: string; name?: string; description?: string; price: number; tags?: string[]; cover?: { type: string; data: string } }) {
    const pack = this.packOf(input.deck, input.name);
    if (!Number.isInteger(input.price)) throw new AccountError("the price is a whole number of US cents", 400, "invalid");
    const preview = pack.items.slice(0, 5).map((i: Json) => ({ type: i.type, fields: i.fields }));
    const listing = await this.json("POST", "/v1/listings", { name: input.name?.trim() || input.deck, description: input.description ?? "", tags: input.tags ?? [], price: input.price, preview });
    if (input.cover) await this.request("PUT", `/v1/listings/${listing.id}/cover`, { raw: Buffer.from(input.cover.data, "base64"), type: input.cover.type });
    await this.json("POST", `/v1/listings/${listing.id}/versions`, { version: "1.0.0", pack, changelog: "First version" });
    return this.json("GET", `/v1/listings/${listing.id}`);
  }

  /** Uploads the deck again as the next version (minor bump); it waits for review before buyers get it. */
  async newVersion(id: string, input: { deck: string; changelog?: string }) {
    const l = await this.json("GET", `/v1/listings/${encodeURIComponent(id)}`);
    const last = (l.versions as Json[]).map((v) => v.version).sort(semverCmp).at(-1) ?? "0.0.0";
    const [maj, min] = last.split(".").map(Number);
    const version = `${maj}.${min + 1}.0`;
    await this.json("POST", `/v1/listings/${encodeURIComponent(id)}/versions`, { version, pack: this.packOf(input.deck, l.name), changelog: input.changelog ?? "" });
    return this.json("GET", `/v1/listings/${encodeURIComponent(id)}`);
  }
  async setCover(id: string, cover: { type: string; data: string }) {
    return (await this.request("PUT", `/v1/listings/${encodeURIComponent(id)}/cover`, { raw: Buffer.from(cover.data, "base64"), type: cover.type })).json();
  }
  updateListing = (id: string, patch: { price?: number; tags?: string[]; name?: string; description?: string }) => this.json("PATCH", `/v1/listings/${encodeURIComponent(id)}`, patch);
  submit = (id: string) => this.json("POST", `/v1/listings/${encodeURIComponent(id)}/submit`, {});
  hide = (id: string) => this.json("POST", `/v1/listings/${encodeURIComponent(id)}/hide`, {});

  // ── review (admins) ───────────────────────────────────────────
  reviewQueue = () => this.json("GET", "/v1/admin/review");
  approve = (id: string, notes?: string) => this.json("POST", `/v1/admin/listings/${encodeURIComponent(id)}/approve`, notes ? { notes } : {});
  reject = (id: string, notes: string) => this.json("POST", `/v1/admin/listings/${encodeURIComponent(id)}/reject`, { notes });

  private packOf(deck: string, name?: string) {
    if (!deck?.trim()) throw new AccountError("choose a deck", 400, "invalid");
    const pack: Json = this.e.exportPack({ deck: deck.trim(), name: name?.trim() || deck.trim() });
    delete pack.exported;
    if (!pack.items.length) throw new AccountError(`the deck "${deck}" has no items`, 400, "invalid");
    return pack;
  }
}

/** Purchased decks are recorded among installed Market entries under their own id, apart from free entries. */
export const paidId = (slug: string) => `paid-${slug}`.slice(0, 64);

function libraryState(rec: { version: string } | undefined, version: string | null): "installed" | "update" | null {
  if (!rec) return null;
  return version && rec.version !== version ? "update" : "installed";
}

function semverCmp(a: string, b: string) {
  const k = (v: string) => v.split(".").map((n) => n.padStart(8, "0")).join(".");
  return k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0;
}

function defaultDeviceName() {
  const nav = (globalThis as any).navigator;
  if (!process.versions?.node && nav?.userAgent) return /iPhone|iPad/.test(nav.userAgent) ? "Etude on iPhone" : /Android/.test(nav.userAgent) ? "Etude on Android" : "Etude in the browser";
  const os = process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "Windows" : "Linux";
  return `Etude on ${os}`;
}

/** Removes this install's saved account (used by tests and `account forget`). */
export function forgetAccountFile(e: Etude) {
  rmSync(join(e.home, "account.json"), { force: true });
}
