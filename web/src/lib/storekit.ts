// Etude Sync through Apple In-App Purchase, in the iOS app only. The native side is
// ios/App/App/EtudeStorePlugin.swift (StoreKit 2); src/browser/native-shell.ts exposes it here as
// globalThis.__etudeStoreKit, so this module doesn't import Capacitor.
//
// Flow: load the products (localized prices from the App Store), buy with the appAccountToken the
// Sync server gives for the signed-in account, send the signed transaction to the server, and finish
// it only once the server gave a definite answer. Renewals and late approvals arrive through the
// `transaction` event and the unfinished list, and go the same way.
import { account, AccountApiError } from "./account";
import { isIOSApp } from "./platform";

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
export interface AppleResult { ok: boolean; result: string; sync: { active: boolean; reason: string; source: string | null }; subscription: { productId: string; status: string; expires: string | null; environment: string } }

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

/** The App Store purchase path: the iOS app with the StoreKit plugin loaded. */
export const storeKit = (): StorePlugin | undefined => (isIOSApp() ? plugin() : undefined);
export const canBuyInApp = () => !!storeKit();

/** Fired after the server accepted an App Store transaction, so account views can refresh. */
export const STOREKIT_EVENT = "etude:storekit";

export async function loadProducts(ids: string[]): Promise<StoreProduct[]> {
  const p = storeKit();
  if (!p || !ids.length) return [];
  return (await p.getProducts({ ids })).products;
}

/** A definite answer from the Sync server (accepted, or refused for good): the transaction can be finished. */
const definite = (e: unknown) => e instanceof AccountApiError && [409, 422].includes(e.status);

/** Sends one signed transaction to the Sync server, then finishes it in StoreKit. */
export async function submitTransaction(t: StoreTransaction): Promise<AppleResult> {
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
  const { appAccountToken } = await account.appleInfo();
  const r = await p.purchase({ productId, appAccountToken });
  if (r.status !== "purchased" || !r.jws) return { status: (r.status as "pending" | "cancelled" | "unknown") ?? "unknown" };
  const res = await submitTransaction(r as StoreTransaction);
  return { status: "purchased", sync: res.sync };
}

/** Restore Purchases: the App Store's current subscriptions for this Apple ID, sent to the Sync server. */
export async function restore(): Promise<{ cancelled: boolean; found: number; active: boolean; errors: string[] }> {
  const p = storeKit();
  if (!p) throw new Error("App Store purchases aren't available here.");
  const r = await p.restore();
  let active = false;
  const errors: string[] = [];
  for (const t of r.transactions) {
    try {
      active = (await submitTransaction(t)).sync.active || active;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { cancelled: r.cancelled, found: r.transactions.length, active, errors };
}

export const manageSubscriptions = () => storeKit()?.manageSubscriptions();

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
