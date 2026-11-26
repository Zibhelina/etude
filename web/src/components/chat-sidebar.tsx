// The chats' sidebar: new chat, search through what was said, who you talk to, pinned chats, then the rest by when.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, MoreHorizontal, Menu, Pencil, Pin, PinOff, Plus, Search, Settings2, SquarePen, SquareArrowOutUpRight, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AgentAvatar } from "@/components/agent-avatar";
import { agentApi, agentKeptSession, DATA_EVENT, type Conversation } from "@/lib/agent";
import { announceChat, CHAT_CHANGED_EVENT } from "@/lib/agent-dock";
import { profileFrom, useAgentProfiles, type ProfileView } from "@/lib/agent-profiles";
import { cn } from "@/lib/utils";

type Hit = { id: string; snippet: string; role: "title" | "user" | "assistant" };

/** Today, Yesterday, Previous 7 days, Previous 30 days, then one group per month. */
function when(iso: string, now: Date): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return d.toLocaleDateString(undefined, { month: "long", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** The words that matched, in the foreground; the rest stays quiet. */
function Marked({ text, q }: { text: string; q: string }) {
  const parts = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return [text];
    const out: React.ReactNode[] = [];
    let i = 0;
    const low = text.toLowerCase();
    for (let at = low.indexOf(n); at >= 0; at = low.indexOf(n, i)) {
      out.push(text.slice(i, at), <b key={at}>{text.slice(at, at + n.length)}</b>);
      i = at + n.length;
    }
    out.push(text.slice(i));
    return out;
  }, [text, q]);
  return <>{parts}</>;
}

