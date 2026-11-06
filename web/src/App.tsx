import { autoSync, MEDIA_EVENT, setMediaPending, STATUS_EVENT, syncStatus, type SyncSeen } from "@/lib/sync";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useLocation } from "@/lib/router";
import { Sidebar } from "@/components/sidebar";
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
import { AGENT_SHORTCUT, AgentLauncher, AgentPanel, announceDataChange, useAgentPanel } from "@/components/agent-panel";
import { MinimiCorner } from "@/components/minimi";
import { MinimiChat } from "@/components/minimi-chat";
import { loadFunMode, useFunMode } from "@/lib/fun";
import { useUpdateDot } from "@/components/update-bar";
import { PhoneTabBar } from "@/components/phone-shell";
import { MorePage } from "@/pages/more";
import { usePhone } from "@/lib/phone";
import { Onboarding, ONBOARDING_EVENT } from "@/components/onboarding";
import { api } from "@/lib/api";

/** First-run setup: shown when the collection has no decks and setup wasn't finished or skipped, or on request. */
function useOnboarding(skip: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (skip) return;
    let live = true;
    api.onboarding().then((o) => live && o.show && setOpen(true)).catch(() => {});
    return () => {
      live = false;
    };
  }, [skip]);
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener(ONBOARDING_EVENT, h);
    return () => window.removeEventListener(ONBOARDING_EVENT, h);
  }, []);
  return [open, setOpen] as const;
}

const COLLAPSED_KEY = "etude.sidebar.collapsed";
/** Pages that only show the collection, so a sync that brought changes can reload them safely. */
const RELOAD_ON_SYNC = new Set(["/", "/archive", "/deck", "/stats", "/more"]);

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest?.("[contenteditable=true], .cm-editor, iframe"));
};

const NARROW = "(max-width: 1279px)";

/**
 * Sidebar or rail. The choice is remembered; `auto` (Ask Etude open on a window too narrow for both) shows the
 * rail for the moment without changing it, and the toggle then only peeks the full sidebar.
 */
function useSidebar(auto: boolean) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  const [peek, setPeek] = useState(false);
  useEffect(() => localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"), [collapsed]);
  useEffect(() => setPeek(false), [auto]);
  const toggle = useRef(() => {});
  toggle.current = () => (auto ? setPeek((p) => !p) : setCollapsed((c) => !c));
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b";
      // A bare [ outside a text field, like Linear and Notion, only while the sidebar is on screen
      // (not in a study session, a dialog or on a phone).
      const bracket =
        e.key === "[" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.defaultPrevented && !typing(e.target) && !document.querySelector("[role=dialog]") && !!document.querySelector<HTMLElement>("[data-shell-sidebar]")?.offsetWidth;
      if (mod || bracket) {
        e.preventDefault();
        toggle.current();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return [auto ? !peek : collapsed, () => toggle.current()] as const;
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
  const { path, params } = useLocation();
  const fun = useFunMode();
  const phone = usePhone();
  // Fun mode on desktop and iPad: ⌘J and a tap on Minimi open his mini chat; the side panel is one click away from it.
  const funRef = useRef({ fun, phone });
  funRef.current = { fun, phone };
  const agent = useAgentPanel(() => funRef.current.fun && !funRef.current.phone && !studyingRef.current);
  const narrow = useMedia(NARROW);
  const [collapsed, toggleSidebar] = useSidebar(agent.open && narrow);
  useEffect(() => void loadFunMode(), []);
  const studying = path === "/study" || path === "/watch";
  const studyingRef = useRef(studying);
  studyingRef.current = studying;
  useEffect(() => {
    if (!fun || phone || studying) agent.setMini(false);
  }, [fun, phone, studying]);
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
  const [onboarding, setOnboarding] = useOnboarding(path === "/embed");
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
    const placement = (deck && params.get("placement")) || undefined;
    page = <StudyPage key={`${deck}|${q}|${card}|${ahead}|${placement}`} scope={{ deck, q, ahead, placement }} startCard={card} title={deck ? deck.split("::").pop()! : q ? `Search: ${q}` : "All cards"} />;
  } else if (path === "/deck") page = <DeckPage key={params.get("name")} name={params.get("name") ?? ""} />;
  else if (path === "/browse") page = <BrowsePage initialQuery={params.get("q") ?? ""} openItem={params.get("item")} />;
  else if (path.startsWith("/types")) page = <TypesPage id={path.split("/")[2] ? decodeURIComponent(path.split("/")[2]) : null} />;
  else if (path === "/stats") page = <StatsPage deck={params.get("deck") ?? undefined} />;
  else if (path === "/settings") page = <SettingsPage />;
  else if (path === "/market") page = <MarketPage />;
  else if (path === "/more") page = <MorePage />;
  else page = <DecksPage key={path} archived={path === "/archive"} />;

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
          <Sidebar path={path} collapsed={collapsed} onToggle={toggleSidebar} />
          {/* Room under the last row for the corner Minimi or ε, and on a phone for the tab island and its fade. */}
          <main key={dataKey} className="min-w-0 flex-1 max-md:overflow-x-clip pb-[calc(var(--tabbar-h)+2.5rem)] md:pb-32">{page}</main>
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
          ) : phone ? null : fun ? (
            <>
              <MinimiCorner onOpen={() => agent.setMini((m) => !m)} shortcut={AGENT_SHORTCUT} talking={agent.mini} />
              {agent.mini && (
                <MinimiChat
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
            <AgentLauncher onOpen={() => agent.setOpen(true)} />
          )}
          <PhoneTabBar path={path} updateDot={updateDot} fun={fun} onAsk={() => agent.setOpen(true)} />
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
      <Toaster position={phone ? "bottom-center" : "top-center"} mobileOffset={phone ? { bottom: studying ? 104 : 92, left: 12, right: 12 } : undefined} />
    </TooltipProvider>
  );
}
