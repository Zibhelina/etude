// Anonymous error reports and opt-in usage counts, sent to Etude's own server (sync.etude.study), never to the
// Sync server the person set up. What is sent, and only that:
//   errors: kind, a scrubbed message (≤300) and stack (≤4 KB), a fingerprint, a count, app version, platform, OS
//   usage:  daily counts of the event names in EVENT_NAMES, app version, platform
// No account, device or install id; no card, deck, answer or collection text; no emails or file names.
// Settings → Privacy: "Send error reports" (on unless turned off), "Share usage stats" (off unless turned on).
//
// Only the app sends: `etude serve` started by the desktop app (ETUDE_APP=desktop) and the core in the browser and
// phone apps call startTelemetry(). The `etude` command, agents and tests never do, and ETUDE_TELEMETRY=0 turns it
// off everywhere. The queue lives in $ETUDE_HOME/telemetry-queue.json; anything older than 7 days is dropped.
// etude-cloud has the same EVENT_NAMES and scrub() (src/lib/telemetry.ts) and scrubs again.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { Etude } from "./engine.ts";
import { ETUDE_ROOT } from "./update.ts";

export const TELEMETRY_SERVER = "https://sync.etude.study";

export const EVENT_NAMES = [
  "app.open",
  "onboarding.finish",
  "onboarding.skip",
  "study.session",
  "card.reviewed",
  "ai.grade",
  "ai.feedback",
  "ask.open",
  "ask.message",
  "market.open",
  "market.install",
  "import.anki",
  "import.pack",
  "deck.create",
  "occlusion.create",
  "type.edit",
  "sync.setup",
  "theme.change",
  "browse.open",
  "stats.open",
  "watch.open",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];
export const isEventName = (s: unknown): s is EventName => typeof s === "string" && (EVENT_NAMES as readonly string[]).includes(s);

/** The usage counter an app route stands for (POST /api/decks → deck.create), or null. AI grades are counted from the answer. */
export function usageEventFor(method: string, path: string): EventName | null {
  const m = method.toUpperCase();
  if (m === "POST") {
    if (path === "/api/study/submit" || path === "/api/study/rate" || path === "/api/watch/grade") return "card.reviewed";
    if (path === "/api/study/feedback") return "ai.feedback";
    if (path === "/api/anki/import") return "import.anki";
    if (path === "/api/import") return "import.pack";
    if (path === "/api/market/install") return "market.install";
    if (path === "/api/decks") return "deck.create";
    if (path === "/api/occlusion") return "occlusion.create";
    if (path === "/api/sync/setup") return "sync.setup";
    if (/^\/api\/agent\/conversations\/[^/]+\/messages$/.test(path)) return "ask.message";
  }
  if (m === "PUT") {
    if (/^\/api\/types\/[^/]+$/.test(path)) return "type.edit";
    if (path === "/api/theme") return "theme.change";
  }
  return null;
}

export type Platform = "mac" | "win" | "linux" | "ios" | "android" | "web";

export interface Privacy {
  /** Send anonymous error reports (on unless turned off). */
  errorReports: boolean;
  /** Share anonymous usage counts (off unless turned on). */
  usageStats: boolean;
}
export const DEFAULT_PRIVACY: Privacy = { errorReports: true, usageStats: false };

const KEEP_MS = 7 * 86400_000;
const MAX_ERRORS = 50;
const FLUSH_EVERY_MS = 5 * 60_000;
const FIRST_FLUSH_MS = 15_000;

/**
 * Removes what could point to a person: the inside of quoted strings (errors often quote the card or deck text that
 * broke), home folders (→ ~), app containers, email addresses, URL query strings, UUIDs and long runs of digits.
 */