export function ChatSidebar({ convs, profiles, active, current, overlay, embedded = false, noPeople = false, running: runningProp, onClose, onPick, onNew, onNewWith, onDelete, onRenamed, onOpenNew, onSettings }: {
  convs: Conversation[];
  profiles: ProfileView[];
  /** The chat open beside it. */
  active: string | null;
  /** Who that chat is with. */
  current: ProfileView;
  /** Drawn over the chat (a narrow pane), with a scrim; else beside it. */
  overlay: boolean;
  /** Inside the app sidebar (Notes' Chats): no head or foot of its own, and it scrolls with the sidebar. */
  embedded?: boolean;
  /** No list of agents above the chats (the Agents screen shows them as cards of its own). */
  noPeople?: boolean;
  /** Chats writing a reply now, when the caller already knows; else it asks every few seconds. */
  running?: string[];
  onClose(): void;
  onPick(id: string): void;
  onNew(): void;
  onNewWith(profile: string): void;
  onDelete(id: string): Promise<void> | void;
  /** A chat renamed or pinned here: the chat and the list catch up. */
  onRenamed(c: Conversation): void;
  /** Opens a chat in a tab of its own (the side panel only). */
  onOpenNew?(id: string): void;
  onSettings(): void;
}) {
  const [polled, setRunning] = useState<string[]>([]);
  const running = runningProp ?? polled;
  const [pins, setPins] = useState<Record<string, boolean>>({});
  const [who, setWho] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [sure, setSure] = useState<string | null>(null);
  const [showAllPeople, setShowAllPeople] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  // Which chats are writing a reply right now, kept fresh while the sidebar is open.
  useEffect(() => {
    if (runningProp) return;
    let on = true;
    const tick = () => agentApi.list().then((r) => on && setRunning(r.running)).catch(() => {});
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [!!runningProp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Search: titles at once, then the words said in every chat.
  useEffect(() => {
    const s = q.trim();
    if (!s) return setHits(null);
    let on = true;
    const t = setTimeout(() => agentApi.search(s).then((r) => on && setHits(r.results)).catch(() => on && setHits([])), 140);
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [q]);
  useEffect(() => {
    if (searching) requestAnimationFrame(() => field.current?.focus());
    else setQ("");
  }, [searching]);

  const pinned = (c: Conversation) => pins[c.id] ?? !!c.pinned;
  const byId = useMemo(() => new Map(convs.map((c) => [c.id, c])), [convs]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of convs) m[c.profile] = (m[c.profile] ?? 0) + 1;
    return m;
  }, [convs]);
  // Everyone you can talk to here, then anyone who only has old chats.
  const people = useMemo(() => profiles.filter((p) => p.available || counts[p.id]), [profiles, counts]);
  // When there are many agents, tuck zero-chat ones behind a toggle so recent chats stay above the fold.
  const quietIds = useMemo(() => {
    if (people.length <= 4) return new Set<string>();
    const quiet = people.filter((p) => (counts[p.id] ?? 0) === 0 && p.id !== who && p.id !== current.id);
    if (quiet.length === 0 || quiet.length >= people.length) return new Set<string>();
    return new Set(quiet.map((p) => p.id));
  }, [people, counts, who, current.id]);
  const visiblePeople = useMemo(
    () => (showAllPeople || quietIds.size === 0 ? people : people.filter((p) => !quietIds.has(p.id))),
    [people, showAllPeople, quietIds],
  );
  const shown = useMemo(() => convs.filter((c) => !who || c.profile === who), [convs, who]);
  const groups = useMemo(() => {
    const now = new Date();
    const out: { label: string; items: Conversation[] }[] = [];
    const top = shown.filter(pinned);
    if (top.length) out.push({ label: "Pinned", items: top });
    for (const c of shown) {
      if (pinned(c)) continue;
      const label = when(c.updated, now);
      const g = out[out.length - 1];
      if (g && g.label === label) g.items.push(c);
      else out.push({ label, items: [c] });
    }
    return out;
  }, [shown, pins]); // eslint-disable-line react-hooks/exhaustive-deps

  const pin = async (c: Conversation) => {
    const next = !pinned(c);
    setPins((p) => ({ ...p, [c.id]: next }));
    try {
      onRenamed(await agentApi.pin(c.id, next));
    } catch (e) {
      setPins((p) => ({ ...p, [c.id]: !next }));
      toast.error("Couldn't pin", { description: (e as Error).message });
    }
  };
  const rename = async (c: Conversation, title: string | null) => {
    setEditing(null);
    if (!title?.trim() || title.trim() === c.title) return;
    try {
      onRenamed(await agentApi.rename(c.id, title.trim()));
    } catch (e) {
      toast.error("Couldn't rename", { description: (e as Error).message });
    }
  };
  const pick = useCallback((id: string) => {
    onPick(id);
    if (overlay) onClose();
  }, [onPick, overlay, onClose]);

  const row = (c: Conversation, snippet?: React.ReactNode) => {
    const on = c.id === active;
    const busy = running.includes(c.id);
    const p = profileFrom({ default: "", profiles }, c.profile);
    if (editing === c.id) return <RenameField key={c.id} title={c.title || "New chat"} onDone={(t) => rename(c, t)} />;
    return (
      <li key={c.id} className={cn("csb-row group/row", on && "is-on", snippet && "has-snippet")} data-chat-row={c.id}>
        <button type="button" className="csb-row-main outline-ring focus-visible:outline-2" aria-current={on ? "true" : undefined} onClick={() => pick(c.id)} onDoubleClick={() => setEditing(c.id)} title={c.title || "New chat"}>
          {people.length > 1 && <AgentAvatar profile={p} size={16} className="csb-row-face" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate" data-chat-title>{snippet ? <Marked text={c.title || "New chat"} q={q} /> : c.title || "New chat"}</span>
            {snippet && <span className="csb-snippet">{snippet}</span>}
          </span>
          {busy && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Writing a reply" />}
        </button>
        <DropdownMenu onOpenChange={(o) => !o && setSure(null)}>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`Options for ${c.title || "New chat"}`} className="csb-row-more outline-ring focus-visible:outline-2">
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right" className="w-48" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuItem onSelect={() => pin(c)}>
              {pinned(c) ? <PinOff /> : <Pin />} {pinned(c) ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setEditing(c.id)}>
              <Pencil /> Rename
            </DropdownMenuItem>
            {onOpenNew && (
              <DropdownMenuItem onSelect={() => onOpenNew(c.id)}>
                <SquareArrowOutUpRight /> Open in a new tab
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive [&_svg]:text-destructive"
              onSelect={(e) => {
                if (sure !== c.id) {
                  e.preventDefault();
                  setSure(c.id);
                  return;
                }
                onDelete(c.id);
              }}
            >
              <Trash2 /> {sure === c.id ? "Delete for good?" : "Delete"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </li>
    );
  };

  const searchBox = (
    <div className="csb-search">
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <input
        ref={field}
        value={q}
        placeholder="Search chats…"
        aria-label="Search chats"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setSearching(false);
          } else if (e.key === "Enter" && hits?.[0] && byId.has(hits[0].id)) pick(hits[0].id);
        }}
      />
      <button type="button" aria-label="Stop searching" className="csb-icon" onClick={() => setSearching(false)}>
        <X className="size-4" />
      </button>
    </div>
  );

  const showPeople = people.length > 0 && !noPeople;

  return (
    <aside className={cn("csb", overlay && "is-overlay", embedded && "is-embedded")} data-chat-sidebar aria-label="Chats">
      {!embedded && <div className="csb-head">
        {searching ? (
          searchBox
        ) : (
          <>
            {/* Where the button that opened it was, so closing is the same click in the same spot. */}
            <button type="button" aria-label="Close the sidebar" title="Close the sidebar (Ctrl+Shift+S)" className="csb-icon" onClick={onClose}>
              <Menu className="size-[17px]" />
            </button>
            <span className="flex-1" />
            <button type="button" aria-label="Search chats" title="Search chats" className="csb-icon" onClick={() => setSearching(true)}>
              <Search className="size-[16px]" />
            </button>
            <button type="button" aria-label="New chat" title="New chat" className="csb-icon" onClick={() => (onNew(), overlay && onClose())}>
              <SquarePen className="size-[16px]" />
            </button>
            {!showPeople && (
              <button type="button" aria-label="Agents and models" title="Agents and models" className="csb-icon" onClick={onSettings}>
                <Settings2 className="size-[16px]" />
              </button>
            )}
          </>
        )}
      </div>}

      <div className="csb-scroll">
        {embedded && searching && searchBox}
        {hits !== null ? (
          <ul className="csb-list" data-chat-search>
            {hits.filter((h) => byId.has(h.id)).length === 0 ? (
              <li className="csb-empty">Nothing said “{q.trim()}” yet.</li>
            ) : (
              hits.filter((h) => byId.has(h.id)).map((h) => row(byId.get(h.id)!, h.role === "title" ? <span>Title</span> : <><span className="csb-who">{h.role === "user" ? "You" : profileFrom({ default: "", profiles }, byId.get(h.id)!.profile).name}:</span> <Marked text={h.snippet.split(" · ").pop()!} q={q} /></>))
            )}
          </ul>
        ) : (
          <>
            {embedded && (
              <nav className="csb-nav">
                <button type="button" className="csb-nav-row" onClick={() => (onNew(), overlay && onClose())}>
                  <SquarePen className="size-[17px]" /> <span className="flex-1">New chat</span>
                </button>
                <button type="button" className="csb-nav-row" onClick={() => setSearching(true)}>
                  <Search className="size-[17px]" /> <span className="flex-1">Search chats</span>
                </button>
              </nav>
            )}

            {showPeople && (
              <section className="csb-section">
                <div className="csb-sec-head">
                  <h3 className="csb-label">Agents</h3>
                  {!embedded && (
                    <button type="button" aria-label="Agents and models" title="Agents and models" className="csb-sec-act outline-ring focus-visible:outline-2" onClick={onSettings}>
                      <Settings2 className="size-3.5" />
                    </button>
                  )}
                </div>
                <ul className="csb-list">
                  {visiblePeople.map((p) => (
                    <li key={p.id} className={cn("csb-row group/row", who === p.id && "is-on")}>
                      <button type="button" className="csb-row-main outline-ring focus-visible:outline-2" aria-pressed={who === p.id} title={who === p.id ? "Show everyone's chats" : `Only chats with ${p.name}`} onClick={() => setWho((w) => (w === p.id ? null : p.id))}>
                        <AgentAvatar profile={p} size={19} />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {who === p.id ? <Check className="size-3.5 shrink-0" /> : <span className="csb-count">{counts[p.id] ?? 0}</span>}
                      </button>
                      <button type="button" aria-label={`New chat with ${p.name}`} title={`New chat with ${p.name}`} disabled={!p.available} className="csb-row-more outline-ring focus-visible:outline-2" onClick={() => (onNewWith(p.id), overlay && onClose())}>
                        <Plus className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
                {quietIds.size > 0 && (
                  <button type="button" className="csb-more-people outline-ring focus-visible:outline-2" onClick={() => setShowAllPeople((v) => !v)}>
                    {showAllPeople ? "Show fewer" : `+${quietIds.size} more`}
                  </button>
                )}
              </section>
            )}

            {groups.length === 0 ? (
              <p className="csb-empty">{who ? "No chats with them yet." : "No chats yet."}</p>
            ) : (
              groups.map((g) => (
                <section key={g.label} className="csb-section">
                  <h3 className="csb-label">{g.label}</h3>
                  <ul className="csb-list">{g.items.map((c) => row(c))}</ul>
                </section>
              ))
            )}
          </>
        )}
      </div>
      {!embedded && <div className="csb-fade" aria-hidden="true" />}
    </aside>
  );
}

function RenameField({ title, onDone }: { title: string; onDone(t: string | null): void }) {
  const [v, setV] = useState(title);
  const done = useRef(false);
  const finish = (t: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(t);
  };
  return (
    <li className="csb-row is-editing">
      <input
        autoFocus
        value={v}
        aria-label="Chat name"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => finish(v)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(v);
          else if (e.key === "Escape") {
            e.stopPropagation();
            finish(null);
          }
        }}
      />
    </li>
  );
}

/**
 * The chats as Notes shows them in the app sidebar: the same list, with no head or foot, loading its own data.
 * `active` is the chat in the front tab of the focused pane; opening one goes through the Notebook (`onOpen`).
 */
export function NotesChats({ active, onOpen, onNewWith, onOpenNew, noPeople = false }: { active: string | null; onOpen(conv: string | null): void; onNewWith(profile: string): void; onOpenNew(conv: string): void; noPeople?: boolean }) {
  const profiles = useAgentProfiles();
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [running, setRunning] = useState<string[]>([]);
  useEffect(() => {
    let on = true;
    const load = () =>
      agentApi
        .list()
        .then((r) => {
          if (!on) return;
          setConvs(r.conversations);
          setRunning(r.running);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 4000);
    window.addEventListener(CHAT_CHANGED_EVENT, load);
    window.addEventListener(DATA_EVENT, load);
    return () => {
      on = false;
      clearInterval(t);
      window.removeEventListener(CHAT_CHANGED_EVENT, load);
      window.removeEventListener(DATA_EVENT, load);
    };
  }, []);
  // A chat that just became the active one may be new: fetch so it shows at once.
  useEffect(() => {
    if (active && !convs.some((c) => c.id === active)) void agentApi.list().then((r) => setConvs(r.conversations)).catch(() => {});
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = profileFrom(profiles, convs.find((c) => c.id === active)?.profile ?? null);
  return (
    <ChatSidebar
      embedded
      noPeople={noPeople}
      convs={convs}
      running={running}
      profiles={profiles.profiles}
      active={active}
      current={current}
      overlay={false}
      onClose={() => {}}
      onPick={(id) => onOpen(id)}
      onNew={() => onOpen(null)}
      onNewWith={onNewWith}
      onDelete={async (id) => {
        try {
          const kept = agentKeptSession(await agentApi.remove(id));
          if (kept) toast.warning(kept);
          setConvs((cs) => cs.filter((c) => c.id !== id));
          announceChat({ deleted: id });
        } catch (e) {
          toast.error((e as Error).message);
        }
      }}
      onRenamed={(c) => {
        setConvs((cs) => cs.map((x) => (x.id === c.id ? c : x)));
        announceChat({ conv: c });
      }}
      onOpenNew={onOpenNew}
      onSettings={() => {}}
    />
  );
}
