import { autoSync, MEDIA_EVENT, setMediaPending, STATUS_EVENT, syncStatus, type SyncSeen } from "@/lib/sync";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { tabShortcut } from "@/lib/tab-keys";
import { TooltipProvider } from "@/components/ui/tooltip";
import { navigate, navScroll, useLocation } from "@/lib/router";
import { cn } from "@/lib/utils";
import { SidebarEdge, Sidebar } from "@/components/sidebar";
import { DecksPage } from "@/pages/decks";
import { StudyPage } from "@/pages/study";
import { WatchPage } from "@/pages/watch";
import { DeckHomePage } from "@/pages/deck-home";
import { DeckPage } from "@/pages/deck";
import { BrowsePage } from "@/pages/browse";
import { TypesPage } from "@/pages/types";
import { StatsPage } from "@/pages/stats";
import { SettingsPage } from "@/pages/settings";
import { EmbedStudy } from "@/pages/embed";
import { MarketPage } from "@/pages/market";
import { CoursePage } from "@/pages/course";
import { NotesPage } from "@/pages/notes";
import { AGENT_SHORTCUT, AgentLauncher, AgentPanel, DockHost, WITH_KEY, announceDataChange, useAgentPanel } from "@/components/agent-panel";
import { MinimiCorner, placeMinimiAt } from "@/components/minimi";
import { AppContextMenu } from "@/components/app-context-menu";
import { setMinimiHidden, useMinimiHidden } from "@/lib/minimi-hidden";
import { MinimiChat } from "@/components/minimi-chat";
import { loadFunMode, useFunMode } from "@/lib/fun";
import { profileFrom, useAgentProfiles, type ProfileView } from "@/lib/agent-profiles";
import { loadHoliday } from "@/lib/holiday";
import { HolidaySnow } from "@/components/holiday";
import { loadMinimiFace } from "@/lib/minimi-face";
import { useUpdateDot } from "@/components/update-bar";
import { PhoneTabBar } from "@/components/phone-shell";
import { MorePage } from "@/pages/more";
import { usePhone } from "@/lib/phone";
import { Onboarding, ONBOARDING_EVENT } from "@/components/onboarding";
import { AiConsentAtLaunch } from "@/components/ai-consent";
import { api } from "@/lib/api";
import { loadAvatar } from "@/lib/avatar";
import { AvatarDialogHost } from "@/components/avatar";
import { DeckFinder } from "@/components/deck-finder";
import { NoteGraphHost } from "@/components/note-graph";
import { PluginHost } from "@/components/plugin-host";
import { isNativeApp } from "@/lib/platform";
import { TooSmall, useTooSmall } from "@/components/too-small";
import { reportShell, setShellHandler } from "@/lib/view-remote";
import { setNotesPagesOpen, SHOW_CHATS_EVENT, useNotesPagesOpen } from "@/lib/sidebar-slot";
import { isScreenPath } from "@/lib/screen-tabs";
import { isChatTab } from "@/lib/agent-dock";
import { ScreenDataKey } from "@/components/screen-view";

/** First-run setup: shown when the collection has no decks and setup wasn't finished or skipped, or on request. */
function useOnboarding(skip: boolean) {
  const [open, setOpen] = useState(false);
  // Whether the collection answered whether setup shows: until then nothing else asks for attention at launch.
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (skip) return;
    let live = true;
    api
      .onboarding()
      .then((o) => live && (o.show && setOpen(true), setChecked(true)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [skip]);
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener(ONBOARDING_EVENT, h);
    return () => window.removeEventListener(ONBOARDING_EVENT, h);
  }, []);
  return [open, setOpen, checked] as const;
}

const COLLAPSED_KEY = "etude.sidebar.collapsed";
/** Pages that only show the collection, so a sync that brought changes can reload them safely. */
const RELOAD_ON_SYNC = new Set(["/", "/archive", "/deck", "/home", "/stats", "/more"]);

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest?.("[contenteditable=true], .cm-editor, iframe, .excalidraw"));
};

