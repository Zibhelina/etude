import { autoSync } from "@/lib/sync";
import { BarChart3, Blocks, Layers, Library, Settings, Store } from "lucide-react";
import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { SidebarIcon } from "@/components/sidebar-icon";
import { navigate, useLocation } from "@/lib/router";
import { Wordmark } from "@/components/logo";
import { cn } from "@/lib/utils";
import { DecksPage } from "@/pages/decks";
import { StudyPage } from "@/pages/study";
import { WatchPage } from "@/pages/watch";
import { DeckPage } from "@/pages/deck";
import { BrowsePage } from "@/pages/browse";
import { TypesPage } from "@/pages/types";
import { StatsPage } from "@/pages/stats";
import { SettingsPage } from "@/pages/settings";
import { EmbedStudy } from "@/pages/embed";
import { MarketPage } from "@/pages/market";
import { AgentLauncher, AgentPanel, announceDataChange, useAgentPanel } from "@/components/agent-panel";
import { SidebarUpdate, useUpdateDot } from "@/components/update-bar";
import { PhoneTabBar } from "@/components/phone-shell";
import { MorePage } from "@/pages/more";
import { usePhone } from "@/lib/phone";

const NAV = [
  { to: "/", label: "Decks", icon: Layers, match: (p: string) => p === "/" || p === "/deck" },
  { to: "/browse", label: "Browse", icon: Library, match: (p: string) => p === "/browse" },
  { to: "/types", label: "Card types", icon: Blocks, match: (p: string) => p.startsWith("/types") },
  { to: "/market", label: "Market", icon: Store, match: (p: string) => p === "/market" },
  { to: "/stats", label: "Stats", icon: BarChart3, match: (p: string) => p === "/stats" },
  { to: "/settings", label: "Settings", icon: Settings, match: (p: string) => p === "/settings" },
];

const COLLAPSED_KEY = "etude.sidebar.collapsed";
const toggleKey = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘B" : "Ctrl+B";

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  useEffect(() => localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"), [collapsed]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return [collapsed, setCollapsed] as const;
}

