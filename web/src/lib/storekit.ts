// Etude Sync bought inside the store apps: Apple In-App Purchase on iOS
// (ios/App/App/EtudeStorePlugin.swift, StoreKit 2) and Google Play Billing on Android
// (android/app/src/main/java/study/etude/app/EtudeStorePlugin.kt). Both plugins have the same shape;
// src/browser/native-shell.ts exposes the one for this platform as globalThis.__etudeStoreKit, so
// this module doesn't import Capacitor. On Android a plan id is "etude_sync:monthly" (product and
// base plan), the purchase token stands in for the JWS, and "finish" means acknowledge.
//
// Flow: load the products (localized prices from the App Store), buy with the appAccountToken the
// Sync server gives for the signed-in account, send the signed transaction to the server, and finish
// it only once the server gave a definite answer. Renewals and late approvals arrive through the
// `transaction` event and the unfinished list, and go the same way.
import { account, AccountApiError } from "./account";
import { isAndroidApp, isIOSApp } from "./platform";
import type { Offering } from "./account";

export interface StoreProduct {
  id: string;
  displayName: string;
  description: string;
  /** Localized by the App Store, with currency ("$9.99", "R$ 54,90"). */
  displayPrice: string;
  period?: { unit: "day" | "week" | "month" | "year" | "unknown"; value: number };
  introOffer?: { displayPrice: string; periodValue: number; paymentMode: string };
}
export interface StoreTransaction {
  jws: string;
  verified: boolean;
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  expires?: string;
  revoked?: string;
}
export type PurchaseOutcome = { status: "purchased"; sync: AppleResult["sync"] } | { status: "pending" | "cancelled" | "unknown" };
export interface AppleResult { ok: boolean; result: string; sync: { active: boolean; reason: string; source: string | null }; subscription: { productId: string; status: string; expires: string | null; environment: string }; /** Set instead of `subscription` for a deck (non-consumable). */ deck?: { listing: string; slug: string; name: string } }
export interface GoogleResult { ok: boolean; result: string; acknowledge: boolean; sync: AppleResult["sync"]; subscription: { productId: string; basePlanId: string; status: string; expires: string | null; test: boolean } }

interface StorePlugin {
  getProducts(o: { ids: string[] }): Promise<{ products: StoreProduct[] }>;
  purchase(o: { productId: string; appAccountToken: string }): Promise<{ status: string } & Partial<StoreTransaction>>;
  finish(o: { transactionId: string }): Promise<{ finished: boolean }>;
  unfinished(): Promise<{ transactions: StoreTransaction[] }>;
  currentEntitlements(): Promise<{ transactions: StoreTransaction[] }>;
  restore(): Promise<{ cancelled: boolean; transactions: StoreTransaction[] }>;
  manageSubscriptions(): Promise<void>;
  addListener(event: "transaction", fn: (t: StoreTransaction) => void): Promise<{ remove(): Promise<void> }> | { remove(): Promise<void> };
}

const plugin = (): StorePlugin | undefined => (globalThis as { __etudeStoreKit?: StorePlugin }).__etudeStoreKit;

/** The in-app purchase path: the iOS app (StoreKit) or the Android app (Play Billing) with its plugin loaded. */
export const storeKit = (): StorePlugin | undefined => (isIOSApp() || isAndroidApp() ? plugin() : undefined);
export const canBuyInApp = () => !!storeKit();

/** Whose store this app sells through, and the entitlement `source` that purchase gives. */
export const storeSource = (): "apple" | "google" | null => (!storeKit() ? null : isAndroidApp() ? "google" : "apple");
export const storeName = () => (storeSource() === "google" ? "Google Play" : "the App Store");

/** The plan ids this app can sell, from what the Sync server offers ([] when it takes none from this store). */
export function inAppProductIds(o: Offering | null | undefined): string[] {
  const src = storeSource();
  if (src === "apple") return o?.appleProducts ?? [];
  if (src === "google") {
    const g = o?.googleProducts;
    return g ? g.productIds.flatMap((p) => (g.basePlans.length ? g.basePlans.map((b) => `${p}:${b}`) : [])) : [];
  }
  return [];
}

/** Fired after the server accepted an App Store transaction, so account views can refresh. */
export const STOREKIT_EVENT = "etude:storekit";

export async function loadProducts(ids: string[]): Promise<StoreProduct[]> {
  const p = storeKit();
  if (!p || !ids.length) return [];
  return (await p.getProducts({ ids })).products;
}

/** A definite answer from the Sync server (accepted, or refused for good): the transaction can be finished. */
const definite = (e: unknown) => e instanceof AccountApiError && [409, 422].includes(e.status);

/**
 * Google Play: the server checks the token with Google. Acknowledge only when it says so: a pending
 * purchase can't be acknowledged yet, and one the server refused is left for Play to refund.
 */
