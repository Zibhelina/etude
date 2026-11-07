// The desktop and iPad sidebar ("Panel"): attached full height on the left, the wordmark and its toggle on top,
// the screens in two groups (Study, Make), and at the bottom the update button and who you are with Sync's state.
// Collapsed it folds to a rail of icons, in one motion (see Sidebar). Only desktops (the desktop app, browsers, iPad) get it, at any width; phones get the tab island.
import { useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SidebarIcon } from "@/components/sidebar-icon";
import { Wordmark } from "@/components/logo";
import { SidebarUpdate } from "@/components/update-bar";
import { ACCOUNT_EVENT } from "@/components/settings-account";
import { ArchiveIcon, BrowseIcon, LibraryIcon, NotesIcon, MarketIcon, SettingsIcon, StatsIcon, TypesIcon } from "@/components/nav-icons";
import { account } from "@/lib/account";
import { useMyName } from "@/lib/avatar";
import { MyAvatar } from "@/components/avatar";
import { openNoteGraph } from "@/components/note-graph";
import { etudeFetch } from "@/lib/transport";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { SB_DEFAULT, SB_FOLD, SB_MAX, SB_MIN, runNotesAction, setNotesPagesOpen, setNotesSlot, setSidebarWidth, useNotesPagesOpen, useSidebarWidth, type NotesAction } from "@/lib/sidebar-slot";

type Item = { to: string; label: string; beta?: boolean; icon: (p: { className?: string }) => React.ReactNode; match(p: string): boolean };

export const NAV_GROUPS: { label: string; items: Item[] }[] = [
  {
    label: "Study",
    items: [
      { to: "/", label: "Library", icon: LibraryIcon, match: (p) => p === "/" || p === "/deck" },
      { to: "/notes", label: "Notes", beta: true, icon: NotesIcon, match: (p) => p === "/notes" },
      { to: "/browse", label: "Browse", icon: BrowseIcon, match: (p) => p === "/browse" },
      { to: "/stats", label: "Stats", icon: StatsIcon, match: (p) => p === "/stats" },
      { to: "/archive", label: "Archive", icon: ArchiveIcon, match: (p) => p === "/archive" },
    ],
  },
  {
    label: "Make",
    items: [
      { to: "/types", label: "Card types", icon: TypesIcon, match: (p) => p.startsWith("/types") },
      { to: "/market", label: "Market", icon: MarketIcon, match: (p) => p === "/market" },
    ],
  },
];

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const SIDEBAR_KEY = mac ? "⌘[" : "Ctrl+[";

/**
 * Hover help in a rail, nothing when the label is already showing. The Tooltip stays mounted either way (only its
 * content comes and goes), so the button inside isn't remounted on toggle and its own transitions get to play.
 */
