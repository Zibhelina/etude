// Vim keys in Notes' file editor (Settings → Keyboard). Off by default. The setting lives with the collection
// (it syncs); a localStorage copy lets an editor open in the right mode before the settings load.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const KEY = "etude.vim";
const EVENT = "etude:vim";
let on = localStorage.getItem(KEY) === "1";
let loaded = false;

export function setVimMode(v: boolean, opts: { save?: boolean } = {}) {
  on = v;
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: v }));
  if (opts.save !== false) return api.saveSettings({ vim: v });
}

/** Whether Vim keys are on, kept current when Settings (or another device) changes it. */
export function useVimMode(): boolean {
  const [v, setV] = useState(on);
  useEffect(() => {
    const h = () => setV(on);
    window.addEventListener(EVENT, h);
    if (!loaded) {
      loaded = true;
      api
        .settings()
        .then((s: any) => typeof s?.vim === "boolean" && s.vim !== on && setVimMode(s.vim, { save: false }))
        .catch(() => {});
    }
    return () => window.removeEventListener(EVENT, h);
  }, []);
  return v;
}