async function submitGoogle(t: StoreTransaction): Promise<AppleResult> {
  const p = storeKit();
  const r = await account.googlePurchase(t.jws);
  if (r.acknowledge) await p?.finish({ transactionId: t.transactionId }).catch(() => {});
  window.dispatchEvent(new Event(STOREKIT_EVENT));
  return { ok: r.ok, result: r.result, sync: r.sync, subscription: { productId: r.subscription.productId, status: r.subscription.status, expires: r.subscription.expires, environment: r.subscription.test ? "Test" : "Production" } };
}

/** Sends one signed transaction to the Sync server, then finishes it in StoreKit. */
export async function submitTransaction(t: StoreTransaction): Promise<AppleResult> {
  if (storeSource() === "google") return submitGoogle(t);
  const p = storeKit();
  try {
    const r = await account.appleTransaction(t.jws);
    await p?.finish({ transactionId: t.transactionId }).catch(() => {});
    window.dispatchEvent(new Event(STOREKIT_EVENT));
    return r;
  } catch (e) {
    if (definite(e)) await p?.finish({ transactionId: t.transactionId }).catch(() => {});
    throw e;
  }
}

/** Buys a plan for the signed-in Etude account. */
export async function buy(productId: string): Promise<PurchaseOutcome> {
  const p = storeKit();
  if (!p) throw new Error("App Store purchases aren't available here.");
  // Google Play's obfuscatedAccountId plays the part of Apple's appAccountToken.
  const appAccountToken = storeSource() === "google" ? (await account.googleInfo()).obfuscatedAccountId : (await account.appleInfo()).appAccountToken;
  const r = await p.purchase({ productId, appAccountToken });
  if (r.status !== "purchased" || !r.jws) return { status: (r.status as "pending" | "cancelled" | "unknown") ?? "unknown" };
  const res = await submitTransaction(r as StoreTransaction);
  return { status: "purchased", sync: res.sync };
}

/** A deck Etude sells itself that this iPhone app can sell (an App Store non-consumable), with the App Store's product. */
export interface AppleDeck { listing: string; productId: string; product: StoreProduct | null }

/** The decks this iPhone app sells, with their App Store price ([] outside the iPhone app or when none are set up). */
export async function appleDecks(): Promise<AppleDeck[]> {
  if (storeSource() !== "apple") return [];
  const decks = (await account.appleInfo()).decks ?? [];
  if (!decks.length) return [];
  const products = await loadProducts(decks.map((d) => d.productId)).catch(() => [] as StoreProduct[]);
  return decks.map((d) => ({ listing: d.listing, productId: d.productId, product: products.find((p) => p.id === d.productId) ?? null }));
}

/** Buys a deck through the App Store for the signed-in Etude account; the server puts it in the library. */
export async function buyDeck(productId: string): Promise<{ status: "purchased" | "pending" | "cancelled" | "unknown"; deck?: AppleResult["deck"] }> {
  const p = storeKit();
  if (!p || storeSource() !== "apple") throw new Error("App Store purchases aren't available here.");
  const r = await p.purchase({ productId, appAccountToken: (await account.appleInfo()).appAccountToken });
  if (r.status !== "purchased" || !r.jws) return { status: (r.status as "pending" | "cancelled" | "unknown") ?? "unknown" };
  return { status: "purchased", deck: (await submitTransaction(r as StoreTransaction)).deck };
}

/** Restore Purchases: the App Store's current subscriptions and decks for this Apple ID, sent to the Sync server. */
export async function restore(): Promise<{ cancelled: boolean; found: number; active: boolean; errors: string[] }> {
  const p = storeKit();
  if (!p) throw new Error("App Store purchases aren't available here.");
  const r = await p.restore();
  let active = false;
  const errors: string[] = [];
  for (const t of r.transactions) {
    try {
      active = !!(await submitTransaction(t)).sync?.active || active;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { cancelled: r.cancelled, found: r.transactions.length, active, errors };
}

export const manageSubscriptions = () => storeKit()?.manageSubscriptions();

/** Play Billing's own errors when the device can't buy (no Play Store, not signed in, a build not installed from Play). */
export const unavailableHere = (e: unknown) => (e as { code?: string })?.code === "unavailable";

let started = false;
/** On launch: send transactions StoreKit still holds unfinished, and every new one as it arrives. Signed out, they wait. */
export function startStoreKit() {
  const p = storeKit();
  if (!p || started) return;
  started = true;
  const send = (t: StoreTransaction) => void submitTransaction(t).catch(() => {});
  void Promise.resolve(p.addListener("transaction", send)).catch(() => {});
  void p.unfinished().then((r) => r.transactions.forEach(send)).catch(() => {});
}

/** { unit: "year", value: 1 } → "year", { unit: "month", value: 3 } → "3 months". */
export function periodLabel(p?: StoreProduct["period"]): string {
  if (!p) return "";
  return p.value === 1 ? p.unit : `${p.value} ${p.unit}s`;
}
