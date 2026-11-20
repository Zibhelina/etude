// Activity, the window's side (src/core/activity.ts has the rules and the table). While Settings → Privacy →
// Activity is on, this counts how long you're active in each page, file, chat and screen and how much you type there,
// and sends the counts about once a minute. What counts:
//   - Time: while this window is visible and focused, and there was input (a key, a click, scrolling, the pointer
//     moving) in the last 2 minutes, or a video or audio plays, or focus sits in an embedded frame (a PDF, a widget)
//     for up to 10 minutes. It goes to the chat or pane you last touched, else the focused pane, else the screen.
//   - Typing: characters typed, pasted and deleted, and words started, from `beforeinput`, composition, paste and cut
//     in whatever has focus (pages, Markdown and code files, a canvas's text, Ask's message box). Only lengths are
//     taken, and whether a character starts a word; nothing keeps or sends the text.
// Nothing runs while it's off, in an automated browser (tests set localStorage etude.activity.test = 1) or in a frame
// inside another page, and the window stops the moment the core says it's off.
import { api, type ActivityEntry, type ActivityKind } from "@/lib/api";
import { etudeFetch } from "@/lib/transport";
import { appPath } from "@/lib/router";

const IDLE_MS = 120_000;
const FRAME_IDLE_MS = 600_000;
const TICK_MS = 5_000;
const FLUSH_MS = 60_000;
/** While off, how often to look again (it may have been turned on in another window or the CLI). */
const RECHECK_MS = 10 * 60_000;
const HOUR = 3_600_000;
const MAX_PENDING = 400;
const CHANGED_KEY = "etude.activity.changed";

const SCREENS = new Set(["decks", "deck", "study", "browse", "stats", "market", "settings", "notes", "types", "watch", "archive", "more"]);
const NOTE_KINDS = new Set<ActivityKind>(["page", "file", "pdf", "canvas", "kanban", "web"]);
/** The same check the core makes; anything else isn't sent, so one odd tab can't spoil a batch. */
const ID_RE = /^[\w.:-]{1,200}$/;

type Target = { kind: ActivityKind; ref: string };

let on = false;
let started = false;
let lastInput = 0;
let lastTick = 0;
let lastMove = 0;
let lastEl: Element | null = null;
let curKey = "";
let prevWordy = false;
const pending = new Map<string, ActivityEntry>();
let tickTimer = 0;
let flushTimer = 0;
let recheckTimer = 0;

/** Automated browsers (unless a test asks) and the app embedded in another page's frame record nothing. */
const automated = () => {
  if (window.self !== window.top) return true;
  const bot = !!(navigator as { webdriver?: boolean }).webdriver || /HeadlessChrome/.test(navigator.userAgent);
  try {
    return bot && localStorage.getItem("etude.activity.test") !== "1";
  } catch {
    return bot;
  }
};

function screen(): Target {
  const seg = appPath().split("/").filter(Boolean)[0] ?? "decks";
  return { kind: "screen", ref: SCREENS.has(seg) ? seg : "other" };
}

function paneTarget(pane: Element): Target | null {
  const note = pane.getAttribute("data-pane-note") ?? "";
  const kind = (pane.getAttribute("data-pane-kind") ?? "") as ActivityKind;
  if (note.startsWith("chat:")) return ID_RE.test(note.slice(5)) ? { kind: "chat", ref: note.slice(5) } : null;
  if (!note || !NOTE_KINDS.has(kind)) return null;
  if (!note.startsWith("fs:") && !ID_RE.test(note)) return null;
  if (note.length > 1024) return null;
  return { kind, ref: note };
}

/** Where activity at `el` goes: its chat, its pane's note, the focused pane's, or the screen. */
function targetOf(el: Element | null): Target {
  const chat = el?.closest?.("[data-chat]")?.getAttribute("data-chat");
  if (chat && ID_RE.test(chat)) return { kind: "chat", ref: chat };
  const pane = el?.closest?.("section[data-pane]");
  if (pane) return paneTarget(pane) ?? screen();
  if (el?.closest?.("[data-agent-panel]")) return screen();
  if (screen().ref === "notes") {
    const panes = document.querySelectorAll("section[data-pane]");
    const focused = document.querySelector("section[data-pane].is-focus") ?? (panes.length === 1 ? panes[0] : null);
    if (focused) return paneTarget(focused) ?? screen();
  }
  return screen();
}

