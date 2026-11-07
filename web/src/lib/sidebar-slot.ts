// What the app sidebar shares with the screens inside it: its width (you drag its edge), whether Notes shows its
// pages under the Notes row, the spot those pages render into, and what Notes' right-click menu can do.
import { useSyncExternalStore } from "react";

export const SB_DEFAULT = 232;
export const SB_MIN = 200;
export const SB_MAX = 480;
/** Let go narrower than this and the sidebar folds into the rail. */
export const SB_FOLD = 150;

const WIDTH_KEY = "etude.sidebar.width";
const PAGES_KEY = "etude.notes.pagesOpen";

export type NotesAction = "new" | "new-canvas" | "new-folder" | "add-pdf" | "import-md" | "import-vault" | "fold-all";

const clampW = (w: number) => Math.max(SB_MIN, Math.min(SB_MAX, Math.round(w)));
const readW = () => {
  const v = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(v) && v > 0 ? clampW(v) : SB_DEFAULT;
};

const state = {
  width: typeof localStorage === "undefined" ? SB_DEFAULT : readW(),
  pagesOpen: typeof localStorage === "undefined" ? true : localStorage.getItem(PAGES_KEY) !== "0",
  slot: null as HTMLElement | null,
  actions: null as ((a: NotesAction) => void) | null,
  pending: null as NotesAction | null,
};
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const sub = (f: () => void) => (subs.add(f), () => void subs.delete(f));

export function setSidebarWidth(w: number) {
  state.width = clampW(w);
  localStorage.setItem(WIDTH_KEY, String(state.width));
  emit();
}
export const useSidebarWidth = () => useSyncExternalStore(sub, () => state.width);

export function setNotesPagesOpen(on: boolean) {
  state.pagesOpen = on;
  localStorage.setItem(PAGES_KEY, on ? "1" : "0");
  emit();
}
export const useNotesPagesOpen = () => useSyncExternalStore(sub, () => state.pagesOpen);

/** The sidebar mounts this element under the Notes row; Notes portals its page tree into it. */
export function setNotesSlot(el: HTMLElement | null) {
  if (state.slot === el) return;
  state.slot = el;
  emit();
}
export const useNotesSlot = () => useSyncExternalStore(sub, () => state.slot);

/** Notes registers what its menu items do while it's open. */
export function registerNotesActions(fn: ((a: NotesAction) => void) | null) {
  state.actions = fn;
  if (fn && state.pending) {
    const a = state.pending;
    state.pending = null;
    queueMicrotask(() => fn(a));
  }
}
/** Runs a Notes action now, or as soon as Notes opens (the caller navigates there). Returns true if it ran now. */
export function runNotesAction(a: NotesAction): boolean {
  if (state.actions) {
    state.actions(a);
    return true;
  }
  state.pending = a;
  return false;
}
