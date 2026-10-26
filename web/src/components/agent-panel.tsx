// "Ask Etude": the assistant's launcher and side panel. The panel pushes the page on desktop and is a full-screen sheet on phones.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Ban, CalendarCheck, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsRight, CornerDownRight, Ellipsis, FileText, FileUp, FolderTree, ImageIcon, Loader2, Package, Palette, Pencil, Plus, RotateCcw, Settings2, Square, SquarePen, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Markdown } from "@/components/markdown";
import { Logo } from "@/components/logo";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { agentApi, DATA_EVENT, type AgentEvent, type AssistantContent, type Attachment, type Conversation, type Item, type Message, type ModelGroup, type ToolItem, type UserContent } from "@/lib/agent";
import { navigate } from "@/lib/router";
import { refreshTheme } from "@/lib/theme";
import { api, relative } from "@/lib/api";
import { cn } from "@/lib/utils";

const OPEN_KEY = "etude.agent.open";
const WIDTH_KEY = "etude.agent.width";
const CONV_KEY = "etude.agent.conversation";
export const AGENT_SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘J" : "Ctrl+J";

const usePhone = () => {
  const q = "(max-width: 640px)";
  const [phone, setPhone] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const h = () => setPhone(m.matches);
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, []);
  return phone;
};

/** Open state and width, shared by the launcher, the panel and the layout. */
export function useAgentPanel() {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    // 400 was the old default; the panel now opens at 428.
    return Math.min(720, Math.max(340, !saved || saved === 400 ? 428 : saved));
  });
  useEffect(() => localStorage.setItem(OPEN_KEY, open ? "1" : "0"), [open]);
  useEffect(() => localStorage.setItem(WIDTH_KEY, String(width)), [width]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return { open, setOpen, width, setWidth };
}

const HINT_KEY = "etude.agent.hinted";

