// More than one Etude window on the same computer (the desktop app's New window, or a browser's). They share
// localStorage, so what belongs to one window (its panes and tabs, the chats and web pages open in them) would be
// overwritten by the other, and a reload would bring back the other window's tabs. The first window keeps those in
// localStorage, so they come back when the app starts again; every window opened after it keeps its own in
// sessionStorage, which lasts as long as that window (reloads included) and nobody else sees.
//
// A window is told it's one of those by its address: `?window=new` starts it empty, `?window=extra` (the desktop
// app reloading it after the engine restarted) keeps what it had. Either is taken off the address at once.

const FLAG = "etude.window";
/** Keys that belong to one window. */
const OWN = ["etude.notes.layout", "etude.agent.docked", "etude.web.tabs"];

function decide(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const u = new URL(location.href);
    const asked = u.searchParams.get("window");
    if (asked === "new" || asked === "extra") {
      sessionStorage.setItem(FLAG, "extra");
      if (asked === "new") for (const k of OWN) sessionStorage.removeItem(k);
      u.searchParams.delete("window");
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    }
    return sessionStorage.getItem(FLAG) === "extra";
  } catch {
    return false;
  }
}

const extra = decide();

/** Whether this is a window opened after the first one. */
export const isExtraWindow = () => extra;

/** localStorage for the first window, sessionStorage for the others: for what belongs to one window. */
export const windowStore = {
  get(key: string): string | null {
    try {
      return (extra ? sessionStorage : localStorage).getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      (extra ? sessionStorage : localStorage).setItem(key, value);
    } catch {}
  },
};

/** Opens another Etude window showing `path` (an address in Etude, like "/notes?id=…"), starting empty there. */
export function openNewWindow(path = "/notes") {
  const bridge = (globalThis as { etudeDesktop?: { newWindow?: (path: string) => Promise<void> } }).etudeDesktop;
  if (bridge?.newWindow) return void bridge.newWindow(path);
  const u = new URL(path, location.origin);
  u.searchParams.set("window", "new");
  // The server's password, if it has one, is already in localStorage (lib/transport.ts), which the window shares.
  window.open(u.toString(), "_blank", "noopener,popup,width=" + window.outerWidth + ",height=" + window.outerHeight);
}

/** Whether a new window can be opened from here (not in the phone apps). */
export const canOpenWindows = () => !(globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