function current(): Target {
  const el = lastEl && lastEl.isConnected ? lastEl : document.activeElement;
  return targetOf(el);
}

function add(t: Target, d: Partial<Pick<ActivityEntry, "ms" | "typed" | "pasted" | "deleted" | "words">>, at = Date.now()) {
  const hour = Math.floor(at / HOUR) * HOUR;
  const key = `${hour}|${t.kind}|${t.ref}`;
  let e = pending.get(key);
  if (!e) {
    if (pending.size >= MAX_PENDING) return;
    pending.set(key, (e = { kind: t.kind, ref: t.ref, hour, ms: 0, typed: 0, pasted: 0, deleted: 0, words: 0 }));
  }
  e.ms += d.ms ?? 0;
  e.typed += d.typed ?? 0;
  e.pasted += d.pasted ?? 0;
  e.deleted += d.deleted ?? 0;
  e.words += d.words ?? 0;
}

function mediaPlaying() {
  for (const m of document.querySelectorAll("video, audio")) if (!(m as HTMLMediaElement).paused && !(m as HTMLMediaElement).ended) return true;
  return false;
}

function active(now: number) {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  if (now - lastInput <= IDLE_MS) return true;
  if (mediaPlaying()) return true;
  return document.activeElement?.tagName === "IFRAME" && now - lastInput <= FRAME_IDLE_MS;
}

/** Credits the time since the last tick to what's in front (a laptop asleep in between doesn't count). */
function tick() {
  const now = Date.now();
  const dt = Math.min(now - lastTick, TICK_MS * 2);
  lastTick = now;
  if (!on || dt <= 0 || !active(now)) return;
  add(current(), { ms: dt }, now);
}

/** Input at `el`: the clock keeps running, and a change of place first closes the time spent in the last one. */
function touch(el: EventTarget | null) {
  if (!(el instanceof Element)) el = document.activeElement;
  const t = targetOf(el as Element | null);
  const key = `${t.kind}|${t.ref}`;
  if (key !== curKey) {
    tick();
    curKey = key;
    prevWordy = false;
  }
  lastEl = el as Element | null;
  lastInput = Date.now();
}

const WORDY = /[\p{L}\p{N}]/u;
/** Counts characters and words started in typed text; the text itself goes nowhere. */
function typed(text: string) {
  let chars = 0, words = 0;
  for (const ch of text) {
    chars++;
    const w = WORDY.test(ch);
    if (w && !prevWordy) words++;
    prevWordy = w;
  }
  return { chars, words };
}

const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && /^(text|search|url|email|)$/.test(t.type)));
const selectedLength = () => {
  const a = document.activeElement;
  if (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) {
    try {
      return Math.abs((a.selectionEnd ?? 0) - (a.selectionStart ?? 0));
    } catch {
      return 0;
    }
  }
  return window.getSelection()?.toString().length ?? 0;
};

function onBeforeInput(ev: Event) {
  const e = ev as InputEvent;
  if (!on || e.isComposing) return;
  touch(e.target);
  const t = current();
  const kind = e.inputType;
  if (kind === "insertText" || kind === "insertReplacementText") {
    const s = typed(e.data ?? e.dataTransfer?.getData("text/plain") ?? "");
    add(t, { typed: s.chars, words: s.words });
  } else if (kind === "insertParagraph" || kind === "insertLineBreak") {
    prevWordy = false;
    add(t, { typed: 1 });
  } else if (kind.startsWith("delete") && kind !== "deleteByCut" && kind !== "deleteByDrag") {
    add(t, { deleted: Math.max(1, selectedLength()) });
  }
}

