// Activity (Settings → Privacy → Activity): how long you spend in each page, file, chat and screen, and how much you
// type there, kept so Stats can show it. Off unless the person turns it on. What keeps it safe:
//   - It stays in this collection on this device: the table `activity_log` and the settings row "activity". Sync
//     carries only the tables in sync/log.ts TABLES and only the settings row "settings", so other devices, shared
//     folders and the Sync server never see it, and telemetry.ts never reads it.
//   - Counts only: milliseconds, characters typed, pasted and deleted, and words started, per hour and per note id
//     (or screen name). Never the text, the keys pressed, what was pasted, or titles (those are looked up when shown).
//   - Only the person turns it on, changes how long it's kept or deletes it: agent-guard.ts refuses those commands to
//     Ask and `etude mcp`, and the HTTP routes refuse to record while it's off.
//   - It's kept `keepDays` days (365 unless changed, 0 = forever); older hours go on every write and read. Turning it
//     off stops recording at once; Delete (or `off --delete`) removes every row.
// The window's side (what counts as active, idle, typing) is web/src/lib/activity.ts.
import { EtudeError, type Etude } from "./engine.ts";
import { isFsId } from "./folders.ts";

export const ACTIVITY_KINDS = ["page", "file", "pdf", "canvas", "kanban", "web", "chat", "screen"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
/** The app's screens by their first path segment; anything else counts as "other". */
export const ACTIVITY_SCREENS = ["decks", "deck", "study", "browse", "stats", "market", "settings", "notes", "types", "watch", "archive", "more", "other"] as const;

export interface ActivityPrefs {
  on: boolean;
  /** Days of activity kept; 0 keeps everything. */
  keepDays: number;
}
export const DEFAULT_ACTIVITY: ActivityPrefs = { on: false, keepDays: 365 };
export const KEEP_CHOICES = [30, 90, 365, 0];

export interface ActivityEntry {
  kind: ActivityKind;
  ref: string;
  /** Start of the hour (ms since epoch, a multiple of 3,600,000). */
  hour: number;
  ms: number;
  typed: number;
  pasted: number;
  deleted: number;
  words: number;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** One request carries at most this many entries; the window sends a minute's worth, a handful. */
const MAX_ENTRIES = 200;
/** No count in one entry goes past this (a whole book pasted at once still fits). */
const MAX_COUNT = 1_000_000;
const MAX_REF = 1024;
/** Entries for hours further back than this are refused: the window sends within a minute, or at the next start. */
const MAX_AGE = 3 * DAY;

const SCHEMA = `CREATE TABLE IF NOT EXISTS activity_log (
  hour INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
  ms INTEGER NOT NULL DEFAULT 0, typed INTEGER NOT NULL DEFAULT 0, pasted INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0, words INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, kind, ref)
) WITHOUT ROWID`;

const isKind = (k: unknown): k is ActivityKind => typeof k === "string" && (ACTIVITY_KINDS as readonly string[]).includes(k);
const count = (v: unknown, max = MAX_COUNT) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0) throw new EtudeError("activity counts must be numbers of 0 or more");
  return Math.min(max, Math.round(n));
};

/** Whether `ref` is the kind of name `kind` has: a screen from the list, an fs: id, or a plain id. */
function refOk(kind: ActivityKind, ref: unknown): ref is string {
  if (typeof ref !== "string" || !ref || ref.length > MAX_REF || /[\u0000-\u001f]/.test(ref)) return false;
  if (kind === "screen") return (ACTIVITY_SCREENS as readonly string[]).includes(ref);
  if (kind === "chat") return /^[\w.:-]{1,200}$/.test(ref);
  return isFsId(ref) || /^[\w.:-]{1,200}$/.test(ref);
}

export class Activity {
  private ready = false;
  private readonly e: Etude;
  constructor(e: Etude) {
    this.e = e;
  }

  private get db() {
    if (!this.ready) {
      this.e.db.sql.exec(SCHEMA);
      this.ready = true;
    }
    return this.e.db;
  }

  prefs(): ActivityPrefs {
    const p = this.e.db.setting<Partial<ActivityPrefs>>("activity", {});
    return { on: p.on === true, keepDays: KEEP_CHOICES.includes(Number(p.keepDays)) ? Number(p.keepDays) : DEFAULT_ACTIVITY.keepDays };
  }

