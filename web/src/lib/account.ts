// Client for /api/account/*: the Etude account, Sync plan, purchased decks and selling.
import { etudeFetch } from "./transport";

export class AccountApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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
  if (!res.ok) throw new AccountApiError(typeof data?.error === "string" ? data.error : data?.error?.message ?? res.statusText ?? "The request failed.", res.status);
  return data as T;
}

export interface Offering {
  billing: boolean;
  market: boolean;
  quotaBytes: number;
  passkeys: { rpId: string };
  marketRules?: { minPrice: number; feeBps: number; currency: string; buyerCountries: string[] };
}
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
export interface Billing { active: boolean; reason: string; status: string | null; expires: string | null; graceUntil: string | null; billing: boolean }
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
  owned: boolean;
  installed: "installed" | "update" | null;
}
export interface LibraryItem { listing: string; slug: string; name: string; cover: string | null; version: string | null; bytes: number | null; changelog: string; ownedSince: string; installed: "installed" | "update" | null; installedVersion: string | null }
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
  versions?: { version: string; status: string; bytes: number; changelog: string; created: string }[];
  pending?: string[];
  creator?: string;
}
export interface Creator { country: string; displayName: string; stripeAccount: string; chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }
export interface Sales { sales: { order: string; listing: string; amount: number; fee: number; earnings: number; currency: string; country: string; status: string; at: string }[]; totals: { count: number; gross: number; earnings: number } }

export const account = {
  status: () => call<AccountStatus>("GET", "/api/account"),
  setServer: (server: string) => call<{ server: string }>("PUT", "/api/account/server", { server }),
  signin: (email: string) => call<{ ok: boolean; email: string }>("POST", "/api/account/signin", { email }),
  verify: (code: string) => call<{ reauth: boolean; email: string }>("POST", "/api/account/verify", { code }),
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
  market: () => call<{ entries: PaidEntry[]; server: string }>("GET", "/api/account/market"),
  buy: (listing: string) => call<{ url: string; price: number; fee: number }>("POST", "/api/account/market/checkout", { listing }),
  library: () => call<{ library: LibraryItem[] }>("GET", "/api/account/library"),
  install: (listing: string) => call<{ result: string; ids: string[]; report: any }>("POST", "/api/account/library/install", { listing }),
  creator: () => call<{ creator: Creator | null }>("GET", "/api/account/creator"),
  becomeCreator: (country: string, displayName?: string) => call<Creator>("POST", "/api/account/creator", { country, displayName }),
  onboarding: () => call<{ url: string }>("POST", "/api/account/creator/onboarding"),
  dashboard: () => call<{ url: string }>("POST", "/api/account/creator/dashboard"),
  sales: () => call<Sales>("GET", "/api/account/creator/sales"),
  listings: () => call<{ listings: Listing[] }>("GET", "/api/account/listings"),
  createListing: (b: { deck: string; name?: string; description?: string; price: number; tags?: string[]; cover?: { type: string; data: string } }) => call<Listing>("POST", "/api/account/listings", b),
  updateListing: (id: string, b: { price?: number; tags?: string[] }) => call<Listing>("PATCH", `/api/account/listings/${encodeURIComponent(id)}`, b),
  newVersion: (id: string, b: { deck: string; changelog?: string }) => call<Listing>("POST", `/api/account/listings/${encodeURIComponent(id)}/versions`, b),
  submit: (id: string) => call<Listing>("POST", `/api/account/listings/${encodeURIComponent(id)}/submit`),
  hide: (id: string) => call<Listing>("POST", `/api/account/listings/${encodeURIComponent(id)}/hide`),
  review: () => call<{ queue: Listing[] }>("GET", "/api/account/review"),
  approve: (id: string, notes?: string) => call<Listing>("POST", `/api/account/review/${encodeURIComponent(id)}/approve`, { notes }),
  reject: (id: string, notes: string) => call<Listing>("POST", `/api/account/review/${encodeURIComponent(id)}/reject`, { notes }),
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
