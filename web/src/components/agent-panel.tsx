// "Ask Etude": the assistant's launcher and side panel. The panel pushes the page on desktop and is a full-screen sheet on phones.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ControlPicker, ContextRing, PermissionPicker, PickerSearch, PILL, ThoughtRow, type SessionFacts } from "@/components/agent-controls";
import { ArrowUp, Ban, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsRight, CornerDownRight, CornerUpRight, FileText, ImageIcon, Loader2, Package, Menu, Plus, RotateCcw, Settings2, Square, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Markdown } from "@/components/markdown";
import { citations, RichBlock, RichContext, RichMarkdown, SourceList, Zoom, richSegments } from "@/components/agent-rich";
import { EPSILON_PATH, Logo } from "@/components/logo";
import { useMinimiFace } from "@/lib/minimi-face";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { agentApi, agentKeptSession, DATA_EVENT, type AgentEvent, type AssistantContent, type Attachment, type BackgroundTask, type ChatControls, type ContextUse, type Conversation, type Item, type Message, type ModelGroup, type ToolItem, type UserContent } from "@/lib/agent";
import { appPath, navigate } from "@/lib/router";
import { inAskPanel, tabShortcut } from "@/lib/tab-keys";
import { EtudeImg, useEtudeSrc } from "@/lib/local-url";
import { refreshTheme } from "@/lib/theme";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { isNativeApp } from "@/lib/platform";
import { useNarrow, usePhone } from "@/lib/device";
import { track } from "@/lib/telemetry";
import { useFunMode } from "@/lib/fun";
import { setMinimiHidden } from "@/lib/minimi-hidden";
import { mediaUrl, MINIMI_PROFILE_ID, profileFrom, useAgentProfiles, type ProfileView } from "@/lib/agent-profiles";
import { AgentAvatar, AgentSwitcher } from "@/components/agent-avatar";
import { currentView, look } from "@/lib/screen";
import { asksAiConsent, consentProvider, useAiConsent } from "@/components/ai-consent";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ChatSidebar } from "@/components/chat-sidebar";
import { setNotesView, showNotesChats, useNotesPagesOpen, useNotesView } from "@/lib/sidebar-slot";
import { announceChat, CHAT_CHANGED_EVENT, CHAT_REQUEST_EVENT, takeChatRequest, type ChatChange, dock, dockNode, notebookSide, panelSide, registerPanel, useDock, type DockedChat } from "@/lib/agent-dock";

// In the iOS app a file input with no accept list offers "Take Video", which needs the microphone; the
// app only takes images, PDFs, text and .apkg, so it asks for those and iOS offers photos, camera and files.
const NATIVE_ATTACH = isNativeApp() ? "image/*,application/pdf,text/*,.md,.csv,.json,.apkg" : undefined;

const OPEN_KEY = "etude.agent.open";
const WIDTH_KEY = "etude.agent.width";
const CONV_KEY = "etude.agent.conversation";
const TABS_KEY = "etude.agent.tabs";
/** Who you last talked to: a new chat starts with them, and the corner keeps their body. */
export const WITH_KEY = "etude.agent.with";
export const AGENT_SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘J" : "Ctrl+J";

// Other screens can hand Ask Etude a request (e.g. "make a card type that..."): it opens a new conversation and sends it.
const ASK_EVENT = "etude:ask";
const OPEN_EVENT = "etude:agent-open";
let asked: string | null = null;
export function askEtude(text: string) {
  asked = text;
  window.dispatchEvent(new Event(ASK_EVENT));
}

/**
 * Open state and width, shared by the launcher, the panel and the layout. `mini` is Minimi's small chat beside him
 * (Fun mode, desktop and iPad); `preferMini` says when ⌘J should open that one instead of the side panel.
 */
/** The side panel's width: at least 280px, and like the bar between two Notebook pages it can take up to 95%
 *  of the room it shares with the page (`room`: the window less the app's sidebar). */
function panelWidth(w: number, room: number): number {
  return Math.round(Math.max(280, Math.min(w, Math.max(280, room * 0.95))));
}

/** The room the panel shares with the page beside it, kept up to date as the window or the app's sidebar changes. */
function usePanelRoom(panel: React.RefObject<HTMLElement | null>): number {
  const [room, setRoom] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    const host = panel.current?.parentElement;
    if (!host) return;
    const measure = () => {
      const side = [...host.children].filter((c) => c !== panel.current && c.tagName === "ASIDE").reduce((n, c) => n + (c as HTMLElement).offsetWidth, 0);
      setRoom(host.clientWidth - side);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    for (const c of host.children) if (c !== panel.current && c.tagName === "ASIDE") ro.observe(c);
    return () => ro.disconnect();
  }, [panel]);
  return room;
}

export function useAgentPanel(preferMini: () => boolean = () => false) {
  const [open, setOpenRaw] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
  const [mini, setMini] = useState(false);
  const openNow = useRef(open);
  openNow.current = open;
  const prefer = useRef(preferMini);
  prefer.current = preferMini;
  const setOpen = useCallback((v: boolean | ((o: boolean) => boolean)) => {
    setOpenRaw((o) => {
      const next = typeof v === "function" ? v(o) : v;
      if (next) setMini(false);
      return next;
    });
  }, []);
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    // 400 was the old default; the panel now opens at 428.
    return Math.max(280, !saved || saved === 400 ? 428 : saved);
  });
  useEffect(() => localStorage.setItem(OPEN_KEY, open ? "1" : "0"), [open]);
  useEffect(() => {
    if (open) track("ask.open");
  }, [open]);
  useEffect(() => localStorage.setItem(WIDTH_KEY, String(width)), [width]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        if (openNow.current) setOpen(false);
        else if (prefer.current()) setMini((m) => !m);
        else setOpen(true);
      }
    };
    window.addEventListener("keydown", h);
    const ask = () => setOpen(true);
    window.addEventListener(ASK_EVENT, ask);
    window.addEventListener(OPEN_EVENT, ask);
    return () => {
      window.removeEventListener("keydown", h);
      window.removeEventListener(ASK_EVENT, ask);
      window.removeEventListener(OPEN_EVENT, ask);
    };
  }, []);
  return { open, setOpen, mini, setMini, width, setWidth };
}

/** Fun mode off: the ε in a round bubble, bottom-right. Hovering or focusing it slides out "Ask Etude ⌘J". */
/** The round button in the corner: the ε for Etude's assistant, or a profile's picture (one without a body of its own). */
export function AgentLauncher({ onOpen, profile }: { onOpen(): void; profile?: ProfileView }) {
  const fun = useFunMode();
  const other = profile && !(profile.id === MINIMI_PROFILE_ID && !fun) ? profile : null;
  // Right-click hides it on this device, like the corner Minimi (same flag); right-clicking an empty spot brings it back.
  const hide = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMinimiHidden(true);
    toast("Ask button hidden", {
      description: `Right-click an empty spot to bring it back. ${AGENT_SHORTCUT} still opens Ask.`,
      action: { label: "Undo", onClick: () => setMinimiHidden(false) },
    });
  };
  return (
    <div className="fixed right-5 bottom-5 z-30 phone:right-3 phone:bottom-[calc(var(--tabbar-h)+0.5rem)]">
      <button
        onClick={onOpen}
        onContextMenu={hide}
        aria-label={`Ask ${other ? other.name : "Etude"} · ${AGENT_SHORTCUT}`}
        data-agent-launcher
        className="group flex h-[52px] items-center rounded-full bg-card shadow-[0_1px_2px_rgb(0_0_0/0.08),0_8px_22px_rgb(0_0_0/0.10)] ring-1 ring-border transition-shadow duration-150 outline-ring hover:shadow-[0_1px_2px_rgb(0_0_0/0.08),0_14px_34px_rgb(0_0_0/0.14)] focus-visible:outline-2 dark:shadow-[0_10px_28px_rgb(0_0_0/0.6)]"
      >
        <span className="grid size-[52px] shrink-0 place-items-center">{other ? <AgentAvatar profile={other} size={40} /> : <Logo className="size-[28px]" />}</span>
        <span className="max-w-0 overflow-hidden text-[14.5px] font-semibold whitespace-nowrap text-foreground transition-[max-width,padding] duration-250 ease-[cubic-bezier(0.3,0.7,0.2,1)] group-hover:max-w-[180px] group-hover:pr-5 group-focus-visible:max-w-[180px] group-focus-visible:pr-5 motion-reduce:transition-none">
          Ask {other ? other.name : "Etude"}
          <kbd className="ml-2 rounded-[5px] bg-muted px-1.5 py-0.5 text-muted-foreground">{AGENT_SHORTCUT}</kbd>
        </span>
      </button>
    </div>
  );
}

/** Phones: the sheet follows the visual viewport, so the composer stays above the on-screen keyboard. */
function useVisualViewport(enabled: boolean) {
  const [vv, setVv] = useState<{ h: number; top: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!enabled || !v) return setVv(null);
    const h = () => setVv({ h: v.height, top: v.offsetTop });
    h();
    v.addEventListener("resize", h);
    v.addEventListener("scroll", h);
    return () => {
      v.removeEventListener("resize", h);
      v.removeEventListener("scroll", h);
    };
  }, [enabled]);
  return vv;
}

/** Black or white, whichever reads better on a theme colour (light pinks on dark themes need black). */
function useReadableOn(cssVar: string) {
  const [color, setColor] = useState<string | undefined>(undefined);
  const theme = typeof document !== "undefined" ? document.documentElement.dataset.theme : "";
  useLayoutEffect(() => {
    const probe = document.createElement("div");
    probe.style.cssText = `position:absolute;visibility:hidden;background:var(${cssVar})`;
    document.body.appendChild(probe);
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.fillStyle = getComputedStyle(probe).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      setColor(1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? "#fff" : "oklch(0.16 0 0)");
    }
    probe.remove();
  }, [theme, cssVar]);
  return color;
}

/** Quiet 28 px header button. */
function HeaderButton({ label, tip, onClick, disabled, children, ...rest }: { label: string; tip?: React.ReactNode; onClick?(): void; disabled?: boolean; children: React.ReactNode } & Omit<React.ComponentProps<"button">, "onClick">) {
  const btn = (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      {...rest}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-ring hover:bg-accent/70 hover:text-foreground focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-40 pointer-coarse:size-9 [&_svg]:size-4"
    >
      {children}
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent>{tip ?? label}</TooltipContent>
    </Tooltip>
  );
}


/** Round 36 px header button, the same as the mini chat's. */
function RoundButton({ label, tip, onClick, disabled, children }: { label: string; tip?: React.ReactNode; onClick?(): void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="flex size-8 shrink-0 items-center justify-center text-muted-foreground transition-colors outline-ring hover:text-foreground focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[17px]">
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip ?? label}</TooltipContent>
    </Tooltip>
  );
}

/** The agent profile the open chat is with. */
const ProfileContext = createContext<ProfileView | null>(null);

/** What the box says: "Ask Tutor", or "Ask Etude" for Minimi with Fun mode off. */
export const askName = (p: ProfileView, fun: boolean) => (p.id === MINIMI_PROFILE_ID && !fun ? "Etude" : p.name);

/** Who's talking: the chat's profile picture (Minimi's face in Fun mode), otherwise the ε on an ink disc. */
function Avatar({ size = 34 }: { size?: number }) {
  const fun = useFunMode();
  const minimiFace = useMinimiFace();
  const profile = useContext(ProfileContext);
  if (profile) return <AgentAvatar profile={profile} size={size} />;
  return fun ? (
    <img src={minimiFace} alt="" data-agent-avatar className="shrink-0 rounded-full bg-card object-cover shadow-[inset_0_0_0_1px_var(--border),0_2px_6px_rgb(0_0_0/0.06)]" style={{ width: size, height: size, objectPosition: "50% 20%" }} />
  ) : (
    <span data-agent-avatar className="grid shrink-0 place-items-center rounded-full bg-foreground" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: size * 0.56, height: size * 0.56 }}>
        <path d={EPSILON_PATH} className="fill-background" transform="translate(2.324 21.144) scale(0.04253 -0.04253)" />
      </svg>
    </span>
  );
}

/** In Minimi's mini chat and the side panel, replies and your messages sit in balloons. */
export const BubbleContext = createContext(false);
/** In the side panel his replies carry his face at the bottom left; the mini chat sits beside Minimi himself. */
const FaceContext = createContext(false);
/** In the side panel only your messages sit in balloons; replies are plain text on the page, so long ones read like a document. */
export const YouContext = createContext(false);

/** Minimi's balloons with his face beside the last one; undo and the model line go under, in the balloon column. */
function Said({ children, below }: { children: React.ReactNode; below?: React.ReactNode }) {
  if (!useContext(FaceContext)) return <>{children}{below}</>;
  return (
    <>
      <div className="flex items-end gap-2" data-agent-said>
        <Avatar />
        <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
      </div>
      {below && <div className="pl-[42px]">{below}</div>}
    </>
  );
}