export function scrub(text: string): string {
  return String(text ?? "")
    .replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|`[^`\n]*`/g, (m) => m[0] + "…" + m[m.length - 1])
    .replace(/(^|[\s(:=,[])'[^'\n]*'/g, (_m, pre) => `${pre}'…'`)
    .replace(/‘[^’\n]*’/g, "‘…’")
    .replace(/\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s:]+/gi, "~")
    .replace(/(?:\/private)?\/(?:Users|home)\/[^/\s:]+/g, "~")
    .replace(/\/var\/mobile\/Containers\/Data\/Application\/[^/\s:]+/g, "~")
    .replace(/\/data\/(?:user\/\d+|data)\/[^/\s:]+/g, "~")
    .replace(/\/root(?=\/)/g, "~")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/(\b[a-z][\w+.-]*:\/\/[^\s?#"'()]+)[?#][^\s"'()]*/gi, "$1?…")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\d{6,}/g, "<n>");
}

const cut = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max).replace(/[\uD800-\uDBFF]$/, ""));

/** FNV-1a, two 32-bit halves: 16 hex digits. Same error, same fingerprint, on every platform. */
function fnv(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (a & 0xff), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** Groups an error by its kind, its message without numbers, and the function names of the first frames. */
export function fingerprint(kind: string, message: string, stack: string): string {
  const frames = stack
    .split("\n")
    .map((l) => l.trim().replace(/\b[a-z][\w+.-]*:\/\/[^/\s)]*/gi, "").replace(/:\d+(:\d+)?\)?$/, "").replace(/[?#].*$/, "").replace(/-[A-Za-z0-9_]{8,}\.js/g, ".js"))
    .filter(Boolean)
    .slice(0, 4)
    .join("|");
  return fnv(`${kind}\n${message.replace(/\d+/g, "#")}\n${frames}`);
}

export interface ReportInput {
  kind: string;
  message: string;
  stack?: string;
}

interface QueuedError {
  kind: string;
  message: string;
  stack: string;
  fingerprint: string;
  count: number;
  version: string;
  platform: Platform;
  os: string;
  at: number;
}
interface Queue {
  errors: QueuedError[];
  /** `day|name|version|platform` → count */
  counters: Record<string, number>;
  /** UTC day app.open was last counted, so it counts once per install per day. */
  openDay?: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>;

export interface TelemetryHost {
  platform: Platform;
  os: string;
  /** Overrides for tests. */
  fetch?: FetchLike;
  now?: () => number;
  /** Where to send; ETUDE_TELEMETRY_URL, else sync.etude.study. Never the person's own Sync server. */
  server?: string;
  /** An automated browser (navigator.webdriver): nothing is sent unless ETUDE_TELEMETRY=1. */
  automated?: boolean;
}

const nodePlatform = (): Platform => (process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux");
const nodeOs = (): string => {
  const r = String(os.release?.() ?? "").split(".").slice(0, 2).join(".");
  return process.platform === "darwin" ? `Darwin ${r}` : process.platform === "win32" ? `Windows ${r}` : `Linux ${r}`;
};

/** Off when ETUDE_TELEMETRY is 0/off/false/no, under `node --test`, or (unless ETUDE_TELEMETRY=1) in an automated browser. */
export function telemetryAllowed(env: Record<string, string | undefined> = process.env, automated = false): boolean {
  const v = (env.ETUDE_TELEMETRY ?? "").trim().toLowerCase();
  if (/^(0|off|false|no)$/.test(v)) return false;
  if (/^(1|on|true|yes)$/.test(v)) return true;
  if (env.NODE_TEST_CONTEXT) return false;
  return !automated;
}

let appVersion: string | null = null;
function version(): string {
  if (appVersion) return appVersion;
  try {
    appVersion = String(JSON.parse(String(readFileSync(join(ETUDE_ROOT, "package.json"), "utf8"))).version);
  } catch {
    appVersion = "0.0.0";
  }
  return appVersion;
}

export class Telemetry {
  readonly e: Etude;
  host: TelemetryHost | null = null;
  private q: Queue | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<unknown> | null = null;
  constructor(e: Etude) {
    this.e = e;
  }

  /** Sending is on for this process: the app started it, and the environment allows it. */
  get active(): boolean {
    return !!this.host && telemetryAllowed(process.env, !!this.host.automated);
  }
  private now() {
    return this.host?.now?.() ?? Date.now();
  }
  prefs(): Privacy {
    const p = (this.e.settings() as { privacy?: Partial<Privacy> }).privacy ?? {};
    return { errorReports: p.errorReports ?? DEFAULT_PRIVACY.errorReports, usageStats: p.usageStats ?? DEFAULT_PRIVACY.usageStats };
  }

  private get file() {
    return join(this.e.home, "telemetry-queue.json");
  }
  private load(): Queue {
    if (this.q) return this.q;
    let q: Queue = { errors: [], counters: {} };
    try {
      if (existsSync(this.file)) {
        const j = JSON.parse(String(readFileSync(this.file, "utf8")));
        q = { errors: Array.isArray(j.errors) ? j.errors : [], counters: j.counters && typeof j.counters === "object" ? j.counters : {}, openDay: typeof j.openDay === "string" ? j.openDay : undefined };
      }
    } catch {}
    return (this.q = q);
  }
  private save() {
    if (!this.q) return;
    try {
      mkdirSync(this.e.home, { recursive: true });
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.q));
      renameSync(tmp, this.file);
    } catch {}
  }

  /** Queues an error report (scrubbed here, before it is stored or sent). False when reports are off. */
  report(input: ReportInput): boolean {
    if (!this.active || !this.prefs().errorReports) return false;
    const kind = /^[a-z][a-z0-9_.-]{0,39}$/.test(input.kind) ? input.kind : "error";
    const message = cut(scrub(String(input.message ?? "")), 300);
    const stack = cut(scrub(String(input.stack ?? "")), 4096);
    const fp = fingerprint(kind, message, stack);
    const q = this.load();
    const v = version();
    const same = q.errors.find((x) => x.fingerprint === fp && x.version === v);
    if (same) same.count = Math.min(10_000, same.count + 1);
    else {
      q.errors.push({ kind, message, stack, fingerprint: fp, count: 1, version: v, platform: this.host!.platform, os: this.host!.os, at: this.now() });
      if (q.errors.length > MAX_ERRORS) q.errors.splice(0, q.errors.length - MAX_ERRORS);
    }
    this.save();
    this.kick();
    return true;
  }

  /** Adds to today's counter for an allowlisted event. False when usage stats are off or the name isn't allowed. */
  count(name: string, n = 1): boolean {
    if (!this.active || !this.prefs().usageStats || !isEventName(name)) return false;
    const q = this.load();
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (name === "app.open") {
      if (q.openDay === day) return true;
      q.openDay = day;
      n = 1;
    }
    const key = `${day}|${name}|${version()}|${this.host!.platform}`;
    q.counters[key] = Math.min(10_000, (q.counters[key] ?? 0) + Math.max(1, Math.floor(n)));
    this.save();
    this.kick();
    return true;
  }

  /** After the Privacy toggles change: drops what is queued for anything now off, at once. */
  applyPrefs() {
    const p = this.prefs();
    const q = this.load();
    let changed = false;
    if (!p.errorReports && q.errors.length) (q.errors = []), (changed = true);
    if (!p.usageStats && Object.keys(q.counters).length) (q.counters = {}), (changed = true);
    if (changed) this.save();
  }

  /** What is waiting to be sent (Settings can show it; tests read it). */
  pending(): { errors: number; counters: number } {
    const q = this.load();
    return { errors: q.errors.length, counters: Object.keys(q.counters).length };
  }

  /** Sends soon (15 s) if nothing is scheduled yet. */
  kick() {
    if (!this.timer && this.host) this.schedule(FIRST_FLUSH_MS);
  }
  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().finally(() => this.host && this.schedule(FLUSH_EVERY_MS));
    }, ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.host = null;
  }

  /** Sends what is queued. Kept on network errors, 429 and 5xx; dropped once sent or refused (4xx). */
  async flush(): Promise<{ sentErrors: number; sentCounters: number }> {
    if (this.sending) await this.sending.catch(() => {});
    const run = this.flushNow();
    this.sending = run;
    try {
      return await run;
    } finally {
      this.sending = null;
    }
  }

  private async flushNow(): Promise<{ sentErrors: number; sentCounters: number }> {
    const out = { sentErrors: 0, sentCounters: 0 };
    const q = this.load();
    const now = this.now();
    // Older than 7 days: dropped unsent.
    const oldestDay = new Date(now - KEEP_MS).toISOString().slice(0, 10);
    const before = JSON.stringify(q);
    q.errors = q.errors.filter((x) => now - x.at < KEEP_MS);
    for (const k of Object.keys(q.counters)) if (k.slice(0, 10) < oldestDay) delete q.counters[k];
    this.applyPrefs();
    if (JSON.stringify(q) !== before) this.save();
    if (!this.active) return out;
    const p = this.prefs();
    const fetchImpl: FetchLike = this.host!.fetch ?? ((url, init) => fetch(url, init));
    const base = (this.host!.server ?? process.env.ETUDE_TELEMETRY_URL ?? TELEMETRY_SERVER).replace(/\/+$/, "");
    const post = async (path: string, body: unknown): Promise<"done" | "retry"> => {
      try {
        const r = await fetchImpl(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
        return r.status === 429 || r.status >= 500 ? "retry" : "done";
      } catch {
        return "retry";
      }
    };
    if (p.errorReports && q.errors.length) {
      const groups = new Map<string, QueuedError[]>();
      for (const x of q.errors) {
        const k = `${x.version}|${x.platform}|${x.os}`;
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(x);
      }
      for (const list of groups.values()) {
        for (let i = 0; i < list.length; i += 20) {
          const chunk = list.slice(i, i + 20);
          const r = await post("/v1/telemetry/errors", { version: chunk[0].version, platform: chunk[0].platform, os: chunk[0].os, errors: chunk.map(({ kind, message, stack, fingerprint, count }) => ({ kind, message, stack, fingerprint, count })) });
          if (r === "retry") break;
          // A toggle may have changed while this was in flight; only remove what was sent.
          const sent = new Set(chunk);
          this.load().errors = this.load().errors.filter((x) => !sent.has(x));
          out.sentErrors += chunk.length;
          this.save();
        }
      }
    }
    if (this.prefs().usageStats && Object.keys(q.counters).length) {
      const groups = new Map<string, { day: string; name: string; count: number; key: string }[]>();
      for (const [key, count] of Object.entries(q.counters)) {
        const [day, name, v, platform] = key.split("|");
        const g = `${v}|${platform}`;
        (groups.get(g) ?? groups.set(g, []).get(g)!).push({ day, name, count, key });
      }
      for (const [g, list] of groups) {
        const [v, platform] = g.split("|");
        for (let i = 0; i < list.length; i += 100) {
          const chunk = list.slice(i, i + 100);
          const r = await post("/v1/telemetry/events", { version: v, platform, counters: chunk.map(({ day, name, count }) => ({ day, name, count })) });
          if (r === "retry") break;
          const cur = this.load().counters;
          for (const c of chunk) {
            // Counted again while sending: keep the difference for the next batch.
            const left = (cur[c.key] ?? 0) - c.count;
            if (left > 0) cur[c.key] = left;
            else delete cur[c.key];
          }
          out.sentCounters += chunk.length;
          this.save();
        }
      }
    }
    return out;
  }
}

const instances = new WeakMap<Etude, Telemetry>();
export function telemetryFor(e: Etude): Telemetry {
  let t = instances.get(e);
  if (!t) instances.set(e, (t = new Telemetry(e)));
  return t;
}

/** Turns sending on for this process (the desktop app's engine, the browser and phone apps). */
export function startTelemetry(e: Etude, host: Partial<TelemetryHost> = {}): Telemetry {
  const t = telemetryFor(e);
  t.host = { platform: host.platform ?? nodePlatform(), os: host.os ?? nodeOs(), ...host } as TelemetryHost;
  if (t.active) {
    const p = t.pending();
    if (p.errors || p.counters) t.kick();
  }
  return t;
}

/** A short OS name from a user agent ("iOS 26.1", "Android 16", "macOS", "Windows", "Linux"), for the web and phone apps. */
export function osFromUserAgent(ua: string): string {
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)[_.](\d+)/.exec(ua);
  if (ios) return `iOS ${ios[1]}.${ios[2]}`;
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua);
  if (android) return `Android ${android[1]}`;
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "";
}
