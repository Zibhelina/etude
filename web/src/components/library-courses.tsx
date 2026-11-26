// Courses section on the Library page (desktop and phone): header + installed courses with progress rings,
// play button and context/overflow menu.
import { useState } from "react";
import { Check, Download, GraduationCap, MoreHorizontal, Play, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type InstalledCourseInfo } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { download } from "@/components/type-editor/starter";

const enc = encodeURIComponent;
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

export function courseProgressLabel(c: InstalledCourseInfo): string {
  const { doneCount, totalCount, minsLeft } = c.progress;
  const total = totalCount || c.manifest.lessons?.length || 0;
  if (total > 0) {
    if (doneCount >= total) return `Completed · ${plural(total, "lesson")}`;
    const parts = [doneCount > 0 ? `${doneCount} of ${total} lessons` : plural(total, "lesson")];
    if (typeof minsLeft === "number" && minsLeft > 0) parts.push(`${minsLeft} min left`);
    return parts.join(" · ");
  }
  return c.progress.updatedAt ? "In progress" : "Interactive course";
}

export function CourseBadge({ course, size = 46 }: { course: InstalledCourseInfo; size?: number }) {
  const total = course.progress.totalCount || course.manifest.lessons?.length || 0;
  const done = course.progress.doneCount;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const completed = total > 0 && done >= total;
  const r = 19;
  const circ = 2 * Math.PI * r;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-full bg-card/80 text-foreground"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 44 44" className="absolute inset-0 size-full -rotate-90">
        <circle cx="22" cy="22" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
        {ratio > 0 && (
          <circle
            cx="22"
            cy="22"
            r={r}
            fill="none"
            stroke="var(--primary)"
            strokeWidth="2.75"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - ratio)}
          />
        )}
      </svg>
      {course.manifest.icon ? (
        <span className="relative text-[19px] leading-none">{course.manifest.icon}</span>
      ) : completed ? (
        <Check className="relative size-[18px] text-primary" strokeWidth={2.5} />
      ) : (
        <GraduationCap className="relative size-[18px] text-primary" />
      )}
    </span>
  );
}

export function CoursesSection({
  courses,
  phone = false,
  onChanged,
}: {
  courses: InstalledCourseInfo[];
  phone?: boolean;
  onChanged(): void;
}) {
  const [removing, setRemoving] = useState<InstalledCourseInfo | null>(null);
  const [busy, setBusy] = useState(false);

  if (!courses.length) return null;

  const totalLessons = courses.reduce((a, c) => a + (c.progress.totalCount || c.manifest.lessons?.length || 0), 0);
  const aside = totalLessons > 0 ? `${plural(courses.length, "course")} · ${plural(totalLessons, "lesson")}` : plural(courses.length, "course");

  const openCourse = (c: InstalledCourseInfo) => navigate(`/course?id=${enc(c.id)}`);

  const resetProgress = async (c: InstalledCourseInfo) => {
    setBusy(true);
    try {
      await api.resetCourseProgress(c.id);
      toast.success(`Reset progress for ${c.manifest.name}`);
      onChanged();
    } catch (e) {
      toast.error("Couldn't reset progress", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const exportPkg = async (c: InstalledCourseInfo) => {
    try {
      const pkg = await api.exportCourse(c.id);
      download(`${c.id}.course.json`, pkg);
    } catch (e) {
      toast.error("Export failed", { description: (e as Error).message });
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.removeCourse(removing.id);
      toast.success(`Removed ${removing.manifest.name}`);
      setRemoving(null);
      onChanged();
    } catch (e) {
      toast.error("Couldn't remove course", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className={cn(phone ? "mx-5 mt-8" : "mt-10")} aria-label="Courses" data-loaded-fade data-courses-section>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="score-kicker font-semibold">Courses</span>
          <span className="text-[13px] text-muted-foreground tabular">{aside}</span>
        </div>
        <div className={cn(phone ? "divide-y divide-border/60" : "relative")}>
          {courses.map((c) => {
            const subline = courseProgressLabel(c);
            const hasProgress = c.progress.doneCount > 0 || !!c.progress.updatedAt;
            const row = (
              <div
                data-course={c.id}
                className={cn(
                  "lib-row group relative flex cursor-pointer items-center gap-3 rounded-xl select-none transition-colors",
                  phone ? "min-h-[4.25rem] py-2.5" : "-mx-2.5 min-h-[4.25rem] px-2.5 py-2",
                )}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest("button,[role=menuitem]")) openCourse(c);
                }}
              >
                <CourseBadge course={c} size={phone ? 42 : 46} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <button
                      type="button"
                      data-course-name
                      className="block max-w-full truncate text-left text-[15.5px] font-semibold hover:underline"
                      onClick={() => openCourse(c)}
                    >
                      {c.manifest.name}
                    </button>
                    {c.manifest.subtitle && !phone && (
                      <span className="truncate text-[12.5px] text-muted-foreground">{c.manifest.subtitle}</span>
                    )}
                  </div>
                  <div className="mt-[3px] flex items-center gap-2 text-[13px] text-muted-foreground tabular">
                    <span className="truncate">{subline}</span>
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground",
                        !phone && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                      )}
                      aria-label={`More options for ${c.manifest.name}`}
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onSelect={() => openCourse(c)}>
                      <Play className="size-4" /> Open course
                    </DropdownMenuItem>
                    {hasProgress && (
                      <DropdownMenuItem disabled={busy} onSelect={() => void resetProgress(c)}>
                        <RotateCcw className="size-4" /> Reset progress
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => void exportPkg(c)}>
                      <Download className="size-4" /> Export .json
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => setRemoving(c)}>
                      <Trash2 className="size-4" /> Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  type="button"
                  className="lib-play flex size-[38px] shrink-0 items-center justify-center rounded-full transition-[transform,background-color,color] active:scale-90"
                  onClick={() => openCourse(c)}
                  aria-label={`Open ${c.manifest.name}`}
                >
                  <Play className="size-3.5 translate-x-px fill-current" />
                </button>
              </div>
            );

            if (phone) return <div key={c.id}>{row}</div>;
            return (
              <ContextMenu key={c.id}>
                <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <ContextMenuItem onSelect={() => openCourse(c)}>
                    <Play className="size-4" /> Open course
                  </ContextMenuItem>
                  {hasProgress && (
                    <ContextMenuItem disabled={busy} onSelect={() => void resetProgress(c)}>
                      <RotateCcw className="size-4" /> Reset progress
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem onSelect={() => void exportPkg(c)}>
                    <Download className="size-4" /> Export .json
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" disabled={busy} onSelect={() => setRemoving(c)}>
                    <Trash2 className="size-4" /> Remove
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      </section>

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove “{removing?.manifest.name}”?</DialogTitle>
            <DialogDescription>
              This removes the course and its saved progress from your Library.
              {removing?.source === "market" ? " You can install it again from the Market anytime." : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmRemove()}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