const NARROW = "(max-width: 1279px)";
/** A desktop window this narrow shows the icon rail, whatever the sidebar was left as (it's still a desktop). Just under the iPad mini's 744, so tablets keep the sidebar they had. */
const RAIL_ONLY = "(max-width: 739px)";
/** Which screen a path is, for the page-in animation: a deck and its Library are different screens, /types/x stays /types. */
const tabOf = (p: string) => (p.startsWith("/types") ? "/types" : p);
const isStudy = (s: string) => s === "/study" || s === "/watch";
const LEAVE_MS = 140;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Changing screens: the old one fades out first (it keeps its last render, so nothing inside it changes while it
 * goes), then the new one rises in. Scrolling to the top waits for the swap, so the old page doesn't jump.
 */
function ScreenSwap({ path, page }: { path: string; page: React.ReactNode }) {
  const screen = tabOf(path);
  const [shown, setShown] = useState(screen);
  const last = useRef(page);
  const leaving = shown !== screen && !isStudy(screen) && !isStudy(shown) && !reducedMotion();
  if (!leaving) last.current = page;
  useEffect(() => {
    if (shown === screen) return;
    const t = setTimeout(() => setShown(screen), leaving ? LEAVE_MS : 0);
    return () => clearTimeout(t);
  }, [screen, shown, leaving]);
  const screenRef = useRef(screen);
  screenRef.current = screen;
  useEffect(() => {
    navScroll.top = (to) => {
      const next = tabOf(new URL(to, location.origin).pathname);
      if (next === screenRef.current || isStudy(next)) window.scrollTo(0, 0);
    };
  }, []);
  // The old screen keeps its key while it fades, so it isn't rebuilt; the new one gets its own.
  const key = leaving ? shown : screen;
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [key]);
  // For a moment after a screen opens, rows that arrive with its data fade in; later ones (a new search) don't.
  const [fresh, setFresh] = useState(true);
  useEffect(() => {
    if (leaving) return;
    setFresh(true);
    const t = setTimeout(() => setFresh(false), 2400);
    return () => clearTimeout(t);
  }, [key, leaving]);
  return (
    <div key={key} className={cn(leaving ? "page-out" : "page-in", !leaving && fresh && "is-fresh")} aria-hidden={leaving || undefined} inert={leaving || undefined}>
      {leaving ? last.current : page}
    </div>
  );
}


/**
 * Three ways to have the sidebar: open (icons and words), the rail (icons only) or none at all. The choice is
 * remembered; `auto` (Ask Etude open on a window too narrow for both) shows the rail for the moment without changing
 * it, and opening it then only peeks the full sidebar.
 * Keys: Ctrl/⌘+[ folds to the rail, Ctrl/⌘+] opens it wide (from the rail or from none), Ctrl/⌘+< switches between
 * the rail and no sidebar. Bare [ and ] do the same as their Ctrl versions outside a text field.
 */
