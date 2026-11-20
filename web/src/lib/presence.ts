// Presence in shared spaces, like Google Docs: this window tells the local server what's open here and where the
// cursor is (it encrypts and sends it, throttled), and reads who else is around. The editor's cursor layer and the
// canvas read the same list from `presenceStore`, so one poll feeds every view.
import { useEffect, useState } from "react";
import { shareApi, type SharePerson } from "./share";
import { etudeFetch } from "./transport";

export type PresenceReport = { note: string | null; sel?: SharePerson["sel"]; block?: number[] | null; typing?: boolean };

// ---------------------------------------------------------------- telling the server what's open here

/** Coalesce bursts (every keystroke moves the selection); the core throttles again before anything leaves the device. */
const REPORT_MS = 120;
/** While something is open, say so again this often, so the core knows the window is still there (it forgets after 40 s). */
const KEEPALIVE_MS = 10_000;

let wanted: PresenceReport = { note: null };
let sentKey = "";
let timer: ReturnType<typeof setTimeout> | null = null;
let beat: ReturnType<typeof setInterval> | null = null;

const send = () => {
  timer = null;
  const body = wanted;
  sentKey = JSON.stringify(body);
  shareApi.setPresence(body).catch(() => {});
};

/** What's open here now. `note` null: nothing shared is open (a private page, another screen). */
export function reportPresence(p: PresenceReport) {
  wanted = { note: p.note, sel: p.sel ?? null, block: p.block ?? null, typing: !!p.typing };
  if (JSON.stringify(wanted) === sentKey) return;
  if (!timer) timer = setTimeout(send, wanted.note ? REPORT_MS : 0);
  if (wanted.note && !beat) beat = setInterval(() => wanted.note && send(), KEEPALIVE_MS);
  if (!wanted.note && beat) (clearInterval(beat), (beat = null));
}
/** The open note changed: start from no cursor on it. */
export function openPresence(note: string | null) {
  if (note === wanted.note) return;
  wanted = { note: null };
  reportPresence({ note, sel: null });
}

if (typeof window !== "undefined")
  window.addEventListener("pagehide", () => {
    if (!wanted.note) return;
    wanted = { note: null };
    // keepalive: the request outlives the page.
    etudeFetch("/api/share/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: null }), keepalive: true }).catch(() => {});
  });

// ---------------------------------------------------------------- who else is here

type Listener = (people: SharePerson[]) => void;
let people: SharePerson[] = [];
const listeners = new Set<Listener>();
export const presenceStore = {
  get: () => people,
  set(next: SharePerson[]) {
    // Same people in the same places: nothing to redraw.
    if (JSON.stringify(next) === JSON.stringify(people)) return;
    people = next;
    for (const l of listeners) l(people);
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

/** The people in the space of `note`, read every second while it's shared and on screen. Empty otherwise. */
export function usePresencePoll(note: string | null, shared: boolean): SharePerson[] {
  const [list, setList] = useState<SharePerson[]>(presenceStore.get);
  useEffect(() => presenceStore.subscribe(setList), []);
  useEffect(() => {
    if (!note || !shared) {
      presenceStore.set([]);
      return;
    }
    let live = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!live) return;
      if (document.visibilityState === "visible")
        try {
          const r = await shareApi.presence(note);
          if (live) presenceStore.set(r.people);
        } catch {
          // Offline or signed out: keep what we had until the next look.
        }
      if (live) t = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [note, shared]);
  return list;
}

/** One entry per person (their most recent device), the ones on `note` first. */
export function peopleIn(list: SharePerson[]): SharePerson[] {
  const by = new Map<string, SharePerson>();
  for (const p of list) {
    const had = by.get(p.accountId);
    if (!had || (p.here && !had.here) || (p.here === had.here && p.at > had.at)) by.set(p.accountId, p);
  }
  return [...by.values()].sort((a, b) => Number(b.here) - Number(a.here) || b.at.localeCompare(a.at));
}

/** The label above a caret: a name, or the part of the email before the @. */
export const presenceLabel = (p: { name: string | null; email: string | null }) => p.name?.trim() || (p.email ?? "").split("@")[0] || "Someone";

/** Text color on a person's color: white, or near-black on the light ones (amber, teal in some themes). */
export function inkOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? "#1b1b1a" : "#ffffff";
}
