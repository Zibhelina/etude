import { BarChart3, Blocks, Layers, Library, Settings } from "lucide-react";
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

const NAV = [
  { to: "/", label: "Decks", icon: Layers, match: (p: string) => p === "/" || p === "/deck" },
  { to: "/browse", label: "Browse", icon: Library, match: (p: string) => p === "/browse" },
  { to: "/types", label: "Card types", icon: Blocks, match: (p: string) => p.startsWith("/types") },
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
    page = <StudyPage key={`${deck}|${q}|${card}`} scope={{ deck, q }} startCard={card} title={deck ? deck.split("::").pop()! : q ? `Search: ${q}` : "All cards"} />;
  } else if (path === "/deck") page = <DeckPage key={params.get("name")} name={params.get("name") ?? ""} />;
  else if (path === "/browse") page = <BrowsePage initialQuery={params.get("q") ?? ""} openItem={params.get("item")} />;
  else if (path.startsWith("/types")) page = <TypesPage id={path.split("/")[2] ? decodeURIComponent(path.split("/")[2]) : null} />;
  else if (path === "/stats") page = <StatsPage deck={params.get("deck") ?? undefined} />;
  else if (path === "/settings") page = <SettingsPage />;
  else page = <DecksPage />;

  return (
    <TooltipProvider delayDuration={300}>
      {studying ? (
        page
      ) : (
        <div className="flex min-h-dvh">
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
          </aside>
          <main className="min-w-0 flex-1 pb-[var(--tabbar-h)]">{page}</main>
          <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 flex border-t bg-sidebar/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
            {NAV.map((n) => (
              <button
                key={n.to}
                onClick={() => navigate(n.to)}
                aria-current={n.match(path) ? "page" : undefined}
                className={cn("flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground", n.match(path) && "font-medium text-foreground")}
              >
                <n.icon className={cn("size-5", n.match(path) && "text-highlight")} />
                <span>{n.label === "Card types" ? "Types" : n.label}</span>
              </button>
            ))}
          </nav>
        </div>
      )}
      <Toaster position="top-center" />
    </TooltipProvider>
  );
}