function onCompositionEnd(ev: Event) {
  if (!on) return;
  const e = ev as CompositionEvent;
  touch(e.target);
  const s = typed(e.data ?? "");
  if (s.chars) add(current(), { typed: s.chars, words: s.words });
}

function onPaste(ev: Event) {
  const e = ev as ClipboardEvent;
  if (!on || !editable(e.target)) return;
  touch(e.target);
  const n = e.clipboardData?.getData("text/plain").length ?? 0;
  prevWordy = false;
  if (n) add(current(), { pasted: n });
}

function onCut(ev: Event) {
  if (!on || !editable(ev.target)) return;
  touch(ev.target);
  const n = selectedLength();
  if (n) add(current(), { deleted: n });
}

function onInput(ev: Event) {
  if (on) touch(ev.target);
}

function onMove(ev: Event) {
  if (!on) return;
  const now = Date.now();
  if (now - lastMove < 1000) return;
  lastMove = now;
  touch(ev.target);
}

const INPUTS: [string, (e: Event) => void][] = [
  ["beforeinput", onBeforeInput],
  ["compositionend", onCompositionEnd],
  ["paste", onPaste],
  ["cut", onCut],
  ["keydown", onInput],
  ["pointerdown", onInput],
  ["wheel", onInput],
  ["focusin", onInput],
  ["pointermove", onMove],
  ["scroll", onMove],
];

/** Sends what's waiting. `leaving`: the page is going away, so the request must outlive it. */
async function flush(leaving = false) {
  tick();
  const entries = [...pending.values()].filter((e) => e.ms || e.typed || e.pasted || e.deleted || e.words);
  pending.clear();
  for (let i = 0; i < entries.length; i += 200) {
    const batch = entries.slice(i, i + 200);
    try {
      const res = await etudeFetch("/api/activity", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: batch }), keepalive: leaving });
      if (!res.ok) continue;
      const r = (await res.json()) as { on: boolean };
      if (!r.on) return stop();
    } catch {
      // Offline or the core restarting: keep them for the next try.
      if (!leaving) for (const e of batch) add(e, e, e.hour);
    }
  }
}

function onVisibility() {
  if (document.visibilityState === "hidden") void flush(true);
  else lastTick = Date.now();
}
const onHide = () => void flush(true);

function start() {
  if (on) return;
  on = true;
  lastTick = Date.now();
  lastInput = Date.now();
  curKey = "";
  for (const [name, fn] of INPUTS) document.addEventListener(name, fn, { capture: true, passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onHide);
  tickTimer = window.setInterval(tick, TICK_MS);
  flushTimer = window.setInterval(() => void flush(), FLUSH_MS);
  window.clearInterval(recheckTimer);
}

function stop() {
  if (!on) return;
  on = false;
  pending.clear();
  for (const [name, fn] of INPUTS) document.removeEventListener(name, fn, { capture: true });
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("pagehide", onHide);
  window.clearInterval(tickTimer);
  window.clearInterval(flushTimer);
  recheckTimer = window.setInterval(() => void check(), RECHECK_MS);
}

async function check() {
  if (automated()) return stop();
  try {
    const s = await api.activity();
    if (s.on) start();
    else stop();
  } catch {
    // An older core without Activity, or one starting up: nothing to do.
  }
}

/** Starts the window's side once (App calls it); it follows the setting from then on. */
export function startActivity() {
  if (started) return;
  started = true;
  window.addEventListener("storage", (e) => {
    if (e.key === CHANGED_KEY) void check();
  });
  recheckTimer = window.setInterval(() => void check(), RECHECK_MS);
  void check();
}

/** Settings changed it here: this window follows at once, and the other windows of this app look again. */
export async function activityChanged(nowOn: boolean) {
  if (nowOn && !automated()) start();
  else {
    if (on) await flush();
    stop();
  }
  try {
    localStorage.setItem(CHANGED_KEY, String(Date.now()));
  } catch {
    // Storage full or blocked: the others look again within RECHECK_MS.
  }
}

/** What's waiting to be sent, for the e2e test. */
export const activityPending = () => [...pending.values()];
export const activityFlush = () => flush();
