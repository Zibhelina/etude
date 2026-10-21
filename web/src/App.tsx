import { BarChart3, Blocks, Layers, Library, Settings } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { navigate, useLocation } from "@/lib/router";
import { cn } from "@/lib/utils";
import { DecksPage } from "@/pages/decks";
import { StudyPage } from "@/pages/study";
import { DeckPage } from "@/pages/deck";
import { BrowsePage } from "@/pages/browse";
import { TypesPage } from "@/pages/types";
import { StatsPage } from "@/pages/stats";
import { SettingsPage } from "@/pages/settings";

const NAV = [
  { to: "/", label: "Decks", icon: Layers, match: (p: string) => p === "/" || p === "/deck" },
  { to: "/browse", label: "Browse", icon: Library, match: (p: string) => p === "/browse" },
  { to: "/types", label: "Card types", icon: Blocks, match: (p: string) => p.startsWith("/types") },
  { to: "/stats", label: "Stats", icon: BarChart3, match: (p: string) => p === "/stats" },
  { to: "/settings", label: "Settings", icon: Settings, match: (p: string) => p === "/settings" },
];

export function App() {
  const { path, params } = useLocation();
  const studying = path === "/study";
  let page: React.ReactNode;
  if (studying) {
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
          <aside className="sticky top-0 flex h-dvh w-14 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-4 md:w-52 md:items-stretch md:px-3">
            <button onClick={() => navigate("/")} className="mb-6 flex items-center gap-2 px-2 text-left">
              <span className="flex size-7 items-center justify-center rounded-lg bg-highlight/15 text-sm font-semibold text-highlight">é</span>
              <span className="hidden text-[0.95rem] font-semibold tracking-tight md:block">Étude</span>
            </button>
            {NAV.map((n) => (
              <button
                key={n.to}
                onClick={() => navigate(n.to)}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground",
                  n.match(path) && "bg-sidebar-accent text-foreground",
                )}
                title={n.label}
              >
                <n.icon className="size-4 shrink-0" />
                <span className="hidden md:block">{n.label}</span>
              </button>
            ))}
          </aside>
          <main className="min-w-0 flex-1">{page}</main>
        </div>
      )}
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
