// Sharing in the Notebook, like Notion or Google Docs: Share in the top bar (or Share… on a row), type an email,
// pick Can edit or Can view, Invite. The people with access are listed right there. Invites to you show as a card
// at the top of the pages. The local server does the encryption and syncing (docs/sharing.md); this is only the UI.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Eye, Lock, Users } from "lucide-react";
import { toast } from "sonner";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useAvatar } from "@/lib/avatar";
import { isPhone } from "@/lib/device";
import { ago, looksLikeEmail, personName, shareApi, shareMessage, ShareError, type LocalSpace, type NoteShare, type ShareActivity, type ShareInvite, type ShareMember, type SharePerson, type ShareRole, type ShareStatus } from "@/lib/share";
import { inkOn, peopleIn, presenceLabel } from "@/lib/presence";
import { AvatarPic } from "@/components/avatar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import "./note-share.css";

export const ROLE_LABEL: Record<ShareRole, string> = { owner: "Owner", edit: "Can edit", view: "Can view" };

// ---------------------------------------------------------------- keeping up with the server

/** What changed since the last look: spaces (and their last sync) and invites. lastSync moves only when a sync did something. */
function signature(s: ShareStatus): string {
  return JSON.stringify([s.signedIn, s.spaces.map((x) => [x.id, x.status, x.role, x.rootId, x.name, x.lastSync]), s.invites.map((i) => i.memberId)]);
}

/**
 * Asks the local server to sync shares (POST /api/share/auto) every 3 s while Notes is on screen and you're signed
 * in, every 30 s otherwise. `onArrived` runs when something came in, so the tree can read itself again.
 * A server without sharing (404) is left alone: `available` turns false and the Share buttons hide.
 */
export function useShareStatus(onArrived: () => void, together = false) {
  const fast = useRef(together);
  fast.current = together;
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [available, setAvailable] = useState(true);
  const arrived = useRef(onArrived);
  arrived.current = onArrived;
  const kick = useRef<() => void>(() => {});
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sig: string | null = null;
    let signedIn = false;
    let running = false;
    const schedule = () => {
      clearTimeout(timer);
      // Someone else on the page open here: every second, so their typing shows up as it happens.
      if (live) timer = setTimeout(() => void tick(), document.visibilityState === "visible" && signedIn ? (fast.current ? 1000 : 3000) : 30000);
    };
    const tick = async () => {
      if (!live || running) return;
      running = true;
      try {
        const s = await shareApi.auto();
        if (!live) return;
        signedIn = !!s.signedIn;
        setStatus(s);
        const next = signature(s);
        if (sig !== null && next !== sig) arrived.current();
        sig = next;
      } catch (e) {
        if (e instanceof ShareError && e.status === 404) {
          // This server has no sharing: stop asking.
          if (live) setAvailable(false);
          return;
        }
        // Offline or a hiccup: the next look tries again.
      } finally {
        running = false;
      }
      schedule();
    };
    kick.current = () => {
      clearTimeout(timer);
      void tick();
    };
    const seen = () => document.visibilityState === "visible" && kick.current();
    void tick();
    document.addEventListener("visibilitychange", seen);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", seen);
    };
  }, []);
  const refresh = useCallback(() => kick.current(), []);
  return { status, available, refresh };
}

// ---------------------------------------------------------------- what the rest of Notes sees

export interface ShareCtxValue {
  available: boolean;
  status: ShareStatus | null;
  /** The share of a note in the tree, if it's in one. */
  shareOf(id: string): NoteShare | undefined;
  open(noteId: string): void;
  /** Everyone else in the open note's space right now (presence), and who's on which note. */
  people?: SharePerson[];
}
export const ShareCtx = createContext<ShareCtxValue | null>(null);

/** View only (or access removed), from the note itself or its row in the tree. */
export function useReadOnly(note: { id: string; share?: NoteShare } | null | undefined): boolean {
  const ctx = useContext(ShareCtx);
  if (!note) return false;
  return !!(ctx?.shareOf(note.id) ?? note.share)?.readonly;
}

