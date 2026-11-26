// Course player screen (`/course?id=<id>`): hosts an installed course inside a sandboxed iframe,
// pushes the active Etude theme (variables + color scheme) live without reloading, and persists
// course progress back to the collection's SQLite database.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type CourseProgressInfo, type InstalledCourseInfo } from "@/lib/api";
import { navigate } from "@/lib/router";
import { pageScheme, THEME_EVENT } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { download } from "@/components/type-editor/starter";
import { courseProgressLabel } from "@/components/library-courses";

const COURSE_THEME_VARS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--muted",
  "--muted-foreground",
  "--secondary",
  "--secondary-foreground",
  "--border",
  "--input",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--success",
  "--warning",
  "--danger",
  "--highlight",
  "--radius",
  "--font-sans",
  "--font-mono",
];

function collectThemeVars(): { vars: Record<string, string>; colorScheme: "dark" | "light" } {
  const cs = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const k of COURSE_THEME_VARS) {
    const v = cs.getPropertyValue(k).trim();
    if (v) vars[k] = v;
  }
  const hl = cs.getPropertyValue("--card-highlight").trim();
  if (hl) vars["--highlight"] = hl;
  return { vars, colorScheme: pageScheme() };
}

export function CoursePage({ id }: { id: string }) {
  const [course, setCourse] = useState<InstalledCourseInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const courseRef = useRef<InstalledCourseInfo | null>(null);
  courseRef.current = course;
  const saveTimer = useRef<number | null>(null);
  const pendingSave = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!id) {
      setError("No course selected.");
      return;
    }
    let live = true;
    setError(null);
    api
      .course(id)
      .then((c) => live && setCourse(c))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [id]);

  const pushTheme = useCallback(() => {
    const win = frameRef.current?.contentWindow;
    if (!win || !id) return;
    const { vars, colorScheme } = collectThemeVars();
    win.postMessage({ etudeCourse: id, kind: "theme", vars, colorScheme }, "*");
  }, [id]);

  const pushState = useCallback(
    (state: Record<string, unknown>) => {
      const win = frameRef.current?.contentWindow;
      if (!win || !id) return;
      win.postMessage({ etudeCourse: id, kind: "state", state }, "*");
    },
    [id],
  );

  useEffect(() => {
    window.addEventListener(THEME_EVENT, pushTheme);
    return () => window.removeEventListener(THEME_EVENT, pushTheme);
  }, [pushTheme]);

  const flushSave = useCallback(() => {
    if (!pendingSave.current || !id) return;
    const payload = pendingSave.current;
    pendingSave.current = null;
    void api
      .saveCourseProgress(id, payload as Parameters<typeof api.saveCourseProgress>[1])
      .then((prog: CourseProgressInfo) => {
        setCourse((cur) => (cur ? { ...cur, progress: prog } : cur));
      })
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== frameRef.current?.contentWindow) return;
      const d = ev.data;
      if (!d || d.etudeCourse !== id) return;
      if (d.kind === "ready") {
        pushTheme();
        const saved = courseRef.current?.progress.state;
        if (saved && Object.keys(saved).length > 0) pushState(saved);
        return;
      }
      if (d.kind === "save" || d.kind === "progress") {
        const s = d.summary && typeof d.summary === "object" ? d.summary : {};
        const next: Record<string, unknown> = {
          ...(d.kind === "save" && d.state && typeof d.state === "object" ? { state: d.state } : {}),
          ...(typeof s.doneCount === "number" ? { doneCount: s.doneCount } : {}),
          ...(typeof s.totalCount === "number" ? { totalCount: s.totalCount } : {}),
          ...(typeof s.minsLeft === "number" || s.minsLeft === null ? { minsLeft: s.minsLeft } : {}),
          ...(typeof s.currentId === "string" || s.currentId === null ? { currentId: s.currentId } : {}),
          ...(typeof s.currentTitle === "string" || s.currentTitle === null ? { currentTitle: s.currentTitle } : {}),
        };
        // Update visible header immediately, debounce the DB write.
        setCourse((cur) =>
          cur
            ? {
                ...cur,
                progress: {
                  ...cur.progress,
                  ...(next.state ? { state: next.state as Record<string, unknown> } : {}),
                  ...(typeof next.doneCount === "number" ? { doneCount: next.doneCount } : {}),
                  ...(typeof next.totalCount === "number" ? { totalCount: next.totalCount } : {}),
                  ...(next.minsLeft !== undefined ? { minsLeft: next.minsLeft as number | null } : {}),
                  ...(next.currentId !== undefined ? { currentId: next.currentId as string | null } : {}),
                  ...(next.currentTitle !== undefined ? { currentTitle: next.currentTitle as string | null } : {}),
                },
              }
            : cur,
        );
        pendingSave.current = { ...(pendingSave.current ?? {}), ...next };
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = null;
          flushSave();
        }, 350);
      }
    };
    window.addEventListener("message", onMsg);
    return () => {
      window.removeEventListener("message", onMsg);
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      flushSave();
    };
  }, [id, pushTheme, pushState, flushSave]);

  const resetProgress = async () => {
    if (!course) return;
    setBusy(true);
    try {
      await api.resetCourseProgress(course.id);
      const fresh = await api.course(course.id);
      setCourse(fresh);
      setRun((r) => r + 1);
      toast.success("Progress reset");
    } catch (e) {
      toast.error("Couldn't reset progress", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const exportPkg = async () => {
    if (!course) return;
    try {
      const pkg = await api.exportCourse(course.id);
      download(`${course.id}.course.json`, pkg);
    } catch (e) {
      toast.error("Export failed", { description: (e as Error).message });
    }
  };

  const removeCourse = async () => {
    if (!course) return;
    setBusy(true);
    try {
      await api.removeCourse(course.id);
      toast.success(`Removed ${course.manifest.name}`);
      navigate("/");
    } catch (e) {
      toast.error("Couldn't remove course", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-start gap-4 px-6 py-16">
        <h1 className="lib-title text-2xl font-semibold">Course not available</h1>
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" onClick={() => navigate("/")}>
          <ArrowLeft className="mr-1.5 size-4" /> Back to Library
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background phone:h-dvh" data-course-page={id}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background/95 px-3">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-foreground/85 hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          <span>Library</span>
        </button>
        <span className="text-border" aria-hidden>/</span>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-[14px] font-semibold text-foreground">{course?.manifest.name ?? "Loading…"}</span>
          {course?.manifest.subtitle && (
            <span className="hidden truncate text-[12.5px] text-muted-foreground sm:inline">{course.manifest.subtitle}</span>
          )}
        </div>
        {course && (
          <span className="hidden shrink-0 text-[12.5px] text-muted-foreground tabular md:inline">
            {courseProgressLabel(course)}
          </span>
        )}
        {course && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Course options"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem disabled={busy} onSelect={() => void resetProgress()}>
                <RotateCcw className="size-4" /> Reset progress
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportPkg()}>
                <Download className="size-4" /> Export .json
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => setRemoving(true)}>
                <Trash2 className="size-4" /> Remove course
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      <div className="relative min-h-0 flex-1">
        {course ? (
          <iframe
            key={`${course.id}:${course.hash}:${run}`}
            ref={frameRef}
            src={api.courseFrameUrl(course.id)}
            title={course.manifest.name}
            sandbox="allow-scripts allow-pointer-lock"
            onLoad={pushTheme}
            className="block size-full border-0 bg-background"
          />
        ) : (
          <div className="grid size-full place-items-center text-sm text-muted-foreground">Loading course…</div>
        )}
      </div>

      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove “{course?.manifest.name}”?</DialogTitle>
            <DialogDescription>This removes the course and its saved progress from your Library.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void removeCourse()}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