/** The ε on the card surface, bottom-right. On the first visit a small "Ask Etude" label shows beside it for a few seconds. */
export function AgentLauncher({ onOpen }: { onOpen(): void }) {
  const [hint, setHint] = useState(() => localStorage.getItem(HINT_KEY) !== "1");
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => {
      setHint(false);
      localStorage.setItem(HINT_KEY, "1");
    }, 5000);
    return () => clearTimeout(t);
  }, [hint]);
  const open = () => {
    localStorage.setItem(HINT_KEY, "1");
    setHint(false);
    onOpen();
  };
  return (
    <div className="fixed right-3 bottom-[calc(var(--tabbar-h)+0.5rem)] z-30 flex items-center gap-2 md:right-4 md:bottom-4">
      {hint && (
        <button onClick={open} tabIndex={-1} aria-hidden className="agent-rise h-8 rounded-full border bg-card px-3 text-xs font-medium whitespace-nowrap text-foreground shadow-sm">
          Ask Etude
        </button>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={open}
            aria-label="Ask Etude"
            data-agent-launcher
            className="flex size-11 items-center justify-center rounded-full border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.18),0_4px_12px_-4px_rgb(0_0_0/0.28)] transition-[translate,border-color,box-shadow] duration-150 outline-ring hover:-translate-y-px hover:border-foreground/30 focus-visible:outline-2 active:translate-y-0 motion-reduce:transition-none"
          >
            <Logo className="size-[26px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">
          Ask Etude <span className="opacity-60">· {AGENT_SHORTCUT}</span>
        </TooltipContent>
      </Tooltip>
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

// ---------------------------------------------------------------- live turn

interface Live {
  turnId: string | null;
  user: Message | null;
  items: Item[];
  changed: boolean;
  error: string | null;
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
  if (location.pathname === "/deck") {
    const name = new URLSearchParams(location.search).get("name") ?? "";
    const decks = await api.decks().catch(() => null);
    if (decks && !decks.some((d) => d.name === name)) {
      navigate("/");
      return;
    }
  }
  onChanged(final);
}

export function AgentPanel({ width, setWidth, onClose, onChanged }: { width: number; setWidth(w: number): void; onClose(): void; onChanged(final: boolean): void }) {
  const phone = usePhone();
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [conv, setConv] = useState<(Conversation & { messages: Message[] }) | null>(null);
  const [models, setModels] = useState<{ configured: boolean; default: string | null; groups: ModelGroup[] } | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<(Attachment | { uploading: string; key: string })[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const panel = useRef<HTMLDivElement>(null);

  const loadList = useCallback(() => agentApi.list().then((r) => setConvs(r.conversations)).catch(() => {}), []);

  const openConv = useCallback(async (id: string | null) => {
    if (!id) {
      setConv(null);
      localStorage.removeItem(CONV_KEY);
      return;
    }
    try {
      const c = await agentApi.get(id);
      setConv(c);
      if (c.model) setModel(c.model);
      localStorage.setItem(CONV_KEY, id);
      stick.current = true;
      if (c.running) setLive((l) => l ?? { turnId: c.running, user: null, items: [], changed: false, error: null });
    } catch {
      setConv(null);
      localStorage.removeItem(CONV_KEY);
    }
  }, []);

  useEffect(() => {
    loadList();
    openConv(localStorage.getItem(CONV_KEY));
    agentApi
      .models()
      .then((m) => {
        setModels(m);
        setModel((cur) => cur ?? m.default);
      })
      .catch(() => setModels({ configured: false, default: null, groups: [] }));
    requestAnimationFrame(() => input.current?.focus());
  }, []);

  // A turn that kept running after a reload: poll until the server has saved it.
  useEffect(() => {
    if (!live || live.user || !conv) return;
    const t = setInterval(async () => {
      const c = await agentApi.get(conv.id).catch(() => null);
      if (c && !c.running) {
        setLive(null);
        setConv(c);
        refreshPage(onChanged, true);
      }
    }, 1500);
    return () => clearInterval(t);
  }, [live, conv?.id]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[role=dialog][data-state=open], [data-slot=popover-content], [role=listbox]")) return;
      onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const ensureConv = async (): Promise<string> => {
    if (conv) return conv.id;
    const c = await agentApi.create(model);
    const full = { ...c, messages: [] };
    setConv(full);
    localStorage.setItem(CONV_KEY, c.id);
    loadList();
    return c.id;
  };

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

  const send = async () => {
    const msg = text.trim();
    const done = atts.filter((a): a is Attachment => !("uploading" in a));
    if ((!msg && !done.length) || busy || !ready) return;
    let id: string;
    try {
      id = await ensureConv();
    } catch (e) {
      toast.error((e as Error).message);
      return;
    }
    setText("");
    setAtts([]);
    stick.current = true;
    const state: Live = { turnId: null, user: null, items: [], changed: false, error: null };
    setLive({ ...state });
    const bump = () => setLive({ ...state, items: [...state.items] });
    // Writes mid-turn refresh the page shortly after, unless the agent navigates first.
    let pendingRefresh: ReturnType<typeof setTimeout> | null = null;
    const cancelRefresh = () => {
      if (pendingRefresh) clearTimeout(pendingRefresh);
      pendingRefresh = null;
    };
    const onEvent = (e: AgentEvent) => {
      switch (e.type) {
        case "start":
          state.turnId = e.turnId;
          state.user = e.userMessage;
          setConvs((cs) => [e.conversation, ...cs.filter((c) => c.id !== e.conversation.id)]);
          setConv((c) => (c ? { ...c, title: e.conversation.title, autoTitle: e.conversation.autoTitle } : c));
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
          refreshTheme();
          cancelRefresh();
          pendingRefresh = setTimeout(() => refreshPage(onChanged, false), 700);
          break;
        case "error":
          state.error = e.error;
          break;
        case "done":
          setConv((c) => (c ? { ...c, messages: [...c.messages, ...(state.user ? [state.user] : []), e.message] } : c));
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
    try {
      await agentApi.send(id, { text: msg, attachments: done.map((a) => a.id), model, page: location.pathname + location.search }, onEvent);
    } catch (e) {
      setLive(null);
      setText(msg);
      toast.error("The assistant couldn't start", { description: (e as Error).message });
      return;
    }
    // The stream ended without `done` (connection lost): fetch what the server saved.
    setLive((l) => {
      if (l) agentApi.get(id).then(setConv).catch(() => {});
      return null;
    });
  };

  const stop = async () => {
    if (live?.turnId) await agentApi.stop(live.turnId).catch(() => {});
  };

  const answer = async (item: ToolItem, allow: boolean) => {
    if (!live?.turnId) return;
    try {
      await agentApi.confirm(live.turnId, item.id, allow);
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

  const removeConv = async (id: string) => {
    try {
      await agentApi.remove(id);
      if (conv?.id === id) openConv(null);
      loadList();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // Desktop resize from the left edge.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => setWidth(Math.min(720, Math.max(340, w0 + (x0 - ev.clientX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const notConfigured = models && !models.configured;
  const messages = conv?.messages ?? [];
  const empty = !messages.length && !live;
  const vv = useVisualViewport(phone);
  const sendText = useReadableOn("--highlight");
  const canSend = (!!text.trim() || atts.length > 0) && ready && !notConfigured;
  const [renaming, setRenaming] = useState(false);

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

  return (
    <div
      ref={panel}
      role="complementary"
      aria-label="Ask Etude"
      data-agent-panel
      className={cn(
        "flex flex-col bg-background text-foreground",
        phone ? "agent-sheet-in fixed inset-x-0 top-0 z-50 h-dvh pt-[env(safe-area-inset-top)]" : "agent-panel-in sticky top-0 h-dvh shrink-0 border-l",
        dragging && "outline-2 -outline-offset-2 outline-ring/60",
      )}
      style={phone ? (vv ? { height: vv.h, top: vv.top } : undefined) : { width }}
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
      {!phone && <div onPointerDown={startResize} className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize" aria-hidden />}
      <header className="mt-2.5 flex h-11 shrink-0 items-center gap-0.5 pr-2.5 pl-4 max-sm:mt-0 max-sm:pl-2 pointer-coarse:h-12">
        {phone && (
          <HeaderButton label="Close" tip="Close" onClick={onClose}>
            <ChevronLeft />
          </HeaderButton>
        )}
        {renaming && conv ? (
          <TitleField title={conv.title || ""} onDone={(t) => (setRenaming(false), t !== null && rename(t))} />
        ) : (
          <HistoryMenu convs={convs} active={conv?.id ?? null} title={conv?.title || "New chat"} onPick={openConv} onDelete={removeConv} />
        )}
        <div className="flex-1" />
        <HeaderButton label="New chat" disabled={busy || !conv} onClick={() => openConv(null)}>
          <SquarePen />
        </HeaderButton>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="More"
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-ring hover:bg-accent/70 hover:text-foreground focus-visible:outline-2 data-[state=open]:bg-accent/70 data-[state=open]:text-foreground pointer-coarse:size-9 [&_svg]:size-4"
                >
                  <Ellipsis />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>More</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem disabled={!conv || busy} onSelect={() => setRenaming(true)}>
              <Pencil />
              Rename chat
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" disabled={!conv || busy} onSelect={() => conv && removeConv(conv.id)}>
              <Trash2 />
              Delete chat
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openAiSettings}>
              <Settings2 />
              AI settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {!phone && (
          <HeaderButton label="Close" tip={<>Close <span className="opacity-60">Esc</span></>} onClick={onClose}>
            <ChevronsRight />
          </HeaderButton>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <div aria-hidden data-agent-fade className={cn("pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent transition-opacity duration-200", scrolled ? "opacity-100" : "opacity-0")} />
        <div
          ref={scroller}
          data-agent-scroll
          className="flex h-full flex-col overflow-y-auto px-4 pt-2 pb-4"
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
            <EmptyState onPick={suggest} onFile={() => fileInput.current?.click()} />
          ) : (
            <div className="flex flex-col gap-6">
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
          )}
        </div>
      </div>

      <div className="shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:px-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div
          data-agent-composer
          className="rounded-[14px] border bg-[color-mix(in_oklab,var(--background),white_65%)] shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-colors focus-within:border-foreground/25 dark:bg-[color-mix(in_oklab,var(--background),var(--foreground)_4.5%)] dark:shadow-none"
          onClick={(e) => {
            if (e.target === e.currentTarget) input.current?.focus();
          }}
        >
          {atts.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
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
            placeholder="Ask Etude…"
            aria-label="Message"
            className="block max-h-52 min-h-11 w-full resize-none bg-transparent px-3 pt-3 pb-1.5 text-sm text-foreground leading-normal outline-none placeholder:text-muted-foreground [field-sizing:content] max-sm:text-base"
          />
          <div className="flex items-center gap-1.5 px-3 pb-3">
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Attach files"
                  disabled={!!notConfigured}
                  onClick={() => fileInput.current?.click()}
                  className="flex size-7 items-center justify-center rounded-full border border-foreground/30 text-foreground/75 transition-colors outline-ring hover:bg-accent/70 hover:text-foreground focus-visible:outline-2 disabled:opacity-40 pointer-coarse:size-9"
                >
                  <Plus className="size-4" strokeWidth={2.25} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Attach images, PDFs, text or .apkg</TooltipContent>
            </Tooltip>
            <div className="flex-1" />
            <ModelPicker models={models} value={model} onPick={pickModel} />
            {busy ? (
              <button type="button" aria-label="Stop" onClick={stop} className="flex size-7 items-center justify-center rounded-full bg-foreground text-background transition-opacity outline-ring hover:opacity-85 focus-visible:outline-2 pointer-coarse:size-9">
                <Square className="size-2.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send"
                disabled={!canSend}
                onClick={send}
                style={canSend ? { color: sendText } : undefined}
                className={cn(
                  "flex size-7 items-center justify-center rounded-full transition-colors outline-ring focus-visible:outline-2 pointer-coarse:size-9",
                  canSend ? "bg-highlight hover:opacity-90" : "border border-foreground/20 bg-transparent text-muted-foreground/70",
                )}
              >
                <ArrowUp className="size-4" strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function openAiSettings() {
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

const SUGGESTIONS: { icon: typeof FileUp; label: string; file?: boolean }[] = [
  { icon: FileUp, label: "Make a deck from a file", file: true },
  { icon: FolderTree, label: "Organize my decks" },
  { icon: Palette, label: "Change the theme" },
  { icon: CalendarCheck, label: "What should I review today?" },
];

/** Bottom-anchored, just above the composer: the mark, a greeting, four suggestions. */
function EmptyState({ onPick, onFile }: { onPick(t: string): void; onFile(): void }) {
  return (
    <div className="agent-rise mt-auto flex flex-col pb-3" data-agent-empty>
      <Logo className="-ml-1.5 size-12" />
      <p className="mt-3.5 mb-3.5 text-[17px] leading-snug font-semibold tracking-tight">What are we practicing today?</p>
      <ul className="-mx-2 flex flex-col">
        {SUGGESTIONS.map(({ icon: Icon, label, file }) => (
          <li key={label}>
            <button
              type="button"
              data-suggestion
              onClick={() => (file ? onFile() : onPick(label))}
              className="flex h-[35px] w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm text-muted-foreground transition-colors outline-ring hover:bg-accent/60 hover:text-foreground focus-visible:outline-2 pointer-coarse:h-11"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              {label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AttachmentChip({ a, conv, onRemove }: { a: Attachment | { uploading: string; key: string }; conv?: string; onRemove?(): void }) {
  if ("uploading" in a)
    return (
      <span className="flex h-7 max-w-full items-center gap-1.5 rounded-lg border bg-background px-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        <span className="truncate">{a.uploading}</span>
      </span>
    );
  const Icon = a.kind === "image" ? ImageIcon : a.kind === "anki" ? Package : FileText;
  return (
    <span className="flex h-7 max-w-full items-center gap-1.5 rounded-lg border bg-background pr-1 pl-2 text-xs" title={a.name}>
      {a.kind === "image" && conv ? <img src={agentApi.attachmentUrl(conv, a.id)} alt="" className="size-4 rounded-sm object-cover" /> : <Icon className="size-3.5 text-muted-foreground" />}
      <span className="max-w-40 truncate">{a.name}</span>
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

function MessageView({ m, conv, last, groups, onUndo }: { m: Message; conv: string; last?: boolean; groups?: ModelGroup[]; onUndo?(): void }) {
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
        {c.text && <div className="max-w-[85%] rounded-2xl bg-[color-mix(in_oklab,var(--background),var(--foreground)_8%)] px-3.5 py-2 text-sm leading-normal whitespace-pre-wrap [overflow-wrap:anywhere]">{c.text}</div>}
      </div>
    );
  }
  const c = m.content as AssistantContent;
  const undoLabel = c.changes?.length ? `Undo: ${undoSummary(c.changes)}` : "Undo these changes";
  const meta = (c.modelRef || c.model) && `${modelLabel(c.modelRef ?? null, groups ?? [], c.model)} · ${(c.ms / 1000).toFixed(1)} s`;
  const undo = c.changed && !m.undone && m.canUndo;
  return (
    <div className="group/reply agent-rise flex flex-col gap-1.5" data-agent-reply>
      <Items items={c.items} />
      {c.error && <div className="rounded-[10px] border border-destructive/40 px-3 py-2 text-[13px] text-destructive">{c.error}</div>}
      {c.stopped && <div className="text-[13px] text-muted-foreground">Stopped.</div>}
      {(undo || (c.changed && m.undone) || meta) && (
        <div
          className={cn(
            "-ml-1.5 flex min-h-6 min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground transition-opacity",
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
          {meta && (
            <span className="px-1.5 whitespace-nowrap text-muted-foreground/80" data-agent-meta>
              {meta}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function LiveView({ live, onAnswer }: { live: Live; onAnswer(item: ToolItem, allow: boolean): void }) {
  const waiting = live.items.some((i) => i.type === "tool" && i.status === "waiting");
  const running = live.items.some((i) => i.type === "tool" && i.status === "running" && !i.lookup);
  const lastIsText = live.items[live.items.length - 1]?.type === "text";
  return (
    <div className="agent-rise flex flex-col gap-1.5">
      <Items items={live.items} onAnswer={onAnswer} live />
      {live.error && <div className="rounded-[10px] border border-destructive/40 px-3 py-2 text-[13px] text-destructive">{live.error}</div>}
      {!waiting && !running && !lastIsText && (
        <div className="flex h-7 items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {live.items.some((i) => i.type !== "text") ? "Working…" : "Thinking…"}
        </div>
      )}
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

type Block = { kind: "text"; text: string; key: string } | { kind: "tools"; tools: ToolItem[]; key: string } | { kind: "ui"; item: Extract<Item, { type: "ui" }>; key: string } | { kind: "confirm"; item: ToolItem; key: string };

/** Consecutive tool calls form one group; look-ups are left out; a waiting call stands on its own. */
function blocks(items: Item[], live: boolean): Block[] {
  const out: Block[] = [];
  items.forEach((it, i) => {
    if (it.type === "text") {
      if (it.text.trim()) out.push({ kind: "text", text: it.text, key: `t${i}` });
      return;
    }
    if (it.type === "ui") {
      if (it.action === "navigate" && it.path) out.push({ kind: "ui", item: it, key: `u${i}` });
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

function Items({ items, onAnswer, live = false }: { items: Item[]; onAnswer?(item: ToolItem, allow: boolean): void; live?: boolean }) {
  return (
    <>
      {blocks(items, live && !!onAnswer).map((b) =>
        b.kind === "text" ? (
          <Markdown key={b.key} className="agent-prose">
            {b.text}
          </Markdown>
        ) : b.kind === "ui" ? (
          <NavRow key={b.key} path={b.item.path!} />
        ) : b.kind === "confirm" ? (
          <ConfirmCard key={b.key} item={b.item} onAnswer={onAnswer!} />
        ) : (
          <ToolGroup key={b.key} tools={b.tools} live={live} />
        ),
      )}
    </>
  );
}

/** One leading-icon row: the shape tool groups and navigation rows share. */
function RowShell({ icon, children, trailing, onClick, expanded }: { icon: React.ReactNode; children: React.ReactNode; trailing?: React.ReactNode; onClick?(): void; expanded?: boolean }) {
  const inner = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
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
  if (item.tool === "read_attachment") return live ? "Reading" : "Read";
  if (item.status === "running") return "Running";
  if (item.status === "denied") return "Not run:";
  if (item.status === "error") return "Failed:";
  return "Ran";
}

function toolLabel(item: ToolItem) {
  if (item.tool === "etude_run") return item.label.replace(/^etude /, "").replace(/ --yes\b/, "").replace(/ -(?= |$)/g, "");
  if (item.tool === "read_attachment") return item.label.replace(/^read /, "");
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
  return (
    <div className="agent-rise rounded-[14px] border border-foreground/20 bg-[color-mix(in_oklab,var(--background),var(--foreground)_3.5%)] p-3.5" role="alertdialog" aria-label="Confirm" aria-describedby={`cf-${item.id}`}>
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

/** The header title is the history: title + chevron opens the list of chats. */
function HistoryMenu({ convs, active, title, onPick, onDelete }: { convs: Conversation[]; active: string | null; title: string; onPick(id: string): void; onDelete(id: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="History"
          data-agent-title
          className="-ml-1.5 flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-sm font-medium transition-colors outline-ring hover:bg-accent/70 focus-visible:outline-2 data-[state=open]:bg-accent/70 pointer-coarse:h-9"
        >
          <span className="truncate">{title}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[min(20rem,calc(100vw-1.5rem))] rounded-xl p-1">
        <div className="px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">Chats</div>
        {convs.length === 0 ? (
          <div className="px-2.5 pb-2 text-sm text-muted-foreground">No chats yet.</div>
        ) : (
          <ul className="max-h-80 overflow-y-auto" data-agent-history>
            {convs.map((c) => (
              <li key={c.id} className="group flex items-center gap-1 rounded-lg hover:bg-accent/70">
                <button
                  className={cn("flex min-w-0 flex-1 items-baseline gap-2 px-2.5 py-1.5 text-left", c.id === active && "text-highlight")}
                  aria-current={c.id === active ? "true" : undefined}
                  onClick={() => {
                    onPick(c.id);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{c.title || "New chat"}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{relative(c.updated)}</span>
                </button>
                <button aria-label={`Delete ${c.title}`} onClick={() => onDelete(c.id)} className="mr-1 rounded-md p-1.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100 pointer-coarse:opacity-100">
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ModelPicker({ models, value, onPick }: { models: { groups: ModelGroup[]; default: string | null } | null; value: string | null; onPick(ref: string): void }) {
  const [open, setOpen] = useState(false);
  const groups = models?.groups ?? [];
  const label = useMemo(() => modelLabel(value ?? models?.default ?? null, groups), [value, models]);
  if (!models) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Model"
          className="group/model flex h-7 max-w-[12rem] min-w-0 items-center gap-0.5 rounded-md px-2 text-[13px] text-foreground/80 transition-colors outline-ring hover:bg-accent/70 hover:text-foreground focus-visible:outline-2 data-[state=open]:text-foreground pointer-coarse:h-9"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-80 transition-opacity group-hover/model:opacity-100 group-focus-visible/model:opacity-100 group-data-[state=open]/model:opacity-100 pointer-coarse:opacity-100" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl p-0">
        <Command filter={(v, s) => (v.toLowerCase().includes(s.toLowerCase()) ? 1 : 0)}>
          <CommandInput placeholder="Search models…" />
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
