// The desktop and iPad sidebar ("Panel"): attached full height on the left, the wordmark and its toggle on top,
// the screens in two groups (Study, Make), and at the bottom the update button and who you are with Sync's state.
// Collapsed it folds to a rail of icons. Nothing here renders below md (768 px); phones get the tab island.
import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SidebarIcon } from "@/components/sidebar-icon";
import { Wordmark } from "@/components/logo";
import { SidebarUpdate } from "@/components/update-bar";
import { ACCOUNT_EVENT } from "@/components/settings-account";
import { ArchiveIcon, BrowseIcon, LibraryIcon, MarketIcon, SettingsIcon, StatsIcon, TypesIcon } from "@/components/nav-icons";
import { account } from "@/lib/account";
import { openAvatarDialog, useMyName } from "@/lib/avatar";
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

/** Hover help in a rail, nothing when the label is already showing. */
function Tip({ show, label, children }: { show: boolean; label: React.ReactNode; children: React.ReactElement }) {
  if (!show) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({ path, collapsed, onToggle }: { path: string; collapsed: boolean; onToggle(): void }) {
  return (
    <aside
      aria-label="Main"
      data-shell-sidebar
      data-collapsed={collapsed || undefined}
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 flex-col overflow-hidden bg-sidebar py-3.5 transition-[width,padding] duration-[220ms] ease-[cubic-bezier(.3,.7,.2,1)] motion-reduce:transition-none md:flex",
        collapsed ? "w-[72px] px-2.5" : "w-[232px] px-3",
      )}
    >
      <div className={cn("mb-3.5 flex h-10 shrink-0 items-center", collapsed && "justify-center")}>
        {!collapsed && (
          <button onClick={() => navigate("/")} aria-label="Etude, go to Library" className="min-w-0 flex-1 rounded-md px-2.5 text-left outline-ring focus-visible:outline-2">
            <Wordmark className="text-[1.45rem] leading-none" />
          </button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggle}
              aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
              aria-expanded={!collapsed}
              className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors outline-ring hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2"
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
            {collapsed ? (
              gi > 0 && <div aria-hidden className="h-4" />
            ) : (
              <div className="shell-group-label px-3 pt-3.5 pb-1.5 whitespace-nowrap">{g.label}</div>
            )}
            {g.items.map((n) => {
              const on = n.match(path);
              return (
                <Tip key={n.to} show={collapsed} label={n.label}>
                  <button
                    onClick={() => navigate(n.to)}
                    aria-label={n.label}
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "flex h-10 shrink-0 items-center gap-3 rounded-[10px] text-[14.5px] whitespace-nowrap text-muted-foreground transition-colors outline-ring hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2",
                      collapsed ? "mx-auto w-[52px] justify-center px-0" : "px-3",
                      on && "bg-sidebar-accent font-[650] text-foreground",
                    )}
                  >
                    <n.icon className="size-5 shrink-0" />
                    {!collapsed && <span>{n.label}</span>}
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
  // Your picture opens the picture dialog; the name beside it goes to Sync.
  const avatar = (
    <button onClick={openAvatarDialog} aria-label="Change your picture" data-shell-avatar className="relative shrink-0 rounded-full outline-ring transition-transform duration-150 hover:scale-105 focus-visible:outline-2 motion-reduce:transition-none">
      <MyAvatar size={32} initial={d.initial} />
      {d.tone === "warn" && collapsed && <span aria-hidden className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-warning ring-2 ring-sidebar" />}
    </button>
  );
  const gear = (
    <Tip show={collapsed} label="Settings">
      <button
        onClick={() => navigate("/settings")}
        aria-label="Settings"
        aria-current={settingsOn ? "page" : undefined}
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors outline-ring hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2",
          settingsOn && "bg-sidebar-accent text-foreground",
        )}
      >
        <SettingsIcon className="size-[18px]" />
      </button>
    </Tip>
  );
  const label = d.line ? `${d.who} · ${d.line}` : d.who;
  if (collapsed)
    return (
      <div data-shell-profile className="flex flex-col items-center gap-1.5">
        <Tip show label={label}>
          {avatar}
        </Tip>
        {gear}
      </div>
    );
  return (
    <div data-shell-profile className="flex items-center gap-1 pt-2.5 pl-1.5">
      {avatar}
      <button onClick={() => navigate("/settings#sync")} title={[d.email, d.when].filter(Boolean).join(" · ") || undefined} aria-label={label} className="flex min-w-0 flex-1 items-center rounded-[10px] py-1 pr-1 pl-1.5 text-left outline-ring focus-visible:outline-2">
        <span className="min-w-0 flex-1 whitespace-nowrap">
          <b className="block truncate text-[14px] font-semibold text-foreground">{d.who}</b>
          <small className={cn("flex items-center gap-1.5 truncate text-[12px]", d.tone === "warn" ? "text-warning" : "text-muted-foreground")}>{d.line || " "}</small>
        </span>
      </button>
      {gear}
    </div>
  );
}
