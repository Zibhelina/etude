// The desktop and iPad sidebar ("Panel"): attached full height on the left, the wordmark and its toggle on top,
// the screens in two groups (Study, Make), and at the bottom the update button and who you are with Sync's state.
// Collapsed it folds to a rail of icons, in one motion (see Sidebar). Nothing here renders below md (768 px); phones get the tab island.
import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SidebarIcon } from "@/components/sidebar-icon";
import { Wordmark } from "@/components/logo";
import { SidebarUpdate } from "@/components/update-bar";
import { ACCOUNT_EVENT } from "@/components/settings-account";
import { ArchiveIcon, BrowseIcon, LibraryIcon, MarketIcon, SettingsIcon, StatsIcon, TypesIcon } from "@/components/nav-icons";
import { account } from "@/lib/account";
import { useMyName } from "@/lib/avatar";
import { MyAvatar } from "@/components/avatar";
import { etudeFetch } from "@/lib/transport";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

type Item = { to: string; label: string; icon: (p: { className?: string }) => React.ReactNode; match(p: string): boolean };

export const NAV_GROUPS: { label: string; items: Item[] }[] = [
  {
    label: "Study",
    items: [
      { to: "/", label: "Library", icon: LibraryIcon, match: (p) => p === "/" || p === "/deck" },
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
export const SIDEBAR_KEY = mac ? "⌘B" : "Ctrl+B";

/**
 * Hover help in a rail, nothing when the label is already showing. The Tooltip stays mounted either way (only its
 * content comes and goes), so the button inside isn't remounted on toggle and its own transitions get to play.
 */
function Tip({ show, label, children }: { show: boolean; label: React.ReactNode; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {show && <TooltipContent side="right">{label}</TooltipContent>}
    </Tooltip>
  );
}

// The open sidebar and the rail share one layout: icons sit at the same x in both (the rail's centre line), and
// the labels, wordmark, group titles and profile name stay mounted and fade, so folding is one motion with the width
// instead of things popping in and out. The timing lives in index.css (.shell-sb).
export function Sidebar({ path, collapsed, onToggle }: { path: string; collapsed: boolean; onToggle(): void }) {
  const hide = collapsed ? { "aria-hidden": true, tabIndex: -1 } : {};
  return (
    <aside
      aria-label="Main"
      data-shell-sidebar
      data-collapsed={collapsed || undefined}
      className={cn("shell-sb sticky top-0 hidden h-dvh shrink-0 flex-col overflow-hidden bg-sidebar px-2.5 py-3.5 md:flex", collapsed ? "w-[72px]" : "w-[232px]")}
    >
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

      <nav className="flex flex-col gap-0.5">
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
              return (
                <Tip key={n.to} show={collapsed} label={n.label}>
                  <button
                    onClick={() => navigate(n.to)}
                    aria-label={n.label}
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "flex h-10 w-full shrink-0 items-center gap-3 rounded-[10px] px-4 text-[14.5px] whitespace-nowrap text-muted-foreground transition-colors outline-ring hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2",
                      on && "bg-sidebar-accent font-[650] text-foreground",
                    )}
                  >
                    <n.icon className="size-5 shrink-0" />
                    <span className="sb-fade sb-slide">{n.label}</span>
                  </button>
                </Tip>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-2 pt-4">
        <SidebarUpdate collapsed={collapsed} />
        <ProfileRow collapsed={collapsed} settingsOn={path === "/settings"} />
      </div>
    </aside>
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
          <span aria-hidden={collapsed || undefined} className="sb-fade sb-slide absolute top-2 left-14 flex h-10 w-[110px] min-w-0 items-center whitespace-nowrap">
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