  /** Turn recording on or off, or change how long it's kept. `deleteAll` with `on: false` removes what was recorded. */
  setPrefs(patch: Partial<ActivityPrefs> & { deleteAll?: boolean }): ActivityPrefs {
    const cur = this.prefs();
    const next = { ...cur };
    if (patch.on !== undefined) {
      if (typeof patch.on !== "boolean") throw new EtudeError("on must be true or false");
      next.on = patch.on;
    }
    if (patch.keepDays !== undefined) {
      const k = Number(patch.keepDays);
      if (!KEEP_CHOICES.includes(k)) throw new EtudeError(`keepDays must be one of ${KEEP_CHOICES.join(", ")} (0 keeps everything)`);
      next.keepDays = k;
    }
    this.e.db.setSetting("activity", next);
    if (!next.on && patch.deleteAll) this.clear();
    else this.prune(next);
    return next;
  }

  /** Adds a window's counts. Refused while recording is off, so nothing reaches the table without the person's OK. */
  record(input: unknown, at = Date.now()): { on: boolean; recorded: number } {
    const p = this.prefs();
    if (!p.on) return { on: false, recorded: 0 };
    const list = (input as { entries?: unknown })?.entries;
    if (!Array.isArray(list)) throw new EtudeError("entries must be a list");
    if (list.length > MAX_ENTRIES) throw new EtudeError(`at most ${MAX_ENTRIES} entries at a time`);
    const rows: ActivityEntry[] = list.map((raw: any) => {
      if (!raw || typeof raw !== "object") throw new EtudeError("each entry must be an object");
      if (!isKind(raw.kind)) throw new EtudeError(`kind must be one of ${ACTIVITY_KINDS.join(", ")}`);
      if (!refOk(raw.kind, raw.ref)) throw new EtudeError(`ref isn't a ${raw.kind === "screen" ? "known screen" : "note or chat id"}`);
      const hour = Number(raw.hour);
      if (!Number.isInteger(hour) || hour % HOUR !== 0) throw new EtudeError("hour must be the start of an hour, in ms");
      if (hour > at + HOUR || hour < at - MAX_AGE) throw new EtudeError("hour is too far from now");
      return { kind: raw.kind, ref: raw.ref, hour, ms: count(raw.ms, HOUR), typed: count(raw.typed), pasted: count(raw.pasted), deleted: count(raw.deleted), words: count(raw.words) };
    });
    const db = this.db;
    db.tx(() => {
      for (const r of rows) {
        if (!r.ms && !r.typed && !r.pasted && !r.deleted && !r.words) continue;
        db.run(
          `INSERT INTO activity_log (hour, kind, ref, ms, typed, pasted, deleted, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (hour, kind, ref) DO UPDATE SET ms = min(${HOUR}, ms + excluded.ms), typed = typed + excluded.typed,
               pasted = pasted + excluded.pasted, deleted = deleted + excluded.deleted, words = words + excluded.words`,
          r.hour, r.kind, r.ref, r.ms, r.typed, r.pasted, r.deleted, r.words,
        );
      }
    });
    this.prune(p, at);
    return { on: true, recorded: rows.length };
  }

  /** Drops hours older than what's kept. */
  prune(p = this.prefs(), at = Date.now()) {
    if (!p.keepDays) return 0;
    return this.db.run("DELETE FROM activity_log WHERE hour < ?", at - p.keepDays * DAY).changes;
  }

  /** Deletes every recorded hour. */
  clear(): { deleted: number } {
    return { deleted: Number(this.db.run("DELETE FROM activity_log").changes) };
  }

  status() {
    const p = this.prefs();
    this.prune(p);
    const r = this.db.get("SELECT COUNT(*) AS n, MIN(hour) AS first FROM activity_log");
    return { ...p, rows: Number(r?.n ?? 0), since: r?.first ? new Date(Number(r.first)).toISOString() : null };
  }

