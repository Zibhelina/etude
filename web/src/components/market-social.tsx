// Likes, dislikes, downloads and comments on Market entries (lib/market-social.ts talks to the account server).
// Votes and comments need an Etude account; counts are public. Every comment can be reported, and its author blocked:
// three reports hide a comment until an admin looks at it.
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Flag, Loader2, MessageCircle, MoreHorizontal, Pencil, ThumbsDown, ThumbsUp, Trash2, UserX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ago, compact, social, type EntryCounts, type EntryStats, type MarketComment } from "@/lib/market-social";
import { account } from "@/lib/account";
import { Input } from "@/components/ui/input";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const msg = (e: unknown) => (e instanceof Error ? e.message : "The request failed.");
const signIn = () => navigate("/settings#account");
const EMPTY: EntryStats = { likes: 0, dislikes: 0, downloads: 0, comments: 0, myVote: 0 };

/** An entry's live numbers, for its page. `null` until the first answer; zeros when the server can't be reached. */
export function useEntryStats(k: string) {
  const [stats, setStats] = useState<EntryStats | null>(null);
  useEffect(() => {
    let live = true;
    social.entry(k).then((s) => live && setStats(s)).catch(() => live && setStats(EMPTY));
    return () => void (live = false);
  }, [k]);
  return [stats, setStats] as const;
}

/** Share of likes among votes, as the App Store shows a rating: "92%" over "1.2k votes". */
export function approval(s: EntryCounts | null | undefined): string | null {
  const n = (s?.likes ?? 0) + (s?.dislikes ?? 0);
  return n ? `${Math.round(((s!.likes) / n) * 100)}%` : null;
}

