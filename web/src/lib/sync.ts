import { etudeFetch } from "./transport";

/**
 * Runs a sync if Sync is set up and unlocked here. `pendingOnly` skips it when nothing local is waiting.
 * Returns the status (with `received`, the count of events pulled from other devices), or null offline.
 */
export async function autoSync(o: { pendingOnly?: boolean } = {}): Promise<{ received?: number; lastSync?: string | null } | null> {
  try {
    const r = await etudeFetch("/api/sync/auto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
