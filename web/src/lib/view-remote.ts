// The app's end of `etude view`: it tells the server what the app shows, and carries out the commands the CLI or
// an agent leaves for it. The app shell does what's about the whole app (the sidebar, the Ask panel, which screen);
// the Notebook page does its tabs and panes. Until the Notebook is on screen, a command for it waits here and the
// app goes to the Notebook.
import { api, type ViewCommand, type ViewShell } from "@/lib/api";
import { navigate } from "@/lib/router";

type Handler = (cmd: ViewCommand) => Promise<void> | void;
let handler: Handler | null = null;
let shellHandler: Handler | null = null;
let waiting: (ViewCommand & { seq: number })[] = [];
let applied: number | undefined;
let failed: { seq: number; error: string } | undefined;
let route = typeof location === "undefined" ? "/" : location.pathname + location.search;
let panes: unknown[] = [];
let shell: ViewShell | undefined;
let heard = false;
let started = false;

/** What the app itself does, without the Notebook. */
const SHELL = new Set<ViewCommand["action"]>(["sidebar", "pages", "panel", "go"]);

// With more than one window open (lib/window-store.ts; or on another computer showing the same engine), the one used
// last answers: it carries out the commands and says what it shows. The others keep counting so they don't replay old
// commands when they take over. Windows of one browser agree through localStorage; the server (/api/view/owner) has
// the last word across browsers and computers.
const OWNER_KEY = "etude.view.owner";
const me = Math.random().toString(36).slice(2, 10);
/** The window that answers, as "id time": it renews the time while it's open, so a window that crashed stops counting. */
const owner = (): string | null => {
  try {
    const [id, at] = (localStorage.getItem(OWNER_KEY) ?? "").split(" ");
    return id && Date.now() - Number(at) < 60_000 ? id : null;
  } catch {
    return me;
  }
};
/** The window the server last heard was used, from the command polls; undefined until one answered. */
let serverOwner: string | null | undefined;
const mine = () => {
  if (serverOwner && serverOwner !== me) return false;
  const o = owner();
  return o === null || o === me;
};
const tellServer = () => void api.viewOwner(me).then((r) => (serverOwner = r.owner), () => {});
const stamp = () => {
  try {
    localStorage.setItem(OWNER_KEY, `${me} ${Date.now()}`);
  } catch {}
};
function claim() {
  tellServer();
  serverOwner = me;
  if (owner() === me) return void report();
  stamp();
  report();
}

const report = () => {
  if (heard && mine()) void api.viewState({ route, panes, shell, applied, failed }).catch(() => {});
};

async function run(c: ViewCommand & { seq: number }) {
  // Another window answers (the palette's own, seq -1, are always this window's).
  if (c.seq >= 0 && !mine()) return;
  const h = SHELL.has(c.action) ? shellHandler : handler;
  if (!h) {
    waiting.push(c);
    if (!SHELL.has(c.action)) navigate("/notes");
    return;
  }
  try {
    await h(c);
  } catch (e) {
    if (c.seq < 0) return;
    failed = { seq: c.seq, error: (e as Error)?.message || String(e) };
  }
  // seq -1: the palette's own, which nobody outside waits on.
  if (c.seq < 0) return;
  applied = c.seq;
  // The page reports its new panes on its own; this makes sure the number gets there even when nothing moved.
  setTimeout(report, 300);
}

/** Starts listening, once, for the life of the app. */
export function startViewRemote() {
  if (started || typeof window === "undefined") return;
  started = true;
  if (document.hasFocus() || owner() === null) claim();
  window.addEventListener("focus", claim);
  // Closing (or reloading) the window that answered: one of the others takes over.
  window.addEventListener("pagehide", () => {
    if (owner() !== me) return;
    try {
      localStorage.removeItem(OWNER_KEY);
    } catch {}
  });
  window.addEventListener("storage", (e) => {
    if (e.key === OWNER_KEY && e.newValue === null) claim();
  });
  void (async () => {
    let seq = 0;
    for (;;) {
      try {
        seq = (await api.viewCommands()).seq;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    for (;;) {
      try {
        const r = await api.viewCommands(seq);
        if (r.owner !== undefined) serverOwner = r.owner;
        // Nobody holds it (the server restarted, or the window that did went quiet): the one in front takes it.
        if (r.owner === null && document.hasFocus()) claim();
        for (const c of r.commands) if (c.seq > seq) await run(c);
        seq = Math.max(seq, r.seq);
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();
  // Still here: an app that goes quiet is taken as closed.
  setInterval(() => {
    if (owner() === me) stamp();
    else if (owner() === null) claim();
    if (serverOwner === me) tellServer();
    report();
  }, 20_000);
}

function flush() {
  const w = waiting.filter((c) => (SHELL.has(c.action) ? shellHandler : handler));
  if (!w.length) return;
  waiting = waiting.filter((c) => !w.includes(c));
  void (async () => {
    for (const c of w) await run(c);
  })();
}

/** The same commands from inside the app (the command palette): carried out here, or once the Notebook shows. */
export async function applyView(c: ViewCommand) {
  const h = SHELL.has(c.action) ? shellHandler : handler;
  if (!h) {
    waiting.push({ ...c, seq: -1 });
    if (!SHELL.has(c.action)) navigate("/notes");
    return;
  }
  await h(c);
}

/** What the Notebook showed last (its panes, with their boxes), and the shell; empty until they've reported. */
export const viewNow = () => ({ panes: panes as ViewPane[], shell, heard });
export type ViewPane = { n: number; focused: boolean; front: { id: string; kind: string; title: string } | null; tabs: { id: string; kind: string; title: string }[]; box?: { x: number; y: number; w: number; h: number } };

/** The Notebook page takes the tab and pane commands while it's on screen. */
export function setViewHandler(h: Handler | null) {
  handler = h;
  if (h) flush();
}

/** The app shell takes the sidebar, the Ask panel and going to another screen. */
export function setShellHandler(h: Handler | null) {
  shellHandler = h;
  if (h) flush();
}

/** What the Notebook shows now, for `etude view show`. */
export function reportView(_route: string, p: unknown[]) {
  panes = p;
  heard = true;
  report();
}

/** The screen, the sidebar, Notes' pages and the Ask panel. */
export function reportShell(r: string, s: ViewShell) {
  route = r;
  shell = s;
  heard = true;
  report();
}