export type SidebarMode = "open" | "rail" | "none";
const MODE_KEY = "etude.sidebar.mode";
const readMode = (): SidebarMode => {
  const m = localStorage.getItem(MODE_KEY);
  if (m === "open" || m === "rail" || m === "none") return m;
  return localStorage.getItem(COLLAPSED_KEY) === "1" ? "rail" : "open";
};
function useSidebar(auto: boolean) {
  const [mode, setMode] = useState<SidebarMode>(readMode);
  const [peek, setPeek] = useState(false);
  useEffect(() => localStorage.setItem(MODE_KEY, mode), [mode]);
  useEffect(() => setPeek(false), [auto]);
  const set = useRef((_m: SidebarMode) => {});
  set.current = (m) => {
    if (!auto) return setMode(m);
    // Squeezed: open only peeks; the rail and none are real choices.
    if (m === "open") return setPeek(true);
    setPeek(false);
    setMode(m === "rail" && mode === "open" ? "open" : m);
  };
  const shownRef = useRef<SidebarMode>(mode);
  const shown: SidebarMode = auto ? (peek ? "open" : mode === "none" ? "none" : "rail") : mode;
  shownRef.current = shown;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Ctrl+T / Ctrl+W belong to the Notebook's and Ask's tabs (even in a canvas); never let the window close.
      if (tabShortcut(e)) e.preventDefault();
      // Not inside a canvas: Excalidraw uses Ctrl/⌘+[ and ] to move shapes back and forward.
      if (t?.closest?.(".excalidraw")) return;
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
      const bracket = e.code === "BracketLeft" ? "[" : e.code === "BracketRight" ? "]" : e.key === "[" || e.key === "]" ? e.key : null;
      // A bare [ or ] outside a text field, like Linear and Notion, only while the sidebar is on screen
      // (not in a study session, a dialog or on a phone).
      const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.defaultPrevented && !typing(t) && !document.querySelector("[role=dialog]") && !!document.querySelector<HTMLElement>("[data-shell-sidebar]");
      if (bracket && !e.shiftKey && (mod || bare)) {
        e.preventDefault();
        set.current(bracket === "[" ? "rail" : "open");
      } else if (mod && (e.key === "<" || e.key === "," || e.code === "Comma" || e.code === "IntlBackslash")) {
        // The ,< key, with or without Shift (on ISO keyboards < has a key of its own). Ctrl+, first clears the
        // notifications on screen; with none showing it hides or brings back the sidebar.
        e.preventDefault();
        if (e.code === "Comma" && !e.shiftKey && document.querySelector("[data-sonner-toast]")) toast.dismiss();
        else set.current(shownRef.current === "none" ? "rail" : "none");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return [shown, (m: SidebarMode) => set.current(m)] as const;
}

function useMedia(q: string) {
  const [on, setOn] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const h = () => setOn(m.matches);
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, [q]);
  return on;
}

