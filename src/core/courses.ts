// Etude courses: self-contained interactive courses (plain HTML/CSS/JS or built with Etude Course Kit)
// stored per collection, served inside a sandboxed iframe with live Etude theme variables and
// collection-backed progress persistence.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { EtudeError, type Etude } from "./engine.ts";
import type { Db } from "./db.ts";

export const COURSE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const MAX_COURSE_BYTES = 16 * 1024 * 1024;
export const MAX_PROGRESS_BYTES = 512 * 1024;

export interface CourseLessonOutline {
  id: string;
  title: string;
  unit?: string;
  minutes?: number;
}

export interface CourseManifest {
  etude: "course/1";
  id: string;
  name: string;
  subtitle?: string;
  description?: string;
  author?: string;
  version: string;
  icon?: string;
  language?: string;
  tags?: string[];
  units?: string[];
  lessons?: CourseLessonOutline[];
  kit?: string;
}

export interface CoursePackage {
  manifest: CourseManifest;
  /** Self-contained HTML document (plain HTML or built by Course Kit). */
  html: string;
}

export interface CourseProgress {
  state: Record<string, unknown>;
  doneCount: number;
  totalCount: number;
  minsLeft: number | null;
  currentId: string | null;
  currentTitle: string | null;
  updatedAt: string | null;
}

export interface InstalledCourse {
  id: string;
  manifest: CourseManifest;
  hash: string;
  source: "local" | "market";
  installedAt: string;
  updatedAt: string;
  lastOpened: string | null;
  bytes: number;
  progress: CourseProgress;
}

const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/** Deterministic SHA-256 over manifest + HTML, for Market integrity & update checks. */
export function courseHash(pkg: CoursePackage): string {
  const h = createHash("sha256");
  const sortedManifest = JSON.stringify(pkg.manifest, Object.keys(pkg.manifest).sort());
  h.update("manifest\0");
  h.update(sortedManifest);
  h.update("\0html\0");
  h.update(pkg.html);
  return h.digest("hex");
}

/** Validates a course package shape, size, and metadata. Returns a list of errors (empty = valid). */
export function checkCourse(pkg: unknown): string[] {
  const errors: string[] = [];
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return ["course package must be an object { manifest, html }"];
  const { manifest: m, html } = pkg as { manifest?: any; html?: any };
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["manifest must be an object"];
  if (m.etude !== "course/1") errors.push('manifest.etude must be "course/1"');
  if (typeof m.id !== "string" || !COURSE_ID.test(m.id)) errors.push("manifest.id must be a lowercase slug (2-64 chars: a-z, 0-9, -)");
  if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 120) errors.push("manifest.name is required (1-120 chars)");
  if (typeof m.version !== "string" || !m.version.trim() || m.version.length > 32) errors.push("manifest.version is required (1-32 chars)");
  if (m.subtitle !== undefined && (typeof m.subtitle !== "string" || m.subtitle.length > 160)) errors.push("manifest.subtitle must be text (up to 160 chars)");
  if (m.description !== undefined && (typeof m.description !== "string" || m.description.length > 2000)) errors.push("manifest.description must be text (up to 2000 chars)");
  if (m.author !== undefined && (typeof m.author !== "string" || m.author.length > 80)) errors.push("manifest.author must be text (up to 80 chars)");
  if (m.icon !== undefined && (typeof m.icon !== "string" || m.icon.length > 16)) errors.push("manifest.icon must be short text/emoji");
  if (m.language !== undefined && (typeof m.language !== "string" || m.language.length > 16)) errors.push("manifest.language must be short text");
  if (m.tags !== undefined && (!Array.isArray(m.tags) || m.tags.length > 12 || m.tags.some((t: unknown) => typeof t !== "string" || t.length > 32))) {
    errors.push("manifest.tags must be up to 12 short strings");
  }
  if (m.units !== undefined && (!Array.isArray(m.units) || m.units.length > 64 || m.units.some((u: unknown) => typeof u !== "string" || u.length > 120))) {
    errors.push("manifest.units must be up to 64 short strings");
  }
  if (m.lessons !== undefined) {
    if (!Array.isArray(m.lessons) || m.lessons.length > 256) errors.push("manifest.lessons must be a list of up to 256 lessons");
    else {
      for (const l of m.lessons) {
        if (!l || typeof l !== "object" || typeof l.id !== "string" || !l.id.trim() || typeof l.title !== "string" || !l.title.trim()) {
          errors.push("each lesson in manifest.lessons needs non-empty id and title");
          break;
        }
      }
    }
  }
  if (typeof html !== "string" || !html.trim()) {
    errors.push("html must be a non-empty HTML string");
  } else if (Buffer.byteLength(html, "utf8") > MAX_COURSE_BYTES) {
    errors.push(`course HTML exceeds max size (${MAX_COURSE_BYTES / 1024 / 1024} MiB)`);
  }
  return errors;
}