/** The right end of a page's top bar: a "View only" pill when it's read-only, and Share (with people when shared). */
export function ShareBits({ note }: { note: { id: string; share?: NoteShare } }) {
  const ctx = useContext(ShareCtx);
  // A file in a folder on this computer isn't a note of the collection: there's nothing to share it through.
  if (!ctx || note.id.startsWith("fs:")) return null;
  const share = ctx.shareOf(note.id) ?? note.share;
  const space = share ? ctx.status?.spaces.find((s) => s.id === share.space) : undefined;
  const removed = space?.status === "removed";
  return (
    <>
      {share?.readonly && (
        <span className="share-pill" aria-label={removed ? "No access" : "View only"} title={removed ? "You no longer have access. This copy stays on your device." : "Shared with you as view only"}>
          <Eye className="size-3.5" /> <span className="share-pill-text">{removed ? "No access" : "View only"}</span>
        </span>
      )}
      {share && !removed && <PresenceStack note={note.id} space={share.space} onOpen={() => ctx.open(note.id)} />}
      {ctx.available && !removed && (
        <button type="button" className={cn("share-btn", share && "is-shared")} onClick={() => ctx.open(note.id)} title={share ? "Shared. See who has access" : "Share with people"} aria-label={share ? "Shared. See who has access" : "Share"}>
          {/* Like Notion: a lock while it's only yours, people once someone else has it. */}
          {share ? <Users className="size-3.5" /> : <Lock className="size-3.5" />}
          <span>Share</span>
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------- who's here

/** "editing Agora", "in Tarefas": where someone is, from the note they have open. */
const where = (p: SharePerson, here: boolean) => (here ? `${p.typing ? "editing" : "on"} ${p.title?.trim() || "this page"}` : p.title != null ? `in ${p.title.trim() || "Untitled"}` : "in this folder");

/** A ticking clock for "2 min ago" labels: re-renders every 30 s. */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** A round initial on the person's color. */
function Face({ p, size = 24, ring }: { p: { name: string | null; email: string | null; color: string }; size?: number; ring?: boolean }) {
  return (
    <span className={cn("presence-face", ring && "has-ring")} style={{ "--who": p.color, "--who-ink": inkOn(p.color), width: size, height: size, fontSize: Math.round(size * 0.46) } as React.CSSProperties}>
      {presenceLabel(p).charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Left of Share: up to 3 people in this space right now, the ones on this page first with a ring in their color, and
 * a green dot for online. Hover says where each is; a click opens the Share dialog.
 */
export function PresenceStack({ note, space, onOpen }: { note: string; space: string; onOpen(): void }) {
  const ctx = useContext(ShareCtx);
  useNow();
  const people = peopleIn((ctx?.people ?? []).filter((p) => p.space === space)).map((p) => ({ ...p, here: p.note === note }));
  if (!people.length) return null;
  const shown = people.slice(0, 3);
  const more = people.length - shown.length;
  const line = (p: SharePerson) => `${presenceLabel(p)} · ${where(p, p.here)} · ${ago(p.at)}`;
  return (
    <button type="button" className="presence-stack" onClick={onOpen} aria-label={`${people.length === 1 ? "1 person" : `${people.length} people`} here: ${people.map(line).join("; ")}`} title={people.map(line).join("\n")}>
      {shown.map((p) => (
        <span key={p.accountId} className="presence-stack-item" data-person={presenceLabel(p)}>
          <Face p={p} ring={p.here} />
          <span className="presence-online" aria-hidden />
        </span>
      ))}
      {more > 0 && <span className="presence-more">+{more}</span>}
    </button>
  );
}

/** A small dot in a person's color on a tree row whose page someone else has open. */
export function PresenceDots({ note }: { note: string }) {
  const ctx = useContext(ShareCtx);
  const on = peopleIn((ctx?.people ?? []).filter((p) => p.note === note));
  if (!on.length) return null;
  return (
    <span className="presence-dots" title={on.map((p) => `${presenceLabel(p)} is here`).join("\n")} aria-label={on.map((p) => `${presenceLabel(p)} is here`).join(", ")}>
      {on.slice(0, 3).map((p) => <span key={p.accountId} className="presence-dot" style={{ "--who": p.color } as React.CSSProperties} />)}
    </span>
  );
}

/** "Edited by Victor · 3 min ago", when the last change to this note came from someone else. */
export function EditedBy({ note }: { note: { id: string; share?: NoteShare } }) {
  const ctx = useContext(ShareCtx);
  const now = useNow();
  const le = (ctx?.shareOf(note.id) ?? note.share)?.lastEdit;
  if (!le || le.you) return null;
  const who = personName({ name: le.name, email: le.email });
  const when = ago(le.at, now);
  return <span className="note-edited-by" title={new Date(le.at).toLocaleString()}><span className="note-edited-by-lead">Edited by </span>{who} · {when === "now" ? "just now" : when}</span>;
}

// ---------------------------------------------------------------- invites to you

/** Waiting for a key on this device: the text the UI shows, with nothing to click. */
export const WAITING_KEY = "Getting the key from another device…";

/**
 * Invites to accept, and shared folders this device can't open yet (joined on another device, or accepted before a key
 * reached this one): those just say they're getting the key.
 */
export function ShareInvites({ invites, waiting = [], onAccept, onDecline }: { invites: ShareInvite[]; waiting?: LocalSpace[]; onAccept(i: ShareInvite): Promise<void>; onDecline(i: ShareInvite): Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!invites.length && !waiting.length) return null;
  const run = async (i: ShareInvite, f: (i: ShareInvite) => Promise<void>) => {
    setBusy(i.memberId);
    try {
      await f(i);
    } catch (e) {
      toast.error(shareMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="share-invites" role="region" aria-label="Shared with you">
      {invites.map((i) => (
        <div key={i.memberId} className="share-invite">
          <div className="share-invite-text">
            <Users className="share-invite-icon" aria-hidden />
            <p>
              <strong>{personName(i.owner)}</strong> shared <strong>{i.name?.trim() || "a folder"}</strong> with you
              <span className="share-invite-role"> · {ROLE_LABEL[i.role]}</span>
            </p>
          </div>
          <div className="share-invite-acts">
            <button type="button" disabled={busy === i.memberId} onClick={() => void run(i, onDecline)} className="share-quiet">Decline</button>
            <button type="button" disabled={busy === i.memberId} onClick={() => void run(i, onAccept)} className="lib-primary share-accept">Accept</button>
          </div>
        </div>
      ))}
      {waiting.map((s) => (
        <div key={s.id} className="share-invite is-waiting" title={WAITING_KEY}>
          <div className="share-invite-text">
            <Users className="share-invite-icon" aria-hidden />
            <p>
              <strong>{personName(s.owner)}</strong> shared <strong>{s.name?.trim() || "a folder"}</strong> with you
              <span className="share-invite-role"> · {WAITING_KEY}</span>
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the dialog

type SpaceDetail = LocalSpace & { members: ShareMember[] };

function RolePicker({ value, onPick, children, align = "end" }: { value: "edit" | "view"; onPick(r: "edit" | "view"): void; children?: React.ReactNode; align?: "start" | "end" }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="share-role">
          {ROLE_LABEL[value]} <ChevronDown className="size-3.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-44">
        {(["edit", "view"] as const).map((r) => (
          <DropdownMenuItem key={r} onSelect={() => onPick(r)}>
            <Check className={cn("size-4", value !== r && "opacity-0")} /> {ROLE_LABEL[r]}
          </DropdownMenuItem>
        ))}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Act = ShareActivity["members"][number];
const justNow = (s: string) => (s === "now" ? "just now" : s);

/** "Online · in Agora", "Last active 5 min ago", "Never"; then "23 edits this week · last edit 2 h ago". */
function presenceLines(m: ShareMember, act: Act | undefined, on: SharePerson | undefined, now: number): { status: React.ReactNode; edits: string | null } {
  const status = on ? (
    <><span className="presence-online is-inline" aria-hidden /> Online · {where(on, false).replace(/^in /, "in ")}</>
  ) : act?.lastSeen ? `Last active ${justNow(ago(act.lastSeen, now))}` : "Never";
  if (!act) return { status, edits: null };
  const week = `${act.edits7d} edit${act.edits7d === 1 ? "" : "s"} this week`;
  return { status, edits: act.lastEdit ? `${week} · last edit ${justNow(ago(act.lastEdit, now))}` : week };
}

function Person({ m, me, onRole, onRemove, onLeave, owner, act, on, now }: { m: ShareMember; me: boolean; owner: boolean; onRole(r: "edit" | "view"): void; onRemove(): void; onLeave(): void; act?: Act; on?: SharePerson; now: number }) {
  const avatar = useAvatar();
  const name = me ? `${personName(m)} (you)` : m.status === "invited" ? m.email : personName(m);
  const lines = m.status === "active" && !me ? presenceLines(m, act, on, now) : null;
  return (
    <li className={cn("share-person", m.status === "invited" && "is-invited")}>
      {!me && act && m.status === "active" ? <Face p={{ name: m.name, email: m.email, color: act.color }} size={30} /> : <AvatarPic value={me ? avatar : null} size={30} initial={(m.name?.trim() || m.email).charAt(0).toUpperCase()} />}
      <div className="share-person-text">
        <span className="share-person-name">{name}</span>
        {lines ? (
          <>
            <span className={cn("share-person-sub", on && "is-online")}>{lines.status}</span>
            {lines.edits && <span className="share-person-sub">{lines.edits}</span>}
          </>
        ) : (
          <span className="share-person-sub">{m.status === "invited" ? "Invited, hasn't accepted yet" : me && act ? `${act.edits7d} edit${act.edits7d === 1 ? "" : "s"} this week` : m.email}</span>
        )}
      </div>
      {m.role === "owner" ? (
        <span className="share-person-role">Owner</span>
      ) : owner ? (
        <RolePicker value={m.role} onPick={onRole}>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>{m.status === "invited" ? "Cancel invite" : "Remove"}</DropdownMenuItem>
        </RolePicker>
      ) : me ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="share-role">{ROLE_LABEL[m.role]} <ChevronDown className="size-3.5 opacity-60" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem variant="destructive" onSelect={onLeave}>Leave</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="share-person-role">{ROLE_LABEL[m.role]}</span>
      )}
    </li>
  );
}

const ORDER: Record<ShareRole, number> = { owner: 0, edit: 1, view: 2 };

/** Activity, collapsed by default: a 14-day bar strip per person in their color, with their total edits. */
function ActivityStrip({ activity, members, myEmail }: { activity: ShareActivity; members: ShareMember[]; myEmail: string | null }) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => activity.members.map((a) => ({ a, m: members.find((m) => m.id === a.memberId), days: activity.days.map((d) => d.edits[a.accountId] ?? 0) })), [activity, members]);
  const top = Math.max(1, ...rows.flatMap((r) => r.days));
  const total = rows.reduce((n, r) => n + r.days.reduce((x, y) => x + y, 0), 0);
  const H = 22;
  const slot = 100 / 14;
  return (
    <div className="share-activity">
      <button type="button" className="share-activity-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown className={cn("size-3.5 transition-transform duration-150", !open && "-rotate-90")} />
        Activity <span className="share-activity-sum">{total} edit{total === 1 ? "" : "s"} in 14 days</span>
      </button>
      {open && (
        <ul className="share-activity-list">
          {rows.map(({ a, m, days }) => {
            const n = days.reduce((x, y) => x + y, 0);
            const who = m ? (myEmail && m.email.toLowerCase() === myEmail ? `${personName(m)} (you)` : personName(m)) : personName(a);
            return (
              <li key={a.memberId} className="share-activity-row">
                <span className="share-activity-name">{who}</span>
                {/* Widths in percent and heights in pixels: the strip fills the row at any width without stretching. */}
                <svg className="share-activity-bars" height={H} role="img" aria-label={`${who}: ${n} edit${n === 1 ? "" : "s"} in 14 days`}>
                  {days.map((v, i) => {
                    const h = v ? Math.max(8, Math.round((v / top) * H)) : 3;
                    return <rect key={i} x={`${i * slot + slot * 0.12}%`} y={H - h} width={`${slot * 0.76}%`} height={h} rx={2} fill={v ? a.color : undefined} className={v ? undefined : "share-activity-zero"}><title>{`${activity.days[i].day}: ${v} edit${v === 1 ? "" : "s"}`}</title></rect>;
                  })}
                </svg>
                <span className="share-activity-n">{a.editsTotal}</span>
              </li>
            );
          })}
          <li className="share-activity-axis" aria-hidden><span><span>2 weeks ago</span><span>today</span></span></li>
        </ul>
      )}
    </div>
  );
}

export function ShareDialog({ noteId, noteTitle, status, onClose, onChanged }: {
  /** The note being shared; null keeps the dialog closed. */
  noteId: string | null;
  noteTitle: string;
  status: ShareStatus | null;
  onClose(): void;
  /** Something about who has access changed: read the tree and the status again. */
  onChanged(): void;
}) {
  const open = noteId !== null;
  const [space, setSpace] = useState<SpaceDetail | null | undefined>(undefined);
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<"edit" | "view">("edit");
  const [busy, setBusy] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  // The email itself is wrong (red field), and whether the fix is turning on Sync (a link to it).
  const [badField, setBadField] = useState(false);
  const [needsSync, setNeedsSync] = useState(false);
  const setError = (m: string | null, opts: { field?: boolean; code?: string } = {}) => {
    setErrorState(m);
    setBadField(!!m && !!opts.field);
    setNeedsSync(opts.code === "sync_required");
  };
  const [confirm, setConfirm] = useState<"stop" | "leave" | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const signedIn = status?.signedIn ?? true;
  const myEmail = status?.email?.toLowerCase() ?? null;

  const [activity, setActivity] = useState<ShareActivity | null>(null);
  const now = useNow();
  const ctx = useContext(ShareCtx);
  const load = useCallback(async (id: string) => {
    try {
      const r = await shareApi.forNote(id);
      setSpace(r.space);
      if (r.space && r.space.status === "active") shareApi.activity(r.space.id).then(setActivity, () => setActivity(null));
      else setActivity(null);
    } catch (e) {
      setSpace(null);
      setError(shareMessage(e));
    }
  }, []);
  useEffect(() => {
    if (!noteId) return;
    setSpace(undefined);
    setActivity(null);
    setEmails("");
    setRole("edit");
    setError(null);
    setConfirm(null);
    if (status?.signedIn !== false) void load(noteId);
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const myRole: ShareRole = space ? space.role : "owner";
  const removed = space?.status === "removed";
  const canInvite = signedIn && !removed && myRole !== "view";
  const isOwner = myRole === "owner";
  const name = space && space.rootId !== noteId ? null : noteTitle;

  const invite = async () => {
    if (!noteId || busy) return;
    const list = emails.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!list.length) return void input.current?.focus();
    const bad = list.find((x) => !looksLikeEmail(x));
    if (bad) return setError(`“${bad}” doesn't look like an email address.`, { field: true });
    if (myEmail && list.includes(myEmail)) return setError("That's you. You already have access.", { field: true });
    setBusy(true);
    setError(null);
    try {
      let sid = space?.id;
      if (!sid) sid = (await shareApi.create(noteId)).space.id;
      for (const email of list) {
        if (space?.members.some((m) => m.email.toLowerCase() === email)) continue;
        await shareApi.invite(sid, email, role);
      }
      setEmails("");
      await load(noteId);
      onChanged();
    } catch (e) {
      setError(shareMessage(e), { code: (e as ShareError).code, field: ["invalid_email", "already_member"].includes((e as ShareError).code ?? "") });
      // A share made just now still counts, even if an invite failed.
      void load(noteId);
      onChanged();
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };
  const act = async (f: () => Promise<unknown>, after?: () => void) => {
    if (!noteId) return;
    setBusy(true);
    setError(null);
    try {
      await f();
      after?.();
      await load(noteId);
      onChanged();
    } catch (e) {
      setError(shareMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const members = [...(space?.members ?? [])].sort((a, b) => ORDER[a.role] - ORDER[b.role] || Number(a.status === "invited") - Number(b.status === "invited"));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn("share-dialog", !isPhone() && "max-w-[30rem]")}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          ((e.currentTarget as HTMLElement).querySelector<HTMLElement>(".share-email") ?? (e.currentTarget as HTMLElement).querySelector<HTMLElement>("button"))?.focus();
        }}
      >
        <DialogTitle className="share-title">
          Share{name ? <> “<span className="share-title-name">{name.trim() || "Untitled"}</span>”</> : null}
        </DialogTitle>
        {!signedIn ? (
          <div className="share-signin">
            <DialogDescription className="text-[13.5px]">Sign in to your Etude account to share. The people you invite sign in with theirs.</DialogDescription>
            <button type="button" className="lib-primary share-primary" onClick={() => (onClose(), navigate("/settings#account"))}>Open Settings → Account</button>
          </div>
        ) : (
          <>
            <DialogDescription className="share-desc">
              {removed
                ? "You no longer have access to this. The copy on your device stays, and you can keep it or delete it."
                : space && space.rootId !== noteId
                  ? `This is inside “${space.name?.trim() || "a shared folder"}”, shared by ${space.role === "owner" ? "you" : personName(space.owner)}. Everyone there sees it.`
                  : myRole === "view"
                    ? `${personName(space!.owner)} shared this with you. You can read it; only editors can change it.`
                    : "Invite people by email. It shows up in their Notebook."}
            </DialogDescription>
            {canInvite && (
              <form
                className="share-invite-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void invite();
                }}
              >
                <input
                  ref={input}
                  className={cn("share-email", badField && "is-bad")}
                  aria-invalid={badField}
                  type="text"
                  inputMode="email"
                  value={emails}
                  onChange={(e) => (setEmails(e.target.value), error && setError(null))}
                  placeholder="Add people by email"
                  aria-label="Email addresses"
                  spellCheck={false}
                  autoComplete="email"
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <div className="share-invite-ctl">
                  <RolePicker value={role} onPick={setRole} />
                  <button type="submit" disabled={busy || !emails.trim()} className="lib-primary share-primary">{busy && emails.trim() ? "Inviting…" : "Invite"}</button>
                </div>
              </form>
            )}
            {error && (
              <p className="share-error" role="alert">
                {error}
                {needsSync && (
                  <>
                    {" "}
                    <button type="button" className="share-inline-link" onClick={() => (onClose(), navigate("/settings#sync"))}>Set up Sync</button>
                  </>
                )}
              </p>
            )}
            {space?.waitingKey && !error && <p className="share-warn">{WAITING_KEY}</p>}
            {space?.error && !error && <p className="share-warn">Last sync didn't finish: {space.error}</p>}
            <div className="share-people">
              <div className="share-label">People with access</div>
              {space === undefined ? (
                <p className="share-empty">Looking…</p>
              ) : !space ? (
                <p className="share-empty">Only you. Invite someone to start sharing.</p>
              ) : (
                <ul>
                  {members.map((m) => (
                    <Person
                      key={m.id}
                      m={m}
                      now={now}
                      act={activity?.members.find((a) => a.memberId === m.id)}
                      on={m.accountId ? peopleIn((ctx?.people ?? []).filter((p) => p.space === space.id && p.accountId === m.accountId))[0] : undefined}
                      me={!!myEmail && m.email.toLowerCase() === myEmail}
                      owner={isOwner && !removed}
                      onRole={(r) => r !== m.role && void act(() => shareApi.setRole(space.id, m.id, r))}
                      onRemove={() => void act(() => shareApi.remove(space.id, m.id))}
                      onLeave={() => setConfirm("leave")}
                    />
                  ))}
                </ul>
              )}
            </div>
            {space && activity && activity.days.length > 0 && <ActivityStrip activity={activity} members={members} myEmail={myEmail} />}
            <div className="share-foot">
              {confirm ? (
                <div className="share-confirm" role="alertdialog" aria-label={confirm === "stop" ? "Stop sharing" : "Leave"}>
                  <p>{confirm === "stop" ? "Stop sharing with everyone? Your copy stays here as a private note; theirs stops updating." : "Leave this share? Your copy stays here as a private note and stops updating."}</p>
                  <div className="flex justify-end gap-2">
                    <button type="button" className="share-quiet" onClick={() => setConfirm(null)} autoFocus>Cancel</button>
                    <button
                      type="button"
                      disabled={busy}
                      className="share-danger"
                      onClick={() =>
                        space &&
                        void act(
                          () => (confirm === "stop" ? shareApi.stop(space.id) : shareApi.leave(space.id)),
                          () => (setConfirm(null), toast(confirm === "stop" ? "Stopped sharing. It's a private note again." : "You left. Your copy is a private note now.")),
                        )
                      }
                    >
                      {confirm === "stop" ? "Stop sharing" : "Leave"}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="share-lock">
                    <Lock className="size-3.5 shrink-0" />
                    <span>End-to-end encrypted. Only the people here can read it, on their own devices.</span>
                  </p>
                  {space && !removed && (isOwner ? (
                    <button type="button" className="share-link-danger" onClick={() => setConfirm("stop")}>Stop sharing</button>
                  ) : (
                    <button type="button" className="share-link-danger" onClick={() => setConfirm("leave")}>Leave</button>
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
