import { etudeFetch } from "./transport";

/** What the app needs from the sync status: events and media files that came from other devices. */
export type SyncSeen = { received?: number; lastSync?: string | null; media?: { active: boolean; received: number } };

/** Fired on window when media files from another device were written, so images and sounds that were missing ask again. */
export const MEDIA_EVENT = "etude:media";
/** Fired on window with a sync status read outside the app's own loop (Settings → Sync), so the app watches its media too. */
export const STATUS_EVENT = "etude:sync-status";
export const shareStatus = (st: SyncSeen) => window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: st }));

/**
 * Runs a sync if Sync is set up and unlocked here. `pendingOnly` skips it when nothing local is waiting.
 * Returns once the collection is in step (media files follow in the background), with the status, or null offline.
 */
export async function autoSync(o: { pendingOnly?: boolean } = {}): Promise<SyncSeen | null> {
  try {
    const r = await etudeFetch("/api/sync/auto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** The sync status, or null when it can't be read. */
export async function syncStatus(): Promise<SyncSeen | null> {
  try {
    const r = await etudeFetch("/api/sync/status");
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
