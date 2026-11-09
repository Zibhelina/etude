// Client for /api/account/*: the Etude account, Sync plan, purchased decks and selling.
import { etudeFetch } from "./transport";
import { storeSafeMessage } from "./platform";

export class AccountApiError extends Error {
  status: number;
  /** The Sync server's error code when there is one (sync_required, apple_other_account…). */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await etudeFetch(path, {
    method,
    headers: body !== undefined || method !== "GET" ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : method !== "GET" ? "{}" : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = typeof data?.error === "string" ? data.error : data?.error?.message ?? res.statusText ?? "The request failed.";
    const code = data?.code ?? data?.error?.code;
    throw new AccountApiError(storeSafeMessage(message, code), res.status, typeof code === "string" ? code : undefined);
  }
  return data as T;
}

export interface Offering {
  billing: boolean;
  market: boolean;
  quotaBytes: number;
  passkeys: { rpId: string };
  /** App Store product ids for Sync, when the server takes App Store purchases. */
  appleProducts?: string[];
  /** Google Play subscription and base plans for Sync, when the server takes Google Play purchases. */
  googleProducts?: { productIds: string[]; basePlans: string[] };
  marketRules?: { minPrice: number; feeBps: number; currency: string; buyerCountries: string[]; immediateAccess?: { version: string; text: string } };
}

/**
 * The box a buyer ticks before the first download of a deck sold by Etude. In the EU and the UK it's what ends the
 * 14-day right to cancel once the deck is delivered. The server sends its own copy (marketRules.immediateAccess); this one is the fallback and
 * matches its version 2026-11-09.
 */
export const IMMEDIATE_ACCESS_TEXT = "I want the deck delivered right away. I understand that once it's delivered, I can no longer cancel this purchase where the law allows that (as in the EU and the UK).";
export interface Me {
  id: string;
  email: string;
  displayName: string;
  created: string;
  device?: Device;
  sync: { active: boolean; reason: string };
  creator: { country: string; chargesEnabled: boolean; payoutsEnabled: boolean } | null;
  admin: boolean;
}
export interface Billing { active: boolean; reason: string; source?: "polar" | "apple" | "google" | "manual" | null; status: string | null; expires: string | null; graceUntil: string | null; billing: boolean }
export interface Vault { quotaBytes: number; usedBytes: number; events: number; blobs: number; hasKeys: boolean }
export interface AccountStatus { server: string; offering: Offering | null; offline: string | null; signedIn: boolean; email: string | null; me: Me | null; billing: Billing | null; vault: Vault | null }
export interface Device { id: string; name: string; via: string; created: string; lastSeen: string; current: boolean }
export interface Passkey { id: string; name: string; credentialId: string; deviceType: string; backedUp: boolean; created: string; lastUsed: string | null }
export interface PaidEntry {
  id: string;
  kind: "deck";
  name: string;
  description: string;
  author: string;
  tags: string[];
  version: string;
  updated: string;
  bytes: number;
  cover?: string;
  summary: any;
  price: number;
  currency: string;
  listing: string;
  preview: any[];
  /** "etude" for decks Etude sells itself through Polar (every country); absent for creators' decks on Stripe. */
  soldBy?: "etude";
  /** null = every country (decks sold by Etude); creators' decks follow the server's marketRules. */
  buyerCountries?: string[] | null;
  owned: boolean;
  /** Owned, sold by Etude and not downloaded yet: the first install asks for the immediate-delivery confirmation. */
  needsDeliveryConfirmation?: boolean;
  installed: "installed" | "update" | null;
}
/** A deck no longer on the account (refunded or disputed). `locked`: its cards here are suspended until it's bought again. */
export interface RevokedItem { listing: string; slug: string; name: string; cover: string | null; reason: "refunded" | "disputed" | "revoked"; at: string | null; locked: boolean }
export interface LibraryItem { listing: string; slug: string; name: string; cover: string | null; version: string | null; bytes: number | null; changelog: string; ownedSince: string; installed: "installed" | "update" | null; installedVersion: string | null; /** A deck sold by Etude not downloaded yet: confirm immediate delivery before the first install. */ needsDeliveryConfirmation?: boolean }
export interface Listing {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  cover: string | null;
  price: number;
  currency: string;
  status: "draft" | "review" | "live" | "rejected" | "hidden";
  version: string | null;
  updated: string;
  reviewNotes?: string | null;
  /** When it first went on sale; from then on, page edits wait for review as `revision`. */
  liveAt?: string | null;
  versions?: { version: string; status: string; bytes: number; changelog: string; created: string; reviewNotes?: string; reviewed?: string | null }[];
  pending?: string[];
  /** Page changes waiting for review (`pending`), or the last ones turned down (`rejected`, with the reviewer's notes). */
  revision?: ListingRevision | null;
  creator?: string;
}
export interface ListingRevision {
  id: string;
  status: "pending" | "rejected";
  name: string;
  description: string;
  tags: string[];
  price: number;
  cover: string | null;
  changed: ("name" | "description" | "tags" | "preview" | "price" | "cover")[];
  reviewNotes: string;
  updated: string;
  reviewed: string | null;
}
/** `setupRequired`: the creator set up selling before Etude moved to direct charges and has to set up again (their
 *  old Stripe account can't take sales; `stripeAccount` is then null and the three flags false). */
export interface Creator { country: string; displayName: string; stripeAccount: string | null; chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean; setupRequired?: boolean }
export interface Sales { sales: { order: string; listing: string; amount: number; fee: number; earnings: number; currency: string; country: string; status: string; at: string }[]; totals: { count: number; gross: number; earnings: number } }

type SignedIn = { reauth: boolean; email: string };
export type SecondStepInput = { code?: string; recoveryCode?: string };
/** Two-step sign-in on the account: an authenticator app, and one-time recovery codes. */
export interface TwoFactor { enabled: boolean; since: string | null; authenticator: boolean; authenticatorAdded: string | null; recoveryCodesLeft: number; passkeys: number }

export const account = {
  status: () => call<AccountStatus>("GET", "/api/account"),
  /** The name shown beside your Market comments. */
  setName: (displayName: string) => call<Me>("PATCH", "/api/account/me", { displayName }),
  setServer: (server: string) => call<{ server: string }>("PUT", "/api/account/server", { server }),
  signin: (email: string) => call<{ ok: boolean; email: string }>("POST", "/api/account/signin", { email }),
  /** `email` is the address the code was sent to (the server falls back to the last sign-in it started). */
  verify: (code: string, email?: string) => call<SignedIn & { secondStep?: { methods: string[] } }>("POST", "/api/account/verify", { code, email }),
  /** The second step of an email sign-in with two-step sign-in on: the authenticator code, or a recovery code. */
  secondStep: (input: SecondStepInput) => call<SignedIn>("POST", "/api/account/second-factor", input),
  twoFactor: () => call<TwoFactor>("GET", "/api/account/two-factor"),
  authenticatorStart: () => call<{ secret: string; uri: string; qrSvg: string; expiresIn: number }>("POST", "/api/account/authenticator"),
  authenticatorConfirm: (code: string) => call<TwoFactor>("POST", "/api/account/authenticator/confirm", { code }),
  /** On returns 10 recovery codes, shown once; off removes the authenticator and the codes. */
  setTwoFactor: (enabled: boolean) => call<TwoFactor & { recoveryCodes: string[] | null }>("PUT", "/api/account/two-factor", { enabled }),
  newRecoveryCodes: () => call<TwoFactor & { recoveryCodes: string[] }>("POST", "/api/account/recovery-codes"),
  signout: () => call<{ signedIn: false }>("POST", "/api/account/signout"),
  devices: () => call<{ devices: Device[] }>("GET", "/api/account/devices"),
  renameDevice: (id: string, name: string) => call<Device>("PATCH", `/api/account/devices/${encodeURIComponent(id)}`, { name }),
  revokeDevice: (id: string) => call<{ ok: boolean }>("DELETE", `/api/account/devices/${encodeURIComponent(id)}`),
  passkeys: () => call<{ passkeys: Passkey[] }>("GET", "/api/account/passkeys"),
  removePasskey: (id: string) => call<{ ok: boolean }>("DELETE", `/api/account/passkeys/${encodeURIComponent(id)}`),
  passkeyRegisterOptions: () => call<{ challengeId: string; options: any }>("POST", "/api/account/passkeys/register/options"),
  passkeyRegisterVerify: (b: { challengeId: string; response: unknown; name?: string }) => call<{ id: string }>("POST", "/api/account/passkeys/register/verify", b),
  passkeyLoginOptions: () => call<{ challengeId: string; options: any }>("POST", "/api/account/passkeys/login/options"),
  passkeyLoginVerify: (b: { challengeId: string; response: unknown }) => call<{ reauth: boolean; email: string }>("POST", "/api/account/passkeys/login/verify", b),
  emailPending: () => call<{ pending: { email: string; created: string; expires: string } | null }>("GET", "/api/account/email"),
  emailStart: (email: string) => call<{ ok: boolean }>("POST", "/api/account/email/start", { email }),
  emailVerify: (code: string) => call<{ ok: boolean; email: string }>("POST", "/api/account/email/verify", { code }),
  emailCancel: () => call<{ ok: boolean }>("DELETE", "/api/account/email"),
  exportData: () => call<unknown>("GET", "/api/account/export"),
  deleteAccount: (confirm: string) => call<{ ok: boolean }>("POST", "/api/account/delete", { confirm }),
  checkout: (plan: "monthly" | "yearly" = "monthly") => call<{ url: string }>("POST", "/api/account/billing/checkout", { plan }),
  portal: () => call<{ url: string }>("POST", "/api/account/billing/portal"),
  /** iOS app: the App Store products and the appAccountToken to buy them with. */
  appleInfo: () => call<{ productIds: string[]; appAccountToken: string; decks?: { listing: string; slug: string; name: string; productId: string }[] }>("GET", "/api/account/billing/apple"),
  /** iOS app: hands a signed App Store transaction (JWS) to the Sync server. */
  appleTransaction: (jws: string) => call<import("./storekit").AppleResult>("POST", "/api/account/billing/apple/transaction", { jws }),
  /** Android app: the Play subscription, base plans and the obfuscatedAccountId to buy with. */
  googleInfo: () => call<{ productIds: string[]; basePlans: string[]; obfuscatedAccountId: string }>("GET", "/api/account/billing/google"),
  /** Android app: hands a Play purchase token to the Sync server, which checks it with Google. */
  googlePurchase: (purchaseToken: string) => call<import("./storekit").GoogleResult>("POST", "/api/account/billing/google/purchase", { purchaseToken }),
  market: () => call<{ entries: PaidEntry[]; server: string }>("GET", "/api/account/market"),
  buy: (listing: string) => call<{ url: string; price: number; fee: number }>("POST", "/api/account/market/checkout", { listing }),
  library: () => call<{ library: LibraryItem[]; revoked?: RevokedItem[]; changes?: { locked: string[]; unlocked: string[] } }>("GET", "/api/account/library"),
  install: (listing: string, immediateAccess = false) => call<{ result: string; ids: string[]; report: any }>("POST", "/api/account/library/install", { listing, ...(immediateAccess ? { immediateAccess: true } : {}) }),
  creator: () => call<{ creator: Creator | null }>("GET", "/api/account/creator"),
  becomeCreator: (country: string, displayName?: string) => call<Creator>("POST", "/api/account/creator", { country, displayName }),
  onboarding: () => call<{ url: string }>("POST", "/api/account/creator/onboarding"),
  dashboard: () => call<{ url: string }>("POST", "/api/account/creator/dashboard"),
  sales: () => call<Sales>("GET", "/api/account/creator/sales"),
  listings: () => call<{ listings: Listing[] }>("GET", "/api/account/listings"),
  createListing: (b: { deck: string; name?: string; description?: string; price: number; tags?: string[]; cover?: { type: string; data: string } }) => call<Listing>("POST", "/api/account/listings", b),
  updateListing: (id: string, b: { price?: number; tags?: string[]; name?: string; description?: string }) => call<Listing>("PATCH", `/api/account/listings/${encodeURIComponent(id)}`, b),
  setCover: (id: string, cover: { type: string; data: string }) => call<{ cover: string; status: string; revision: string | null }>("PUT", `/api/account/listings/${encodeURIComponent(id)}/cover`, cover),
  withdrawChanges: (id: string) => call<Listing>("DELETE", `/api/account/listings/${encodeURIComponent(id)}/revision`),
  newVersion: (id: string, b: { deck: string; changelog?: string }) => call<Listing>("POST", `/api/account/listings/${encodeURIComponent(id)}/versions`, b),
  submit: (id: string) => call<Listing>("POST", `/api/account/listings/${encodeURIComponent(id)}/submit`),
  hide: (id: string) => call<Listing>("POST", `/api/account/listings/${encodeURIComponent(id)}/hide`),
  review: () => call<{ queue: Listing[] }>("GET", "/api/account/review"),
  approve: (id: string, notes?: string) => call<Listing>("POST", `/api/account/review/${encodeURIComponent(id)}/approve`, { notes }),
  reject: (id: string, notes: string) => call<Listing>("POST", `/api/account/review/${encodeURIComponent(id)}/reject`, { notes }),
};

// ── Market likes, dislikes, downloads and comments (free and paid entries) ──
/** An entry as etude-cloud names it: `deck/<id>`, `theme/<id>`, `type/<id>` for the free catalog, `paid/<listing id>` for a paid deck. */
export type MarketKey = string;
export const freeKey = (kind: "deck" | "theme" | "type", id: string): MarketKey => `${kind}/${id}`;
export const paidKey = (listing: string): MarketKey => `paid/${listing}`;

export interface MarketCounts { likes: number; dislikes: number; downloads: number; comments: number }
/** Every entry that has counts (entries nobody touched aren't listed: treat them as all zero). */
export interface MarketStats { entries: Record<MarketKey, MarketCounts> }
/** One entry; `myVote` (1 like, -1 dislike, 0 none) only when signed in. */
export interface EntryStats extends MarketCounts { key: MarketKey; myVote?: 1 | -1 | 0 }
export interface MarketComment {
  id: string;
  key: MarketKey;
  body: string;
  /** `id` is a public author id (au_…) for blocking; `name` is the display name, or "Etude learner". */
  author: { id: string; name: string };
  mine: boolean;
  created: string;
  edited: string | null;
}
export interface MarketCommentPage { key: MarketKey; comments: MarketComment[]; next: string | null }
export interface MarketBlock { authorId: string; name: string; created: string }

export const marketSocial = {
  stats: () => call<MarketStats>("GET", "/api/account/market/stats"),
  entry: (key: MarketKey) => call<EntryStats>("GET", `/api/account/market/entry-stats?key=${encodeURIComponent(key)}`),
  /** Needs sign-in (401 `signed_out` otherwise). 0 takes the vote back. */
  vote: (key: MarketKey, value: 1 | -1 | 0) => call<EntryStats & { myVote: 1 | -1 | 0 }>("PUT", "/api/account/market/votes", { key, value }),
  /** Newest first, 20 a page; `before` is the previous page's `next`. */
  comments: (key: MarketKey, before?: string) => call<MarketCommentPage>("GET", `/api/account/market/comments?key=${encodeURIComponent(key)}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  /** Needs sign-in; `403 comment_banned` for an account the team stopped commenting. Body: 1–2000 characters. */
  comment: (key: MarketKey, body: string) => call<{ comment: MarketComment }>("POST", "/api/account/market/comments", { key, body }),
  editComment: (id: string, body: string) => call<{ comment: MarketComment }>("PATCH", `/api/account/market/comments/${encodeURIComponent(id)}`, { body }),
  deleteComment: (id: string) => call<{ ok: boolean; deleted: string }>("DELETE", `/api/account/market/comments/${encodeURIComponent(id)}`),
  /** One report per account; `hidden` is true when this report was the third and the comment is now hidden. */
  report: (id: string, reason?: string) => call<{ ok: boolean; counted: boolean; hidden: boolean }>("POST", `/api/account/market/comments/${encodeURIComponent(id)}/report`, reason ? { reason } : {}),
  blocks: () => call<{ blocks: MarketBlock[] }>("GET", "/api/account/market/blocks"),
  block: (authorId: string) => call<{ ok: boolean; blocked: string }>("POST", `/api/account/market/blocks/${encodeURIComponent(authorId)}`),
  unblock: (authorId: string) => call<{ ok: boolean; unblocked: string }>("DELETE", `/api/account/market/blocks/${encodeURIComponent(authorId)}`),
};

export const money = (cents: number, currency = "usd") => new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
export const bytes = (b: number) => (b < 1024 ** 2 ? `${Math.max(0, Math.round(b / 1024))} KB` : b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`);

/** Opens a page outside Etude (checkout, billing, Stripe onboarding) in the browser. */
export function openOutside(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

// ── WebAuthn: the options JSON from the server ↔ the browser's binary API ──
const b64uToBuf = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
};
const bufToB64u = (buf: ArrayBuffer | null | undefined) => {
  if (!buf) return undefined;
  let s = "";
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** WebAuthn only works when this page's host is the server's passkey RP id or under it. */
export function passkeysHere(rpId: string | undefined): boolean {
  if (!rpId || typeof PublicKeyCredential === "undefined" || !window.isSecureContext) return false;
  const h = location.hostname;
  return h === rpId || h.endsWith("." + rpId);
}

export async function createPasskey(options: any) {
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...options,
    challenge: b64uToBuf(options.challenge),
    user: { ...options.user, id: b64uToBuf(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((c: any) => ({ ...c, id: b64uToBuf(c.id) })),
  };
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created.");
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    clientExtensionResults: {},
    response: { clientDataJSON: bufToB64u(r.clientDataJSON), attestationObject: bufToB64u(r.attestationObject), transports: r.getTransports?.() ?? [] },
  };
}

export async function getPasskey(options: any) {
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...options,
    challenge: b64uToBuf(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((c: any) => ({ ...c, id: b64uToBuf(c.id) })),
  };
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was chosen.");
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    clientExtensionResults: {},
    response: { clientDataJSON: bufToB64u(r.clientDataJSON), authenticatorData: bufToB64u(r.authenticatorData), signature: bufToB64u(r.signature), userHandle: bufToB64u(r.userHandle) },
  };
}
