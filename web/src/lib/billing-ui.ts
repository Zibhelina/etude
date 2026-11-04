// Small rules for Settings → Sync, kept free of imports so the tests can load them.

/** Settings → Sync storage when the server gave no number (it only answers while Sync is active). */
export function storageNote(st: { offline: string | null }, active: boolean): string {
  if (st.offline) return "the server can't be reached right now";
  return active ? "the server didn't say how much is used" : "shown while Sync is active";
}

