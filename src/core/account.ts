// The Etude account on an etude-cloud server: sign-in, devices, passkeys, email, export, deletion,
// the Sync subscription, and the paid Market (catalog, library, selling, review).
// The device token is kept per install in $ETUDE_HOME/account.json (0600); the collection never holds it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EtudeError, type Etude } from "./engine.ts";
import { DEFAULT_MARKET, installedEntries, installFile, patchInstall, type InstalledEntry } from "./market.ts";

export const DEFAULT_CLOUD = "https://sync.etude.study";

export class AccountError extends EtudeError {
  code: string;
  /** The server's error object, for fields like `ticket` and `attemptsLeft`. */
  data: Record<string, any>;
  constructor(message: string, status = 400, code = "error", data: Record<string, any> = {}) {
    super(message, status);
    this.code = code;
    this.data = data;
  }
}

/** An email sign-in waiting for its second step (two-step sign-in): the server's ticket, short-lived. */
export interface PendingSecondStep {
  ticket: string;
  methods: string[];
  expires: number;
}

interface Saved {
  server?: string;
  token?: string;
  email?: string;
  accountId?: string;
  /** The address of the last emailed sign-in, so a 6-digit code can be redeemed with it. */
  pendingEmail?: string;
  pendingSecond?: PendingSecondStep;
}

/** The ticket from a 401 `second_factor_required`, or null for any other error. */
export function secondStepFrom(e: unknown): PendingSecondStep | null {
  if (!(e instanceof AccountError) || e.code !== "second_factor_required" || typeof e.data.ticket !== "string") return null;
  return { ticket: e.data.ticket, methods: Array.isArray(e.data.methods) ? e.data.methods : [], expires: Date.now() + (Number(e.data.expiresIn) || 600) * 1000 };
}

/** The body for /v1/auth/second-factor: a recovery code when one is given, else the authenticator code. */
export function secondStepBody(ticket: string, input: { code?: string; recoveryCode?: string }) {
  const recovery = input.recoveryCode?.trim();
  if (recovery) return { ticket, recoveryCode: recovery };
  const code = (input.code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) throw new AccountError("enter the 6-digit code from your authenticator app, or a recovery code", 400, "invalid_code");
  return { ticket, code };
}

