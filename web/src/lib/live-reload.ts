// When the server starts handing out a new build of the web app (an update, a deploy, `npm run build` on a
// checkout), an open window picks it up by itself instead of running the old code until someone presses reload.
// It reloads only at a safe moment: nothing waiting to be saved, no text typed into a box that isn't saved yet, no
// dialog open, and the user idle for a few seconds (longer while studying), or the window in the background.
// The open tabs, page and route come back as they were: they live in the URL and localStorage.
import { toast } from "sonner";
import { api } from "@/lib/api";
import { isLocal } from "@/lib/transport";

const holds = new Set<() => boolean>();
/** Something with unsaved work (a page's saver) says "not now" while `busy()` is true. Returns the release. */
export function holdReload(busy: () => boolean): () => void {
  holds.add(busy);
  return () => void holds.delete(busy);
}

const FLAG = "etude.reloaded-for-build";
const POLL_MS = 15_000;
const TRY_MS = 3_000;

/** The entry script this window runs, as index.html names it (null in development, where there's no build). */
function mine(): string | null {
  const s = [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((x) => new URL(x.src, location.href).pathname).find((p) => /\/assets\/[^/]+\.js$/.test(p));
  return s ?? null;
}

let lastInput = Date.now();
const touch = () => void (lastInput = Date.now());

function safe(): boolean {
  if ([...holds].some((busy) => busy())) return false;
  if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return false;
  const a = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && !["checkbox", "radio", "range", "button", "submit"].includes(a.type))) && a.value) return false;
  if (document.visibilityState === "hidden") return true;
  const quiet = /^\/(study|watch)\b/.test(location.pathname) ? 30_000 : 5_000;
  return Date.now() - lastInput >= quiet;
}

/** Starts watching for a new build. Call once, at startup. */
export function startLiveReload() {
  if (isLocal()) return; // the phone apps carry their own copy of the app
  const have = mine();
  if (!have) return;
  if (sessionStorage.getItem(FLAG)) {
    sessionStorage.removeItem(FLAG);
    setTimeout(() => toast.success("Etude updated", { description: "This window reloaded itself on the new version." }), 600);
  }
  for (const e of ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"]) window.addEventListener(e, touch, { passive: true, capture: true });
  let waiting = false;
  const tryReload = () => {
    if (!safe()) return void setTimeout(tryReload, TRY_MS);
    sessionStorage.setItem(FLAG, "1");
    location.reload();
  };
  const check = async () => {
    if (waiting) return;
    try {
      const { entry } = await api.appBuild();
      if (entry && entry !== have) {
        waiting = true;
        tryReload();
      }
    } catch {
      // The server is restarting or away: look again later.
    }
  };
  setInterval(() => void check(), POLL_MS);
  window.addEventListener("focus", () => void check());
  document.addEventListener("visibilitychange", () => void check());
}