export function App() {
  const { path, params, hash } = useLocation();
  const fun = useFunMode();
  const phone = usePhone();
  const small = useTooSmall();
  // Fun mode on desktop and iPad: ⌘J and a tap on Minimi open his mini chat; the side panel is one click away from it.
  const minimiOff = useMinimiHidden();
  // The corner follows the default agent profile: Minimi (in Fun mode), another profile's body, or a round button.
  // The corner shows whoever you last talked to, when that one has a body to sit there; it stays theirs after the chat closes.
  const profiles = useAgentProfiles();
  const [chatWith, setChatWithRaw] = useState<string | null>(() => localStorage.getItem(WITH_KEY));
  const setChatWith = useCallback((id: string | null) => {
    if (!id) return;
    localStorage.setItem(WITH_KEY, id);
    setChatWithRaw(id);
  }, []);
  const hasBody = (p: ProfileView) => (p.body === "minimi" ? fun : !!p.body);
  const byDefault = profileFrom(profiles, null);
  const talking = chatWith ? profileFrom(profiles, chatWith) : null;
  const lead = talking && hasBody(talking) ? talking : byDefault;
  const seated = hasBody(lead);
  const funRef = useRef({ fun: seated, phone, minimiOff });
  funRef.current = { fun: seated, phone, minimiOff };
  // With Minimi put away, ⌘J opens the side panel: his mini chat would have nobody to sit beside.
  const agent = useAgentPanel(() => funRef.current.fun && !funRef.current.phone && !funRef.current.minimiOff && !studyingRef.current);
  const narrow = useMedia(NARROW);
  const railOnly = useMedia(RAIL_ONLY);
  const [sbMode, setSbMode] = useSidebar((agent.open && narrow) || railOnly);
  useEffect(() => void loadFunMode(), []);
  useEffect(() => void loadHoliday(), []);
  useEffect(() => void loadMinimiFace(), []);
  // Notes isn't on phones yet (it needs screens of its own): an old link to it opens the Library.
  useEffect(() => {
    if (phone && path === "/notes") navigate("/", { replace: true });
  }, [phone, path]);
  const studying = path === "/study" || path === "/watch";
  // Desktops: every screen (Library, Browse, a study session…) is a tab among the Notebook's panes. Phones keep
  // their screens one at a time, and a study session fills the phone.
  const inTabs = !phone && isScreenPath(path);
  const fullStudy = studying && phone;
  const onNotes = path === "/notes";
  const notesId = useRef<string | null>(null);
  if (onNotes) notesId.current = params.get("id");
  const studyingRef = useRef(studying);
  studyingRef.current = studying;
  useEffect(() => {
    if (!seated || phone || studying || minimiOff) agent.setMini(false);
  }, [seated, phone, studying, minimiOff]);
  // Sync on its own, so every device shows the same collection without anyone pressing Sync:
  // local changes go up within ~10 s, other devices' changes come down every 30 s and whenever
  // the app comes back to the front. Not during a study session, which syncs when it ends.
  const received = useRef<number | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  // Media files follow the collection in the background. While they come in, the status is read every few
  // seconds, also during a study session, and open cards and pages hear when files arrive.
  const mediaReceived = useRef<number | null>(null);
  const [mediaActive, setMediaActive] = useState(false);
  const noteMedia = useCallback((st: SyncSeen | null) => {
    const m = st?.media;
    if (!m) return;
    if (mediaReceived.current !== null && m.received > mediaReceived.current) window.dispatchEvent(new Event(MEDIA_EVENT));
    mediaReceived.current = m.received;
    setMediaActive(m.active);
    setMediaPending(m.active || !!m.error);
  }, []);
  useEffect(() => {
    if (!mediaActive) return;
    const t = setInterval(() => void syncStatus().then(noteMedia), 2000);
    return () => clearInterval(t);
  }, [mediaActive, noteMedia]);
  useEffect(() => {
    const h = (e: Event) => noteMedia((e as CustomEvent<SyncSeen>).detail);
    window.addEventListener(STATUS_EVENT, h);
    // Once on opening too: the app may open on a study session, which doesn't sync, while media still comes in.
    void syncStatus().then(noteMedia);
    return () => window.removeEventListener(STATUS_EVENT, h);
  }, [noteMedia]);
  useEffect(() => {
    if (studying) return;
    let stop = false;
    const run = async (o?: { pendingOnly?: boolean }) => {
      const st = await autoSync(o);
      if (stop || typeof st?.received !== "number") return;
      const before = received.current;
      received.current = st.received;
      // Changes came in: reload the page's data where nothing is being edited.
      if (before !== null && st.received > before && RELOAD_ON_SYNC.has(pathRef.current)) setDataKey((k) => k + 1);
    };
    void run();
    const pull = setInterval(() => void run(), 30_000);
    const push = setInterval(() => void run({ pendingOnly: true }), 10_000);
    const wake = () => document.visibilityState === "visible" && void run();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      stop = true;
      clearInterval(pull);
      clearInterval(push);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [studying]);
  const updateDot = useUpdateDot();
  // Bumped after the assistant changed something, so the page remounts and reloads its data.
  const [dataKey, setDataKey] = useState(0);
  const [onboarding, setOnboarding, onboardingChecked] = useOnboarding(path === "/embed");
  // A launch that showed first-run setup asked there already: no AI consent sheet after it.
  const sawOnboarding = useRef(false);
  if (onboarding) sawOnboarding.current = true;
  // Your picture: read once, and again when a sync brought changes (another device may have picked a new one).
  useEffect(() => void loadAvatar(), [dataKey]);
  // `etude view` (the CLI, an agent over MCP): the sidebar, Notes' pages, the Ask panel and which screen, like a person would.
  const pagesOpen = useNotesPagesOpen();
  const shellRef = useRef({ setSbMode, setOpen: agent.setOpen });
  shellRef.current = { setSbMode, setOpen: agent.setOpen };
  useEffect(() => {
    setShellHandler((c) => {
      if (c.action === "sidebar") shellRef.current.setSbMode(c.mode);
      else if (c.action === "pages") setNotesPagesOpen(c.open);
      else if (c.action === "panel") shellRef.current.setOpen(c.open);
      else if (c.action === "go") navigate(c.route);
    });
    return () => setShellHandler(null);
  }, []);
  // A chat asked for the list of chats while the sidebar was folded: open it (Notes' part shows them).
  useEffect(() => {
    const h = () => shellRef.current.setSbMode("open");
    window.addEventListener(SHOW_CHATS_EVENT, h);
    return () => window.removeEventListener(SHOW_CHATS_EVENT, h);
  }, []);
  const route = path + (params.size ? `?${params}` : "") + (hash || "");
  useEffect(() => {
    if (path !== "/embed") reportShell(route, { sidebar: phone ? "none" : sbMode, pages: pagesOpen, panel: agent.open });
  }, [route, sbMode, pagesOpen, agent.open, phone]); // eslint-disable-line react-hooks/exhaustive-deps
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
  if (inTabs) page = null;
  else if (path === "/watch") {
    const deck = params.get("deck") ?? undefined;
    const q = params.get("q") ?? undefined;
    page = <WatchPage key={`${deck}|${q}`} scope={{ deck, q }} title={deck ? deck.split("::").pop()! : q ? `Search: ${q}` : "All cards"} />;
  } else if (studying) {
    const deck = params.get("deck") ?? undefined;
    const q = params.get("q") ?? undefined;
    const card = params.get("card") ? Number(params.get("card")) : undefined;
    const ahead = params.get("ahead") === "1";
    const placement = (deck && params.get("placement")) || undefined;
    page = <StudyPage key={`${deck}|${q}|${card}|${ahead}|${placement}`} scope={{ deck, q, ahead, placement }} startCard={card} title={deck ? deck.split("::").pop()! : q ? `Search: ${q}` : "All cards"} />;
  } else if (path === "/deck") page = <DeckPage key={params.get("name")} name={params.get("name") ?? ""} />;
  else if (path === "/home") page = <DeckHomePage key={params.get("deck")} name={params.get("deck") ?? ""} />;
  else if (path === "/browse") page = <BrowsePage initialQuery={params.get("q") ?? ""} openItem={params.get("item")} />;
  else if (path.startsWith("/types")) page = <TypesPage id={path.split("/")[2] ? decodeURIComponent(path.split("/")[2]) : null} />;
  else if (path === "/stats") page = <StatsPage deck={params.get("deck") ?? undefined} />;
  else if (path === "/settings") page = <SettingsPage />;
  else if (path === "/market") page = <MarketPage />;
  else if (path === "/course") page = <CoursePage key={params.get("id")} id={params.get("id") ?? ""} />;
  // The Notebook stays mounted (hidden) on the other screens, so its pages keep showing in the sidebar.
  else if (path === "/notes") page = null;
  else if (path === "/more") page = <MorePage />;
  else page = <DecksPage key={path} archived={path === "/archive"} />;

  return (
    <TooltipProvider delayDuration={300}>
      {small.on && path !== "/embed" && <TooSmall pose={small.pose} w={small.w} h={small.h} />}
      {/* Etude's right-click menu instead of the browser's (not in an embed, which lives inside someone else's page). */}
      {!phone && path !== "/embed" && (
        <AppContextMenu
          path={path}
          sidebar={fullStudy ? null : sbMode}
          onSidebar={setSbMode}
          extra={(x, y) =>
            minimiOff && !agent.open && !studying
              ? [seated ? { label: `Show ${lead.name}`, onSelect: () => (placeMinimiAt(x, y), setMinimiHidden(false)) } : { label: "Show Ask button", onSelect: () => setMinimiHidden(false) }]
              : []
          }
        />
      )}
      {fullStudy ? (
        page
      ) : (
        <div
          className="flex min-h-dvh"
          data-agent-open={agent.open}
          style={{ "--agent-offset": agent.open ? `${agent.width}px` : "0px", } as React.CSSProperties}
        >
          {!phone && <Sidebar path={onNotes && isChatTab(params.get("id")) ? "/agents" : path} mode={sbMode} onMode={setSbMode} />}
          {!phone && sbMode === "none" && <SidebarEdge onMode={setSbMode} />}
          {/* Room under the last row for the corner Minimi or ε, and on a phone for the tab island and its fade. */}
          <ScreenDataKey.Provider value={dataKey}>
          <main key={phone ? dataKey : 0} className={cn("min-w-0 flex-1", phone && path === "/course" ? "pb-0 phone:overflow-x-clip" : "pb-32 phone:overflow-x-clip phone:pb-[calc(var(--tabbar-h)+2.5rem)]")}>
            {!inTabs && <ScreenSwap path={path} page={page} />}
            {!phone && (
              <div hidden={!onNotes && !inTabs} className="page-in">
                <NotesPage id={onNotes ? notesId.current : null} route={inTabs ? route : null} active={onNotes || inTabs} />
              </div>
            )}
          </main>
          </ScreenDataKey.Provider>
          {agent.open ? (
            <AgentPanel
              onProfile={setChatWith}
              width={agent.width}
              setWidth={agent.setWidth}
              onClose={() => agent.setOpen(false)}
              onChanged={(final) => {
                announceDataChange();
                if (final) setDataKey((k) => k + 1);
              }}
            />
          ) : phone ? null : minimiOff || path === "/course" ? null : seated ? (
            <>
              <MinimiCorner key={lead.body === "minimi" ? "minimi" : lead.id} profile={lead} onOpen={() => agent.setMini((m) => !m)} shortcut={AGENT_SHORTCUT} talking={agent.mini} />
              {agent.mini && (
                <MinimiChat
                  onProfile={setChatWith}
                  onClose={() => agent.setMini(false)}
                  onExpand={() => agent.setOpen(true)}
                  onChanged={(final) => {
                    announceDataChange();
                    if (final) setDataKey((k) => k + 1);
                  }}
                />
              )}
            </>
          ) : (
            <AgentLauncher profile={lead} onOpen={() => agent.setOpen(true)} />
          )}
          {phone && <PhoneTabBar path={path} updateDot={updateDot} fun={fun} onAsk={() => agent.setOpen(true)} />}
        </div>
      )}
      {onboarding && (
        <Onboarding
          onFinish={() => {
            setOnboarding(false);
            setDataKey((k) => k + 1);
          }}
        />
      )}
      {path !== "/embed" && (
        <DockHost
          onChanged={(final) => {
            announceDataChange();
            if (final) setDataKey((k) => k + 1);
          }}
        />
      )}
      {path !== "/embed" && <AvatarDialogHost />}
      {/* The iPhone app: AI set up before it asked for an OK gets asked once, after setup and once the collection is ready. */}
      <AiConsentAtLaunch enabled={onboardingChecked && !onboarding && !sawOnboarding.current && path !== "/embed"} />
      {/* Ctrl/⌘K: find a deck. Browse and a deck's page keep the key for their own card search. */}
      <DeckFinder enabled={!studying && path !== "/embed" && path !== "/browse" && path !== "/deck" && !onboarding} />
      {path !== "/embed" && !phone && <NoteGraphHost />}
      {path !== "/embed" && !isNativeApp() && <PluginHost />}
      <HolidaySnow hidden={studying} />
      <Toaster position={phone ? "bottom-center" : "top-center"} mobileOffset={phone ? { bottom: studying ? 104 : 92, left: 12, right: 12 } : undefined} />
    </TooltipProvider>
  );
}