/** The sign-in email's 6-digit code (spaces allowed, as in `482 913`), or null for anything else (a link token). */
export function signInCode(input: string): string | null {
  const digits = (input ?? "").replace(/\s+/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
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
    // A sign-in, a sign-out or a new server: an answer already on its way describes the account before it.
    this.statusing = null;
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

  /** `auth: "optional"` sends the token when signed in (public routes that add `myVote` or hide blocked authors). */
  async request(method: string, path: string, opts: { body?: unknown; raw?: Uint8Array; type?: string; auth?: boolean | "optional" } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    const auth = opts.auth ?? true;
    const token = this.token();
    if (auth === true) {
      if (!token) throw new AccountError("sign in to your Etude account first", 401, "signed_out");
      headers.Authorization = `Bearer ${token}`;
    } else if (auth === "optional" && token) headers.Authorization = `Bearer ${token}`;
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
      // A creator from before direct charges asks for a Stripe link: the server's message names its API route.
      // Selling needs two-step sign-in: the server's message points to its own web page; the app has the setting itself.
      const message =
        code === "creator_setup_required" ? "Etude now sells through your own Stripe account. Set up selling again in Market → Sell."
        : code === "two_factor_required" ? "Selling on the Etude Market needs two-step sign-in. Turn it on with an authenticator app, or add a passkey, in Settings → Account, then try again."
        : (data?.error?.message ?? `the Etude server answered ${res.status}`);
      // A revoked or expired device: forget the token so the app shows "signed out" instead of failing forever.
      if (res.status === 401 && auth === true && ["unauthorized", "invalid_token", "token_expired", "signed_out"].includes(code)) this.forget();
      throw new AccountError(message, res.status, code, data?.error ?? {});
    }
    return res;
  }
  async json(method: string, path: string, body?: unknown, auth: boolean | "optional" = true): Promise<Json> {
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
  /** Several screens ask at once (Settings has four): they share one answer while it's on its way. */
  status() {
    if (!this.statusing) {
      const p = this.readStatus().finally(() => {
        if (this.statusing === p) this.statusing = null;
      });
      this.statusing = p;
    }
    return this.statusing;
  }
  private statusing: ReturnType<AccountClient["readStatus"]> | null = null;
  /** Two round trips: the server's offering with the account, then billing with the vault. */
  private async readStatus() {
    const server = this.server();
    const saved = this.load();
    const settle = <T>(p: Promise<T>) => p.then((value) => ({ value }), (error: unknown) => ({ error }));
    const [offered, mine] = await Promise.all([settle(this.json("GET", "/v1/server", undefined, false)), saved.token ? settle(this.json("GET", "/v1/me")) : null]);
    const offering: Json = "value" in offered ? offered.value : null;
    const offline = "error" in offered ? (offered.error as Error).message : null;
    const base = { server, offering, offline, signedIn: !!saved.token, email: saved.email ?? null };
    if (!saved.token || offline || !mine) return { ...base, me: null, billing: null, vault: null };
    if ("error" in mine) {
      if (mine.error instanceof AccountError && mine.error.status === 401) return { ...base, signedIn: false, me: null, billing: null, vault: null };
      throw mine.error;
    }
    const me: Json = mine.value;
    if (me.email && me.email !== saved.email) this.save({ ...this.load(), email: me.email, accountId: me.id });
    const [billing, vault] = await Promise.all([this.json("GET", "/v1/billing/sync").catch(() => null), me.sync?.active ? this.json("GET", "/v1/vault").catch(() => null) : null]);
    return { ...base, email: me.email, me, billing, vault };
  }

  // ── signing in and out ────────────────────────────────────────
  async signin(email: string) {
    if (!email?.trim()) throw new AccountError("enter your email address", 400, "invalid_email");
    await this.json("POST", "/v1/auth/email/start", { email: email.trim() }, false);
    this.save({ ...this.load(), pendingEmail: email.trim() });
    return { ok: true, server: this.server(), email: email.trim() };
  }

  /**
   * Redeems the 6-digit code from the email (with the address of the pending sign-in, or `email`), or the long
   * token from the link. Signed in already: it re-confirms this device (needed before deleting the account).
   */
  async verify(input: string, deviceName?: string, email?: string): Promise<{ reauth: boolean; email: string | null; secondStep?: { methods: string[] } }> {
    const raw = input?.trim();
    if (!raw) throw new AccountError("enter the code from the email", 400, "invalid_code");
    const code = signInCode(raw);
    const saved = this.load();
    const address = (email?.trim() || saved.pendingEmail || saved.email || "").trim();
    if (code && !address) throw new AccountError("ask for a code first: the code goes with the email address it was sent to", 400, "invalid_email");
    const signedIn = !!this.token();
    const body = code ? { email: address, code } : { token: raw };
    let r: Json;
    try {
      r = await this.json("POST", "/v1/auth/email/verify", { ...body, deviceName: deviceName || defaultDeviceName() }, signedIn);
    } catch (e) {
      const second = secondStepFrom(e);
      if (!second) throw e;
      this.save({ ...this.load(), pendingSecond: second });
      return { reauth: false, email: address || null, secondStep: { methods: second.methods } };
    }
    return this.signedIn(r);
  }

  /**
   * The second step of an email sign-in with two-step sign-in on: a code from the authenticator app, or a recovery
   * code. `verify` answers `secondStep` when it's needed.
   */
  async secondStep(input: { code?: string; recoveryCode?: string }) {
    const pending = this.load().pendingSecond;
    if (!pending || pending.expires < Date.now()) throw new AccountError("sign in by email again: the sign-in waiting for its second step expired", 401, "ticket_expired");
    const r = await this.json("POST", "/v1/auth/second-factor", secondStepBody(pending.ticket, input), !!this.token()).catch((e) => {
      // A ticket that's used up or expired is no use any more.
      if (e instanceof AccountError && (e.code === "ticket_expired" || e.code === "too_many_attempts")) {
        const { pendingSecond: _, ...rest } = this.load();
        this.save(rest);
      }
      throw e;
    });
    return this.signedIn(r);
  }

  private signedIn(r: Json) {
    const { pendingEmail: _, pendingSecond: __, ...rest } = this.load();
    if (r.reauth) {
      this.save(rest);
      return { reauth: true, email: r.account.email };
    }
    this.save({ ...rest, token: r.token, email: r.account.email, accountId: r.account.id });
    return { reauth: false, email: r.account.email };
  }

  // ── two-step sign-in (an authenticator app and recovery codes on top of the email code) ──
  twoFactor = () => this.json("GET", "/v1/me/two-factor");
  /** A new authenticator secret, its otpauth:// link and a QR code (SVG). The one in use keeps working until this is confirmed. */
  authenticatorStart = () => this.json("POST", "/v1/me/authenticator", {});
  authenticatorConfirm = (code: string) => this.json("POST", "/v1/me/authenticator/confirm", { code: (code ?? "").replace(/\s+/g, "") });
  removeAuthenticator = () => this.json("DELETE", "/v1/me/authenticator");
  /** On returns 10 recovery codes, shown once; off removes the authenticator and the codes. */
  setTwoFactor = (enabled: boolean) => this.json("PUT", "/v1/me/two-factor", { enabled });
  newRecoveryCodes = () => this.json("POST", "/v1/me/recovery-codes", {});

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

  /** The name shown beside your Market comments (and nowhere else public). Empty clears it. */
  setDisplayName = (name: string) => this.json("PATCH", "/v1/me", { displayName: String(name ?? "").trim().slice(0, 80) });

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

  // ── Sync subscription (App Store, in the iOS app) ─────────────
  appleInfo = () => this.json("GET", "/v1/billing/apple");
  appleTransaction = (jws: string) => this.json("POST", "/v1/billing/apple/transaction", { jws });
  // ── Sync subscription (Google Play, in the Android app) ───────
  googleInfo = () => this.json("GET", "/v1/billing/google");
  googlePurchase = (purchaseToken: string) => this.json("POST", "/v1/billing/google/purchase", { purchaseToken, packageName: "study.etude.app" });

  // ── paid Market ───────────────────────────────────────────────
  async paidIndex() {
    const idx = await this.json("GET", "/v1/market/paid-index.json", undefined, false);
    const installed = installedEntries(this.e);
    let owned = new Set<string>();
    let needs = new Set<string>();
    if (this.token()) {
      const lib = (await this.library().catch(() => ({ library: [] }))).library as Json[];
      owned = new Set(lib.map((l) => l.listing));
      needs = new Set(lib.filter((l) => l.needsDeliveryConfirmation).map((l) => l.listing));
    }
    return { ...idx, entries: (idx.entries as Json[]).map((x) => ({ ...x, owned: owned.has(x.listing), needsDeliveryConfirmation: needs.has(x.listing), installed: libraryState(installed[paidId(x.id)], x.version) })) };
  }
  checkout = (listing: string) => this.json("POST", "/v1/market/checkout", { listing });

  async library() {
    const r = await this.json("GET", "/v1/library");
    const changes = this.reconcile(r);
    const installed = installedEntries(this.e);
    return {
      library: (r.library as Json[]).map((l) => ({ ...l, installed: libraryState(installed[paidId(l.slug)], l.version), installedVersion: installed[paidId(l.slug)]?.version ?? null })),
      revoked: ((r.revoked ?? []) as Json[]).map((l) => ({ ...l, locked: !!installed[paidId(l.slug)]?.locked })),
      changes,
    };
  }

  /**
   * Locks bought decks the server says were refunded or disputed: their cards are suspended (history kept) and the
   * install record remembers which, so buying the deck again restores exactly those. Only the server's own word counts:
   * being offline, signed out or on another account changes nothing here.
   */
  reconcile(lib: { library?: Json[]; revoked?: Json[] }) {
    const installed = installedEntries(this.e);
    const out = { locked: [] as string[], unlocked: [] as string[] };
    const ids = (rec: InstalledEntry) => {
      if (rec.items) return rec.items;
      const names = rec.ids ?? [];
      return names.flatMap((n) => this.e.db.all("SELECT i.id FROM items i JOIN decks d ON d.id = i.deck_id WHERE d.name = ? OR d.name LIKE ?", n, `${n}::%`).map((r) => r.id as string));
    };
    const cardsOf = (items: string[], suspended: 0 | 1) => {
      const out: number[] = [];
      for (let i = 0; i < items.length; i += 400) {
        const part = items.slice(i, i + 400);
        out.push(...this.e.db.all(`SELECT id FROM cards WHERE suspended = ? AND item_id IN (${part.map(() => "?").join(",")})`, suspended, ...part).map((r) => r.id as number));
      }
      return out;
    };
    for (const r of lib.revoked ?? []) {
      const id = paidId(r.slug);
      const rec = installed[id];
      if (!rec || rec.locked) continue;
      const cards = cardsOf(ids(rec), 0);
      if (cards.length) this.e.setSuspended(cards, true);
      patchInstall(this.e, id, { locked: { at: new Date().toISOString(), reason: String(r.reason ?? "revoked"), cards } });
      out.locked.push(rec.name);
    }
    for (const l of lib.library ?? []) {
      const id = paidId(l.slug);
      const rec = installed[id];
      if (!rec?.locked) continue;
      const mine = new Set(rec.locked.cards);
      const back = cardsOf(ids(rec), 1).filter((c) => mine.has(c));
      if (back.length) this.e.setSuspended(back, false);
      patchInstall(this.e, id, { locked: undefined });
      out.unlocked.push(rec.name);
    }
    return out;
  }

  private reconciledAt = 0;
  /** reconcile() against the server at most every 30 minutes (the app calls this after automatic syncs). */
  async reconcilePurchases(o: { force?: boolean } = {}) {
    if (!this.token()) return null;
    if (!o.force && Date.now() - this.reconciledAt < 30 * 60_000) return null;
    this.reconciledAt = Date.now();
    return this.reconcile(await this.json("GET", "/v1/library"));
  }

  /**
   * Downloads a purchased deck and imports it the way a free Market deck is imported. Installing again updates it in
   * place. The first download of a deck sold by Etude needs `immediateAccess` (the buyer asked for delivery now and
   * acknowledged losing the right to cancel where the law allows that); the server records it before handing it out.
   */
  async install(listing: string, opts: { dryRun?: boolean; immediateAccess?: boolean } = {}) {
    const lib = (await this.library()).library.find((l: Json) => l.listing === listing || l.slug === listing);
    if (!lib) throw new AccountError("that deck isn't in your library", 404, "not_owned");
    if (lib.needsDeliveryConfirmation) {
      if (!opts.immediateAccess || opts.dryRun) throw new AccountError("confirm that you want the deck delivered now: once it's delivered, you can no longer cancel the purchase where the law allows that (--immediate-access)", 409, "delivery_confirmation_required");
      await this.json("POST", `/v1/listings/${encodeURIComponent(lib.listing)}/delivery`, { immediateAccess: true });
    }
    const res = await this.request("GET", `/v1/listings/${encodeURIComponent(lib.listing)}/pack`);
    const pack = await res.json();
    const version = res.headers.get("x-etude-version") ?? lib.version ?? "1";
    const out = installFile(this.e, { etudeMarket: 1, kind: "deck", id: paidId(lib.slug), name: lib.name, author: "Etude Market", description: "", tags: [], version, updated: version, content: pack } as any, opts);
    // Which items and card types are paid: exports leave them out and a refund locks exactly these.
    if (!opts.dryRun) patchInstall(this.e, paidId(lib.slug), { listing: lib.listing, items: (pack.items ?? []).map((i: Json) => String(i.id)), types: (pack.types ?? []).map((t: Json) => String(t.id)) });
    // The server is up (it just sent the pack), so waiting for the ping costs nothing; it never fails the install.
    if (!opts.dryRun && out.result !== "unchanged" && /^lst_/.test(lib.listing)) await this.marketDownload(`paid/${lib.listing}`);
    return out;
  }

  // ── Market likes, downloads and comments (free and paid entries) ──
  /** Counts for every entry anyone voted on, commented on or downloaded: `{ entries: { [key]: MarketCounts } }`. */
  marketStats = () => this.json("GET", "/v1/market/stats", undefined, false);
  /** One entry's counts, plus `myVote` when signed in. */
  entryStats = async (key: string) => this.json("GET", `/v1/market/entry-stats?key=${encodeURIComponent(marketKey(key))}`, undefined, "optional");
  vote = async (key: string, value: 1 | -1 | 0) => this.json("PUT", "/v1/market/votes", { key: marketKey(key), value });
  /** Newest first, 20 a page; pass the previous page's `next` as `before`. Signed in, authors you blocked are left out. */
  comments = async (key: string, before?: string) => this.json("GET", `/v1/market/comments?key=${encodeURIComponent(marketKey(key))}${before ? `&before=${encodeURIComponent(before)}` : ""}`, undefined, "optional");
  postComment = async (key: string, body: string) => this.json("POST", "/v1/market/comments", { key: marketKey(key), body });
  editComment = (id: string, body: string) => this.json("PATCH", `/v1/market/comments/${encodeURIComponent(id)}`, { body });
  deleteComment = (id: string) => this.json("DELETE", `/v1/market/comments/${encodeURIComponent(id)}`);
  reportComment = (id: string, reason?: string) => this.json("POST", `/v1/market/comments/${encodeURIComponent(id)}/report`, reason ? { reason } : {});
  blocks = () => this.json("GET", "/v1/market/blocks");
  block = (authorId: string) => this.json("POST", `/v1/market/blocks/${encodeURIComponent(authorId)}`, {});
  unblock = (authorId: string) => this.json("DELETE", `/v1/market/blocks/${encodeURIComponent(authorId)}`);

  /**
   * The anonymous "installed" ping: only the entry key goes to the server, no token, no device id. It never throws
   * and gives up after `timeoutMs`; the answer is `{ counted }`, or null when the server couldn't be reached.
   */
  async marketDownload(key: string, timeoutMs = 4000): Promise<{ counted: boolean } | null> {
    try {
      const res = await fetch(this.server() + "/v1/market/downloads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: marketKey(key) }), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      return (await res.json()) as { counted: boolean };
    } catch {
      return null;
    }
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
  /**
   * Edits the Market page. A listing that has never been on sale changes in place; once it has been live, the change
   * waits as the listing's `revision` until the Etude team approves it, and buyers keep seeing the approved page.
   */
  updateListing = (id: string, patch: { price?: number; tags?: string[]; name?: string; description?: string }) => this.json("PATCH", `/v1/listings/${encodeURIComponent(id)}`, patch);
  /** Withdraws the page change waiting for review. */
  withdrawChanges = (id: string) => this.json("DELETE", `/v1/listings/${encodeURIComponent(id)}/revision`);
  /** A cover by hash, with this account's token (a cover waiting for review is only served to its creator and admins). */
  async cover(hash: string) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new AccountError("no such cover", 404, "not_found");
    const res = await this.request("GET", `/v1/market/covers/${hash}`);
    return { type: res.headers.get("content-type") ?? "application/octet-stream", body: new Uint8Array(await res.arrayBuffer()) };
  }
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

/** How etude-cloud names a Market entry for likes, downloads and comments: `deck|theme|type/<id>` or `paid/<listing id>`. */
export const MARKET_KEY = /^(?:(?:deck|theme|type)\/[a-z0-9][a-z0-9-]{1,63}|paid\/lst_[A-Za-z0-9_-]{22})$/;
export function marketKey(key: string): string {
  const k = String(key ?? "").trim();
  if (!MARKET_KEY.test(k)) throw new AccountError(`"${k}" isn't a Market entry: use deck/<id>, theme/<id>, type/<id> or paid/<listing id>`, 400, "invalid");
  return k;
}

/**
 * After a free entry was installed or updated from the official catalog, counts it as a download. Fire and forget:
 * the promise never rejects, and a custom catalog (market.url) sends nothing, since its ids aren't the official ones.
 */
export function pingFreeInstall(e: Etude, out: { entry: { kind: string; id: string }; result: string; dryRun: boolean }, marketUrl: string): Promise<unknown> {
  if (out.dryRun || out.result === "unchanged" || marketUrl.replace(/\/+$/, "") !== DEFAULT_MARKET.url) return Promise.resolve(null);
  const key = `${out.entry.kind}/${out.entry.id}`;
  if (!MARKET_KEY.test(key)) return Promise.resolve(null);
  return accountFor(e).marketDownload(key);
}

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