function Tip({ show, label, children }: { show: boolean; label: React.ReactNode; children: React.ReactElement }) {
  return (
    <Tooltip disabled={!show}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

// The open sidebar and the rail share one layout: icons sit at the same x in both (the rail's centre line), and
// the labels, wordmark, group titles and profile name stay mounted and fade, so folding is one motion with the width
// instead of things popping in and out. The timing lives in index.css (.shell-sb).
// The width is yours: drag the sidebar's right edge (200–480 px, remembered); let go narrower than 150 and it folds
// into the rail, drag the rail out and it opens again; double-click the edge for the usual width. On Notes your
// pages hang under the Notes row (Notes portals its tree into the slot), and the other tabs come after them: with a
// long tree you scroll the sidebar down to reach them.
export function Sidebar({ path, collapsed, onToggle }: { path: string; collapsed: boolean; onToggle(): void }) {
  const hide = collapsed ? { "aria-hidden": true, tabIndex: -1 } : {};
  const width = useSidebarWidth();
  const pagesOpen = useNotesPagesOpen();
  const onNotes = path === "/notes";
  const showPages = onNotes && pagesOpen && !collapsed;
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? (collapsed ? 72 : width);
  return (
    <aside
      aria-label="Main"
      data-shell-sidebar
      data-collapsed={(drag === null ? collapsed : drag < SB_FOLD) || undefined}
      data-resizing={drag !== null || undefined}
      style={{ width: shown, ["--sbw" as string]: `${drag === null ? width : Math.max(SB_MIN, drag)}px` }}
      className="shell-sb sticky top-0 hidden h-dvh shrink-0 flex-col overflow-hidden bg-sidebar px-2.5 py-3.5 desktop:flex"
    >
      <ResizeGrip collapsed={collapsed} width={width} onToggle={onToggle} onDrag={setDrag} />
      <div className="relative mb-3.5 h-10 shrink-0">
        <button {...hide} onClick={() => navigate("/")} aria-label="Etude, go to Library" className="sb-fade absolute inset-y-0 left-0 w-[160px] rounded-md pl-3 text-left outline-ring focus-visible:outline-2">
          <Wordmark className="text-[1.45rem] leading-none whitespace-nowrap" />
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggle}
              aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
              aria-expanded={!collapsed}
              className="sb-toggle absolute top-0 left-0 flex size-10 items-center justify-center rounded-[10px] text-muted-foreground transition-colors outline-ring hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2"
            >
              <SidebarIcon className="size-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {collapsed ? "Show sidebar" : "Hide sidebar"} <span className="opacity-60">[ · {SIDEBAR_KEY}</span>
          </TooltipContent>
        </Tooltip>
      </div>

      <nav className="sb-nav -mx-2.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto px-2.5">
        {NAV_GROUPS.map((g, gi) => (
          <div key={g.label} className="flex flex-col gap-0.5">
            {/* Open: the group's title. Rail: nothing above the first group, a small gap above the others. */}
            <div className={cn("sb-group shrink-0 overflow-hidden", gi === 0 && "sb-group-first")}>
              <div aria-hidden={collapsed || undefined} className="sb-fade shell-group-label px-4 pt-[14px] pb-[6px] leading-4 whitespace-nowrap">
                {g.label}
              </div>
            </div>
            {g.items.map((n) => {
              const on = n.match(path);
              const isNotes = n.to === "/notes";
              const button = (
                <button
                  onClick={() => {
                    // Notes: clicking it again shows or hides your pages; from another tab it opens them.
                    if (isNotes && onNotes && !collapsed) return setNotesPagesOpen(!pagesOpen);
                    if (isNotes) setNotesPagesOpen(true);
                    navigate(n.to);
                  }}
                  aria-label={n.label}
                  aria-current={on ? "page" : undefined}
                  aria-expanded={isNotes && onNotes && !collapsed ? pagesOpen : undefined}
                  className={cn(
                    "flex h-10 w-full shrink-0 items-center gap-3 rounded-[10px] px-4 text-[14.5px] whitespace-nowrap text-muted-foreground transition-colors outline-ring hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2",
                    on && "font-[650] text-foreground",
                    // With your pages showing, the open page carries the highlight, not Notes.
                    on && !(isNotes && showPages) && "bg-sidebar-accent",
                  )}
                >
                  <n.icon className="size-5 shrink-0" />
                  <span className="sb-fade sb-slide">{n.label}</span>
                  {n.beta && <span className="sb-fade sb-beta">beta</span>}
                </button>
              );
              return (
                <div key={n.to} className="contents">
                  <Tip show={collapsed} label={n.label}>
                    {isNotes ? <NotesMenu pagesOpen={showPages}>{button}</NotesMenu> : button}
                  </Tip>
                  {isNotes && showPages && <div ref={setNotesSlot} data-notes-slot className="sb-pages shrink-0" />}
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="flex shrink-0 flex-col gap-2 pt-4">
        <SidebarUpdate collapsed={collapsed} />
        <ProfileRow collapsed={collapsed} settingsOn={path === "/settings"} />
      </div>
    </aside>
  );
}

/** Right-click Notes: what used to be the buttons on its row. From another tab, Notes opens and then does it. */
function NotesMenu({ pagesOpen, children }: { pagesOpen: boolean; children: React.ReactElement }) {
  const run = (a: NotesAction) => {
    if (!runNotesAction(a)) {
      setNotesPagesOpen(true);
      navigate("/notes");
    }
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60" onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuItem onSelect={() => run("new")}>
          New page <span className="ml-auto text-[12px] text-muted-foreground">{mac ? "⌘⌥N" : "Ctrl+Alt+N"}</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => run("new-canvas")}>New canvas</ContextMenuItem>
        <ContextMenuItem onSelect={() => run("new-file")}>New file</ContextMenuItem>
        <ContextMenuItem onSelect={() => run("new-folder")}>New folder</ContextMenuItem>
        <ContextMenuItem onSelect={() => run("add-pdf")}>Add a PDF…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => run("import-md")}>Import Markdown or code files…</ContextMenuItem>
        <ContextMenuItem onSelect={() => run("import-vault")}>Import a folder (Obsidian vault)…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            if (location.pathname.endsWith("/notes") || pagesOpen) setNotesPagesOpen(!pagesOpen);
            else run("fold-all");
          }}
        >
          {pagesOpen ? "Hide pages" : "Show pages"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => run("fold-all")}>Fold every page</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => openNoteGraph()}>View graph</ContextMenuItem>
        <ContextMenuItem onSelect={() => run("tutorial")}>Notes tutorial</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The sidebar's right edge. Drag it to resize; past the fold point it becomes the rail. */
function ResizeGrip({ collapsed, width, onToggle, onDrag }: { collapsed: boolean; width: number; onToggle(): void; onDrag(w: number | null): void }) {
  const [hot, setHot] = useState(false);
  const live = useRef<number | null>(null);
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = collapsed ? 72 : width;
    let moved = false;
    setHot(true);
    document.body.classList.add("sb-dragging");
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      const w = Math.min(SB_MAX, w0 + ev.clientX - x0);
      live.current = w;
      onDrag(w < SB_FOLD ? 72 : Math.max(SB_MIN, w));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.classList.remove("sb-dragging");
      setHot(false);
      const w = live.current;
      live.current = null;
      onDrag(null);
      if (!moved || w === null) return;
      if (w < SB_FOLD) {
        if (!collapsed) onToggle();
      } else {
        setSidebarWidth(w);
        if (collapsed) onToggle();
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuenow={collapsed ? 72 : width}
      aria-valuemin={SB_MIN}
      aria-valuemax={SB_MAX}
      tabIndex={-1}
      title="Drag to resize · double-click for the usual width"
      data-on={hot || undefined}
      onPointerDown={down}
      onDoubleClick={() => {
        setSidebarWidth(SB_DEFAULT);
        if (collapsed) onToggle();
      }}
      className="sb-grip"
    />
  );
}

// ---------------------------------------------------------------- who you are, and Sync

interface SyncState {
  configured: boolean;
  kind: "folder" | "cloud" | null;
  signedIn: boolean;
  account?: boolean;
  email?: string;
  unlocked: boolean;
  lastSync: string | null;
  error: string | null;
  busy: boolean;
}

const NAME_KEY = "etude.shell.name";

/** The local Sync state (cheap, polled) and the account's display name (fetched once per sign-in, then remembered). */
function useWho() {
  const [sync, setSync] = useState<SyncState | null>(null);
  const [name, setName] = useState<string | null>(() => localStorage.getItem(NAME_KEY));
  useEffect(() => {
    let live = true;
    const load = () =>
      etudeFetch("/api/sync/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((s: SyncState | null) => live && s && setSync(s))
        .catch(() => {});
    const named = () =>
      account
        .status()
        .then((a) => {
          if (!live) return;
          const n = a.me?.displayName?.trim() || null;
          if (n) localStorage.setItem(NAME_KEY, n);
          else if (!a.signedIn) localStorage.removeItem(NAME_KEY);
          setName(n);
        })
        .catch(() => {});
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    const onAccount = () => {
      void load();
      void named();
    };
    window.addEventListener(ACCOUNT_EVENT, onAccount);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener(ACCOUNT_EVENT, onAccount);
      window.removeEventListener("focus", load);
    };
  }, []);
  // Signed in but no name remembered yet: ask the account once.
  useEffect(() => {
    if (!sync?.signedIn || name) return;
    let live = true;
    account.status().then((a) => {
      const n = a.me?.displayName?.trim();
      if (live && n) {
        localStorage.setItem(NAME_KEY, n);
        setName(n);
      }
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [sync?.signedIn, name]);
  return { sync, name };
}

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!(s >= 0)) return "Synced";
  if (s < 60) return "Synced just now";
  if (s < 3600) return `Synced ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `Synced ${Math.floor(s / 3600)} h ago`;
  return `Synced ${new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function describe(sync: SyncState | null, name: string | null) {
  const email = sync?.email ?? null;
  const who = name || (email ? email.split("@")[0] : null);
  const [line, tone]: [string, "ok" | "warn" | "off"] = !sync
    ? ["", "off"]
    : !sync.configured
      ? ["Sync is off", "off"]
      : sync.error
        ? ["Sync needs a look", "warn"]
        : sync.kind === "cloud" && !sync.signedIn
          ? ["Sync is signed out", "warn"]
          : !sync.unlocked
            ? ["Sync is locked", "warn"]
            : sync.busy
              ? ["Syncing…", "ok"]
              : ["Sync on", "ok"];
  const when = sync?.lastSync ? ago(sync.lastSync) : null;
  return { who: who ?? (sync?.kind === "folder" ? "This device" : "Sign in"), initial: (who ?? "").trim().charAt(0).toUpperCase(), line, tone, email, when };
}

function ProfileRow({ collapsed, settingsOn }: { collapsed: boolean; settingsOn: boolean }) {
  const { sync, name } = useWho();
  const mine = useMyName();
  const d = describe(sync, mine || name);
  const label = d.line ? `${d.who} · ${d.line}` : d.who;
  // The whole row is one button to Settings: picture, name with Sync's state, and the gear light up together on
  // hover (the gear turns a little). Being on Settings doesn't keep it lit; only the mouse does. One box for both
  // shapes: open, picture · name · gear on one row; rail, only the picture. The picture keeps its place and the name
  // and gear fade, all on the sidebar's timing (index.css .sb-profile).
  return (
    <div data-shell-profile className="sb-profile relative shrink-0">
      <Tip show={collapsed} label={`Settings · ${label}`}>
        <button
          onClick={() => navigate("/settings")}
          aria-label={`Settings · ${label}`}
          aria-current={settingsOn ? "page" : undefined}
          title={collapsed ? undefined : [d.email, d.when].filter(Boolean).join(" · ") || undefined}
          data-shell-profile-button
          className="group/prof absolute inset-0 rounded-[12px] text-left transition-colors duration-150 outline-ring hover:bg-sidebar-accent focus-visible:outline-2 motion-reduce:transition-none"
        >
          <span className="sb-avatar absolute top-0 left-1.5 flex">
            <MyAvatar size={40} initial={d.initial} />
            {d.tone === "warn" && <span aria-hidden className="sb-rail-only absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-warning ring-2 ring-sidebar" />}
          </span>
          <span aria-hidden={collapsed || undefined} className="sb-fade sb-slide sb-who absolute top-2 left-14 flex h-10 min-w-0 items-center whitespace-nowrap">
            <span className="min-w-0 flex-1">
              <b className="block truncate text-[14px] font-semibold text-foreground">{d.who}</b>
              <small className={cn("block truncate text-[12px]", d.tone === "warn" ? "text-warning" : "text-muted-foreground")}>{d.line || "\u00a0"}</small>
            </span>
          </span>
          <span aria-hidden className="sb-gear absolute top-0 left-0 flex size-9 items-center justify-center text-muted-foreground transition-colors duration-150 group-hover/prof:text-foreground">
            <SettingsIcon className="size-[18px] transition-transform duration-[350ms] ease-[cubic-bezier(.3,.7,.2,1)] group-hover/prof:rotate-45 motion-reduce:transition-none" />
          </span>
        </button>
      </Tip>
    </div>
  );
}
