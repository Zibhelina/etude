// Small rules for Settings → Sync, kept free of imports so the tests can load them.

/** Settings → Sync storage when the server gave no number (it only answers while Sync is active). */
export function storageNote(st: { offline: string | null }, active: boolean): string {
  if (st.offline) return "the server can't be reached right now";
  return active ? "the server didn't say how much is used" : "shown while Sync is active";
}

/**
 * Whether "Manage subscription" (the Polar portal) applies. Only a website subscription has a
 * portal. A Sync granted by hand ("manual"), or bought in a store app, has nothing to manage there.
 * Servers before the App Store support didn't send `source`; everything there was Polar.
 */
export function hasWebPortal(b: { source?: string | null; status: string | null } | null | undefined): boolean {
  if (!b?.status) return false;
  return b.source === "polar" || b.source === undefined;
}

/** On desktop and the web: where to manage a Sync bought in a store app (there's no portal for it). */
export function storeSource(b: { source?: string | null } | null | undefined): string | null {
  if (b?.source === "apple") return "Bought in the iPhone or iPad app. Manage it in your Apple account's subscriptions.";
  if (b?.source === "google") return "Bought in the Android app. Manage it in the Play Store's subscriptions.";
  return null;
}
