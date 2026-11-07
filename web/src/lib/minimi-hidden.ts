// Whether the corner Minimi is hidden on this device (right-click him → Hide; right-click the empty page →
// Show Minimi). Kept per device in localStorage, like where he sits: hiding him on the laptop leaves him
// on the iPad. Fun mode itself stays on, so the mini chat, his faces and his voice in Ask Etude stay.
import { useEffect, useState } from "react";

const KEY = "etude.minimi.hidden";
const EVENT = "etude:minimi-hidden";
let hidden = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();

export const minimiHidden = () => hidden;

export function setMinimiHidden(on: boolean) {
  hidden = on;
  try {
    on ? localStorage.setItem(KEY, "1") : localStorage.removeItem(KEY);
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
}

export function useMinimiHidden(): boolean {
  const [on, setOn] = useState(hidden);
  useEffect(() => {
    const h = () => setOn(hidden);
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, []);
  return on;
}