export function App() {
  const { path, params } = useLocation();
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const studying = path === "/study" || path === "/watch";
  useEffect(() => {
    if (studying) return;
    void autoSync();
    const timer = setInterval(() => void autoSync(), 180_000);
    return () => clearInterval(timer);
  }, [studying]);
  const agent = useAgentPanel();
  const updateDot = useUpdateDot();
  const phone = usePhone();
  // Bumped after the assistant changed something, so the page remounts and reloads its data.
  const [dataKey, setDataKey] = useState(0);
  if (path === "/embed") {
    const deck = params.get("deck") ?? undefined;
    const q = params.get("q") ?? undefined;
    const card = params.get("card") ? Number(params.get("card")) : undefined;
    const title = params.get("title") ?? (deck ? deck.split("::").pop()! : q ? q : "Etude");
    return (
      <TooltipProvider delayDuration={300}>
        <EmbedStudy scope={{ deck, q }} limit={Math.max(1, Number(params.get("n") ?? 10))} cardId={card} title={title} />
      </TooltipProvider>
    );
  }
  let page: React.ReactNode;
  if (path === "/watch") {
    const deck = params.get("deck") ?? undefined;
    const q = params.get("q") ?? undefined;
    page = <WatchPage key={`${deck}|${q}`} scope={{ deck, q }} title={deck ? deck.split("::").pop()! : q ? `Search: ${q}` : "All cards"} />;
  } else if (studying) {
    const deck = params.get("deck") ?? undefined;
    const q = params.get("q") ?? undefined;
    const card = params.get("card") ? Number(params.get("card")) : undefined;
    const ahead = params.get("ahead") === "1";
    page = <StudyPage key={`${deck}|${q}|${card}|${ahead}`} scope={{ deck, q, ahead }} startCard={card} title={deck ? deck.split("::").pop()! : q ? `Search: ${q}` : "All cards"} />;
  } else if (path === "/deck") page = <DeckPage key={params.get("name")} name={params.get("name") ?? ""} />;
  else if (path === "/browse") page = <BrowsePage initialQuery={params.get("q") ?? ""} openItem={params.get("item")} />;
  else if (path.startsWith("/types")) page = <TypesPage id={path.split("/")[2] ? decodeURIComponent(path.split("/")[2]) : null} />;
  else if (path === "/stats") page = <StatsPage deck={params.get("deck") ?? undefined} />;
  else if (path === "/settings") page = <SettingsPage />;
  else if (path === "/market") page = <MarketPage />;
  else if (path === "/more") page = <MorePage />;
  else page = <DecksPage />;

  return (
    <TooltipProvider delayDuration={300}>
      {studying ? (
        page
      ) : (
        <div
          className="flex min-h-dvh"
          data-agent-open={agent.open}
          style={{ "--agent-offset": agent.open ? `${agent.width}px` : "0px", } as React.CSSProperties}
        >
          <aside
            className={cn(
              "sticky top-0 hidden h-dvh shrink-0 flex-col gap-1 overflow-hidden bg-sidebar py-4 transition-[width] duration-200 ease-out md:flex",
              collapsed ? "w-14 px-2" : "w-52 px-3",
            )}
          >
            <div className={cn("mb-6 flex h-8 items-center", collapsed ? "justify-center" : "justify-between pl-2")}>
              {!collapsed && (
                <button onClick={() => navigate("/")} className="text-left">
                  <Wordmark className="text-[1.45rem] leading-none" />
                </button>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setCollapsed((c) => !c)}
                    aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                    aria-expanded={!collapsed}
                    className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                  >
                    <SidebarIcon className="size-[18px]" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {collapsed ? "Expand" : "Collapse"} <span className="opacity-60">{toggleKey}</span>
                </TooltipContent>
              </Tooltip>
            </div>
            {NAV.map((n) => {
              const btn = (
                <button
                  key={n.to}
                  onClick={() => navigate(n.to)}
                  aria-label={n.label}
                  aria-current={n.match(path) ? "page" : undefined}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-md text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground",
                    collapsed ? "justify-center px-0" : "px-2",
                    n.match(path) && "font-medium text-foreground",
                  )}
                >
                  <n.icon className={cn("size-4 shrink-0", n.match(path) && "text-highlight")} />
                  {!collapsed && <span className="whitespace-nowrap">{n.label}</span>}
                </button>
              );
              return collapsed ? (
                <Tooltip key={n.to}>
                  <TooltipTrigger asChild>{btn}</TooltipTrigger>
                  <TooltipContent side="right">{n.label}</TooltipContent>
                </Tooltip>
              ) : (
                btn
              );
            })}
            <div className="mt-auto pt-4">
              <SidebarUpdate collapsed={collapsed} />
            </div>
          </aside>
          {/* Room under the last row for the corner launcher, so it never sits on it for good. */}
          <main key={dataKey} className="min-w-0 flex-1 pb-[calc(var(--tabbar-h)+1.5rem)] md:pb-16">{page}</main>
          {agent.open ? (
            <AgentPanel
              width={agent.width}
              setWidth={agent.setWidth}
              onClose={() => agent.setOpen(false)}
              onChanged={(final) => {
                announceDataChange();
                if (final) setDataKey((k) => k + 1);
              }}
            />
          ) : phone ? null : (
            <AgentLauncher onOpen={() => agent.setOpen(true)} />
          )}
          <PhoneTabBar path={path} updateDot={updateDot} onAsk={() => agent.setOpen(true)} />
        </div>
      )}
      <Toaster position={phone ? "bottom-center" : "top-center"} mobileOffset={phone ? { bottom: studying ? 104 : 92, left: 12, right: 12 } : undefined} />
    </TooltipProvider>
  );
}
