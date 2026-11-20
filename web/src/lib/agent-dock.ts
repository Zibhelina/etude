// Chats out of the side panel, open among the Notebook's pages: a chat is a tab there like a page is, so it can
// fill the screen, sit beside a page or under one. This keeps which chats are out, what their tabs say, and the
// box each one lives in (it moves between panes without the chat starting over).
import { useSyncExternalStore } from "react";
import { windowStore } from "@/lib/window-store";

/** A chat's tab id in the Notebook's layout: it isn't a note (kept in the tab list like a page's id). */
export const CHAT_PREFIX = "chat:";
export const isChatTab = (id: string | null | undefined): id is string => typeof id === "string" && id.startsWith(CHAT_PREFIX);
export const chatTabId = (key: string) => CHAT_PREFIX + key;
export const chatKey = (id: string) => id.slice(CHAT_PREFIX.length);

export interface DockedChat {
  key: string;
  conv: string | null;
}
export interface ChatMeta {
  title: string;
  profile: string;
  busy: boolean;
}
interface DockState {
  chats: DockedChat[];
  metas: Record<string, ChatMeta>;
  /** Where each chat's pane wants its history button. */
  slots: Record<string, HTMLElement | null>;
  /** Which chats are in front in their pane (the others keep working out of sight). */
  shown: Record<string, boolean>;
}

const KEY = "etude.agent.docked";
function saved(): DockedChat[] {
  try {
    const j = JSON.parse(windowStore.get(KEY) ?? "[]");
    if (Array.isArray(j)) return j.filter((c) => c && typeof c.key === "string" && (c.conv === null || typeof c.conv === "string"));
  } catch {}
  return [];
}

let state: DockState = { chats: typeof localStorage === "undefined" ? [] : saved(), metas: {}, slots: {}, shown: {} };
const subs = new Set<() => void>();
function set(next: DockState) {
  if (next === state) return;
  const chats = next.chats !== state.chats;
  state = next;
  if (chats) windowStore.set(KEY, JSON.stringify(state.chats));
  for (const f of subs) f();
}
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const useDock = () => useSyncExternalStore(subscribe, () => state);
export const dockState = () => state;

// A chat on its way to the Notebook from another screen: the Notebook opens it when it shows.
let waiting: string[] = [];
export const takeWaiting = () => {
  const w = waiting;
  waiting = [];
  return w;
};

export const dock = {
  has: (key: string) => state.chats.some((c) => c.key === key),
  add(chat: DockedChat, meta?: ChatMeta) {
    if (dock.has(chat.key)) return;
    set({ ...state, chats: [...state.chats, chat], metas: meta ? { ...state.metas, [chat.key]: meta } : state.metas });
  },
  /** Docks a chat for the Notebook to open as soon as it's on screen. */
  addWaiting(chat: DockedChat, meta?: ChatMeta) {
    dock.add(chat, meta);
    waiting.push(chat.key);
  },
  remove(key: string) {
    if (!dock.has(key)) return;
    const { [key]: _m, ...metas } = state.metas;
    const { [key]: _s, ...slots } = state.slots;
    const { [key]: _v, ...shown } = state.shown;
    nodes.get(key)?.remove();
    nodes.delete(key);
    set({ chats: state.chats.filter((c) => c.key !== key), metas, slots, shown });
  },
  /** Chats whose tab is gone (closed in the Notebook) leave. */
  keep(keys: Set<string>) {
    for (const c of state.chats) if (!keys.has(c.key) && !waiting.includes(c.key)) dock.remove(c.key);
  },
  setConv(key: string, conv: string | null) {
    if (!state.chats.some((c) => c.key === key && c.conv !== conv)) return;
    set({ ...state, chats: state.chats.map((c) => (c.key === key ? { ...c, conv } : c)) });
  },
  setMeta(key: string, meta: ChatMeta) {
    const m = state.metas[key];
    if (!dock.has(key) || (m && m.title === meta.title && m.profile === meta.profile && m.busy === meta.busy)) return;
    set({ ...state, metas: { ...state.metas, [key]: meta } });
  },
  setSlot(key: string, el: HTMLElement | null) {
    if ((state.slots[key] ?? null) === el) return;
    set({ ...state, slots: { ...state.slots, [key]: el } });
  },
  setShown(key: string, on: boolean) {
    if (!!state.shown[key] === on) return;
    set({ ...state, shown: { ...state.shown, [key]: on } });
  },
};

// The box a docked chat is drawn in. It's moved into whichever pane shows the chat, so the chat keeps its state.
const nodes = new Map<string, HTMLElement>();
export function dockNode(key: string): HTMLElement {
  let n = nodes.get(key);
  if (!n) {
    n = document.createElement("div");
    n.className = "achat achat-docked";
    n.dataset.agentDocked = key;
    nodes.set(key, n);
  }
  return n;
}

// ---- dragging between the panel and the Notebook. Each side says what it can take while it's on screen.

export interface DragStart {
  clientX: number;
  clientY: number;
  button: number;
}
interface NotebookSide {
  /** A panel tab being dragged: the Notebook follows the pointer and, dropped on a pane, calls `taken`. */
  dragIn(chat: DockedChat, meta: ChatMeta | undefined, e: DragStart, taken: () => void): void;
  /** A chat opened as a page: a new tab in the focused pane. */
  open(chat: DockedChat, meta: ChatMeta | undefined): void;
}
interface PanelSide {
  /** A chat coming back from the Notebook as a tab of the panel. */
  take(chat: DockedChat): void;
}
let notebook: NotebookSide | null = null;
let panel: PanelSide | null = null;
export const registerNotebook = (n: NotebookSide | null) => void (notebook = n);
export const registerPanel = (p: PanelSide | null) => void (panel = p);
export const notebookSide = () => notebook;
export const panelSide = () => panel;

// ---- the Notebook's chat list talking to a chat that's open in a tab.

/** What the list asks a chat tab to do: show another conversation (null: a new one), or start one with someone. */
export type ChatRequest = { open: string | null } | { with: string };
const requests = new Map<string, ChatRequest>();
export const CHAT_REQUEST_EVENT = "etude:chat-request";
/** Asks the tab `key` (open now, or about to mount) to do `r`; it takes it when it hears the event or when it mounts. */
export function requestChat(key: string, r: ChatRequest) {
  requests.set(key, r);
  window.dispatchEvent(new CustomEvent(CHAT_REQUEST_EVENT, { detail: key }));
}
export function takeChatRequest(key: string): ChatRequest | undefined {
  const r = requests.get(key);
  requests.delete(key);
  return r;
}

/** A chat renamed, pinned or deleted from a list: every tab that has it catches up. */
export const CHAT_CHANGED_EVENT = "etude:chat-changed";
export type ChatChange = { deleted: string } | { conv: { id: string; title: string; autoTitle?: boolean; pinned?: boolean } };
export const announceChat = (c: ChatChange) => window.dispatchEvent(new CustomEvent<ChatChange>(CHAT_CHANGED_EVENT, { detail: c }));
