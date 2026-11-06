import { etudeFetch } from "./transport";

/** What the app needs from the sync status: events and media files that came from other devices. */
export type SyncSeen = { received?: number; lastSync?: string | null; media?: { active: boolean; received: number; error?: string | null } };

/** Fired on window when media files from another device were written, so images and sounds that were missing ask again. */
export const MEDIA_EVENT = "etude:media";
/** Fired on window with each sync status the app gets (an automatic sync, Settings → Sync), so it can watch the media that follows. */
export const STATUS_EVENT = "etude:sync-status";
export const shareStatus = (st: SyncSeen) => window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: st }));

/** Fired on window when media files start or stop being on their way (see `mediaPending`). */
export const MEDIA_STATE_EVENT = "etude:media-state";
let pending = false;
/** Whether media files are still on their way: the media sync runs, or failed and tries again at the next sync. */
export const mediaPending = () => pending;
export function setMediaPending(p: boolean) {
  if (p === pending) return;
  pending = p;
  window.dispatchEvent(new Event(MEDIA_STATE_EVENT));
}

/**
 * Runs a sync if Sync is set up and unlocked here. `pendingOnly` skips it when nothing local is waiting.
 * Returns once the collection is in step (media files follow in the background), with the status, or null offline.
 */
export async function autoSync(o: { pendingOnly?: boolean } = {}): Promise<SyncSeen | null> {
  try {
    const r = await etudeFetch("/api/sync/auto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
    if (!r.ok) return null;
    const st: SyncSeen = await r.json();
    shareStatus(st);
    return st;
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