/** 👍 / 👎 with their counts. Pressing your vote again takes it back. */
export function Votes({ k, stats, setStats, signedIn }: { k: string; stats: EntryStats | null; setStats(s: EntryStats): void; signedIn: boolean }) {
  const [busy, setBusy] = useState(false);
  const s = stats ?? EMPTY;
  const vote = async (v: 1 | -1) => {
    if (!signedIn) {
      toast("Sign in to vote", { description: "One vote per Etude account.", action: { label: "Sign in", onClick: signIn } });
      return;
    }
    const value = (s.myVote === v ? 0 : v) as -1 | 0 | 1;
    // Show it at once; the server's answer replaces it.
    const prev = s;
    const next = { ...s, myVote: value, likes: s.likes - (s.myVote === 1 ? 1 : 0) + (value === 1 ? 1 : 0), dislikes: s.dislikes - (s.myVote === -1 ? 1 : 0) + (value === -1 ? 1 : 0) };
    setStats(next);
    setBusy(true);
    try {
      setStats(await social.vote(k, value));
    } catch (e) {
      setStats(prev);
      toast.error("Couldn't save your vote", { description: msg(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mk-votes" role="group" aria-label="Vote" data-votes>
      <button type="button" aria-pressed={s.myVote === 1} disabled={busy} onClick={() => void vote(1)} aria-label={`Like (${s.likes})`} data-like>
        <ThumbsUp className="size-[17px]" strokeWidth={2.1} />
        <span>{compact(s.likes)}</span>
      </button>
      <i aria-hidden="true" />
      <button type="button" aria-pressed={s.myVote === -1} disabled={busy} onClick={() => void vote(-1)} aria-label={`Dislike (${s.dislikes})`} data-dislike>
        <ThumbsDown className="size-[17px]" strokeWidth={2.1} />
        <span>{compact(s.dislikes)}</span>
      </button>
    </div>
  );
}

/** The small counts under a tile: likes and downloads, only when there are any. */
export function TileCounts({ c }: { c?: EntryCounts }) {
  if (!c || (!c.likes && !c.downloads)) return null;
  return (
    <span className="mk-counts" data-tile-counts>
      {c.likes > 0 && <span><ThumbsUp className="size-3" strokeWidth={2.4} />{compact(c.likes)}</span>}
      {c.downloads > 0 && <span><Download className="size-3" strokeWidth={2.4} />{compact(c.downloads)}</span>}
    </span>
  );
}

/** The cells the detail page puts in its numbers row (likes share, downloads, comments). */
export function socialCells(s: EntryStats | null) {
  const share = approval(s);
  const votes = (s?.likes ?? 0) + (s?.dislikes ?? 0);
  return [
    { key: "likes", label: votes ? `${compact(votes)} ${votes === 1 ? "vote" : "votes"}` : "No votes yet", value: share ? <><ThumbsUp className="size-4" strokeWidth={2.3} />{share}</> : "–" },
    { key: "downloads", label: "Downloads", value: s ? compact(s.downloads) : "–" },
    { key: "comments", label: "Comments", value: s ? <a href="#market-comments" className="hover:underline" onClick={(e) => (e.preventDefault(), document.getElementById("market-comments")?.scrollIntoView({ behavior: "smooth", block: "start" }))}>{compact(s.comments)}</a> : "–" },
  ];
}

// ------------------------------------------------------------------ comments

export function Comments({ k, signedIn, onCount }: { k: string; signedIn: boolean; onCount?(d: number): void }) {
  const [list, setList] = useState<MarketComment[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [reporting, setReporting] = useState<MarketComment | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // The name beside your comments: asked for once, right before your first post, if the account has none.
  const named = useRef<boolean | null>(null);
  const [askName, setAskName] = useState(false);
  const [name, setName] = useState("");

  const load = useCallback(async (before?: string) => {
    try {
      const r = await social.comments(k, before);
      setList((l) => (before && l ? [...l, ...r.comments] : r.comments));
      setNext(r.next);
      setError(false);
    } catch {
      setError(true);
      setList((l) => l ?? []);
    }
  }, [k]);
  useEffect(() => void load(), [load]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      if (named.current === null) named.current = !!(await account.status().catch(() => null))?.me?.displayName?.trim();
      if (!named.current) {
        if (!askName) return setAskName(true);
        const n = name.trim();
        if (!n) return;
        await account.setName(n);
        named.current = true;
        setAskName(false);
      }
      const c = await social.comment(k, body);
      setList((l) => [c, ...(l ?? [])]);
      setText("");
      onCount?.(1);
    } catch (e) {
      toast.error("Couldn't post that", { description: msg(e) });
    } finally {
      setSending(false);
    }
  };
  const remove = async (c: MarketComment) => {
    try {
      await social.remove(c.id);
      setList((l) => l?.filter((x) => x.id !== c.id) ?? null);
      onCount?.(-1);
    } catch (e) {
      toast.error("Couldn't delete it", { description: msg(e) });
    }
  };
  const block = async (c: MarketComment) => {
    try {
      await social.block(c.authorId);
      const gone = list?.filter((x) => x.authorId === c.authorId).length ?? 0;
      setList((l) => l?.filter((x) => x.authorId !== c.authorId) ?? null);
      toast(`You won't see ${c.author}'s comments anymore`, {
        action: {
          label: "Undo",
          onClick: () => void social.unblock(c.authorId).then(() => load()).catch((e) => toast.error("Couldn't undo", { description: msg(e) })),
        },
      });
      if (gone) onCount?.(-gone);
    } catch (e) {
      toast.error("Couldn't block them", { description: msg(e) });
    }
  };

  return (
    <section id="market-comments" className="mk-sec mk-comments" data-comments>
      <h3 className="mk-serif">Comments{list && list.length > 0 && <span>{list.length}{next ? "+" : ""}</span>}</h3>
      {signedIn ? (
        <div className="mk-compose">
          <Textarea
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void send()}
            placeholder="What did you think? Be kind; people made this."
            rows={text ? 3 : 1}
            maxLength={2000}
            aria-label="Write a comment"
          />
          {askName && (
            <div className="mk-name" data-name-step>
              <label htmlFor="mk-name">Name people see beside your comments</label>
              <Input id="mk-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void send()} maxLength={80} autoFocus placeholder="Your name" />
              <span>Your email stays private. You can change the name in Settings → Account.</span>
            </div>
          )}
          {text.trim() && (
            <div className="mk-compose-bar">
              <span>{text.length > 1800 ? `${2000 - text.length} left` : "⌘ Enter to post"}</span>
              <Button variant="ghost" size="sm" onClick={() => (setText(""), setAskName(false))}>Cancel</Button>
              <Button size="sm" disabled={sending || (askName && !name.trim())} onClick={() => void send()} data-post>{sending && <Loader2 className="size-3.5 animate-spin" />}{askName ? "Save name and post" : "Post"}</Button>
            </div>
          )}
        </div>
      ) : (
        <button type="button" className="mk-compose signed-out" onClick={signIn}>
          <MessageCircle className="size-4" />Sign in to your Etude account to comment
        </button>
      )}
      {!list ? (
        <div className="mk-c-empty"><Loader2 className="size-4 animate-spin" /></div>
      ) : error && !list.length ? (
        <div className="mk-c-empty">Comments didn't load. <button className="underline underline-offset-2" onClick={() => void load()}>Try again</button></div>
      ) : !list.length ? (
        <div className="mk-c-empty">No comments yet.{signedIn && " Be the first."}</div>
      ) : (
        <ul className="mk-c-list">
          {list.map((c) => (
            <li key={c.id} data-comment={c.id}>
              <span className="mk-c-avatar" aria-hidden="true">{(c.author || "?").slice(0, 1).toUpperCase()}</span>
              <div className="mk-c-main">
                <div className="mk-c-head">
                  <b>{c.author}{c.mine && <em> · you</em>}</b>
                  <time dateTime={c.created} title={new Date(c.created).toLocaleString()}>{ago(c.created)}{c.edited && " · edited"}</time>
                  <CommentMenu c={c} signedIn={signedIn} onEdit={() => setEditing(c.id)} onDelete={() => void remove(c)} onReport={() => (signedIn ? setReporting(c) : signIn())} onBlock={() => (signedIn ? void block(c) : signIn())} />
                </div>
                {editing === c.id ? (
                  <EditBox c={c} onDone={(n) => (setEditing(null), n && setList((l) => l?.map((x) => (x.id === n.id ? n : x)) ?? null))} />
                ) : (
                  <p>{c.body}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {next && <Button variant="ghost" className="mt-1 text-foreground" onClick={() => void load(next)}>Show older</Button>}
      {reporting && <ReportDialog c={reporting} onClose={() => setReporting(null)} onReported={() => { setList((l) => l?.filter((x) => x.id !== reporting.id) ?? null); setReporting(null); }} />}
    </section>
  );
}

function CommentMenu({ c, signedIn, onEdit, onDelete, onReport, onBlock }: { c: MarketComment; signedIn: boolean; onEdit(): void; onDelete(): void; onReport(): void; onBlock(): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="mk-c-more" aria-label="Comment options"><MoreHorizontal className="size-4" /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {c.mine ? (
          <>
            <DropdownMenuItem onSelect={onEdit}><Pencil className="size-4" />Edit</DropdownMenuItem>
            <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive"><Trash2 className="size-4" />Delete</DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onSelect={onReport} data-report><Flag className="size-4" />Report{!signedIn && "…"}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onBlock} data-block><UserX className="size-4" />Block {c.author}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EditBox({ c, onDone }: { c: MarketComment; onDone(n: MarketComment | null): void }) {
  const [text, setText] = useState(c.body);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onDone(await social.edit(c.id, text.trim()));
    } catch (e) {
      toast.error("Couldn't save it", { description: msg(e) });
      setBusy(false);
    }
  };
  return (
    <div className="mk-compose mt-1">
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} autoFocus aria-label="Edit your comment" />
      <div className="mk-compose-bar">
        <span />
        <Button variant="ghost" size="sm" onClick={() => onDone(null)}>Cancel</Button>
        <Button size="sm" disabled={busy || !text.trim() || text.trim() === c.body} onClick={() => void save()}>Save</Button>
      </div>
    </div>
  );
}

const REASONS = ["Spam or ads", "Rude or hateful", "Sexual or violent", "Something else"];

function ReportDialog({ c, onClose, onReported }: { c: MarketComment; onClose(): void; onReported(): void }) {
  const [reason, setReason] = useState(REASONS[0]);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await social.report(c.id, reason);
      toast.success("Thanks, we'll look at it", { description: "It's hidden for you now." });
      onReported();
    } catch (e) {
      toast.error("Couldn't send the report", { description: msg(e) });
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Report this comment</DialogTitle>
          <DialogDescription>By {c.author}. The Etude team reads every report.</DialogDescription>
        </DialogHeader>
        <div className="mk-reasons" role="radiogroup" aria-label="Reason">
          {REASONS.map((r) => (
            <button key={r} role="radio" aria-checked={reason === r} className={cn(reason === r && "on")} onClick={() => setReason(r)}>{r}</button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void send()} data-send-report>{busy && <Loader2 className="size-4 animate-spin" />}Report</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
