// Sounds (Settings → Appearance): a pop when you tick a to-do in a Notebook page and a chime when a whole list is
// done. On by default. The setting lives with the collection (it syncs); a localStorage copy avoids waiting on load.
// Clips are decoded once into Web Audio buffers so a burst of ticks (a parent ticking its sub-items) plays on time,
// each a little higher than the one before.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import tickUrl from "@/assets/sounds/todo-tick.mp3?no-inline";
import doneUrl from "@/assets/sounds/todo-done.mp3?no-inline";

const KEY = "etude.sounds";
const EVENT = "etude:sounds";
let on = localStorage.getItem(KEY) !== "0";
let loaded = false;

export const soundsOn = () => on;

export function setSounds(v: boolean, opts: { save?: boolean } = {}) {
  on = v;
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: v }));
  if (opts.save !== false) return api.saveSettings({ sounds: v });
}

function loadOnce() {
  if (loaded) return;
  loaded = true;
  api
    .settings()
    .then((s: any) => typeof s?.sounds === "boolean" && s.sounds !== on && setSounds(s.sounds, { save: false }))
    .catch(() => {});
}

export function useSounds(): boolean {
  const [v, setV] = useState(on);
  useEffect(() => {
    const h = () => setV(on);
    window.addEventListener(EVENT, h);
    loadOnce();
    return () => window.removeEventListener(EVENT, h);
  }, []);
  return v;
}

const URLS = { tick: tickUrl, done: doneUrl } as const;
export type SoundName = keyof typeof URLS;
let ctx: AudioContext | null = null;
const buffers = new Map<SoundName, Promise<AudioBuffer | null>>();

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const C = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!C) return null;
  ctx = new C() as AudioContext;
  return ctx;
}

function buffer(name: SoundName): Promise<AudioBuffer | null> {
  let b = buffers.get(name);
  if (!b) {
    const c = audio();
    b = !c
      ? Promise.resolve(null)
      : fetch(URLS[name])
          .then((r) => r.arrayBuffer())
          .then((a) => c.decodeAudioData(a))
          .catch(() => null);
    buffers.set(name, b);
  }
  return b;
}

/** Fetches and decodes the clips ahead of the first tick, and reads the saved setting. */
export function primeSounds() {
  loadOnce();
  if (!on) return;
  void buffer("tick");
  void buffer("done");
}

/** Plays a clip `delay` ms from now. `step` raises the pitch by that many notes of a major pentatonic scale. */
export function playSound(name: SoundName, opts: { delay?: number; step?: number; gain?: number } = {}) {
  if (!on) return;
  const c = audio();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => {});
  const at = c.currentTime + (opts.delay ?? 0) / 1000;
  void buffer(name).then((b) => {
    if (!b) return;
    const src = c.createBufferSource();
    src.buffer = b;
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
    const s = Math.max(-12, Math.min(opts.step ?? 0, scale.length - 1));
    src.playbackRate.value = 2 ** ((s >= 0 ? scale[s] : s) / 12);
    const g = c.createGain();
    g.gain.value = (opts.gain ?? 1) * 0.6;
    src.connect(g).connect(c.destination);
    src.start(Math.max(at, c.currentTime));
  });
}
