// Fun mode (Settings → Appearance): Minimi, Etude's mascot, sits in the corner and answers instead of the plain ε.
// On by default. The setting lives with the collection (it syncs); a localStorage copy avoids a flash on load.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const KEY = "etude.fun";
const EVENT = "etude:fun";
let fun = localStorage.getItem(KEY) !== "0";

export const funMode = () => fun;

export function setFunMode(on: boolean, opts: { save?: boolean } = {}) {
  fun = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
  if (opts.save !== false) return api.saveSettings({ fun: on });
}

/** Reads the saved value once, so another device's choice wins over this one's cache. */
export async function loadFunMode() {
  try {
    const s = (await api.settings()) as { fun?: boolean };
    if (typeof s.fun === "boolean" && s.fun !== fun) setFunMode(s.fun, { save: false });
  } catch {}
}

export function useFunMode(): boolean {
  const [on, setOn] = useState(fun);
  useEffect(() => {
    const h = () => setOn(fun);
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, []);
  return on;
}
