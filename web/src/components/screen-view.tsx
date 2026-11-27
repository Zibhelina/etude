// A screen (Library, Browse, Stats, Agents, a study session…) drawn inside a Notebook tab. It reads its own route
// (LocationContext), so screens in different panes don't see each other's address, and remounts the way App's
// screens do: a deck's page per deck, a study session per deck or search.
import { createContext, useContext } from "react";
import { LocationContext } from "@/lib/router";
import { screenOf } from "@/lib/screen-tabs";
import { DecksPage } from "@/pages/decks";
import { StudyPage } from "@/pages/study";
import { WatchPage } from "@/pages/watch";
import { DeckHomePage } from "@/pages/deck-home";
import { DeckPage } from "@/pages/deck";
import { BrowsePage } from "@/pages/browse";
import { TypesPage } from "@/pages/types";
import { StatsPage } from "@/pages/stats";
import { SettingsPage } from "@/pages/settings";
import { MarketPage } from "@/pages/market";
import { MorePage } from "@/pages/more";
import { CoursePage } from "@/pages/course";
import { cn } from "@/lib/utils";

/** Bumped by App when a sync or an agent changed the collection: the screens in tabs load their data again. */
export const ScreenDataKey = createContext(0);

function page(route: string): React.ReactNode {
  const u = new URL(route, "http://x");
  const path = u.pathname;
  const params = u.searchParams;
  const deck = params.get("deck") ?? undefined;
  const q = params.get("q") ?? undefined;
  const title = deck ? deck.split("::").pop()! : q ? `Search: ${q}` : "All cards";
  if (path === "/watch") return <WatchPage key={`w|${deck}|${q}`} scope={{ deck, q }} title={title} />;
  if (path === "/study") {
    const card = params.get("card") ? Number(params.get("card")) : undefined;
    const ahead = params.get("ahead") === "1";
    const placement = (deck && params.get("placement")) || undefined;
    return <StudyPage key={`s|${deck}|${q}|${card}|${ahead}|${placement}`} scope={{ deck, q, ahead, placement }} startCard={card} title={title} />;
  }
  if (path === "/deck") return <DeckPage key={`d|${params.get("name")}`} name={params.get("name") ?? ""} />;
  if (path === "/home") return <DeckHomePage key={`h|${deck}`} name={deck ?? ""} />;
  if (path === "/browse") return <BrowsePage key="browse" initialQuery={q ?? ""} openItem={params.get("item")} />;
  if (path.startsWith("/types")) return <TypesPage key="types" id={path.split("/")[2] ? decodeURIComponent(path.split("/")[2]) : null} />;
  if (path === "/stats") return <StatsPage key={`st|${deck}`} deck={deck} />;
  if (path === "/settings") return <SettingsPage key="settings" />;
  if (path === "/market") return <MarketPage key="market" />;
  if (path === "/more") return <MorePage key="more" />;
  if (path === "/course") return <CoursePage key={`c|${params.get("id")}`} id={params.get("id") ?? ""} />;
  // /agents opens a chat tab directly (handled in NotesPage).
  if (path === "/agents") return null;
  return <DecksPage key={`lib|${path}`} archived={path === "/archive"} />;
}

export function ScreenView({ route, top }: { route: string; top: React.ReactNode }) {
  const data = useContext(ScreenDataKey);
  const screen = screenOf(route);
  const study = screen === "/study" || screen === "/watch" || screen === "/course";
  const fill = screen === "/browse";
  return (
    <LocationContext.Provider value={route}>
      {top}
      {/* A study session scrolls inside a paint-contained shell, so its fixed bottom bar stays pinned to the bottom of this pane while the inner box scrolls under it. */}
      <div key={`${screen}:${data}`} className={cn("screen-body page-in", study && "screen-study", fill && "screen-fill")} data-screen={screen}>
        {study ? <div className="screen-study-scroll" data-study-scroll>{page(route)}</div> : page(route)}
      </div>
    </LocationContext.Provider>
  );
}
