// Settings → Privacy: the two anonymous telemetry toggles (src/core/telemetry.ts says what each sends), Activity (your
// own time and typing for Stats, kept on this device: src/core/activity.ts), and the Market authors you hid.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { api, type ActivityStatus } from "@/lib/api";
import { activityChanged } from "@/lib/activity";
import { cn } from "@/lib/utils";
import { BigSwitch, Block, Section } from "@/components/settings-ui";
import { NATIVE_COPY } from "@/lib/native-copy";

type Prefs = { errorReports: boolean; usageStats: boolean };

export function PrivacySection() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [active, setActive] = useState(true);
  useEffect(() => {
    api.telemetry().then(
      (t) => {
        setPrefs(t.prefs);
        setActive(t.active);
      },
      () => setActive(false),
    );
  }, []);

  const set = async (patch: Partial<Prefs>) => {
    if (!prefs) return;
    const before = prefs;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      const saved = await api.saveSettings({ privacy: next });
      setPrefs(saved.privacy ?? next);
    } catch (e) {
      setPrefs(before);
      toast.error("Couldn't save", { description: (e as Error).message });
    }
  };

  return (
    <Section id="privacy" title="Privacy" description="Both are anonymous: not linked to your Etude account, and they go to Etude's own server even when Sync uses yours.">
      <Block
        title={<label htmlFor="privacy-errors">Send error reports</label>}
        description={NATIVE_COPY.privacyErrors}
        aside={<BigSwitch id="privacy-errors" checked={prefs?.errorReports ?? true} disabled={!prefs} onCheckedChange={(v) => void set({ errorReports: v })} />}
      />
      <Block
        title={<label htmlFor="privacy-usage">Share usage stats</label>}
        description={NATIVE_COPY.privacyUsage}
        aside={<BigSwitch id="privacy-usage" checked={prefs?.usageStats ?? false} disabled={!prefs} onCheckedChange={(v) => void set({ usageStats: v })} />}
      />
      {prefs && !active && (
        <Block description="This copy of Etude isn't sending either right now (ETUDE_TELEMETRY=0, or an etude serve started outside the app). The switches apply wherever this collection opens in the app." />
      )}
    </Section>
  );
}

const KEEP: { days: number; label: string }[] = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "A year" },
  { days: 0, label: "Forever" },
];

/**
 * Settings → Privacy → Activity: your own time and typing per page, file, chat and screen, for Stats. Off unless you
 * turn it on; kept in this collection on this device, never synced, shared or sent (src/core/activity.ts).
 */
export function ActivitySection() {
  const [s, setS] = useState<ActivityStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => api.activity().then(setS, () => setS(null));
  useEffect(() => void load(), []);

  const save = async (p: { on?: boolean; keepDays?: number; deleteAll?: boolean }, done?: string) => {
    setBusy(true);
    try {
      const r = await api.saveActivity(p);
      if (p.on !== undefined) await activityChanged(r.on);
      await load();
      if (done) toast.success(done);
    } catch (e) {
      toast.error("Couldn't save", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    try {
      const r = await api.clearActivity();
      await load();
      toast.success(r.deleted ? "Activity deleted" : "Nothing to delete");
    } catch (e) {
      toast.error("Couldn't delete", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const toggle = (v: boolean) => {
    if (v) return void save({ on: true }, "Activity is on. Stats shows it from now.");
    // Off: keep what's there, or delete it too.
    if (s?.rows) setAsking(true);
    else void save({ on: false });
  };

  return (
    <Section id="activity" title="Activity" description="Only counts: how long, and how many characters and words. Never what you wrote or pasted. It stays in this collection on this computer: Sync doesn't carry it, people you share folders with never see it, and it's not part of the reports above. Backups of your collection include it.">
      <Block
        title={<label htmlFor="privacy-activity">Keep track of my activity</label>}
        description="For Stats: how long you spend in each page, file, PDF, canvas, chat and screen, and how much you write there. Time counts while the window is in front and you've done something in the last 2 minutes."
        aside={<BigSwitch id="privacy-activity" checked={s?.on ?? false} disabled={!s || busy} onCheckedChange={toggle} />}
      />
      {s && (s.on || s.rows > 0) && (
        <Block
          title="Keep it for"
          description={s.rows ? `Recorded since ${new Date(s.since!).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}. Older days are dropped.` : "Older days are dropped."}
          stackAside
          aside={
            <span className="inline-flex flex-wrap gap-0.5 rounded-[9px] bg-[var(--stats-track,var(--muted))] p-[3px]" role="radiogroup" aria-label="Keep activity for">
              {KEEP.map((k) => (
                <button key={k.days} type="button" role="radio" aria-checked={s.keepDays === k.days} disabled={busy} data-activity-keep={k.days} onClick={() => void save({ keepDays: k.days })} className={cn("rounded-[7px] px-2.5 py-[5px] text-[12.5px] font-semibold transition-colors", s.keepDays === k.days ? "bg-card text-foreground shadow-sm" : "text-foreground/80 hover:text-foreground")}>
                  {k.label}
                </button>
              ))}
            </span>
          }
        />
      )}
      {s && s.rows > 0 && (
        <Block
          title="Delete my activity"
          description="Removes everything recorded so far. If it's on, it keeps recording from now."
          aside={<Button size="sm" variant="outline" className="phone:h-10 h-8" disabled={busy} onClick={() => void clear()} data-activity-delete><Trash2 className="size-4" />Delete</Button>}
        />
      )}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop keeping track?</AlertDialogTitle>
            <AlertDialogDescription>Nothing more gets recorded from now. What's already there can stay in Stats, or go.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="outline" data-activity-off-keep onClick={() => { setAsking(false); void save({ on: false }, "Activity is off"); }}>Turn off, keep it</Button>
            <Button variant="destructive" data-activity-off-delete onClick={() => { setAsking(false); void save({ on: false, deleteAll: true }, "Activity is off and deleted"); }}>Turn off and delete</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

/** Authors hidden from the Market (an entry's menu → Hide everything from…). Kept in your settings and synced. */
export function HiddenAuthorsSection() {
  const [list, setList] = useState<{ author: string; since: string }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api.hiddenAuthors().then((r) => setList(r.hiddenAuthors), () => setList([]));
  }, []);
  const show = async (author: string) => {
    setBusy(author);
    try {
      const r = await api.showAuthor(author);
      setList((l) => l?.filter((h) => r.hiddenAuthors.includes(h.author)) ?? null);
      toast.success(`${author}'s entries show in the Market again`);
    } catch (e) {
      toast.error("Couldn't show them again", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section id="market-hidden" title="Market" description="Everything in the Market fits a 13+ age rating. If something doesn't, report it from its page.">
      <Block
        title="Hidden authors"
        description={
          list?.length
            ? "Their decks, card types and themes are left out of the Market, on every device you sync. What you installed stays."
            : "None. To hide someone, open one of their entries in the Market and pick Hide everything from them in its menu."
        }
      >
        {!!list?.length && (
          <ul className="flex flex-col gap-2" data-hidden-authors>
            {list.map((h) => (
              <li key={h.author} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">{h.author}</span>
                <Button size="sm" variant="outline" className="phone:h-10 h-8" disabled={busy === h.author} onClick={() => void show(h.author)} data-show-author={h.author}>Show again</Button>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </Section>
  );
}