/** Extracts Course Kit metadata embedded in a built HTML file (`window.COURSE = {...};`), if present. */
export function extractEmbeddedCourseMeta(html: string): Partial<CourseManifest> {
  const out: Partial<CourseManifest> = {};
  const gen = /<meta\s+name=["']generator["']\s+content=["']([^"']+)["']/i.exec(html);
  if (gen) out.kit = gen[1].trim();
  const titleMatch = /<title>([^<]+)<\/title>/i.exec(html);
  if (titleMatch) out.name = titleMatch[1].trim();
  const descMatch = /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i.exec(html);
  if (descMatch) out.description = descMatch[1].trim();

  // Look for Course Kit payload: `window.COURSE = { ... };\nwindow.COURSE_KIT_MINIMI`
  const marker = "window.COURSE = ";
  const start = html.indexOf(marker);
  if (start >= 0) {
    const jsonStart = start + marker.length;
    const endMarker = html.indexOf(";\nwindow.COURSE_KIT_MINIMI", jsonStart);
    const slice = endMarker > jsonStart ? html.slice(jsonStart, endMarker) : "";
    if (slice) {
      try {
        const parsed = JSON.parse(slice.replace(/<\\\/script/gi, "</script"));
        if (typeof parsed.id === "string" && COURSE_ID.test(slugify(parsed.id))) out.id = slugify(parsed.id);
        if (typeof parsed.title === "string" && parsed.title.trim()) out.name = parsed.title.replace(/<[^>]+>/g, "").trim();
        if (typeof parsed.subtitle === "string" && parsed.subtitle.trim()) out.subtitle = parsed.subtitle.trim();
        if (typeof parsed.summary === "string" && parsed.summary.trim()) out.description = parsed.summary.trim();
        if (typeof parsed.ui === "string" && parsed.ui.trim()) out.language = parsed.ui.trim();
        if (Array.isArray(parsed.units)) {
          const units: string[] = [];
          const lessons: CourseLessonOutline[] = [];
          for (const u of parsed.units) {
            const unitTitle = [u.label, u.title].filter(Boolean).join(" · ") || String(u.title ?? u.id ?? "");
            if (unitTitle) units.push(unitTitle);
            if (Array.isArray(u.lessons)) {
              for (const l of u.lessons) {
                if (typeof l?.id === "string" && typeof (l?.short || l?.title) === "string") {
                  lessons.push({
                    id: l.id,
                    title: String(l.short || l.title).replace(/<[^>]+>/g, "").trim(),
                    ...(unitTitle ? { unit: unitTitle } : {}),
                    ...(typeof l.minutes === "number" ? { minutes: l.minutes } : {}),
                  });
                }
              }
            }
          }
          if (units.length) out.units = units;
          if (lessons.length) out.lessons = lessons;
        }
      } catch {
        // Ignore unparseable script fragments; fall back to <title> and options.
      }
    }
  }
  return out;
}

/** Builds a valid CoursePackage from raw HTML plus optional overrides (used for plain HTML imports). */
export function packageFromHtml(
  html: string,
  opts: { id?: string; name?: string; subtitle?: string; description?: string; author?: string; version?: string; icon?: string; tags?: string[]; fallbackName?: string } = {},
): CoursePackage {
  const detected = extractEmbeddedCourseMeta(html);
  const name = (opts.name?.trim() || detected.name || opts.fallbackName || "Untitled course").slice(0, 120);
  const rawId = opts.id?.trim() || detected.id || slugify(name) || "course";
  const id = COURSE_ID.test(rawId) ? rawId : slugify(rawId).padEnd(2, "0");
  const manifest: CourseManifest = {
    etude: "course/1",
    id,
    name,
    version: opts.version?.trim() || "1.0.0",
    author: opts.author?.trim() || "You",
    ...(opts.subtitle?.trim() || detected.subtitle ? { subtitle: opts.subtitle?.trim() || detected.subtitle } : {}),
    ...(opts.description?.trim() || detected.description ? { description: opts.description?.trim() || detected.description } : {}),
    ...(opts.icon?.trim() ? { icon: opts.icon.trim() } : {}),
    ...(detected.language ? { language: detected.language } : {}),
    ...(opts.tags?.length ? { tags: opts.tags } : {}),
    ...(detected.units?.length ? { units: detected.units } : {}),
    ...(detected.lessons?.length ? { lessons: detected.lessons } : {}),
    ...(detected.kit ? { kit: detected.kit } : {}),
  };
  return { manifest, html };
}

/**
 * Loads a course package from a local folder (containing `course.json` + `index.html`, or any `index.html`),
 * a `.json` package / Market entry file, or a standalone `.html` file.
 */
export function loadCourseSource(
  source: string,
  overrides: { id?: string; name?: string; subtitle?: string; description?: string; author?: string; version?: string; icon?: string; tags?: string[] } = {},
): CoursePackage {
  const p = resolve(source);
  if (!existsSync(p)) throw new EtudeError(`no course folder or file at "${source}"`, 404);
  const st = statSync(p);
  if (st.isDirectory()) {
    const cfgPath = join(p, "course.json");
    let cfg: any = null;
    if (existsSync(cfgPath)) {
      try {
        cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      } catch (e) {
        throw new EtudeError(`course.json is invalid JSON: ${(e as Error).message}`, 400);
      }
    }
    const htmlName = typeof cfg?.output === "string" ? cfg.output : "index.html";
    const htmlPath = join(p, htmlName);
    if (!existsSync(htmlPath)) throw new EtudeError(`no ${htmlName} in ${source} (build it first, e.g. with course-kit build)`, 400);
    const html = readFileSync(htmlPath, "utf8");
    return packageFromHtml(html, {
      id: overrides.id ?? cfg?.id,
      name: overrides.name ?? (typeof cfg?.title === "string" ? cfg.title.replace(/<[^>]+>/g, "") : undefined),
      subtitle: overrides.subtitle ?? cfg?.subtitle,
      description: overrides.description ?? cfg?.summary ?? cfg?.description,
      author: overrides.author ?? cfg?.author,
      version: overrides.version ?? cfg?.version,
      icon: overrides.icon ?? cfg?.icon,
      tags: overrides.tags ?? cfg?.tags,
      fallbackName: basename(p),
    });
  }
  const ext = extname(p).toLowerCase();
  const raw = readFileSync(p, "utf8");
  if (ext === ".html" || ext === ".htm") {
    return packageFromHtml(raw, { ...overrides, fallbackName: basename(p, ext) });
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new EtudeError(`course file isn't valid JSON or HTML: ${(e as Error).message}`, 400);
  }
  const pkg: CoursePackage = parsed?.etudeMarket === 1 && parsed?.kind === "course" && parsed?.content ? parsed.content : parsed;
  if (pkg?.manifest && typeof pkg.html === "string") {
    const merged: CourseManifest = {
      ...pkg.manifest,
      ...(overrides.id ? { id: overrides.id } : {}),
      ...(overrides.name ? { name: overrides.name } : {}),
      ...(overrides.subtitle ? { subtitle: overrides.subtitle } : {}),
      ...(overrides.description ? { description: overrides.description } : {}),
      ...(overrides.author ? { author: overrides.author } : {}),
      ...(overrides.version ? { version: overrides.version } : {}),
      ...(overrides.icon ? { icon: overrides.icon } : {}),
      ...(overrides.tags ? { tags: overrides.tags } : {}),
    };
    return { manifest: merged, html: pkg.html };
  }
  throw new EtudeError("unrecognized course file format (expected .html, course/1 JSON, or Market course entry)", 400);
}

// ------------------------------------------------------------------ database store

export function ensureCourseSchema(db: Db) {
  db.sql.exec(`
CREATE TABLE IF NOT EXISTS courses (
  id           TEXT PRIMARY KEY,
  manifest     TEXT NOT NULL,
  html         TEXT NOT NULL,
  hash         TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'local',
  installed_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_opened  TEXT
);
CREATE TABLE IF NOT EXISTS course_progress (
  course_id     TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT '{}',
  done_count    INTEGER NOT NULL DEFAULT 0,
  total_count   INTEGER NOT NULL DEFAULT 0,
  mins_left     INTEGER,
  current_id    TEXT,
  current_title TEXT,
  updated_at    TEXT NOT NULL
);
`);
}

export class CourseStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
    ensureCourseSchema(db);
  }

  private toView(row: any, prog?: any): InstalledCourse {
    const manifest = JSON.parse(row.manifest) as CourseManifest;
    const totalFallback = manifest.lessons?.length ?? 0;
    const progress: CourseProgress = prog
      ? {
          state: JSON.parse(prog.state || "{}"),
          doneCount: Number(prog.done_count ?? 0),
          totalCount: Number(prog.total_count || totalFallback),
          minsLeft: prog.mins_left === null || prog.mins_left === undefined ? null : Number(prog.mins_left),
          currentId: prog.current_id ?? null,
          currentTitle: prog.current_title ?? null,
          updatedAt: prog.updated_at ?? null,
        }
      : {
          state: {},
          doneCount: 0,
          totalCount: totalFallback,
          minsLeft: null,
          currentId: manifest.lessons?.[0]?.id ?? null,
          currentTitle: manifest.lessons?.[0]?.title ?? null,
          updatedAt: null,
        };
    return {
      id: row.id,
      manifest,
      hash: row.hash,
      source: row.source === "market" ? "market" : "local",
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
      lastOpened: row.last_opened ?? null,
      bytes: Number(row.bytes ?? 0),
      progress,
    };
  }

  list(): InstalledCourse[] {
    const rows = this.db.all(
      `SELECT c.id, c.manifest, c.hash, c.source, c.installed_at, c.updated_at, c.last_opened, length(CAST(c.html AS BLOB)) AS bytes,
              p.state, p.done_count, p.total_count, p.mins_left, p.current_id, p.current_title, p.updated_at AS p_updated_at
       FROM courses c LEFT JOIN course_progress p ON p.course_id = c.id
       ORDER BY COALESCE(c.last_opened, c.updated_at) DESC, c.id ASC`,
    );
    return rows.map((r) =>
      this.toView(
        r,
        r.p_updated_at
          ? {
              state: r.state,
              done_count: r.done_count,
              total_count: r.total_count,
              mins_left: r.mins_left,
              current_id: r.current_id,
              current_title: r.current_title,
              updated_at: r.p_updated_at,
            }
          : undefined,
      ),
    );
  }

  get(id: string): InstalledCourse | null {
    const row = this.db.get(
      "SELECT id, manifest, hash, source, installed_at, updated_at, last_opened, length(CAST(html AS BLOB)) AS bytes FROM courses WHERE id = ?",
      id,
    );
    if (!row) return null;
    const prog = this.db.get("SELECT * FROM course_progress WHERE course_id = ?", id);
    return this.toView(row, prog);
  }

  packageOf(id: string): (CoursePackage & { hash: string }) | null {
    const row = this.db.get("SELECT manifest, html, hash FROM courses WHERE id = ?", id);
    if (!row) return null;
    return { manifest: JSON.parse(row.manifest), html: row.html, hash: row.hash };
  }

  install(
    pkg: CoursePackage,
    opts: { source?: "local" | "market"; expectedHash?: string } = {},
  ): { course: InstalledCourse; status: "installed" | "updated" | "unchanged" } {
    const errors = checkCourse(pkg);
    if (errors.length) throw new EtudeError(`invalid course: ${errors.join("; ")}`, 400);
    const hash = courseHash(pkg);
    if (opts.expectedHash && opts.expectedHash !== hash) {
      throw new EtudeError(`course "${pkg.manifest.id}" hash mismatch: expected ${opts.expectedHash.slice(0, 12)}, got ${hash.slice(0, 12)}`, 400);
    }
    const existing = this.db.get("SELECT id, hash, source FROM courses WHERE id = ?", pkg.manifest.id);
    const now = new Date().toISOString();
    if (!existing) {
      this.db.run(
        "INSERT INTO courses (id, manifest, html, hash, source, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        pkg.manifest.id,
        JSON.stringify(pkg.manifest),
        pkg.html,
        hash,
        opts.source ?? "local",
        now,
        now,
      );
      return { course: this.get(pkg.manifest.id)!, status: "installed" };
    }
    if (existing.hash === hash) {
      return { course: this.get(pkg.manifest.id)!, status: "unchanged" };
    }
    this.db.run(
      "UPDATE courses SET manifest = ?, html = ?, hash = ?, source = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(pkg.manifest),
      pkg.html,
      hash,
      opts.source ?? existing.source,
      now,
      pkg.manifest.id,
    );
    return { course: this.get(pkg.manifest.id)!, status: "updated" };
  }

  touchOpened(id: string): void {
    this.db.run("UPDATE courses SET last_opened = ? WHERE id = ?", new Date().toISOString(), id);
  }

  getProgress(id: string): CourseProgress {
    const c = this.get(id);
    if (!c) throw new EtudeError(`unknown course "${id}"`, 404);
    return c.progress;
  }

  saveProgress(
    id: string,
    input: {
      state?: Record<string, unknown>;
      doneCount?: number;
      totalCount?: number;
      minsLeft?: number | null;
      currentId?: string | null;
      currentTitle?: string | null;
    },
  ): CourseProgress {
    const c = this.get(id);
    if (!c) throw new EtudeError(`unknown course "${id}"`, 404);
    const state = input.state && typeof input.state === "object" && !Array.isArray(input.state) ? input.state : c.progress.state;
    const rawState = JSON.stringify(state);
    if (Buffer.byteLength(rawState, "utf8") > MAX_PROGRESS_BYTES) throw new EtudeError("course progress state too large", 400);
    const doneCount = typeof input.doneCount === "number" && Number.isFinite(input.doneCount) ? Math.max(0, Math.floor(input.doneCount)) : c.progress.doneCount;
    const totalCount = typeof input.totalCount === "number" && Number.isFinite(input.totalCount) ? Math.max(0, Math.floor(input.totalCount)) : c.progress.totalCount;
    const minsLeft = input.minsLeft === null ? null : typeof input.minsLeft === "number" && Number.isFinite(input.minsLeft) ? Math.max(0, Math.round(input.minsLeft)) : c.progress.minsLeft;
    const currentId = input.currentId === undefined ? c.progress.currentId : input.currentId ? String(input.currentId).slice(0, 120) : null;
    const currentTitle = input.currentTitle === undefined ? c.progress.currentTitle : input.currentTitle ? String(input.currentTitle).slice(0, 200) : null;
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO course_progress (course_id, state, done_count, total_count, mins_left, current_id, current_title, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(course_id) DO UPDATE SET
         state = excluded.state,
         done_count = excluded.done_count,
         total_count = excluded.total_count,
         mins_left = excluded.mins_left,
         current_id = excluded.current_id,
         current_title = excluded.current_title,
         updated_at = excluded.updated_at`,
      id,
      rawState,
      doneCount,
      totalCount,
      minsLeft,
      currentId,
      currentTitle,
      now,
    );
    this.db.run("UPDATE courses SET last_opened = ? WHERE id = ?", now, id);
    return this.getProgress(id);
  }

  resetProgress(id: string): { reset: string } {
    if (!this.get(id)) throw new EtudeError(`unknown course "${id}"`, 404);
    this.db.run("DELETE FROM course_progress WHERE course_id = ?", id);
    return { reset: id };
  }

  remove(id: string): { removed: string } {
    const res = this.db.run("DELETE FROM courses WHERE id = ?", id);
    if (!res.changes) throw new EtudeError(`unknown course "${id}"`, 404);
    return { removed: id };
  }
}

const stores = new WeakMap<Etude, CourseStore>();
export function coursesFor(e: Etude): CourseStore {
  let s = stores.get(e);
  if (!s) {
    s = new CourseStore(e.db);
    stores.set(e, s);
  }
  return s;
}
