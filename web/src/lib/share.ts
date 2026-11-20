// Client for /api/share/*: shared folders and pages in the Notebook (docs/sharing.md).
// The local server does the crypto and the syncing; this only asks it and says what went wrong in plain words.
import { etudeFetch } from "./transport";

export type ShareRole = "owner" | "edit" | "view";

/** What a note in the tree knows about its share (NoteSummary.share). */
export interface NoteShare {
  space: string;
  role: ShareRole;
  /** The shared folder or page itself, not something inside it. */
  root: boolean;
  /** View only, or a share you no longer have access to. */
  readonly: boolean;
  /** Who changed it last: a member (email, name) or you. */
  lastEdit?: { email: string | null; name: string | null; at: string; you?: boolean } | null;
}

/** Someone else's device in a shared space right now (GET /api/share/presence). */
export interface SharePerson {
  device: string;
  accountId: string;
  email: string | null;
  name: string | null;
  color: string;
  space: string;
  note: string | null;
  title: string | null;
  kind: string | null;
  sel: { anchor: number; head: number } | { x: number; y: number } | null;
  block: number[] | null;
  typing: boolean;
  at: string;
  /** On the very note asked about. */
  here: boolean;
}

export interface ShareActivity {
  members: { memberId: string; accountId: string; email: string; name: string | null; color: string; lastSeen: string | null; lastEdit: string | null; edits7d: number; edits30d: number; editsTotal: number }[];
  days: { day: string; edits: Record<string, number> }[];
}

export interface ShareMember {
  id: string;
  email: string;
  name: string | null;
  role: ShareRole;
  status: "invited" | "active";
  accountId: string | null;
  /** Their signed-in devices with a sharing key, and whether each holds the key yet. */
  devices: { id: string; publicKey: string; hasKey: boolean }[];
  hasKey: boolean;
  created: string | number;
}

export interface LocalSpace {
  id: string;
  rootId: string;
  name: string | null;
  role: ShareRole;
  status: "active" | "removed" | string;
  owner: { email: string; name: string | null };
  members?: ShareMember[];
  lastSync: string | number | null;
  error: string | null;
  pending?: number | boolean | null;
  /** This device hasn't got the space's key yet: another device hands it over by itself. */
  waitingKey?: boolean;
}

export interface ShareInvite {
  spaceId: string;
  memberId: string;
  role: ShareRole;
  owner: { email: string; name: string | null };
  name: string | null;
  created: string | number;
}

export interface ShareStatus {
  signedIn: boolean;
  email: string | null;
  server?: string;
  spaces: LocalSpace[];
  invites: ShareInvite[];
}

export class ShareError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await etudeFetch(path, {
      method,
      headers: method !== "GET" ? { "Content-Type": "application/json" } : undefined,
      body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ShareError("offline", 0, "offline");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const message = typeof data?.error === "string" ? data.error : data?.error?.message ?? res.statusText ?? "The request failed.";
    const code = data?.code ?? data?.error?.code;
    throw new ShareError(message, res.status, typeof code === "string" ? code : undefined);
  }
  return data as T;
}

const enc = encodeURIComponent;
export const shareApi = {
  status: () => call<ShareStatus>("GET", "/api/share"),
  auto: () => call<ShareStatus>("POST", "/api/share/auto"),
  sync: () => call<ShareStatus>("POST", "/api/share/sync"),
  forNote: (id: string) => call<{ space: (LocalSpace & { members: ShareMember[] }) | null }>("GET", `/api/share/note/${enc(id)}`),
  create: (noteId: string) => call<{ space: LocalSpace }>("POST", "/api/share", { noteId }),
  invite: (space: string, email: string, role: "edit" | "view") => call<{ member: ShareMember }>("POST", `/api/share/${enc(space)}/invite`, { email, role }),
  setRole: (space: string, member: string, role: "edit" | "view") => call<unknown>("PATCH", `/api/share/${enc(space)}/members/${enc(member)}`, { role }),
  remove: (space: string, member: string) => call<unknown>("DELETE", `/api/share/${enc(space)}/members/${enc(member)}`),
  accept: (space: string, parentId?: string | null) => call<{ space: LocalSpace; rootId: string }>("POST", `/api/share/${enc(space)}/accept`, parentId ? { parentId } : {}),
  decline: (space: string) => call<unknown>("POST", `/api/share/${enc(space)}/decline`),
  leave: (space: string) => call<unknown>("POST", `/api/share/${enc(space)}/leave`),
  stop: (space: string) => call<unknown>("DELETE", `/api/share/${enc(space)}`),
  presence: (note: string) => call<{ people: SharePerson[] }>("GET", `/api/share/presence?note=${enc(note)}`),
  setPresence: (p: { note: string | null; sel?: unknown; block?: number[] | null; typing?: boolean }) => call<{ ok: true }>("POST", "/api/share/presence", p),
  activity: (space: string) => call<ShareActivity>("GET", `/api/share/${enc(space)}/activity`),
};

/** An error from sharing, said the way a person would say it. */
export function shareMessage(e: unknown): string {
  const err = e as ShareError;
  switch (err?.code) {
    case "offline":
      return "Couldn't reach Etude. Check your connection and try again.";
    case "sync_required":
      return "Sharing a folder uses Etude Sync. Viewers and editors you invite don't need it.";
    case "not_signed_in":
    case "unauthorized":
    case "signed_out":
      return "Sign in to your Etude account to share.";
    case "already_member":
      return "They already have access.";
    case "owner_cannot_leave":
      return "You own this. To end it for everyone, stop sharing instead.";
    case "epoch_mismatch":
      return "Someone changed who has access at the same time. Try again.";
    case "forbidden":
      return "You don't have permission to do that here.";
    case "not_found":
      return "This share doesn't exist anymore.";
    case "invalid_email":
      return "That doesn't look like an email address.";
  }
  // A bug or an answer we didn't expect: no stack-trace words on screen.
  if (!(e instanceof ShareError)) return "Something went wrong. Try again.";
  if (err.status >= 500) return "Etude couldn't do that right now. Try again in a moment.";
  if (err?.status === 403) return "You don't have permission to do that here.";
  if (err?.status === 401) return "Sign in to your Etude account to share.";
  const m = err?.message ?? String(e);
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/** Someone's name if the server knows it, else the part of the email before the @. */
export const personName = (p: { name?: string | null; email: string | null }) => p.name?.trim() || (p.email ?? "").split("@")[0] || "Someone";

/** "now", "5 min ago", "2 h ago", "3 days ago": how long since `at`. */
export function ago(at: string | number | null | undefined, now = Date.now()): string {
  const t = typeof at === "number" ? at : at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return "never";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : d < 60 ? `${d} days ago` : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** A rough email check, enough to catch a typo before asking the server. */
export const looksLikeEmail = (s: string) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s);