// ---------------------------------------------------------------- live turn

interface Live {
  turnId: string | null;
  user: Message | null;
  items: Item[];
  changed: boolean;
  error: string | null;
  /** The stream broke before the reply ended (the server went away): waiting to hear what became of it. */
  lost?: boolean;
  /** The chat the reply belongs to. */
  conv?: string;
  /** Another chat was opened while it ran: it goes on on the server, and this window stops showing it. */
  detached?: boolean;
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The picker's display name for a model ref; a served model id is matched by its slug too. */
function modelLabel(ref: string | null, groups: ModelGroup[], served?: string) {
  for (const g of groups) for (const m of g.models) if (m.ref === ref) return m.name;
  const slug = (ref ?? "").replace(/^[a-z]+:/, "") || served || "";
  for (const g of groups) for (const m of g.models) if (m.ref.replace(/^[a-z]+:/, "") === slug || (served && m.ref.endsWith(`:${served}`))) return m.name;
  return slug || "Default model";
}

/** Reloads what the page shows. A deck page whose deck was moved or deleted goes back to Decks instead of asking for it. */
async function refreshPage(onChanged: (final: boolean) => void, final: boolean) {
  if (appPath() === "/deck") {
    const name = new URLSearchParams(location.search).get("name") ?? "";
    const decks = await api.decks().catch(() => null);
    if (decks && !decks.some((d) => d.name === name)) {
      navigate("/");
      return;
    }
  }
  onChanged(final);
}

/** One Ask Etude conversation: history, model, composer, attachments and the live turn. The side panel and Minimi's mini chat share it. */
/** Where a chat remembers which conversation it has open: one place for the mini chat, one per tab in the panel. */
export interface ConvStore {
  get(): string | null;
  set(id: string | null): void;
}
const LAST_CONV: ConvStore = { get: () => localStorage.getItem(CONV_KEY), set: (id) => (id ? localStorage.setItem(CONV_KEY, id) : localStorage.removeItem(CONV_KEY)) };

export function useAgentChat({ onClose, onChanged, takeAsk = true, store = LAST_CONV, active = true, lastWith = true }: {
  /** A new chat starts with whoever you talked to last (Minimi's mini chat, beside that one in the corner); false starts it with the default profile (a new tab). */
  lastWith?: boolean;
  onClose(): void;
  onChanged(final: boolean): void;
  /** Takes what another screen asked (askEtude): always, never, or only what was waiting when it opened ("mount", a tab made for it). */
  takeAsk?: boolean | "mount";
  store?: ConvStore;
  /** False for a tab that's open behind another: it keeps working but leaves the keyboard alone. */
  active?: boolean;
}) {
  const kept = useRef(store);
  kept.current = store;
  const activeRef = useRef(active);
  activeRef.current = active;
  const phone = usePhone();
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [conv, setConv] = useState<(Conversation & { messages: Message[] }) | null>(null);
  const [models, setModels] = useState<{ configured: boolean; default: string | null; groups: ModelGroup[] } | null>(null);
  // A model picked by hand, or the open chat's own; null follows the profile's model, then the default.
  const [model, setModel] = useState<string | null>(null);
  const profiles = useAgentProfiles();
  // The iPhone app asks before a message goes to a provider the person hasn't agreed to (render `consentDialog`).
  const consent = useAiConsent();
  // Who a chat that isn't saved yet will be with; null is the default profile.
  const [nextProfile, setNextProfile] = useState<string | null>(() => (lastWith ? localStorage.getItem(WITH_KEY) : null));
  const profile = profileFrom(profiles, conv ? conv.profile : nextProfile);
  const profileRef = useRef(profile.id);
  profileRef.current = profile.id;
  const convRef = useRef(conv);
  convRef.current = conv;
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<(Attachment | { uploading: string; key: string })[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  // A turn that went on without this window (it reloaded, or lost the stream): followed from its start.
  const [resume, setResume] = useState<{ conv: string; turn: string } | null>(null);
  // The chat's pickers (model, effort, speed) as its agent offers them, and what was picked before the chat exists.
  const [offered, setOffered] = useState<ChatControls | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const picksRef = useRef(picks);
  picksRef.current = picks;
  // Monotonic counter so an older GET /controls can never overwrite a newer pick, refresh, or live turn event.
  const controlsSeq = useRef(0);
  // Set when deliver() creates a brand-new conversation so the [convId] effect doesn't flash or race against send().
  const skipControlsFor = useRef<string | null>(null);
  const [usage, setUsage] = useState<ContextUse | null>(null);
  const [bgTasks, setBgTasks] = useState<BackgroundTask[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stick = useRef(true);

  const loadList = useCallback(() => agentApi.list().then((r) => setConvs(r.conversations)).catch(() => {}), []);

  /** The reply this window is sending, while its stream is open. */
  const sending = useRef<Live | null>(null);
  /**
   * Opening another chat (or a new one) while a reply is being written: the reply goes on on the server and shows
   * in its own chat when you go back (picked up like after a reload); this window lets go of it.
   */
  const leaveReply = (to: string | null) => {
    const s = sending.current;
    if (!s || s.conv === to) return;
    s.detached = true;
    sending.current = null;
    setLive((l) => (l && (l.turnId === s.turnId || !l.turnId) ? null : l));
  };

  const openConv = useCallback(async (id: string | null) => {
    leaveReply(id);
    if (!id) {
      // A new chat stays with whoever you were talking to.
      if (convRef.current) setNextProfile(convRef.current.profile);
      setConv(null);
      setModel(null);
      setResume(null);
      setBgTasks([]);
      kept.current.set(null);
      return;
    }
    try {
      const c = await agentApi.get(id);
      setConv(c);
      setModel(c.model);
      setBgTasks(c.tasks ?? []);
      kept.current.set(id);
      stick.current = true;
      if (c.running && liveRef.current?.turnId !== c.running) setResume({ conv: c.id, turn: c.running });
      else setResume((r) => (r && r.conv !== c.id ? null : r));
    } catch {
      setConv(null);
      kept.current.set(null);
    }
  }, []);

  useEffect(() => {
    loadList();
    openConv(asked && takeAsk ? null : kept.current.get());
    agentApi
      .models()
      .then((m) => setModels(m))
      .catch(() => setModels({ configured: false, default: null, groups: [] }));
    if (activeRef.current) requestAnimationFrame(() => input.current?.focus());
  }, []);

  // What this chat (or, before it exists, this profile) lets you pick. The first time ever, that starts the agent to ask.
  const convId = conv?.id ?? null;
  useEffect(() => {
    if (convId && skipControlsFor.current === convId) {
      skipControlsFor.current = null;
      return;
    }
    let on = true;
    const seq = ++controlsSeq.current;
    setOffered(null);
    setUsage(null);
    if (!convId) setPicks({});
    const harness = convId ? picksRef.current.harness : undefined;
    agentApi
      .controls(convId, profile.id, true, harness)
      .then((c) => {
        if (!on || seq !== controlsSeq.current) return;
        setOffered(c);
        setUsage(c.usage ?? null);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [convId, profile.id]);

  // Watch live background tasks (ACP background tool calls, Hermes subagents & shell jobs) for any open external chat.
  const isExternalChat = profile.brain.kind === "external";
  useEffect(() => {
    if (!convId || !isExternalChat) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      while (!ctl.signal.aborted) {
        try {
          await agentApi.watchTasks(
            convId,
            (next) => {
              if (!ctl.signal.aborted) setBgTasks(next);
            },
            ctl.signal,
          );
        } catch {}
        if (ctl.signal.aborted) return;
        await new Promise<void>((r) => {
          timer = setTimeout(r, 3000);
        });
      }
    };
    void loop();
    return () => {
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [convId, isExternalChat]);

  // Following a turn that went on without this window: what it did so far, then the rest live, with stop and steer.
  useEffect(() => {
    if (!resume) return;
    const ctl = new AbortController();
    const state: Live = { turnId: resume.turn, user: null, items: [], changed: false, error: null, conv: resume.conv };
    setLive({ ...state });
    stick.current = true;
    const handle = turnEvents(state, true);
    let ended = false;
    void (async () => {
      let found = false;
      try {
        found = await agentApi.follow(
          resume.turn,
          (e, replay) => {
            if (e.type === "done") ended = true;
            handle(e, replay);
          },
          ctl.signal,
        );
      } catch {}
      if (ctl.signal.aborted || ended) return;
      // Over before it could be followed, or the stream broke: read what's saved, and follow again if it's still going.
      const c = await savedAfterBreak(resume.conv, state, ctl.signal);
      if (ctl.signal.aborted) return;
      if (c?.running) {
        const turn = c.running;
        setTimeout(() => !ctl.signal.aborted && setResume({ conv: resume.conv, turn }), found ? 300 : 1500);
        return;
      }
      ended = true;
      setLive((l) => (l?.turnId === state.turnId && !l.user ? null : l));
      if (c) setConv((cur) => (cur?.id === c.id ? c : cur));
      if (state.changed) refreshPage(onChanged, true);
    })();
    return () => {
      ctl.abort();
      if (!ended) setLive((l) => (l?.turnId === state.turnId && !l.user ? null : l));
    };
  }, [resume]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !activeRef.current) return;
      if (document.querySelector("[role=dialog][data-state=open], [data-slot=popover-content], [role=listbox]")) return;
      onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const ensureConv = async (forSend = false): Promise<string> => {
    if (conv) return conv.id;
    const c = await agentApi.create(profile.brain.kind === "model" ? model : null, profile.id);
    const full = { ...c, messages: [] };
    if (forSend) skipControlsFor.current = c.id;
    setConv(full);
    kept.current.set(c.id);
    loadList();
    return c.id;
  };

  /** Talk to someone else: a new chat with that profile. The old one stays in the history. */
  const pickProfile = (id: string) => {
    setNextProfile(id);
    leaveReply(null);
    setConv(null);
    setModel(null);
    setLive(null);
    setResume(null);
    kept.current.set(null);
    requestAnimationFrame(() => input.current?.focus());
  };

  /** Picks a value in one of the chat's pickers. Before the chat exists (and for a model's effort) it waits for the next message. */
  const pickControl = async (id: string, value: string, confirmed = false) => {
    // Another harness before the chat's first message: its own pickers (model, effort) replace the last one's.
    if (id === "harness" && !conv) {
      const seq = ++controlsSeq.current;
      setPicks({ harness: value });
      try {
        const c = await agentApi.controls(null, profile.id, true, value);
        if (seq === controlsSeq.current) setOffered(c);
      } catch (e) {
        toast.error((e as Error).message);
      }
      return;
    }
    if (!conv || profile.brain.kind !== "external") return setPicks((p) => ({ ...p, [id]: value }));
    const seq = ++controlsSeq.current;
    try {
      const c = await agentApi.setControl(conv.id, id, value, confirmed);
      if (seq === controlsSeq.current) setOffered(c);
    } catch (e) {
      // The agent asks before a costly switch (a large context re-read at the new model's price): its words, and a yes.
      if ((e as { code?: string }).code === "confirm_pick" && !confirmed) {
        toast.warning((e as Error).message, { duration: 20_000, action: { label: "Switch anyway", onClick: () => void pickControl(id, value, true) } });
        return;
      }
      toast.error((e as Error).message);
    }
  };
  /** Asks again what can be picked: the providers' model lists, and an agent's choices (it restarts to read them). */
  const reloadModels = async () => setModels(await agentApi.models(true));
  const reloadControls = async () => {
    const seq = ++controlsSeq.current;
    const c = await agentApi.refreshControls(conv?.id ?? null, profile.id);
    if (seq !== controlsSeq.current) return;
    setOffered(c);
    if (c.usage) setUsage(c.usage);
  };
  const controls = useMemo(() => (offered?.controls ?? []).map((c) => (picks[c.id] && c.options.some((o) => o.value === picks[c.id]) ? { ...c, currentValue: picks[c.id] } : c)), [offered, picks]);

  const pickModel = async (ref: string) => {
    setModel(ref);
    if (conv) {
      try {
        await agentApi.setModel(conv.id, ref);
      } catch (e) {
        toast.error((e as Error).message);
      }
    }
  };

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    let id: string;
    try {
      id = await ensureConv();
    } catch (e) {
      toast.error((e as Error).message);
      return;
    }
    for (const f of files) {
      if (f.size > 50 * 1024 * 1024) {
        toast.error(`${f.name} is over 50 MB`);
        continue;
      }
      const key = Math.random().toString(36).slice(2);
      setAtts((a) => [...a, { uploading: f.name || "pasted image", key }]);
      try {
        const meta = await agentApi.upload(id, f);
        setAtts((a) => a.map((x) => ("key" in x && x.key === key ? meta : x)));
      } catch (e) {
        setAtts((a) => a.filter((x) => !("key" in x && x.key === key)));
        toast.error(`Couldn't attach ${f.name}`, { description: (e as Error).message });
      }
    }
  };

  const busy = !!live;
  const ready = atts.every((a) => !("uploading" in a));

  // A request handed over by another screen (askEtude): a fresh conversation, sent once a model is known.
  const autoSend = useRef(false);
  useEffect(() => {
    if (!takeAsk) return;
    const take = () => {
      if (asked == null) return;
      setConv(null);
      kept.current.set(null);
      setText(asked);
      asked = null;
      autoSend.current = true;
      requestAnimationFrame(() => input.current?.focus());
    };
    take();
    if (takeAsk === "mount") return;
    window.addEventListener(ASK_EVENT, take);
    return () => window.removeEventListener(ASK_EVENT, take);
  }, []);
  useEffect(() => {
    if (!autoSend.current || !text.trim() || !models || busy) return;
    autoSend.current = false;
    if (models.configured) send();
  });

  // Steer: words typed while the reply is being written go to the model after the step it's on.
  const steerAtts = atts.filter((a): a is Attachment => !("uploading" in a));
  const canSteer = busy && (!!text.trim() || steerAtts.length > 0) && !atts.some((a) => "uploading" in a) && !!live?.turnId && !live.lost;
  // Words an agent couldn't take mid-reply: they go as the next message, unless the box changed meanwhile.
  const afterReply = useRef<string | null>(null);
  const steer = async () => {
    const msg = text.trim();
    const turnId = live?.turnId;
    const files = steerAtts;
    if ((!msg && !files.length) || !turnId || atts.some((a) => "uploading" in a)) return;
    setText("");
    setAtts([]);
    stick.current = true;
    const ok = await agentApi.steer(turnId, msg, files.map((a) => a.id)).then((r) => r.steered, () => false);
    if (ok) return;
    setText(msg);
    setAtts((x) => [...files, ...x]);
    afterReply.current = msg;
    toast(`${profile.name} can't take a message mid-reply here`, { description: "It goes as soon as this reply ends." });
  };
  useEffect(() => {
    const kept = afterReply.current;
    if (kept == null) return;
    if (text.trim() !== kept) afterReply.current = null;
    else if (!busy) {
      afterReply.current = null;
      send();
    }
  }, [busy, text]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * What a turn's events do to the chat, kept in `state`. A replayed event (picking a turn up after a reload) only
   * redraws: it doesn't navigate or refresh the page again.
   */
  const turnEvents = (state: Live, resumed = false) => {
    const bump = () => !state.detached && setLive({ ...state, items: [...state.items] });
    const mine = (c: Conversation | null) => !!c && !state.detached && (!state.conv || c.id === state.conv);
    // Writes mid-turn refresh the page shortly after, unless the agent navigates first.
    let pendingRefresh: ReturnType<typeof setTimeout> | null = null;
    const cancelRefresh = () => {
      if (pendingRefresh) clearTimeout(pendingRefresh);
      pendingRefresh = null;
    };
    const onEvent = (e: AgentEvent, replay = false) => {
      switch (e.type) {
        case "start":
          state.turnId = e.turnId;
          // A picked-up turn's question is already in the chat's saved messages.
          if (!resumed) state.user = e.userMessage;
          setConvs((cs) => [e.conversation, ...cs.filter((c) => c.id !== e.conversation.id)]);
          setConv((c) => (c && mine(c) ? { ...c, title: e.conversation.title, autoTitle: e.conversation.autoTitle } : c));
          break;
        case "text": {
          const last = state.items[state.items.length - 1];
          if (last?.type === "text") state.items[state.items.length - 1] = { type: "text", text: last.text + e.delta };
          else state.items.push({ type: "text", text: e.delta });
          break;
        }
        case "tool_start":
        case "tool_end":
        case "confirm": {
          const i = state.items.findIndex((x) => x.type === "tool" && x.id === e.item.id);
          if (i >= 0) state.items[i] = e.item;
          else state.items.push(e.item);
          break;
        }
        case "ui":
          state.items.push({ type: "ui", action: e.action, path: e.path });
          if (replay || state.detached) break;
          if (e.action === "navigate" && e.path) {
            cancelRefresh();
            navigate(e.path);
            if (phone) toast(`Opened ${pageLabel(e.path).name}`, { action: { label: "Close chat", onClick: onClose } });
          } else {
            cancelRefresh();
            refreshPage(onChanged, true);
          }
          break;
        case "title":
          setConvs((cs) => cs.map((c) => (c.id === e.conversation.id ? e.conversation : c)));
          setConv((c) => (c && c.id === e.conversation.id ? { ...c, title: e.conversation.title, autoTitle: e.conversation.autoTitle } : c));
          return;
        case "changed":
          state.changed = true;
          if (replay) break;
          refreshTheme();
          cancelRefresh();
          pendingRefresh = setTimeout(() => refreshPage(onChanged, false), 700);
          break;
        case "error":
          state.error = e.error;
          break;
        case "thought": {
          const last = state.items[state.items.length - 1];
          if (last?.type === "thought") state.items[state.items.length - 1] = { type: "thought", text: last.text + e.delta, ms: e.ms };
          else state.items.push({ type: "thought", text: e.delta, ms: e.ms });
          break;
        }
        case "steer":
          state.items.push({ type: "steer", text: e.text, ...(e.attachments?.length ? { attachments: e.attachments } : {}) });
          break;
        case "usage":
          if (!state.detached) setUsage(e.usage);
          return;
        case "controls":
          if (state.detached) return;
          controlsSeq.current++;
          setOffered(e.controls);
          setPicks({});
          return;
        case "tasks":
          if (!state.detached) setBgTasks(e.tasks);
          return;
        case "look":
          // The model asked to see the screen: answer from this window, not part of the chat.
          if (state.turnId) {
            const turnId = state.turnId;
            void look(e.mode).then((r) => agentApi.look(turnId, e.id, r)).catch(() => {});
          }
          return;
        case "done":
          if (state.detached) {
            if (state.changed) refreshPage(onChanged, true);
            loadList();
            return;
          }
          setConv((c) => (c && mine(c) ? { ...c, messages: [...c.messages.filter((m) => m.id !== e.message.id && m.id !== state.user?.id), ...(state.user ? [state.user] : []), e.message] } : c));
          setLive(null);
          cancelRefresh();
          if (state.changed) {
            refreshTheme();
            refreshPage(onChanged, true);
          }
          loadList();
          return;
      }
      bump();
    };
    return onEvent;
  };

  const send = async () => {
    if (busy) return steer();
    const msg = text.trim();
    const done = atts.filter((a): a is Attachment => !("uploading" in a));
    if ((!msg && !done.length) || !ready) return;
    await deliver(msg, done);
  };

  const deliver = async (msg: string, done: Attachment[]) => {
    let id: string;
    try {
      id = await ensureConv(true);
    } catch (e) {
      toast.error((e as Error).message);
      return;
    }
    setText("");
    setAtts([]);
    stick.current = true;
    const state: Live = { turnId: null, user: null, items: [], changed: false, error: null, conv: id };
    setLive({ ...state });
    sending.current = state;
    const handle = turnEvents(state);
    let ended = false;
    const onEvent = (e: AgentEvent) => {
      if (e.type === "done") ended = true;
      handle(e);
    };
    try {
      await agentApi.send(id, { text: msg, attachments: done.map((a) => a.id), model: profile.brain.kind === "model" ? model : null, ...(profile.brain.kind === "model" ? (picks.effort ? { effort: picks.effort } : {}) : Object.keys(picks).length ? { controls: picks } : {}), page: appPath() + location.search, view: currentView() }, onEvent);
    } catch (e) {
      // Before the turn began, the message never went. After that, the stream broke under a turn that had started.
      if (!state.turnId && state.detached) {
        toast.error("The assistant couldn't start", { description: (e as Error).message });
        return;
      }
      if (!state.turnId) {
        if (sending.current === state) sending.current = null;
        setLive(null);
        setText(msg);
        // The iPhone app: its provider wasn't agreed to, so nothing went. Ask; I agree sends it, Not now keeps the draft.
        const provider = asksAiConsent() ? consentProvider(e) : null;
        if (provider) {
          setAtts(done);
          consent.confirm([provider], () => void deliver(msg, done), true);
          return;
        }
        toast.error("The assistant couldn't start", { description: (e as Error).message });
        return;
      }
    }
    if (sending.current === state) sending.current = null;
    if (ended || state.detached) return;
    // The stream ended without `done` (the server went away, the connection dropped): take what the server saved, and follow the turn if it's still going.
    const c = await savedAfterBreak(id, state);
    setLive(null);
    if (c) setConv(c);
    if (c?.running) setResume({ conv: id, turn: c.running });
  };

  /**
   * A reply's stream broke. What it wrote stays on screen until the server answers again (it may be restarting), then
   * the chat as the server has it comes back: the reply saved as far as it got, or still running. Null when the
   * server stayed away, or `signal` gave up.
   */
  const savedAfterBreak = async (id: string, state: Live, signal?: AbortSignal) => {
    for (let i = 0; i < 200 && mounted.current && !signal?.aborted; i++) {
      const c = await agentApi.get(id).catch(() => null);
      if (c || signal?.aborted) return c;
      if (i === 1) {
        state.lost = true;
        setLive((l) => (l && l.turnId === state.turnId ? { ...l, lost: true } : l));
      }
      await new Promise((r) => setTimeout(r, i < 30 ? 500 : 3000));
    }
    return null;
  };

  const stop = async () => {
    if (live?.turnId) await agentApi.stop(live.turnId).catch(() => {});
  };

  const answer = async (item: ToolItem, allow: boolean, optionId?: string) => {
    if (!live?.turnId) return;
    try {
      await agentApi.confirm(live.turnId, item.id, allow, optionId);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const undo = async (m: Message) => {
    if (!conv) return;
    try {
      const r = await agentApi.undo(conv.id, m.id);
      setConv({ ...conv, messages: conv.messages.map((x) => (r.undone.includes(x.id) ? { ...x, undone: true, canUndo: false } : x)) });
      await refreshTheme();
      await refreshPage(onChanged, true);
      toast.success("Changes undone");
    } catch (e) {
      toast.error("Couldn't undo", { description: (e as Error).message });
    }
  };

  const rename = async (title: string) => {
    if (!conv || !title.trim() || title.trim() === conv.title) return;
    try {
      const c = await agentApi.rename(conv.id, title.trim());
      setConv({ ...conv, title: c.title, autoTitle: c.autoTitle });
      setConvs((cs) => cs.map((x) => (x.id === c.id ? c : x)));
    } catch (e) {
      toast.error("Couldn't rename", { description: (e as Error).message });
    }
  };

  /** A chat renamed or pinned somewhere else (the sidebar): this chat and the list catch up. */
  const touchConv = (c: Conversation) => {
    setConv((cur) => (cur && cur.id === c.id ? { ...cur, title: c.title, autoTitle: c.autoTitle, pinned: c.pinned } : cur));
    setConvs((cs) => cs.map((x) => (x.id === c.id ? c : x)));
  };

  const removeConv = async (id: string) => {
    try {
      const kept = agentKeptSession(await agentApi.remove(id));
      if (kept) toast.warning(kept);
      if (conv?.id === id) openConv(null);
      loadList();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // An external agent needs no AI provider; a profile whose agent isn't on this device can't answer here.
  const notConfigured = models && !models.configured && profile.brain.kind === "model";
  const unavailable = !profile.available;
  const showModel = profile.brain.kind === "model";
  const fallback = models?.default?.startsWith("agent:") ? null : (models?.default ?? null);
  const shownModel = model ?? (profile.brain.kind === "model" ? profile.brain.model : null) ?? fallback;
  const messages = conv?.messages ?? [];
  const empty = !messages.length && !live;
  const canSend = (!!text.trim() || atts.length > 0) && ready && !notConfigured && !unavailable;

  const suggest = (t: string) => {
    if (busy) return;
    setText(t);
    pendingSend.current = true;
  };
  // A suggestion fills the composer, then sends on the next render (so `send` sees the text).
  const pendingSend = useRef(false);
  useEffect(() => {
    if (pendingSend.current && text) {
      pendingSend.current = false;
      send();
    }
  }, [text]);
  return { phone, convs, conv, models, model: shownModel, profile, profiles, pickProfile, showModel, unavailable, text, setText, atts, setAtts, live, busy, bgTasks, ready, scroller, input, fileInput, stick, openConv, pickModel, addFiles, send, stop, steer, canSteer, answer, undo, rename, removeConv, touchConv, notConfigured, messages, empty, canSend, suggest, loadList, controls, pickControl, usage, reloadModels, reloadControls, consentDialog: consent.dialog };
}

interface PanelTab {
  key: string;
  conv: string | null;
}
interface TabMeta {
  title: string;
  profile: string;
  busy: boolean;
}
const MAX_TABS = 12;
const tabKey = () => Math.random().toString(36).slice(2, 9);

/** The tabs as they were, with the chat the mini chat last had open among them. */
function savedTabs(): { tabs: PanelTab[]; active: string } {
  let tabs: PanelTab[] = [];
  let active = "";
  try {
    const j = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null");
    if (Array.isArray(j?.tabs)) tabs = j.tabs.filter((t: PanelTab) => t && typeof t.key === "string" && (t.conv === null || typeof t.conv === "string")).slice(0, MAX_TABS);
    if (typeof j?.active === "string") active = j.active;
  } catch {}
  const last = localStorage.getItem(CONV_KEY);
  if (last && tabs.find((t) => t.key === active)?.conv !== last) {
    const has = tabs.find((t) => t.conv === last);
    if (has) active = has.key;
    else {
      const blank = tabs.find((t) => t.key === active && !t.conv);
      if (blank) blank.conv = last;
      else {
        tabs.push({ key: tabKey(), conv: last });
        active = tabs[tabs.length - 1].key;
      }
    }
  }
  if (!tabs.length) tabs = [{ key: tabKey(), conv: null }];
  if (!tabs.some((t) => t.key === active)) active = tabs[tabs.length - 1].key;
  return { tabs, active };
}

/** A chat that was open in the Notebook goes back to the side panel as a tab; the panel opens if it was closed. */
export function chatToPanel(chat: DockedChat) {
  const p = panelSide();
  if (p) return p.take(chat);
  const s = savedTabs();
  const tabs = s.tabs.filter((t) => t.conv && t.conv !== chat.conv).slice(0, MAX_TABS - 1);
  localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: [...tabs, chat], active: chat.key }));
  if (chat.conv) localStorage.setItem(CONV_KEY, chat.conv);
  else localStorage.removeItem(CONV_KEY);
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const noop = () => {};
const never = () => false;
/** The chats that are open in the Notebook. They're drawn here, above the pages, each in a box of its own that its
 *  pane takes in: a chat keeps working (and keeps what's typed) when its tab moves, hides or the page reloads its data. */
export function DockHost({ onChanged }: { onChanged(final: boolean): void }) {
  const d = useDock();
  const phone = usePhone();
  const onConv = useCallback((key: string, conv: string | null) => dock.setConv(key, conv), []);
  if (phone) return null;
  return (
    <>
      {d.chats.map((c) =>
        createPortal(
          <ChatTab tab={c} active={!!d.shown[c.key]} ask={false} phone={false} docked slot={d.slots[c.key] ?? null} onClose={noop} onChanged={onChanged} onMeta={dock.setMeta} onConv={onConv} onPick={never} onDeleted={noop} />,
          dockNode(c.key),
          c.key,
        ),
      )}
    </>
  );
}

/** The side panel: chats in tabs. Each tab is a chat of its own, and they can all be working at once. */
export function AgentPanel({ width, setWidth, onClose, onChanged, onProfile }: { width: number; setWidth(w: number): void; onClose(): void; onChanged(final: boolean): void; /** Who the tab in front is with. */ onProfile?(id: string): void }) {
  const phone = usePhone();
  // The tab made for what another screen asked (askEtude).
  const askTab = useRef<string | null>(null);
  const [state, setState] = useState(() => {
    const s = savedTabs();
    if (asked != null) {
      const cur = s.tabs.find((t) => t.key === s.active)!;
      if (cur.conv) {
        s.tabs.push({ key: tabKey(), conv: null });
        s.active = s.tabs[s.tabs.length - 1].key;
      }
      askTab.current = s.active;
    }
    return s;
  });
  const { tabs, active } = state;
  const [metas, setMetas] = useState<Record<string, TabMeta>>({});
  const [unread, setUnread] = useState<Record<string, boolean>>({});
  const profiles = useAgentProfiles();
  const strip = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    localStorage.setItem(TABS_KEY, JSON.stringify(state));
    const conv = tabs.find((t) => t.key === active)?.conv;
    if (conv) localStorage.setItem(CONV_KEY, conv);
    else localStorage.removeItem(CONV_KEY);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const withNow = metas[active]?.profile;
  useEffect(() => {
    if (withNow) onProfile?.(withNow);
  }, [withNow]); // eslint-disable-line react-hooks/exhaustive-deps

  const show = useCallback((key: string) => {
    setState((s) => (s.active === key ? s : { ...s, active: key }));
    setUnread((u) => (u[key] ? { ...u, [key]: false } : u));
  }, []);
  const add = useCallback((ask = false) => {
    setState((s) => {
      // An empty tab that's already there is the new chat.
      const cur = s.tabs.find((t) => t.key === s.active);
      const key = tabKey();
      if (ask) askTab.current = key;
      if (cur && !cur.conv && ask) return { tabs: s.tabs.map((t) => (t === cur ? { key, conv: null } : t)), active: key };
      if (s.tabs.length >= MAX_TABS) {
        toast("Close a tab to open another");
        return s;
      }
      return { tabs: [...s.tabs, { key, conv: null }], active: key };
    });
  }, []);
  const close = useCallback((key: string) => {
    setState((s) => {
      const i = s.tabs.findIndex((t) => t.key === key);
      if (i < 0) return s;
      const left = s.tabs.filter((t) => t.key !== key);
      if (!left.length) {
        const fresh = { key: tabKey(), conv: null };
        return { tabs: [fresh], active: fresh.key };
      }
      return { tabs: left, active: s.active === key ? left[Math.min(i, left.length - 1)].key : s.active };
    });
    setMetas(({ [key]: _, ...m }) => m);
  }, []);
  // Closed by hand (×, middle click, the menu, Alt+W): the only tab left takes the panel with it, like a window's
  // last tab. The panel opens again on a blank chat. A chat that leaves for the Notebook keeps the panel open.
  const closeByHand = (key: string) => {
    const last = tabsRef.current.length <= 1 && tabsRef.current[0]?.key === key;
    close(key);
    if (last) onClose();
  };
  const byHand = useRef(closeByHand);
  byHand.current = closeByHand;
  const onConv = useCallback((key: string, conv: string | null) => setState((s) => (s.tabs.some((t) => t.key === key && t.conv !== conv) ? { ...s, tabs: s.tabs.map((t) => (t.key === key ? { ...t, conv } : t)) } : s)), []);
  const onMeta = useCallback((key: string, meta: TabMeta) => {
    setMetas((m) => {
      // A reply that finished behind another tab leaves a dot on its tab.
      if (m[key]?.busy && !meta.busy && activeRef.current !== key) setUnread((u) => ({ ...u, [key]: true }));
      return { ...m, [key]: meta };
    });
  }, []);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const onPick = useCallback((conv: string) => {
    const has = tabsRef.current.find((t) => t.conv === conv);
    if (has) show(has.key);
    return !!has;
  }, [show]);
  /** A chat from the sidebar in a tab of its own (the one that has it already comes forward). */
  const openInTab = useCallback((conv: string) => {
    if (onPick(conv)) return;
    setState((s) => {
      if (s.tabs.length >= MAX_TABS) {
        toast("Close a tab to open another");
        return s;
      }
      const key = tabKey();
      return { tabs: [...s.tabs, { key, conv }], active: key };
    });
  }, [onPick]);
  // A chat deleted in one tab closes in the others.
  const onDeleted = useCallback((conv: string) => setState((s) => (s.tabs.some((t) => t.conv === conv) ? { ...s, tabs: s.tabs.map((t) => (t.conv === conv ? { key: tabKey(), conv: null } : t)) } : s)), []);

  // A chat coming back from the Notebook is a tab here again.
  useEffect(() => {
    registerPanel({
      take: (chat) =>
        setState((s) => {
          if (s.tabs.some((t) => t.key === chat.key)) return { ...s, active: chat.key };
          const blank = s.tabs.length === 1 && !s.tabs[0].conv;
          return { tabs: [...(blank ? [] : s.tabs), { key: chat.key, conv: chat.conv }], active: chat.key };
        }),
    });
    return () => registerPanel(null);
  }, []);
  /** A tab leaves for the Notebook: dragged onto a pane there, or opened as a page from its menu. */
  const metasRef = useRef(metas);
  metasRef.current = metas;
  const startDrag = (t: PanelTab, e: React.PointerEvent) => {
    if (phone || e.button !== 0) return;
    notebookSide()?.dragIn({ key: t.key, conv: t.conv }, metasRef.current[t.key], e, () => close(t.key));
  };
  const openAsPage = (t: PanelTab) => {
    const chat = { key: t.key, conv: t.conv };
    const nb = notebookSide();
    if (nb) nb.open(chat, metasRef.current[t.key]);
    else {
      dock.addWaiting(chat, metasRef.current[t.key]);
      navigate("/notes");
    }
    close(t.key);
  };

  // Something asked from another screen while the panel is open: a tab of its own.
  useEffect(() => {
    const h = () => asked != null && add(true);
    window.addEventListener(ASK_EVENT, h);
    return () => window.removeEventListener(ASK_EVENT, h);
  }, [add]);

  // Alt+1…9 picks a tab, Alt+T opens one, Alt+W closes the one in front. Ctrl+T / Ctrl+W do the same when you're in
  // the panel, or on a screen with no tabs of its own (everything but the Notebook).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const k = tabShortcut(e);
      if (k && (inAskPanel() || !location.pathname.startsWith("/notes"))) {
        e.preventDefault();
        if (k === "new") add();
        else byHand.current(activeRef.current);
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const n = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (n && tabsRef.current[Number(n) - 1]) show(tabsRef.current[Number(n) - 1].key);
      else if (e.code === "KeyT") add();
      else if (e.code === "KeyW") byHand.current(activeRef.current);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [show, add, close]);

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  // Desktop resize from the left edge, as far as a bar between two Notebook pages goes; a double click
  // puts it back to its usual width.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = shown;
    const move = (ev: PointerEvent) => setWidth(panelWidth(w0 + (x0 - ev.clientX), room));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const vv = useVisualViewport(phone);
  // A desktop window too narrow for the page and the panel side by side: the panel lies over the page.
  const cramped = useNarrow(720);
  // A window made smaller since the width was set still leaves the page its share.
  const panel = useRef<HTMLDivElement>(null);
  const room = usePanelRoom(panel);
  const shown = panelWidth(width, room);
  useEffect(() => {
    if (!phone && !cramped && shown !== width) setWidth(shown);
  }, [phone, cramped, shown, width, setWidth]);

  return (
    <div
      ref={panel}
      role="complementary"
      aria-label="Ask Etude"
      data-agent-panel
      className={cn(
        "achat flex flex-col text-foreground",
        phone ? "agent-sheet-in fixed inset-x-0 top-0 z-50 h-dvh pt-[env(safe-area-inset-top)]" : cramped ? "agent-panel-in fixed top-0 right-0 z-40 h-dvh max-w-full bg-background shadow-[-24px_0_60px_rgb(0_0_0/0.18)]" : "agent-panel-in sticky top-0 h-dvh shrink-0",
      )}
      style={phone ? (vv ? { height: vv.h, top: vv.top } : undefined) : { width: shown }}
    >
      {!phone && <div onPointerDown={startResize} onDoubleClick={() => setWidth(428)} data-agent-resize className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize" aria-hidden />}
      <div className="mt-2 flex h-10 shrink-0 items-center gap-1 px-3 phone:mt-1" data-agent-tabs>
        {phone && (
          <RoundButton label="Close" onClick={onClose}>
            <ChevronLeft />
          </RoundButton>
        )}
        <div ref={strip} role="tablist" aria-label="Chats" className="achat-tabs flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t, i) => {
            const meta = metas[t.key];
            const on = t.key === active;
            const name = meta?.title || "New chat";
            return (
              <ContextMenu key={t.key}>
              <ContextMenuTrigger asChild>
              <div className={cn("achat-tab group/tab", on && "is-on")} data-chat-tab={t.key}>
                <button type="button" role="tab" aria-selected={on} title={i < 9 ? `${name} (Alt+${i + 1})` : name} onPointerDown={(e) => startDrag(t, e)} onClick={() => show(t.key)} onAuxClick={(e) => e.button === 1 && closeByHand(t.key)} className="achat-tab-main outline-ring focus-visible:outline-2">
                  {meta?.busy ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Working" /> : <AgentAvatar profile={profileFrom(profiles, meta?.profile ?? null)} size={18} />}
                  <span className="truncate">{name}</span>
                  {unread[t.key] && !on && <i className="achat-tab-dot" aria-label="New reply" />}
                </button>
                <button type="button" aria-label={`Close ${name}`} onClick={() => closeByHand(t.key)} className="achat-tab-x outline-ring focus-visible:outline-2">
                  <X className="size-3" />
                </button>
              </div>
              </ContextMenuTrigger>
              {!phone && (
                <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
                  <ContextMenuItem onSelect={() => openAsPage(t)}>Open as a page</ContextMenuItem>
                  <ContextMenuItem onSelect={() => closeByHand(t.key)}>Close</ContextMenuItem>
                </ContextMenuContent>
              )}
              </ContextMenu>
            );
          })}
          {/* Right after the last tab, where a browser has it; it stays in reach when the tabs fill the row. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="New chat" onClick={() => add()} className="achat-tab-add outline-ring focus-visible:outline-2">
                <Plus className="size-4" strokeWidth={2.2} />
              </button>
            </TooltipTrigger>
            <TooltipContent>New tab, blank chat <span className="opacity-60">Alt+T</span></TooltipContent>
          </Tooltip>
        </div>
        <span ref={setSlot} className="contents" />
        {!phone && (
          <RoundButton label="Close" tip={<>Close <span className="opacity-60">Esc</span></>} onClick={onClose}>
            <ChevronsRight />
          </RoundButton>
        )}
      </div>
      {tabs.map((t) => (
        <ChatTab key={t.key} tab={t} active={t.key === active} ask={askTab.current === t.key} phone={phone} slot={slot} onClose={onClose} onChanged={onChanged} onMeta={onMeta} onConv={onConv} onPick={onPick} onDeleted={onDeleted} onOpenNew={openInTab} />
      ))}
    </div>
  );
}

const SIDEBAR_KEY = "etude.agent.sidebar";
const SIDEBAR_EVENT = "etude:chat-sidebar";
/** Whether the chats' sidebar is open: one answer for every chat on this device, remembered across reloads. */
function useChatSidebar(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => localStorage.getItem(SIDEBAR_KEY) === "1");
  useEffect(() => {
    const h = () => setOpen(localStorage.getItem(SIDEBAR_KEY) === "1");
    window.addEventListener(SIDEBAR_EVENT, h);
    return () => window.removeEventListener(SIDEBAR_EVENT, h);
  }, []);
  const set = useCallback((v: boolean) => {
    localStorage.setItem(SIDEBAR_KEY, v ? "1" : "0");
    window.dispatchEvent(new Event(SIDEBAR_EVENT));
  }, []);
  return [open, set];
}

/** One tab of the panel: a chat of its own, which keeps working while another tab is in front. */
function ChatTab({ tab, active, ask, phone, slot, docked = false, onClose, onChanged, onMeta, onConv, onPick, onDeleted, onOpenNew }: {
  tab: PanelTab;
  active: boolean;
  /** Open among the Notebook's pages instead of in the panel: it's always drawn, its pane decides if it's seen. */
  docked?: boolean;
  /** Made for something another screen asked: it takes that as its first message. */
  ask: boolean;
  phone: boolean;
  /** A spot in the row of tabs the tab in front can put a button in (nothing goes there now). */
  slot: HTMLElement | null;
  onClose(): void;
  onChanged(final: boolean): void;
  onMeta(key: string, meta: TabMeta): void;
  onConv(key: string, conv: string | null): void;
  /** A chat picked from the history: true when another tab already has it (that tab comes forward). */
  onPick(conv: string): boolean;
  onDeleted(conv: string): void;
  /** Opens a chat in a tab of its own (the side panel). */
  onOpenNew?(conv: string): void;
}) {
  const store = useMemo<ConvStore>(() => ({ get: () => tab.conv, set: (id) => onConv(tab.key, id) }), [tab.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const chat = useAgentChat({ onClose, onChanged, takeAsk: ask ? "mount" : false, store, active, lastWith: false });
  const { convs, conv, models, profile, profiles, busy, live, scroller, input, fileInput, stick, openConv, addFiles, answer, undo, removeConv, touchConv, pickProfile, notConfigured, messages, empty, suggest, loadList } = chat;
  const host = useMemo(() => ({ conv: conv?.id ?? "", send: suggest }), [conv?.id, suggest]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = conv?.title || "";
  useEffect(() => onMeta(tab.key, { title, profile: profile.id, busy: busy || chat.bgTasks.length > 0 }), [tab.key, title, profile.id, busy, chat.bgTasks.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Coming to the front: the keyboard goes to its box, and its history catches up with the other tabs.
  useEffect(() => {
    if (!active) return;
    loadList();
    requestAnimationFrame(() => input.current?.focus());
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async (id: string) => {
    await removeConv(id);
    onDeleted(id);
    announceChat({ deleted: id });
  };
  // A chat renamed, pinned or deleted elsewhere (the Notebook's list, another tab): this one catches up.
  useEffect(() => {
    const h = (e: Event) => {
      const c = (e as CustomEvent<ChatChange>).detail;
      if ("deleted" in c) {
        if (conv?.id === c.deleted) openConv(null);
      } else if (c.conv.id === conv?.id) touchConv(c.conv as Conversation);
      loadList();
    };
    window.addEventListener(CHAT_CHANGED_EVENT, h);
    return () => window.removeEventListener(CHAT_CHANGED_EVENT, h);
  }, [conv?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // In the Notebook, the app sidebar's list of chats asks this tab to show a chat or start one.
  useEffect(() => {
    if (!docked) return;
    const take = () => {
      const r = takeChatRequest(tab.key);
      if (!r) return;
      if ("with" in r) pickProfile(r.with);
      else openConv(r.open);
    };
    take();
    const h = (e: Event) => (e as CustomEvent<string>).detail === tab.key && take();
    window.addEventListener(CHAT_REQUEST_EVENT, h);
    return () => window.removeEventListener(CHAT_REQUEST_EVENT, h);
  }, [docked, tab.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const notesView = useNotesView();
  const notesPages = useNotesPagesOpen();
  const [dragging, setDragging] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  // The chats' sidebar, open or not in every chat at once; over the chat when the pane is narrow.
  const [side, setSide] = useChatSidebar();
  const [roomy, setRoomy] = useState(true);
  useEffect(() => {
    const el = panel.current;
    if (!el || phone) return void setRoomy(false);
    const ro = new ResizeObserver(() => setRoomy(el.clientWidth >= 720));
    ro.observe(el);
    return () => ro.disconnect();
  }, [phone]);
  // In the Notebook the list lives in the app sidebar (Notes' Chats), so a chat there draws none of its own.
  const sideOpen = side && active && !docked;
  useEffect(() => {
    if (sideOpen) loadList();
  }, [sideOpen, conv?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Ctrl+Shift+S opens and closes it from inside this chat.
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.code !== "KeyS") return;
      const a = document.activeElement;
      if (!panel.current || !(a && panel.current.contains(a))) return;
      e.preventDefault();
      if (docked) notesView === "chats" && notesPages ? setNotesView("pages") : showNotesChats();
      else setSide(!side);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [active, side, docked, notesView, notesPages]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ProfileContext.Provider value={profile}>
    {chat.consentDialog}
    <div
      ref={panel}
      role="tabpanel"
      data-agent-tab={active ? "on" : "off"}
      data-chat={conv?.id ?? ""}
      hidden={!active && !docked}
      className={cn("relative min-h-0 flex-1", active || docked ? "flex" : "hidden", dragging && "outline-2 -outline-offset-2 outline-ring/60")}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!panel.current?.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      {sideOpen && !roomy && <div className="csb-scrim" aria-hidden onClick={() => setSide(false)} />}
      {sideOpen && (
        <ChatSidebar
          convs={convs}
          profiles={profiles.profiles}
          active={conv?.id ?? null}
          current={profile}
          overlay={!roomy}
          onClose={() => setSide(false)}
          onPick={(id) => void (!onPick(id) && openConv(id))}
          onNew={() => openConv(null)}
          onNewWith={pickProfile}
          onDelete={remove}
          onRenamed={(c) => {
            touchConv(c);
            announceChat({ conv: c });
          }}
          onOpenNew={onOpenNew}
          onSettings={openAiSettings}
        />
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* The row under the tabs: the chats' sidebar button, at the left. The open sidebar has its own in its head. */}
      <div className="achat-bar" data-chat-bar>
        {!(sideOpen && roomy) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Chats"
                aria-pressed={docked ? notesView === "chats" && notesPages : side}
                onClick={() => (docked ? (notesView === "chats" && notesPages ? setNotesView("pages") : showNotesChats()) : setSide(!side))}
                className="csb-icon outline-ring focus-visible:outline-2"
                data-chat-sidebar-toggle
              >
                <Menu className="size-[17px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Chats <span className="opacity-60">Ctrl+Shift+S</span></TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div aria-hidden data-agent-fade className={cn("pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-[var(--achat-bg)] to-transparent transition-opacity duration-200", scrolled ? "opacity-100" : "opacity-0")} />
        <div
          ref={scroller}
          data-agent-scroll
          className="flex h-full flex-col overflow-y-auto px-4 pt-3 pb-14 phone:px-3.5"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            setScrolled(el.scrollTop > 4);
          }}
        >
          {notConfigured ? (
            <div className="mt-auto flex flex-col items-start gap-3 pb-2">
              <Logo className="size-11" />
              <p className="text-[17px] font-semibold tracking-tight">Set up an AI provider first</p>
              <p className="text-[13px] text-muted-foreground">Ask Etude uses the model you connect in Settings: your ChatGPT plan, an API key, or a local server.</p>
              <Button size="sm" variant="outline" onClick={openAiSettings}>
                Settings → AI
              </Button>
            </div>
          ) : empty ? (
            <div className="mx-auto flex w-full max-w-[608px] flex-1 flex-col">
              <EmptyState onPick={suggest} onFile={() => fileInput.current?.click()} />
            </div>
          ) : (
            <RichContext.Provider value={host}>
            <YouContext.Provider value>
                <div className="mx-auto flex w-full max-w-[608px] flex-col gap-3" data-agent-log>
                  {messages.map((m, i) => (
                    <MessageView key={m.id} m={m} conv={conv!.id} last={i === messages.length - 1 && !live} groups={models?.groups} onUndo={() => undo(m)} />
                  ))}
                  {live && (
                    <>
                      {live.user && <MessageView m={live.user} conv={conv?.id ?? ""} />}
                      <LiveView live={live} onAnswer={answer} />
                    </>
                  )}
                </div>
            </YouContext.Provider>
            </RichContext.Provider>
          )}
        </div>
      </div>

      <div data-agent-composer-wrap className="mx-auto w-full max-w-[640px] shrink-0 px-4 pt-1 pb-[max(1rem,env(safe-area-inset-bottom))] phone:px-3.5 phone:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {chat.bgTasks.length > 0 && <BackgroundTasksBar tasks={chat.bgTasks} />}
        <Composer chat={chat} phone={phone} onDelete={conv ? () => remove(conv.id) : undefined} />
      </div>
      </div>
    </div>
    </ProfileContext.Provider>
  );
}

function formatElapsed(startedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${String(rem).padStart(2, "0")}s`;
}

/** Compact live bar above the composer whenever the external agent has background processes still running. */
function BackgroundTasksBar({ tasks }: { tasks: BackgroundTask[] }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const oldest = Math.min(...tasks.map((t) => t.startedAt));
  const single = tasks.length === 1 ? tasks[0] : null;
  return (
    <div data-agent-bg-tasks className="mb-2 overflow-hidden rounded-2xl border border-border/80 bg-card/85 text-[12.5px] text-muted-foreground shadow-xs backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent/50"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
        <span className="shrink-0 font-medium text-foreground/90">
          {single ? "Running in background" : `${tasks.length} background processes`}
        </span>
        {single && (
          <>
            <span aria-hidden className="opacity-45">·</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{single.title}</span>
          </>
        )}
        {!single && <span className="min-w-0 flex-1" />}
        <span className="shrink-0 tabular-nums text-[11.5px] opacity-75">{formatElapsed(oldest, now)}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 opacity-60 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 border-t border-border/60 px-3 py-2">
          {tasks.map((t) => (
            <div key={t.id} className="flex items-start gap-2 text-[12px]">
              <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin text-primary/80" aria-hidden />
              <span className="min-w-0 flex-1 break-words text-foreground/85">
                {t.kind === "subagent" && <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">Subagent</span>}
                {t.title}
              </span>
              <span className="shrink-0 tabular-nums text-[11px] opacity-70">{formatElapsed(t.startedAt, now)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The message box: text on top, then who, model and effort as pills, permissions, the context ring and send. The side panel, a docked chat and Minimi's mini chat share it. */
export function Composer({ chat, phone, compact = false, below = false, onDelete }: { chat: ReturnType<typeof useAgentChat>; phone: boolean; /** Narrow (the mini chat): the pills shrink to their icons when there are several. */ compact?: boolean; /** The options sit in a row under the box (the mini chat), with only the text and Send inside it. */ below?: boolean; onDelete?(): void }) {
  const { conv, models, model, profile, pickProfile, showModel, text, setText, atts, setAtts, busy, input, fileInput, pickModel, addFiles, send, stop, steer, canSteer, rename, notConfigured, messages, canSend, controls, pickControl, usage, reloadModels, reloadControls } = chat;
  const sendText = useReadableOn("--highlight");
  const fun = useFunMode();
  // What the ring's card says about this chat.
  const facts = useMemo<SessionFacts>(() => {
    const replies = messages.filter((m) => m.role === "assistant").map((m) => m.content as AssistantContent);
    return { title: conv?.title ?? "", started: conv?.created ?? null, workedMs: replies.reduce((a, c) => a + (c.ms || 0), 0), turns: replies.length, tools: replies.reduce((a, c) => a + c.items.filter((i) => i.type === "tool" && !i.lookup).length, 0), served: replies[replies.length - 1]?.model ?? "" };
  }, [messages, conv?.title, conv?.created]);
  const external = profile.brain.kind === "external";
  const pill = (c: (typeof controls)[number]) => c.category === "harness" || c.category === "model" || c.category === "thought_level";
  const attach = (
    <>
            <input ref={fileInput} type="file" multiple hidden accept={NATIVE_ATTACH} onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Attach files"
                  disabled={!!notConfigured}
                  onClick={() => fileInput.current?.click()}
                  className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-ring hover:bg-accent hover:text-foreground focus-visible:outline-2 disabled:opacity-40 pointer-coarse:size-9"
                >
                  <Plus className="size-[18px]" strokeWidth={2.2} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Attach images, PDFs, text or .apkg</TooltipContent>
            </Tooltip>
    </>
  );
  const options = (
    <>
            <AgentSwitcher current={profile} onPick={pickProfile} disabled={busy} avatar={false} compact={(phone || compact) && controls.filter(pill).length > 1} className={PILL} />
            {showModel && <ModelPicker models={models} value={model} onPick={pickModel} className={PILL} onReload={reloadModels} />}
            {controls.filter(pill).map((c) => (
              <ControlPicker key={c.id} control={c} onPick={(v) => pickControl(c.id, v)} disabled={busy} onReload={c.category === "model" ? reloadControls : undefined} />
            ))}
            <div className="min-w-0 flex-1" />
            <PermissionPicker external={external ? profile.name : undefined} />
            <ContextRing usage={usage} facts={facts} extra={external ? controls.filter((c) => !pill(c)) : []} onPick={pickControl} onRename={conv ? rename : undefined} onDelete={onDelete} onSettings={openAiSettings} busy={busy} />
    </>
  );
  const sendButton = (
    <>
          {canSteer ? (
            // Something typed while the reply is being written: Stop becomes Steer.
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label="Steer" data-agent-steer-send onClick={steer} style={{ color: sendText }} className="grid size-8 shrink-0 place-items-center rounded-full bg-highlight transition-opacity outline-ring hover:opacity-90 focus-visible:outline-2 pointer-coarse:size-9">
                  <CornerUpRight className="size-[17px]" strokeWidth={2.2} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Steer: {profile.name} reads it after the step it's on</TooltipContent>
            </Tooltip>
          ) : busy ? (
            <button type="button" aria-label="Stop" onClick={stop} disabled={!!chat.live?.lost} style={{ color: sendText }} className="grid size-8 shrink-0 place-items-center rounded-full bg-highlight transition-opacity outline-ring hover:opacity-85 focus-visible:outline-2 disabled:opacity-35 pointer-coarse:size-9">
              <Square className="size-[13px] fill-current" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend}
              onClick={send}
              style={canSend ? { color: sendText } : undefined}
              className={cn("grid size-8 shrink-0 place-items-center rounded-full transition-all outline-ring focus-visible:outline-2 pointer-coarse:size-9", canSend ? "bg-highlight hover:opacity-90" : "pointer-events-none -ml-1 w-0 scale-75 opacity-0")}
            >
              <ArrowUp className="size-[18px]" strokeWidth={2.2} />
            </button>
          )}
    </>
  );
  const focusOnBlank = (e: React.MouseEvent) => e.target === e.currentTarget && input.current?.focus();
  if (below)
    return (
      <div className="achat-composer-below">
        <div
          data-agent-composer
          className="mchat-pill achat-composer is-below"
          onClick={(e) => {
            if (e.target === e.currentTarget) input.current?.focus();
          }}
        >
          {atts.length > 0 && (
            <div data-agent-atts className="achat-atts">
              {atts.map((a) => (
                <AttachmentChip key={"key" in a ? a.key : a.id} a={a} conv={conv?.id} onRemove={"id" in a ? () => setAtts((x) => x.filter((y) => !("id" in y) || y.id !== a.id)) : undefined} />
              ))}
            </div>
          )}
          <div className="flex items-end gap-0.5 px-1.5 py-1.5" onClick={focusOnBlank}>
          {attach}
          <textarea
            ref={input}
            value={text}
            rows={1}
            disabled={!!notConfigured}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            placeholder={`Ask ${askName(profile, fun)}…`}
            aria-label="Message"
            className="achat-input block min-w-0 flex-1 max-h-52 w-full resize-none bg-transparent text-[14.5px] leading-[21px] text-foreground outline-none placeholder:text-muted-foreground/80 [field-sizing:content] phone:text-base"
          />
            {sendButton}
          </div>
        </div>
        <div className="achat-ctl is-below" onClick={focusOnBlank}>{options}</div>
      </div>
    );
  return (
        <div
          data-agent-composer
          className="mchat-pill achat-composer"
          onClick={(e) => {
            if (e.target === e.currentTarget) input.current?.focus();
          }}
        >
          {atts.length > 0 && (
            <div data-agent-atts className="achat-atts">
              {atts.map((a) => (
                <AttachmentChip key={"key" in a ? a.key : a.id} a={a} conv={conv?.id} onRemove={"id" in a ? () => setAtts((x) => x.filter((y) => !("id" in y) || y.id !== a.id)) : undefined} />
              ))}
            </div>
          )}
          <textarea
            ref={input}
            value={text}
            rows={1}
            disabled={!!notConfigured}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            placeholder={`Ask ${askName(profile, fun)}…`}
            aria-label="Message"
            className="achat-input block max-h-52 w-full resize-none bg-transparent text-[14.5px] leading-[21px] text-foreground outline-none placeholder:text-muted-foreground/80 [field-sizing:content] phone:text-base"
          />
          <div className="achat-ctl" onClick={focusOnBlank}>
            {attach}
            {options}
            {sendButton}
          </div>
        </div>
  );
}

export function openAiSettings() {
  navigate("/settings");
  setTimeout(() => document.getElementById("ai")?.scrollIntoView({ block: "start" }), 120);
}

function TitleField({ title, onDone }: { title: string; onDone(t: string | null): void }) {
  const [draft, setDraft] = useState(title);
  const done = useRef(false);
  const finish = (t: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(t);
  };
  return (
    <input
      autoFocus
      value={draft}
      maxLength={80}
      aria-label="Conversation title"
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
      className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm font-medium outline-none focus:border-foreground/30"
    />
  );
}

type Idea = { label: string; say?: string; file?: boolean; hot?: boolean };

/** What's due today across the study decks (top level, Watch decks left out), and the deck carrying most of it. */
function useToday() {
  const [t, setT] = useState<{ due: number; decks: number; top: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    api
      .decks()
      .then((all) => {
        if (!live) return;
        const open = all.filter((d) => !d.archived);
        const names = new Set(open.map((d) => d.name));
        const study = open.filter((d) => d.mode !== "watch" && !names.has(d.name.split("::").slice(0, -1).join("::")));
        const work = (d: (typeof study)[number]) => d.new + d.learning + d.review;
        const top = [...study].sort((a, b) => work(b) - work(a))[0];
        setT({ due: study.reduce((a, d) => a + work(d), 0), decks: study.length, top: top && work(top) > 0 ? top.name : null });
      })
      .catch(() => live && setT({ due: 0, decks: 0, top: null }));
    return () => {
      live = false;
    };
  }, []);
  return t;
}

/**
 * Before the first message. An agent with a banner shows just that, in the middle, its edges fading into the page.
 * Otherwise, bottom-anchored above the composer: who you're talking to, a question, today's line and up to
 * three things to ask, as plain lines.
 */
function EmptyState({ onPick, onFile }: { onPick(t: string): void; onFile(): void }) {
  const profile = useContext(ProfileContext);
  const t = useToday();
  if (profile?.banner && profile.available)
    return (
      <div className="agent-rise my-auto w-full py-3" data-agent-empty>
        <EtudeImg src={mediaUrl(profile.banner)} alt={profile.name} draggable={false} data-agent-banner={profile.id} className="agent-banner" />
      </div>
    );
  const due = t?.due ?? 0;
  const n = due.toLocaleString();
  const line =
    profile && !profile.available ? (
      <>{profile.note}. Pick someone else above, or open Etude on that computer.</>
    ) : !t ? null : !t.decks ? (
      <>No decks yet. Give me a file and I’ll make your first one.</>
    ) : due ? (
      <>
        <b className="font-semibold text-foreground">{n} card{due === 1 ? "" : "s"}</b> waiting{t.top ? <>, most from {t.top}</> : null}
      </>
    ) : (
      <>All done for today.</>
    );
  const ideas: Idea[] = [
    ...(due ? [{ label: `Plan my due card${due === 1 ? "" : "s"}`, say: "Plan my review for today. What's due, and where should I start?", hot: true }] : []),
    ...(t?.top ? [{ label: `Quiz me on ${t.top}`, say: `Quiz me on ${t.top}: pick a few cards I keep missing and ask me one at a time.` }] : []),
    { label: "Make a deck from a file", file: true },
    { label: "Organize my decks" },
    { label: "Make a card type", say: "Help me make a new card type." },
  ].slice(0, 3);
  return (
    <div className="agent-rise mt-auto flex flex-col items-start pb-4" data-agent-empty>
      {profile ? <AgentAvatar profile={profile} size={40} /> : <Logo className="-ml-1.5 size-10" />}
      <p className="agent-empty-title mt-3.5 text-[22px] leading-tight">{t && !due && t.decks ? "What should we make?" : "What are we practicing?"}</p>
      {line && <p className="mt-1.5 text-[14px] leading-snug text-muted-foreground" data-agent-bubble>{line}</p>}
      <div className="mt-4 flex flex-col items-start">
        {ideas.map(({ label, say, file, hot }) => (
          <button
            key={label}
            type="button"
            data-suggestion
            onClick={() => (file ? onFile() : onPick(say ?? label))}
            className={cn("max-w-full truncate rounded-md py-1.5 text-left text-[14.5px] text-foreground/75 transition-colors outline-ring hover:text-foreground focus-visible:outline-2 pointer-coarse:py-2.5", hot && "font-medium text-primary hover:text-primary")}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function AttachmentChip({ a, conv, onRemove }: { a: Attachment | { uploading: string; key: string }; conv?: string; onRemove?(): void }) {
  const [zoom, setZoom] = useState(false);
  if ("uploading" in a)
    return (
      <span className="flex h-7 max-w-full items-center gap-1.5 rounded-lg border bg-background px-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        <span className="truncate">{a.uploading}</span>
      </span>
    );
  const Icon = a.kind === "image" ? ImageIcon : a.kind === "anki" ? Package : FileText;
  const src = conv ? agentApi.attachmentUrl(conv, a.id) : null;
  // A picture shows itself: a thumbnail that opens full size, before sending and after.
  if (a.kind === "image" && src)
    return (
      <span data-agent-att="image" className="relative block size-16 shrink-0" title={a.name}>
        <button type="button" onClick={() => setZoom(true)} aria-label={`Preview ${a.name}`} className="block size-full cursor-zoom-in overflow-hidden rounded-xl border bg-background outline-ring focus-visible:outline-2">
          <EtudeImg src={src} alt="" className="size-full object-cover" />
        </button>
        {onRemove && (
          <button type="button" onClick={onRemove} aria-label={`Remove ${a.name}`} className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-card text-muted-foreground hover:text-foreground pointer-coarse:size-6">
            <X className="size-3" />
          </button>
        )}
        {zoom && <Zoom src={src} alt={a.name} onClose={() => setZoom(false)} />}
      </span>
    );
  return (
    <span className="flex h-7 max-w-full items-center gap-1.5 rounded-lg border bg-background pr-1 pl-2 text-xs" title={a.name}>
      <Icon className="size-3.5 text-muted-foreground" />
      {a.kind === "pdf" && src ? (
        <a href={src} target="_blank" rel="noopener noreferrer" className="max-w-40 truncate hover:underline">{a.name}</a>
      ) : (
        <span className="max-w-40 truncate">{a.name}</span>
      )}
      <span className="text-muted-foreground">{a.pages ? `${a.pages} p` : fmtBytes(a.bytes)}</span>
      {onRemove ? (
        <button onClick={onRemove} aria-label={`Remove ${a.name}`} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          <X className="size-3" />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  );
}

export function MessageView({ m, conv, last, groups, onUndo }: { m: Message; conv: string; last?: boolean; groups?: ModelGroup[]; onUndo?(): void }) {
  const bubble = useContext(BubbleContext);
  const you = useContext(YouContext) || bubble;
  if (m.role === "user") {
    const c = m.content as UserContent;
    return (
      <div className="agent-rise flex flex-col items-end gap-1.5" data-agent-user>
        {c.attachments?.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {c.attachments.map((a) => (
              <AttachmentChip key={a.id} a={a} conv={conv} />
            ))}
          </div>
        )}
        {c.text && <div className={cn("max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-normal whitespace-pre-wrap [overflow-wrap:anywhere]", you ? "mchat-you rounded-[18px] px-[14px] py-[9px] text-[14.5px] leading-[1.42]" : "bg-[color-mix(in_oklab,var(--background),var(--foreground)_8%)]")}>{c.text}</div>}
      </div>
    );
  }
  const c = m.content as AssistantContent;
  const host = useContext(RichContext);
  const mine = useMemo(() => ({ ...host, conv, message: m.id }), [host, conv, m.id]);
  const undoLabel = c.changes?.length ? `Undo: ${undoSummary(c.changes)}` : "Undo these changes";
  const undo = c.changed && !m.undone && m.canUndo;
  return (
    <RichContext.Provider value={mine}>
    <div className={cn("group/reply agent-rise flex flex-col", bubble ? "gap-2.5" : "gap-1.5")} data-agent-reply>
      <Said
        below={(undo || (c.changed && m.undone)) && (
        <div
          className={cn(
            "-ml-1.5 flex min-h-6 min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground transition-opacity",
            bubble && "mchat-b ml-0 w-fit max-w-[88%] self-start px-1 py-0.5",
            // Hover-only on desktop, except the last reply's undo stays visible; always shown on touch.
            !last && "opacity-0 group-focus-within/reply:opacity-100 group-hover/reply:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          {undo ? (
            <button type="button" onClick={onUndo} title={undoLabel} className="flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 transition-colors outline-ring hover:bg-accent/70 hover:text-foreground focus-visible:outline-2">
              <RotateCcw className="size-3 shrink-0" />
              <span className="truncate">{undoLabel}</span>
            </button>
          ) : c.changed && m.undone ? (
            <span className="px-1.5">Undone{c.changes?.length ? `: ${c.changes.join(", ")}` : ""}</span>
          ) : null}
        </div>
      )}
      >
        <Items items={c.items} />
        <SourceList items={citations(c.items.flatMap((i) => (i.type === "text" ? [i.text] : [])))} />
        {c.error && <div className={cn("rounded-[10px] border border-destructive/40 px-3 py-2 text-[13px] text-destructive", bubble && "max-w-[88%] self-start bg-card")}>{c.error}</div>}
        {c.stopped && <div className={cn("text-[13px] text-muted-foreground", bubble && "mchat-b self-start px-3 py-1.5")}>Stopped.</div>}
        {c.cut && <div data-agent-cut className={cn("text-[13px] text-muted-foreground", bubble && "mchat-b self-start px-3 py-1.5")}>Etude restarted before this reply finished.</div>}
      </Said>
    </div>
    </RichContext.Provider>
  );
}

export function LiveView({ live, onAnswer }: { live: Live; onAnswer(item: ToolItem, allow: boolean, optionId?: string): void }) {
  const bubble = useContext(BubbleContext);
  const waiting = live.items.some((i) => i.type === "tool" && i.status === "waiting");
  const running = live.items.some((i) => i.type === "tool" && i.status === "running" && !i.lookup);
  const lastIsText = live.items[live.items.length - 1]?.type === "text";
  return (
    <div className={cn("agent-rise flex flex-col", bubble ? "gap-2.5" : "gap-1.5")}>
      <Said>
        <Items items={live.items} onAnswer={onAnswer} live />
      {live.error && <div className={cn("rounded-[10px] border border-destructive/40 px-3 py-2 text-[13px] text-destructive", bubble && "max-w-[88%] self-start bg-card")}>{live.error}</div>}
      {live.lost && <div data-agent-lost className={cn("text-[13px] text-muted-foreground", bubble && "mchat-b self-start px-3 py-1.5")}>Etude isn't answering. Waiting for it to come back…</div>}
      {!live.lost && !waiting && !running && !lastIsText && (
        <div data-mbub={bubble ? "" : undefined} className={cn("flex h-7 items-center gap-2 text-[13px] text-muted-foreground", bubble && "mchat-b h-9 self-start px-3.5")}>
          <Loader2 className="size-3.5 animate-spin" />
          {live.items.some((i) => i.type !== "text") ? "Working…" : "Thinking…"}
        </div>
      )}
      </Said>
    </div>
  );
}

/** "created deck A", "created deck B", "created deck C" reads as "created 3 decks". */
function undoSummary(changes: string[]): string {
  const merged: string[] = [];
  const groups = new Map<string, number>();
  for (const ch of changes) {
    const m = /^(created|deleted|moved|renamed|archived|installed) (deck|type) /.exec(ch);
    const key = m ? `${m[1]} ${m[2]}` : ch;
    if (!groups.has(key)) merged.push(key);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const parts = merged.map((k) => {
    const n = groups.get(k)!;
    if (n === 1) return changes.find((ch) => ch === k || ch.startsWith(`${k} `))!;
    const [verb, noun] = k.split(" ");
    return `${verb} ${n} ${noun}s`;
  });
  return parts.length > 2 ? `${parts.slice(0, 2).join(", ")} and ${parts.length - 2} more` : parts.join(", ");
}

type Block = { kind: "thought"; text: string; ms: number; key: string; last: boolean } | { kind: "text"; text: string; key: string } | { kind: "tools"; tools: ToolItem[]; key: string } | { kind: "ui"; item: Extract<Item, { type: "ui" }>; key: string } | { kind: "confirm"; item: ToolItem; key: string } | { kind: "steer"; text: string; attachments?: Attachment[]; key: string };

/** Consecutive tool calls form one group; look-ups are left out; a waiting call stands on its own. */
function blocks(items: Item[], live: boolean): Block[] {
  const out: Block[] = [];
  items.forEach((it, i) => {
    if (it.type === "text") {
      if (it.text.trim()) out.push({ kind: "text", text: it.text, key: `t${i}` });
      return;
    }
    if (it.type === "thought") {
      if (it.text.trim()) out.push({ kind: "thought", text: it.text, ms: it.ms, key: `h${i}`, last: i === items.length - 1 });
      return;
    }
    if (it.type === "ui") {
      if (it.action === "navigate" && it.path) out.push({ kind: "ui", item: it, key: `u${i}` });
      return;
    }
    if (it.type === "steer") {
      out.push({ kind: "steer", text: it.text, attachments: it.attachments, key: `s${i}` });
      return;
    }
    if (it.lookup) return;
    if (it.status === "waiting" && live) {
      out.push({ kind: "confirm", item: it, key: it.id });
      return;
    }
    const prev = out[out.length - 1];
    if (prev?.kind === "tools") prev.tools.push(it);
    else out.push({ kind: "tools", tools: [it], key: `g${it.id}` });
  });
  return out;
}

function Items({ items, onAnswer, live = false }: { items: Item[]; onAnswer?(item: ToolItem, allow: boolean, optionId?: string): void; live?: boolean }) {
  const bubble = useContext(BubbleContext);
  const you = useContext(YouContext) || bubble;
  const rich = useContext(RichContext);
  const all = blocks(items, live && !!onAnswer);
  // A finished reply folds its work (thoughts, tool calls, the text said along the way) into one row above the
  // answer. The answer is all the text after the last step: a steer the turn answered after it had already
  // replied leaves two answers with a thought between them, and both stay out.
  let cut = all.length;
  while (cut > 0 && (all[cut - 1].kind === "text" || all[cut - 1].kind === "thought" || all[cut - 1].kind === "steer")) cut--;
  while (cut < all.length && all[cut].kind !== "text") cut++;
  const tail = all.slice(cut);
  const work = cut < all.length ? [...all.slice(0, cut), ...tail.filter((b) => b.kind === "thought")].filter((b) => b.kind !== "steer") : [];
  const fold = !live && work.some((b) => b.kind === "tools") || !live && work.filter((b) => b.kind === "thought").length > 1;
  const render = (b: Block) =>
        b.kind === "thought" ? (
          <ThoughtRow key={b.key} text={b.text} ms={b.ms} live={live && b.last} />
        ) : b.kind === "text" ? (
          // Text in balloons; a widget, chart, picture or voice note the reply shows stands between them.
          richSegments(b.text, live).map((seg, k) =>
            seg.kind !== "md" ? (
              <div key={`${b.key}.${k}`} data-agent-rich={seg.kind} className={cn("achat-rich", seg.kind === "sticker" || seg.kind === "media" ? "self-start" : "self-stretch")}>
                <RichBlock seg={seg} />
              </div>
            ) : bubble ? (
              <div key={`${b.key}.${k}`} data-mbub className="mchat-b max-w-[88%] self-start px-[14px] py-[3px]">
                <RichMarkdown className="agent-prose text-[14.5px]" text={seg.text} />
              </div>
            ) : (
              <RichMarkdown key={`${b.key}.${k}`} className="agent-prose" text={seg.text} />
            ),
          )
        ) : b.kind === "steer" ? (
          // What the user sent mid-reply, where it landed: their own balloon, on their side.
          <div key={b.key} className="flex max-w-full flex-col items-end gap-1.5 self-end">
            {b.attachments?.length ? (
              <div data-agent-steer-files className="flex flex-wrap justify-end gap-1.5">
                {b.attachments.map((a) => (
                  <AttachmentChip key={a.id} a={a} conv={rich.conv || undefined} />
                ))}
              </div>
            ) : null}
            {b.text && (
              <div data-agent-steer className={cn("max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-normal whitespace-pre-wrap [overflow-wrap:anywhere]", you ? "mchat-you rounded-[18px] px-[14px] py-[9px] text-[14.5px] leading-[1.42]" : "bg-[color-mix(in_oklab,var(--background),var(--foreground)_8%)]")}>
                {b.text}
              </div>
            )}
          </div>
        ) : b.kind === "ui" ? (
          bubble ? (
            <div key={b.key} data-mbub className="mchat-b max-w-[88%] self-start px-3 py-1">
              <NavRow path={b.item.path!} />
            </div>
          ) : (
            <NavRow key={b.key} path={b.item.path!} />
          )
        ) : b.kind === "confirm" ? (
          bubble ? (
            <div key={b.key} data-mbub className="mchat-b self-stretch">
              {b.item.options ? <PermissionCard item={b.item} onAnswer={onAnswer!} /> : <ConfirmCard item={b.item} onAnswer={onAnswer!} />}
            </div>
          ) : (
            b.item.options ? <PermissionCard key={b.key} item={b.item} onAnswer={onAnswer!} /> : <ConfirmCard key={b.key} item={b.item} onAnswer={onAnswer!} />
          )
        ) : bubble ? (
          <div key={b.key} data-mbub className="mchat-b max-w-[88%] self-start px-3 py-1">
            <ToolGroup tools={b.tools} live={live} />
          </div>
        ) : (
          <ToolGroup key={b.key} tools={b.tools} live={live} />
        );
  if (!fold) return <>{all.map(render)}</>;
  return (
    <>
      {all.slice(0, cut).filter((b) => b.kind === "steer").map(render)}
      <WorkFold blocks={work} render={render} />
      {tail.filter((b) => b.kind !== "thought").map(render)}
    </>
  );
}

/** The work behind a finished answer, folded: one row that opens to every thought and step. */
function WorkFold({ blocks: work, render }: { blocks: Block[]; render(b: Block): React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const bubble = useContext(BubbleContext);
  const tools = work.flatMap((b) => (b.kind === "tools" ? b.tools : b.kind === "confirm" ? [b.item] : []));
  const thoughts = work.filter((b) => b.kind === "thought");
  const ms = thoughts.reduce((n, b) => n + (b.kind === "thought" ? b.ms : 0), 0);
  const parts = [tools.length ? `${tools.length} ${tools.length === 1 ? "step" : "steps"}` : `${thoughts.length} thoughts`];
  const row = (
    <RowShell onClick={() => setOpen((o) => !o)} expanded={open}>
      <span className="truncate" data-agent-work>
        Worked · {parts.join(" · ")}
        {ms >= 1000 && !tools.length ? ` · ${Math.round(ms / 1000)}s` : null}
      </span>
      <Chevron open={open} />
    </RowShell>
  );
  return (
    <div className="flex flex-col">
      {bubble ? <div data-mbub className="mchat-b max-w-[88%] self-start px-3 py-1">{row}</div> : row}
      {open && <div className="mt-0.5 ml-[0.45rem] flex flex-col gap-1.5 border-l pl-2.5">{work.map(render)}</div>}
    </div>
  );
}

/** One leading-icon row: the shape tool groups and navigation rows share. */
function RowShell({ icon, children, trailing, onClick, expanded }: { icon?: React.ReactNode; children: React.ReactNode; trailing?: React.ReactNode; onClick?(): void; expanded?: boolean }) {
  const inner = (
    <>
      {icon && <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
      {trailing}
    </>
  );
  const cls = "-ml-1.5 flex h-7 w-[calc(100%+0.375rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-[13px] text-muted-foreground";
  return onClick ? (
    <button type="button" onClick={onClick} aria-expanded={expanded} className={cn(cls, "transition-colors hover:bg-accent/60 hover:text-foreground")}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

const Chevron = ({ open }: { open: boolean }) => <ChevronRight className={cn("size-3.5 shrink-0 transition-transform duration-150", open && "rotate-90")} />;

function ToolGroup({ tools, live }: { tools: ToolItem[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const current = tools.find((t) => t.status === "running");
  if (current && live) {
    return (
      <RowShell icon={<Loader2 className="size-3.5 animate-spin" />}>
        <span className="shrink-0">{toolVerb(current, true)}</span>
        <code className="min-w-0 truncate font-mono text-xs text-foreground/75">{toolLabel(current)}</code>
        <span className="shrink-0">…</span>
      </RowShell>
    );
  }
  if (tools.length === 1) return <ToolRow item={tools[0]} />;
  const failed = tools.filter((t) => t.status === "error").length;
  const denied = tools.filter((t) => t.status === "denied").length;
  const icon = failed ? <X className="size-3.5 text-destructive" /> : <Check className="size-3.5" />;
  return (
    <div>
      <RowShell icon={icon} onClick={() => setOpen((o) => !o)} expanded={open} trailing={<Chevron open={open} />}>
        <span className="truncate">
          {tools.length} steps
          {failed ? <span className="text-destructive"> · {failed} failed</span> : null}
          {denied ? ` · ${denied} not run` : null}
        </span>
      </RowShell>
      {open && (
        <div className="mt-0.5 ml-[0.45rem] flex flex-col border-l pl-2.5">
          {tools.map((t) => (
            <ToolRow key={t.id} item={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function toolVerb(item: ToolItem, live = false) {
  if (item.tool === "plan") return "Planned";
  if (item.tool === "read_attachment") return live ? "Reading" : "Read";
  if (item.tool === "read_screen") return live || item.status === "running" ? "Reading" : item.status === "error" ? "Couldn't read" : "Read";
  if (item.tool === "screenshot") return live || item.status === "running" ? "Looking at" : item.status === "error" ? "Couldn't see" : "Looked at";
  if (item.status === "running") return "Running";
  if (item.status === "denied") return "Not run:";
  if (item.status === "error") return "Failed:";
  return "Ran";
}

function toolLabel(item: ToolItem) {
  if (item.tool === "acp" || item.tool === "plan") return item.label + (item.chose ? ` · ${item.chose}` : "");
  if (item.tool === "etude_run") return item.label.replace(/^etude /, "").replace(/ --yes\b/, "").replace(/ -(?= |$)/g, "");
  if (item.tool === "read_attachment") return item.label.replace(/^read /, "");
  if (item.tool === "read_screen" || item.tool === "screenshot") return "your screen";
  return item.label.replace(/^help ?/, "") || "commands";
}

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const Icon = item.status === "running" ? Loader2 : item.status === "denied" ? Ban : item.status === "error" ? X : Check;
  const icon = <Icon className={cn("size-3.5", item.status === "running" && "animate-spin", item.status === "error" && "text-destructive")} />;
  const body = (
    <>
      <span className="shrink-0">{toolVerb(item)}</span>
      <code className="min-w-0 truncate font-mono text-xs text-foreground/75">{toolLabel(item)}</code>
    </>
  );
  if (!item.output) return <RowShell icon={icon}>{body}</RowShell>;
  return (
    <div>
      <RowShell icon={icon} onClick={() => setOpen((o) => !o)} expanded={open} trailing={<Chevron open={open} />}>
        {body}
      </RowShell>
      {open && <pre className="mt-1 mb-1 max-h-64 overflow-auto rounded-[10px] border bg-[color-mix(in_oklab,var(--background),var(--foreground)_3.5%)] px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap">{item.output}</pre>}
    </div>
  );
}

function NavRow({ path }: { path: string }) {
  const { verb, name } = pageLabel(path);
  return (
    <RowShell icon={<CornerDownRight className="size-3.5" />}>
      <span className="shrink-0">{verb}</span>
      <button type="button" onClick={() => navigate(path)} className="min-w-0 truncate font-medium text-foreground underline-offset-2 hover:underline">
        {name}
      </button>
    </RowShell>
  );
}

/** "Opened" + a readable name for an app path: the deck's own name, never the URL. */
function pageLabel(path: string): { verb: string; name: string } {
  const u = new URL(path, location.origin);
  const deck = u.searchParams.get("name") ?? u.searchParams.get("deck");
  const leaf = (d: string) => d.split("::").pop() || d;
  if (u.pathname === "/deck" && deck) return { verb: "Opened", name: leaf(deck) };
  if ((u.pathname === "/study" || u.pathname === "/watch") && deck) return { verb: "Started practice:", name: leaf(deck) };
  if (u.pathname === "/browse") return { verb: "Opened", name: u.searchParams.get("q") ? `Browse: ${u.searchParams.get("q")}` : "Browse" };
  if (u.pathname.startsWith("/types/")) return { verb: "Opened card type", name: decodeURIComponent(u.pathname.slice(7)) };
  const pages: Record<string, string> = { "/": "Decks", "/types": "Card types", "/market": "Market", "/stats": "Stats", "/settings": "Settings", "/study": "Practice" };
  return { verb: "Opened", name: pages[u.pathname] ?? "a page" };
}

/** The dry run's list of what goes, as names: `deleted` or `ids` arrays. Null when the preview isn't that shape. */
function previewList(preview?: string): { label: string; names: string[] } | null {
  if (!preview) return null;
  try {
    const p = JSON.parse(preview);
    const names = Array.isArray(p.deleted) ? p.deleted : Array.isArray(p.ids) ? p.ids : typeof p.deleted === "string" ? [p.deleted] : null;
    if (!names?.length || !names.every((x: unknown) => typeof x === "string")) return null;
    return { label: Array.isArray(p.ids) ? "Items that go:" : "What goes:", names };
  } catch {
    return null;
  }
}

/** The target's name in bold, where it appears in the sentence. */
function emphasize(text: string, target?: string) {
  const i = target ? text.indexOf(target) : -1;
  if (!target || i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <strong className="font-semibold">{target}</strong>
      {text.slice(i + target.length)}
    </>
  );
}

/** Black or white text, whichever reads better on the theme's --destructive (light reds on dark themes need black). */
function useDangerText() {
  return useReadableOn("--destructive");
}
function ConfirmCard({ item, onAnswer }: { item: ToolItem; onAnswer(item: ToolItem, allow: boolean): void }) {
  const [sent, setSent] = useState(false);
  const dangerText = useDangerText();
  const [open, setOpen] = useState(true);
  const label = item.label.replace(/^etude /, "").replace(/ --yes\b/, "");
  const summary = item.summary ?? `Runs etude ${label}.`;
  const affected = previewList(item.preview);
  const bubble = useContext(BubbleContext);
  return (
    <div className={cn("agent-rise p-3.5", !bubble && "rounded-[14px] border border-foreground/20 bg-[color-mix(in_oklab,var(--background),var(--foreground)_3.5%)]")} role="alertdialog" aria-label="Confirm" aria-describedby={`cf-${item.id}`}>
      <p id={`cf-${item.id}`} className="text-sm leading-snug text-pretty text-foreground">
        {emphasize(summary.replace(/(\d) /g, "$1\u00a0").replace(/, (\d)/g, ",\u00a0$1"), item.target)}
      </p>
      <p className="mt-1 text-[13px] text-foreground/75">You can undo this afterwards.</p>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-2.5 -ml-0.5 flex items-center gap-1 rounded-sm px-0.5 text-[13px] text-foreground/75 hover:text-foreground">
        <Chevron open={open} />
        Details
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {affected ? (
            <div className="rounded-lg bg-muted px-2.5 py-1.5 text-xs">
              <div className="text-foreground/80">{affected.label}</div>
              <ul className="mt-0.5 flex max-h-40 flex-col overflow-auto">
                {affected.names.map((n) => (
                  <li key={n} className="truncate text-foreground" title={n}>
                    {n.split("::").join(" › ")}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            item.preview && <pre className="max-h-40 overflow-auto rounded-lg bg-muted px-2 py-1.5 font-mono text-[11px] break-words whitespace-pre-wrap text-foreground/80">{item.preview}</pre>
          )}
          <code className="block rounded-lg bg-muted px-2.5 py-1.5 font-mono text-[11.5px] break-all text-foreground/90">{label}</code>
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="rounded-lg" disabled={sent} onClick={() => (setSent(true), onAnswer(item, false))}>
          Cancel
        </Button>
        <Button size="sm" variant="destructive" disabled={sent} className="rounded-lg bg-destructive hover:bg-destructive/90 dark:bg-destructive" style={{ color: dangerText }} onClick={() => (setSent(true), onAnswer(item, true))}>
          {item.action ?? "Run"}
        </Button>
      </div>
    </div>
  );
}

/** An external agent asking before a step: what it wants to do, and its own options as buttons. */
function PermissionCard({ item, onAnswer }: { item: ToolItem; onAnswer(item: ToolItem, allow: boolean, optionId?: string): void }) {
  const [sent, setSent] = useState(false);
  const [open, setOpen] = useState(false);
  const bubble = useContext(BubbleContext);
  const options = item.options ?? [];
  const pick = (o: { id: string; kind: string }) => (setSent(true), onAnswer(item, o.kind.startsWith("allow"), o.id));
  return (
    <div className={cn("agent-rise p-3.5", !bubble && "rounded-[14px] border border-foreground/20 bg-[color-mix(in_oklab,var(--background),var(--foreground)_3.5%)]")} role="alertdialog" aria-label="Permission" aria-describedby={`pm-${item.id}`} data-agent-permission>
      <p id={`pm-${item.id}`} className="text-sm leading-snug text-pretty text-foreground">
        {emphasize(item.summary ?? `Run ${item.label}?`, item.target)}
      </p>
      {item.preview && (
        <>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-2.5 -ml-0.5 flex items-center gap-1 rounded-sm px-0.5 text-[13px] text-foreground/75 hover:text-foreground">
            <Chevron open={open} />
            Details
          </button>
          {open && <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg bg-muted px-2 py-1.5 font-mono text-[11px] break-words whitespace-pre-wrap text-foreground/80">{item.preview}</pre>}
        </>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {options.map((o) => (
          <Button key={o.id} size="sm" variant={o.kind.startsWith("allow") ? (o.kind === "allow_once" ? "default" : "outline") : "ghost"} className="rounded-lg" disabled={sent} onClick={() => pick(o)}>
            {o.name}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function ModelPicker({ models, value, onPick, side = "top", className, placeholder, onReload }: { models: { groups: ModelGroup[]; default: string | null } | null; value: string | null; onPick(ref: string): void; side?: "top" | "bottom"; className?: string; placeholder?: string; /** Fetches the providers' model lists again. */ onReload?: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const groups = models?.groups ?? [];
  const label = useMemo(() => (placeholder && !value && !models?.default ? placeholder : modelLabel(value ?? models?.default ?? null, groups)), [value, models, placeholder]);
  if (!models) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Model"
          className={cn("group/model flex h-7 max-w-[12rem] min-w-0 items-center gap-0.5 rounded-md px-2 text-[13px] text-foreground/80 transition-colors outline-ring hover:bg-accent/70 hover:text-foreground focus-visible:outline-2 data-[state=open]:text-foreground pointer-coarse:h-9", className)}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-80 transition-opacity group-hover/model:opacity-100 group-focus-visible/model:opacity-100 group-data-[state=open]/model:opacity-100 pointer-coarse:opacity-100" />
        </button>
      </PopoverTrigger>
      <PopoverContent align={side === "top" ? "end" : "start"} side={side} sideOffset={8} className="w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl p-0">
        <Command filter={(v, s) => (v.toLowerCase().includes(s.toLowerCase()) ? 1 : 0)}>
          <PickerSearch placeholder="Search models…" onReload={onReload} />
          <CommandList className="max-h-72">
            <CommandEmpty>No model found.</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g.provider} heading={g.label}>
                {g.error && <div className="px-2 py-1 text-[11px] text-destructive">{g.error}</div>}
                {g.models.map((m) => (
                  <CommandItem
                    key={m.ref}
                    value={`${m.name} ${m.ref}`}
                    onSelect={() => {
                      onPick(m.ref);
                      setOpen(false);
                    }}
                  >
                    <span className={cn("min-w-0 flex-1 truncate", m.ref === value && "text-highlight")}>{m.name}</span>
                    {m.ref === value && <Check className="size-3.5 text-highlight" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Pages that keep their own state reload on `focus`; this also lets App remount the page after a turn. */
export function announceDataChange() {
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event(DATA_EVENT));
}