  /**
   * What Stats shows: per day (study days, starting at Settings' dayStartHour), per kind, per hour of day, and the
   * pages, files and chats you spent the most time in. Titles are looked up now; `chatTitle` names Ask chats.
   */
  summary(days = 30, opts: { chatTitle?(id: string): string | null; at?: Date; top?: number } = {}) {
    const at = opts.at ?? new Date();
    days = Math.max(1, Math.min(366, Math.round(Number(days) || 30)));
    const p = this.prefs();
    this.prune(p, at.getTime());
    const dayHour = this.e.settings().dayStartHour;
    const today = this.e.dayStart(at, dayHour);
    const start = new Date(today);
    start.setDate(start.getDate() - (days - 1));
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayList: { day: string; ms: number; typed: number; words: number; pasted: number }[] = [];
    const byDay = new Map<string, (typeof dayList)[number]>();
    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const row = { day: key(d), ms: 0, typed: 0, words: 0, pasted: 0 };
      dayList.push(row);
      byDay.set(row.day, row);
    }
    const rows = this.db.all("SELECT hour, kind, ref, ms, typed, pasted, deleted, words FROM activity_log WHERE hour >= ? ORDER BY hour", start.getTime() - HOUR);
    const totals = { ms: 0, typed: 0, pasted: 0, deleted: 0, words: 0 };
    const kinds = new Map<string, { kind: string; ms: number; typed: number; words: number }>();
    const screens = new Map<string, number>();
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, ms: 0, typed: 0 }));
    const things = new Map<string, { kind: ActivityKind; ref: string; ms: number; typed: number; words: number; pasted: number; last: number }>();
    const dayCache = new Map<number, string>();
    for (const r of rows) {
      const hour = Number(r.hour);
      // An hour that starts before the day boundary (dayStartHour isn't always on the hour's edge) goes to its start's day.
      let dk = dayCache.get(hour);
      if (!dk) dayCache.set(hour, (dk = key(this.e.dayStart(new Date(hour), dayHour))));
      const day = byDay.get(dk);
      if (!day) continue;
      const ms = Number(r.ms), typed = Number(r.typed), pasted = Number(r.pasted), deleted = Number(r.deleted), words = Number(r.words);
      day.ms += ms;
      day.typed += typed;
      day.words += words;
      day.pasted += pasted;
      totals.ms += ms;
      totals.typed += typed;
      totals.pasted += pasted;
      totals.deleted += deleted;
      totals.words += words;
      const k = kinds.get(r.kind) ?? { kind: r.kind, ms: 0, typed: 0, words: 0 };
      k.ms += ms;
      k.typed += typed;
      k.words += words;
      kinds.set(r.kind, k);
      const hh = hours[new Date(hour).getHours()];
      hh.ms += ms;
      hh.typed += typed;
      if (r.kind === "screen") {
        screens.set(r.ref, (screens.get(r.ref) ?? 0) + ms);
        continue;
      }
      const id = `${r.kind}\u0000${r.ref}`;
      const t = things.get(id) ?? { kind: r.kind, ref: r.ref, ms: 0, typed: 0, words: 0, pasted: 0, last: 0 };
      t.ms += ms;
      t.typed += typed;
      t.words += words;
      t.pasted += pasted;
      t.last = Math.max(t.last, hour);
      things.set(id, t);
    }
    const ranked = [...things.values()].sort((a, b) => b.ms - a.ms || b.typed - a.typed).slice(0, opts.top ?? 25);
    const titles = this.titles(ranked, opts.chatTitle);
    return {
      on: p.on,
      keepDays: p.keepDays,
      days: dayList,
      today: key(today),
      totals,
      kinds: [...kinds.values()].sort((a, b) => b.ms - a.ms),
      screens: [...screens.entries()].map(([screen, ms]) => ({ screen, ms })).sort((a, b) => b.ms - a.ms),
      hours,
      top: ranked.map((t) => ({ kind: t.kind, ref: t.ref, ms: t.ms, typed: t.typed, words: t.words, pasted: t.pasted, last: new Date(t.last).toISOString(), ...titles.get(`${t.kind}\u0000${t.ref}`)! })),
    };
  }

  /** Each thing's title and where it is now; `missing` when it was deleted or moved since. */
  private titles(list: { kind: ActivityKind; ref: string }[], chatTitle?: (id: string) => string | null) {
    const out = new Map<string, { title: string; path?: string; missing?: boolean }>();
    let notes: Map<string, { title: string; archived: boolean }> | null = null;
    for (const t of list) {
      const id = `${t.kind}\u0000${t.ref}`;
      if (t.kind === "chat") {
        let title: string | null = null;
        try { title = chatTitle?.(t.ref) ?? null; } catch { title = null; }
        out.set(id, title === null ? { title: "Ask chat", missing: true } : { title: title || "Ask chat" });
        continue;
      }
      if (isFsId(t.ref)) {
        const rel = t.ref.slice(t.ref.indexOf("/") + 1);
        const name = rel.split("/").pop() || rel;
        try {
          const s = this.e.folders.summary(t.ref) as { title?: string };
          out.set(id, { title: s.title || name, path: rel });
        } catch {
          out.set(id, { title: name, path: rel, missing: true });
        }
        continue;
      }
      if (!notes) {
        notes = new Map();
        for (const archived of [false, true]) for (const n of this.e.notes.list({ archived })) notes.set(n.id, { title: n.title, archived });
      }
      const n = notes.get(t.ref);
      out.set(id, n ? { title: n.title || "Untitled", ...(n.archived ? { missing: true } : {}) } : { title: "Deleted page", missing: true });
    }
    return out;
  }
}

const instances = new WeakMap<Etude, Activity>();
export function activityFor(e: Etude): Activity {
  let a = instances.get(e);
  if (!a) instances.set(e, (a = new Activity(e)));
  return a;
}
