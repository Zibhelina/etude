import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CalendarClock, ChevronDown, Copy, MoreHorizontal, Pencil, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { StepsInput } from "@/components/deck-steps-input";
import { api, type DeckDetail, type DeckFace, type DeckNode, type OptimizeResult, type PresetConfig, type Preset, type SchedulerSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

export type DeckFull = DeckDetail;
type Key = keyof PresetConfig;

/** FSRS-6 published defaults, shown when a deck doesn't set its own weights. */
const DEFAULT_WEIGHTS = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];

/** Settings whose change moves existing due dates only after a reschedule. */
const RESCHEDULE_KEYS: Key[] = ["desiredRetention", "learningSteps", "relearningSteps", "maximumInterval", "weights", "deadline", "deadlineMargin", "scheduler", "schedulerOptions"];

const LABELS: Record<Key, string> = {
  desiredRetention: "Desired retention",
  learningSteps: "Learning steps",
  relearningSteps: "Relearning steps",
  maximumInterval: "Maximum interval",
  enableFuzz: "Fuzz",
  enableShortTerm: "Short-term scheduling",
  weights: "FSRS weights",
  newPerDay: "New cards per day",
  newPerFace: "New cards per face",
  reviewsPerDay: "Reviews per day",
  newOrder: "New card order",
  reviewOrder: "Review order",
  newMix: "New and review mix",
  deadline: "Exam deadline",
  deadlineMargin: "Deadline margin",
  autoRate: "Auto-rating thresholds",
  autoApply: "Apply suggested rating",
  burySiblings: "Bury siblings",
  mode: "Mode",
  scheduler: "Schedule with",
  schedulerOptions: "Scheduler settings",
  adaptiveChallenge: "Adaptive challenge",
  adaptivePace: "Adaptive pace",
  targetSuccess: "Target success",
  minutesPerDay: "Time budget",
  newPerDayMin: "Fewest new cards",
  newPerDayMax: "Most new cards",
  levels: "Levels",
  levelAdvanceAt: "Open the next level at",
  levelMix: "Next-level share",
  quickChecksPerDay: "Quick checks per day",
};

/** Levels as text: one per line, the level's tag, then optionally the tag of its level check. */
const levelsText = (levels: PresetConfig["levels"]) => levels.map((l) => (l.check ? `${l.tag} ${l.check}` : l.tag)).join("\n");
const parseLevels = (text: string): PresetConfig["levels"] =>
  text
    .split("\n")
    .map((line) => line.trim().split(/\s+/).filter(Boolean))
    .filter((p) => p.length)
    .map(([tag, check]) => (check ? { tag, check } : { tag }));

const norm = (v: unknown) => JSON.stringify(v ?? null);
const same = (a: unknown, b: unknown) => norm(a) === norm(b);
const short = (deck: string) => deck.split("::").pop()!;
const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

type Source = { kind: "default" | "parent" | "preset" | "deck"; label: string };

function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function DeckOptions({ deck, decks, presets, onChanged }: { deck: DeckFull; decks: DeckNode[]; presets: Preset[]; onChanged(): Promise<void> | void }) {
  const [draft, setDraft] = useState<Partial<PresetConfig>>({});
  const [busy, setBusy] = useState(false);
  const [resched, setResched] = useState<{ decks: string[]; cards: number | null } | null>(null);
  const [presetDialog, setPresetDialog] = useState<null | "create" | "rename">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPresetSave, setConfirmPresetSave] = useState(false);
  const [schedulers, setSchedulers] = useState<SchedulerSummary[]>([]);
  useEffect(() => {
    api.schedulers().then(setSchedulers).catch(() => {});
  }, []);
  const [faces, setFaces] = useState<DeckFace[]>([]);
  useEffect(() => {
    api.deckFaces(deck.name).then(setFaces, () => setFaces([]));
  }, [deck.name]);

  const preset = presets.find((p) => p.id === deck.presetId) ?? null;
  const usage = (id: string) => decks.filter((d) => d.presetId === id);
  const presetUsers = preset ? usage(preset.id) : [];

  // Drop draft entries that now match the saved value (after a save or reset elsewhere).
  useEffect(() => {
    setDraft((d) => {
      const next = { ...d };
      for (const k of Object.keys(next) as Key[]) if (same(next[k], deck.resolved[k])) delete next[k];
      return next;
    });
  }, [deck]);

  const value = <K extends Key>(k: K): PresetConfig[K] => (k in draft ? (draft[k] as PresetConfig[K]) : deck.resolved[k]);
  const set = <K extends Key>(k: K, v: PresetConfig[K]) =>
    setDraft((d) => {
      const next = { ...d };
      if (same(v, deck.resolved[k])) delete next[k];
      else next[k] = v;
      return next;
    });

  /** Where a setting's value comes from. `has` narrows it to part of a setting, like one face's limit. */
  const source = (k: Key, has = (c: Partial<PresetConfig>) => c[k] !== undefined): Source => {
    let s: Source = { kind: "default", label: "Default" };
    const parts = deck.name.split("::");
    for (let i = 1; i < parts.length; i++) {
      const name = parts.slice(0, i).join("::");
      const node = decks.find((d) => d.name === name);
      if (!node) continue;
      const p = presets.find((x) => x.id === node.presetId);
      if (p && has(p.config)) s = { kind: "parent", label: `${short(name)} · ${p.name}` };
      if (has(node.config)) s = { kind: "parent", label: short(name) };
    }
    if (preset && has(preset.config)) s = { kind: "preset", label: preset.name };
    if (has(deck.config)) s = { kind: "deck", label: "This deck" };
    return s;
  };

  const changed = Object.keys(draft) as Key[];
  const overridden = (Object.keys(deck.config) as Key[]).filter((k) => deck.config[k] !== undefined);

  const afterSave = async (keys: Key[], scopeDecks: string[]) => {
    setDraft({});
    await onChanged();
    if (keys.some((k) => RESCHEDULE_KEYS.includes(k))) {
      // Nested decks are covered by their ancestor's reschedule.
      const roots = scopeDecks.filter((n) => !scopeDecks.some((o) => o !== n && n.startsWith(o + "::")));
      setResched({ decks: roots, cards: null });
      try {
        let n = 0;
        for (const d of roots) n += (await api.search(`deck:"${d}" -is:new`, { limit: 1 })).total;
        setResched({ decks: roots, cards: n });
      } catch {}
    }
  };

  const saveToDeck = async () => {
    const config: Partial<PresetConfig> = { ...deck.config };
    for (const k of changed) {
      if (same(draft[k], deck.inherited[k])) delete config[k];
      else (config as any)[k] = draft[k];
    }
    setBusy(true);
    try {
      await api.updateDeck(deck.name, { config });
      toast.success(`Saved ${changed.length} setting${changed.length === 1 ? "" : "s"} to this deck`);
      await afterSave(changed, [deck.name]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ownCollisions = changed.filter((k) => deck.config[k] !== undefined);
  const saveToPreset = async () => {
    if (!preset) return;
    const config: Partial<PresetConfig> = { ...preset.config };
    for (const k of changed) {
      if (same(draft[k], deck.presetBase[k])) delete config[k];
      else (config as any)[k] = draft[k];
    }
    setBusy(true);
    try {
      await api.savePreset(preset.id, preset.name, config);
      // The deck's own override would hide the new preset value; drop it.
      if (ownCollisions.length) {
        const own = { ...deck.config };
        for (const k of ownCollisions) delete own[k];
        await api.updateDeck(deck.name, { config: own });
      }
      toast.success(`Saved to preset ${preset.name}`, { description: `Affects ${presetUsers.length} deck${presetUsers.length === 1 ? "" : "s"}` });
      await afterSave(changed, presetUsers.map((d) => d.name));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      setConfirmPresetSave(false);
    }
  };

  const resetKeys = async (keys: Key[]) => {
    const config: Partial<PresetConfig> = { ...deck.config };
    for (const k of keys) delete config[k];
    try {
      await api.updateDeck(deck.name, { config });
      setDraft((d) => {
        const next = { ...d };
        for (const k of keys) delete next[k];
        return next;
      });
      toast.success(keys.length === 1 ? `${LABELS[keys[0]]} reset to inherited` : `${keys.length} settings reset to inherited`);
      await afterSave(keys, [deck.name]);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const setPreset = async (id: string | null) => {
    try {
      await api.updateDeck(deck.name, { presetId: id });
      toast.success(id ? `Using preset ${presets.find((p) => p.id === id)?.name ?? id}` : "No preset");
      await afterSave(RESCHEDULE_KEYS, [deck.name]);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const reschedule = async () => {
    if (!resched) return;
    setBusy(true);
    try {
      let n = 0;
      for (const d of resched.decks) n += (await api.reschedule({ deck: d })).rescheduled;
      toast.success(`Rescheduled ${n} card${n === 1 ? "" : "s"}`);
      setResched(null);
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const row = (k: Key, control: ReactNode, help?: ReactNode, opts: { wide?: boolean; inline?: boolean } = {}) => (
    <SettingRow key={k} k={k} source={source(k)} dirty={k in draft} help={help} wide={opts.wide} inline={opts.inline} onReset={deck.config[k] !== undefined ? () => resetKeys([k]) : undefined}>
      {control}
    </SettingRow>
  );

  const faceLimits = value("newPerFace") ?? {};
  const faceRow = (f: DeckFace) => {
    const own = deck.config.newPerFace?.[f.face] !== undefined;
    const browse = `/browse?q=${encodeURIComponent(`deck:"${deck.name}" face:${f.face} is:new`)}`;
    return (
      <SettingRow
        key={`face:${f.face}`}
        k="newPerFace"
        label={`New ${f.face} cards per day`}
        source={source("newPerFace", (c) => c.newPerFace?.[f.face] !== undefined)}
        dirty={"newPerFace" in draft && !same((draft.newPerFace ?? {})[f.face], deck.resolved.newPerFace?.[f.face])}
        help={
          <>
            {f.types.map((t) => t.name).join(", ")} · {f.new.toLocaleString()} new (<a href={browse} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">view</a>).
            Empty: they share the limit above.
          </>
        }
        onReset={own ? () => {
          const mine = { ...(deck.config.newPerFace ?? {}) };
          delete mine[f.face];
          const config: Partial<PresetConfig> = { ...deck.config, newPerFace: mine };
          if (!Object.keys(mine).length) delete config.newPerFace;
          api.updateDeck(deck.name, { config }).then(() => afterSave(["newPerFace"], [deck.name])).catch((e) => toast.error((e as Error).message));
        } : undefined}
      >
        <LimitField
          value={faceLimits[f.face] ?? null}
          ariaLabel={`New ${f.face} cards per day`}
          onChange={(v) => {
            const next = { ...faceLimits };
            // Clearing a limit set further up needs an explicit null to drop it here.
            if (v !== null) next[f.face] = v;
            else if (deck.inherited.newPerFace?.[f.face] != null) next[f.face] = null;
            else delete next[f.face];
            set("newPerFace", next);
          }}
        />
      </SettingRow>
    );
  };

  const schedulerId = value("scheduler") ?? "fsrs";
  const current = schedulers.find((x) => x.id === schedulerId);
  const fsrs = schedulerId === "fsrs";
  const schedOpts = value("schedulerOptions") ?? {};
  const retention = value("desiredRetention");
  const deadline = value("deadline");
  const autoRate = value("autoRate");
  const weights = value("weights");

  return (
    <div className="flex flex-col gap-6">
      {/* Preset */}
      <div className="rounded-xl border bg-card/40 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Label htmlFor="preset-select" className="text-sm font-medium">Preset</Label>
            <p className="mt-1 text-sm text-muted-foreground">
              {preset ? (
                <span title={presetUsers.map((d) => d.name).join("\n")}>
                  Shared by {presetUsers.length} deck{presetUsers.length === 1 ? "" : "s"}. Saving to the preset changes all of them.
                </span>
              ) : (
                "No preset: this deck takes its parents' settings plus its own overrides."
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={deck.presetId ?? "__none"} onValueChange={(v) => setPreset(v === "__none" ? null : v)}>
              <SelectTrigger id="preset-select" className="h-10 w-full min-w-48 sm:w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">None</SelectItem>
                {presets.length > 0 && <SelectSeparator />}
                {presets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="size-10" aria-label="Preset actions"><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem onClick={() => setPresetDialog("create")}><Plus />New preset from these settings</DropdownMenuItem>
                <DropdownMenuItem disabled={!preset} onClick={() => setPresetDialog("rename")}><Pencil />Rename preset</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" disabled={!preset} onClick={() => setConfirmDelete(true)}><Trash2 />Delete preset…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setResched({ decks: [deck.name], cards: null })}><RefreshCw />Reschedule cards…</DropdownMenuItem>
                <DropdownMenuItem disabled={!overridden.length} onClick={() => resetKeys(overridden)}><RotateCcw />Reset all overrides ({overridden.length})</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {resched && (
        <div className="flex flex-col gap-3 rounded-xl border border-highlight/30 bg-highlight/5 p-4 sm:flex-row sm:items-center">
          <RefreshCw className="hidden size-4 shrink-0 text-highlight sm:block" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">Reschedule existing cards?</div>
            <div className="text-muted-foreground">
              New settings apply to the next review of each card. Rescheduling recomputes current due dates from review history
              {resched.decks.length > 1 ? ` in ${resched.decks.length} decks` : ""}
              {resched.cards != null ? ` (${resched.cards} reviewed card${resched.cards === 1 ? "" : "s"})` : ""}.
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" className="h-10" onClick={() => setResched(null)}>Not now</Button>
            <Button className="h-10" disabled={busy || resched.cards === 0} onClick={reschedule}>Reschedule</Button>
          </div>
        </div>
      )}

      <Group title="Scheduler" description="Who decides when a card comes back. FSRS is for things you want to remember; a drill is for skills you train and measure.">
        {row(
          "scheduler",
          <ChoiceSelect
            value={schedulerId}
            onChange={(v) => {
              set("scheduler", v);
              if (!same(schedOpts, deck.resolved.schedulerOptions)) set("schedulerOptions", deck.resolved.schedulerOptions);
            }}
            options={(schedulers.length ? schedulers : [{ id: "fsrs", name: "FSRS" } as SchedulerSummary]).map((x) => [x.id, x.name])}
            ariaLabel="Scheduler"
          />,
          <>
            {current?.description || (fsrs ? "Spaced repetition." : schedulerId)}
            {deck.typeSchedulers.length > 0 && <TypeSchedulers deck={deck} schedulers={schedulers} unset={source("scheduler").kind === "default"} onPin={() => afterSave(["scheduler"], [deck.name])} />}
          </>,
          { wide: true },
        )}
        {!fsrs &&
          (current?.options ?? []).map((o) => {
            const v = o.name in schedOpts ? schedOpts[o.name] : o.default;
            const put = (x: unknown) => set("schedulerOptions", { ...schedOpts, [o.name]: x });
            return (
              <SettingRow
                key={o.name}
                k="schedulerOptions"
                label={o.label ?? o.name}
                source={deck.config.schedulerOptions?.[o.name] !== undefined ? { kind: "deck", label: "This deck" } : source("schedulerOptions").kind === "deck" ? { kind: "default", label: "Default" } : source("schedulerOptions")}
                dirty={"schedulerOptions" in draft && !same((draft.schedulerOptions ?? {})[o.name], deck.resolved.schedulerOptions?.[o.name])}
                help={o.description}
                inline={o.kind === "boolean"}
                onReset={deck.config.schedulerOptions?.[o.name] !== undefined ? () => {
                  const own = { ...(deck.config.schedulerOptions ?? {}) };
                  delete own[o.name];
                  const config: Partial<PresetConfig> = { ...deck.config, schedulerOptions: own };
                  if (!Object.keys(own).length) delete config.schedulerOptions;
                  api.updateDeck(deck.name, { config }).then(() => afterSave(["schedulerOptions"], [deck.name])).catch((e) => toast.error((e as Error).message));
                } : undefined}
              >
                {o.kind === "boolean" ? (
                  <Switch checked={v === true} onCheckedChange={put} aria-label={o.label ?? o.name} />
                ) : o.kind === "number" ? (
                  <NumberField value={Number(v ?? 0)} min={o.min} max={o.max} onChange={put} suffix={o.suffix} ariaLabel={o.label ?? o.name} />
                ) : (
                  <Input value={String(v ?? "")} onChange={(e) => put(e.target.value)} aria-label={o.label ?? o.name} className="h-10" />
                )}
              </SettingRow>
            );
          })}
      </Group>

      {fsrs && <>
      <Group title="Memory" description="How hard FSRS works to keep cards in memory.">
        {row(
          "desiredRetention",
          <div>
            <div className="flex items-center gap-4">
              <Slider min={0.7} max={0.99} step={0.01} value={[retention]} onValueChange={([v]) => set("desiredRetention", Math.round(v * 100) / 100)} aria-label="Desired retention" className="flex-1 py-3" />
              <span className="tabular w-11 text-right text-sm font-medium">{Math.round(retention * 100)}%</span>
            </div>
            <div className="tabular -mt-1 flex justify-between pr-15 text-[11px] text-muted-foreground"><span>70%</span><span>99%</span></div>
          </div>,
          <>
            When a card comes up for review, you should remember it about <span className="text-foreground">{Math.round(retention * 100)}%</span> of the time. Higher means shorter intervals and more reviews; above 95% the workload climbs steeply.
          </>,
        )}
        {row(
          "maximumInterval",
          <NumberField value={value("maximumInterval")} min={1} onChange={(v) => set("maximumInterval", v)} suffix="days" ariaLabel="Maximum interval in days" />,
          "No card waits longer than this between reviews.",
        )}
        {row("enableFuzz", <Switch checked={value("enableFuzz")} onCheckedChange={(v) => set("enableFuzz", v)} aria-label="Fuzz" />, "Adds a little randomness to intervals so cards learned together don't stay bunched up.", { inline: true })}
      </Group>

      <Group title="Steps" description="Short intervals before a card graduates to FSRS scheduling.">
        {row("learningSteps", <StepsInput value={value("learningSteps")} onChange={(v) => set("learningSteps", v)} ariaLabel="Learning steps" />, "Intervals for a new card. Again restarts the steps.", { wide: true })}
        {row("relearningSteps", <StepsInput value={value("relearningSteps")} onChange={(v) => set("relearningSteps", v)} ariaLabel="Relearning steps" />, "Intervals after you forget a review card.", { wide: true })}
        {row(
          "enableShortTerm",
          <Switch checked={value("enableShortTerm")} onCheckedChange={(v) => set("enableShortTerm", v)} aria-label="Short-term scheduling" />,
          "Let FSRS model reviews on the same day. Off: steps run, but stability only updates across days.",
          { inline: true },
        )}
      </Group>

      </>}

      <Group title="Daily limits" description="Counted across this deck and its subdecks, custom study included.">
        {row(
          "newPerDay",
          <NumberField value={value("newPerDay")} min={0} onChange={(v) => set("newPerDay", v)} suffix="cards" ariaLabel="New cards per day" />,
          value("adaptivePace") ? "Adaptive pace sets this each day; until there's a week of answers it starts here." : "New cards introduced per study day, across this deck and its subdecks.",
        )}
        {faces.length > 1 && faces.map(faceRow)}
        {row("reviewsPerDay", <NumberField value={value("reviewsPerDay")} min={0} onChange={(v) => set("reviewsPerDay", v)} suffix="cards" ariaLabel="Reviews per day" />, "Due reviews shown per day. The rest wait until tomorrow.")}
      </Group>

      <Group title="Order" description="What a study session shows next.">
        {row(
          "newOrder",
          <ChoiceSelect value={value("newOrder")} onChange={(v) => set("newOrder", v as PresetConfig["newOrder"])} options={[["added", "Order added"], ["deck", "Deck, then order added"], ["random", "Random"]]} ariaLabel="New card order" />,
          "Which new cards are introduced first.",
        )}
        {row(
          "reviewOrder",
          <ChoiceSelect value={value("reviewOrder")} onChange={(v) => set("reviewOrder", v as PresetConfig["reviewOrder"])} options={[["due", "Due date"], ["retrievability", "Weakest first"], ["random", "Random"]]} ariaLabel="Review order" />,
          "Weakest first shows the cards you're most likely to forget before the rest.",
        )}
        {row(
          "newMix",
          <ChoiceSelect value={value("newMix")} onChange={(v) => set("newMix", v as PresetConfig["newMix"])} options={[["mix", "Spread through reviews"], ["first", "New cards first"], ["last", "Reviews first"]]} ariaLabel="New and review mix" />,
          "When new cards appear in a session.",
        )}
        {row(
          "mode",
          <ChoiceSelect value={value("mode")} onChange={(v) => set("mode", v as PresetConfig["mode"])} options={[["study", "Study"], ["watch", "Watch (a tour)"]]} ariaLabel="Mode" />,
          "Watch makes the deck a tour: every card can show an example answer, nothing is scheduled, and its cards stay out of study sessions.",
        )}
        {row("burySiblings", <Switch checked={value("burySiblings")} onCheckedChange={(v) => set("burySiblings", v)} aria-label="Bury siblings" />, "After you study one face of an item, hide its other new faces until tomorrow.", { inline: true })}
      </Group>

      <Group title="Adaptive" description="Fit the work to how you're doing. Off: the deck works as built.">
        {row("adaptivePace", <Switch checked={value("adaptivePace")} onCheckedChange={(v) => set("adaptivePace", v)} aria-label="Adaptive pace" />, "Raise or lower the new cards per day from how well last week's new cards held (against the desired retention) and your study time.", { inline: true })}
        {value("adaptivePace") && <>
          {row("minutesPerDay", <NumberField value={value("minutesPerDay")} min={1} onChange={(v) => set("minutesPerDay", v)} suffix="min/day" ariaLabel="Time budget in minutes per day" />, "Study time per day the pace aims for.")}
          {row("newPerDayMin", <NumberField value={value("newPerDayMin")} min={0} onChange={(v) => set("newPerDayMin", v)} suffix="cards" ariaLabel="Fewest new cards per day" />, "The pace never goes below this.")}
          {row("newPerDayMax", <NumberField value={value("newPerDayMax")} min={0} onChange={(v) => set("newPerDayMax", v)} suffix="cards" ariaLabel="Most new cards per day" />, "Or above this.")}
        </>}
        {row(
          "adaptiveChallenge",
          <Switch checked={value("adaptiveChallenge")} onCheckedChange={(v) => set("adaptiveChallenge", v)} aria-label="Adaptive challenge" />,
          "Let card types choose versions for you: the clearest one when a card is new, one of its usual difficulty when FSRS measures your memory. Only types that support it change.",
          { inline: true },
        )}
        {(value("adaptivePace") || value("adaptiveChallenge")) && <>
          {row(
            "levels",
            <Textarea value={levelsText(value("levels"))} onChange={(e) => set("levels", parseLevels(e.target.value))} placeholder={"level::1 check::1\nlevel::2 check::2"} rows={3} className="font-mono text-sm" aria-label="Levels" />,
            "One per line, easiest first: the tag of the level's items, then optionally the tag of its level check. New cards come from your level; the next one opens gradually.",
            { wide: true },
          )}
          {value("levels").length > 0 && <>
            {row("levelAdvanceAt", <NumberField value={Math.round(value("levelAdvanceAt") * 100)} min={0} max={100} onChange={(v) => set("levelAdvanceAt", v / 100)} suffix="% stable" ariaLabel="Open the next level at" />, "How much of a level has to be stable before the next level's new cards start to appear.")}
            {row("levelMix", <NumberField value={Math.round(value("levelMix") * 100)} min={0} max={100} onChange={(v) => set("levelMix", v / 100)} suffix="%" ariaLabel="Next-level share" />, "Share of new cards taken from the next level once it opens.")}
          </>}
          {row("quickChecksPerDay", <NumberField value={value("quickChecksPerDay")} min={0} onChange={(v) => set("quickChecksPerDay", v)} suffix="cards" ariaLabel="Quick checks per day" />, "After a placement, earlier cards it judged known come up as quick checks, on top of the new cards.")}
        </>}
      </Group>

      {fsrs && <>
      <Group title="Exam" description="Exam mode pulls every interval in so each card gets a last look before the deadline.">
        {row(
          "deadline",
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              type="datetime-local"
              value={toLocalInput(deadline)}
              onChange={(e) => {
                const d = e.target.value ? new Date(e.target.value) : null;
                if (!d || !Number.isNaN(d.getTime())) set("deadline", d ? d.toISOString() : null);
              }}
              aria-label="Exam deadline"
              className="h-10 sm:w-60"
            />
            {deadline && (
              <Button variant="ghost" className="h-10 gap-1.5 self-start text-muted-foreground" onClick={() => set("deadline", null)}><X className="size-4" />Clear</Button>
            )}
          </div>,
          deadline ? (
            <span className="inline-flex items-center gap-1.5"><CalendarClock className="size-3.5 text-highlight" />{formatDeadline(deadline)}{new Date(deadline) < new Date() ? " (passed: no longer capping)" : ""}</span>
          ) : (
            "No deadline: intervals grow freely."
          ),
          { wide: true },
        )}
        {row("deadlineMargin", <NumberField value={value("deadlineMargin")} min={0} step={0.5} onChange={(v) => set("deadlineMargin", v)} suffix="hours" ariaLabel="Deadline margin in hours" />, "The last review is scheduled at least this long before the deadline.")}
      </Group>

      </>}

      {(fsrs || current?.ratings !== false) && <Group title="Grading" description="How a graded score turns into a suggested rating.">
        {row(
          "autoRate",
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1.5 text-xs text-muted-foreground">Good at or above</Label>
              <NumberField value={Math.round(autoRate.good * 100)} min={0} max={100} onChange={(v) => set("autoRate", { ...autoRate, good: v / 100 })} suffix="%" ariaLabel="Good threshold percent" />
            </div>
            <div>
              <Label className="mb-1.5 text-xs text-muted-foreground">Hard at or above</Label>
              <NumberField value={Math.round(autoRate.hard * 100)} min={0} max={100} onChange={(v) => set("autoRate", { ...autoRate, hard: v / 100 })} suffix="%" ariaLabel="Hard threshold percent" />
            </div>
          </div>,
          autoRate.hard > autoRate.good ? <span className="text-destructive">Hard should be at or below Good.</span> : "Script-graded scores below Hard suggest Again. AI verdicts map directly: correct, partial, incorrect.",
          { wide: true },
        )}
        {row("autoApply", <Switch checked={value("autoApply")} onCheckedChange={(v) => set("autoApply", v)} aria-label="Apply suggested rating" />, "Rate automatically after grading instead of waiting for you to confirm.", { inline: true })}
      </Group>}

      {fsrs && <WeightsGroup
        deck={deck.name}
        value={weights ?? null}
        inherited={deck.inherited.weights ?? null}
        source={source("weights")}
        dirty={"weights" in draft}
        onChange={(w) => set("weights", (w ?? (deck.inherited.weights ? null : undefined)) as PresetConfig["weights"])}
        onReset={deck.config.weights !== undefined ? () => resetKeys(["weights"]) : undefined}
      />}

      {changed.length > 0 && (
        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 md:bottom-4">
          <div className="flex flex-col gap-3 rounded-xl border bg-popover/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:pl-4">
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium">{changed.length} unsaved change{changed.length === 1 ? "" : "s"}</span>
              <span className="text-muted-foreground"> · {changed.map((k) => LABELS[k]).join(", ")}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" className="h-10" onClick={() => setDraft({})} disabled={busy}>Discard</Button>
              {preset && (
                <Button variant="outline" className="h-10" onClick={() => setConfirmPresetSave(true)} disabled={busy || autoRate.hard > autoRate.good}>
                  Save to preset
                </Button>
              )}
              <Button className="h-10" onClick={saveToDeck} disabled={busy || autoRate.hard > autoRate.good}>Save to this deck</Button>
            </div>
          </div>
        </div>
      )}

      <PresetNameDialog
        mode={presetDialog}
        preset={preset}
        presets={presets}
        onOpenChange={(o) => !o && setPresetDialog(null)}
        onCreate={async (name, id) => {
          // The new preset captures what this deck uses now; its own overrides move into it.
          const config: Partial<PresetConfig> = { ...deck.resolved, ...draft };
          if (config.weights == null) delete config.weights;
          await api.savePreset(id, name, config);
          await api.updateDeck(deck.name, { presetId: id, config: {} });
          toast.success(`Created preset ${name}`);
          setPresetDialog(null);
          setDraft({});
          await onChanged();
        }}
        onRename={async (name) => {
          if (!preset) return;
          await api.savePreset(preset.id, name, preset.config);
          toast.success(`Renamed to ${name}`);
          setPresetDialog(null);
          await onChanged();
        }}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete preset {preset?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {presetUsers.length
                ? `It's used by ${presetUsers.length} deck${presetUsers.length === 1 ? "" : "s"} (${presetUsers.map((d) => d.name).join(", ")}). Switch ${presetUsers.length === 1 ? "it" : "them"} to another preset or None first.`
                : "No deck uses it. This can't be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={presetUsers.length > 0}
              variant="destructive"
              onClick={async () => {
                if (!preset) return;
                try {
                  await api.deletePreset(preset.id);
                  toast.success(`Deleted preset ${preset.name}`);
                  await onChanged();
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmPresetSave} onOpenChange={setConfirmPresetSave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save to preset {preset?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {presetUsers.length === 1
                ? "Only this deck uses it right now."
                : `This changes ${presetUsers.length} decks: ${presetUsers.map((d) => short(d.name)).join(", ")}.`}
              {ownCollisions.length > 0 && ` This deck's own override for ${ownCollisions.map((k) => LABELS[k].toLowerCase()).join(", ")} will be removed so the preset value applies.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={saveToPreset}>Save to preset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Card types here that pick their own scheduler: whether they follow it, and a way to put every card on this deck's. */
function TypeSchedulers({ deck, schedulers, unset, onPin }: { deck: DeckFull; schedulers: SchedulerSummary[]; unset: boolean; onPin(): void }) {
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string) => schedulers.find((x) => x.id === id)?.name ?? id;
  const list = deck.typeSchedulers.map((t, i) => (
    <span key={t.type}>
      {i > 0 && (i === deck.typeSchedulers.length - 1 ? " and " : ", ")}
      {t.name}, {t.cards.toLocaleString()} card{t.cards === 1 ? "" : "s"} on {nameOf(t.scheduler)}
    </span>
  ));
  const pin = async () => {
    setBusy(true);
    try {
      await api.updateDeck(deck.name, { config: { ...deck.config, scheduler: deck.resolved.scheduler } });
      onPin();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return unset ? (
    <span className="mt-1.5 block">
      Except where a card type picks its own scheduler: {list}.{" "}
      <button className="underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={busy} onClick={pin}>Use {nameOf(deck.resolved.scheduler)} for them too</button>
    </span>
  ) : (
    <span className="mt-1.5 block">It also applies to cards whose type picks its own scheduler, instead of that one: {deck.typeSchedulers.map((t) => `${t.name} (${nameOf(t.scheduler)})`).join(", ")}.</span>
  );
}

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      <div className="divide-y overflow-hidden rounded-xl border bg-card/40">{children}</div>
    </section>
  );
}

const SOURCE_CLS: Record<Source["kind"], string> = {
  default: "border-border text-muted-foreground",
  parent: "border-border text-muted-foreground",
  preset: "border-foreground/15 text-foreground/75",
  deck: "border-highlight/40 text-highlight",
};

function SourceTag({ source }: { source: Source }) {
  const prefix = source.kind === "parent" ? "from " : source.kind === "preset" ? "preset: " : "";
  const text = source.kind === "default" ? "default" : source.kind === "deck" ? "this deck" : `${prefix}${source.label}`;
  return (
    <span className={cn("inline-flex h-5 max-w-full items-center truncate rounded-full border px-2 text-[11px] leading-none", SOURCE_CLS[source.kind])} title={`Current value comes from ${text}`}>
      <span className="truncate">{text}</span>
    </span>
  );
}

function SettingRow({ k, label, source, dirty, help, wide, inline, onReset, children }: { k: Key; label?: string; source: Source; dirty: boolean; help?: ReactNode; wide?: boolean; inline?: boolean; onReset?: () => void; children: ReactNode }) {
  // Switches sit beside the label at every width; other controls drop below it on small screens.
  if (inline)
    return (
      <div className="flex items-start gap-4 px-4 py-4 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="text-sm font-medium">{label ?? LABELS[k]}</span>
            {dirty ? <EditedTag /> : <SourceTag source={source} />}
            {onReset && !dirty && <ResetButton onClick={onReset} />}
          </div>
          {help && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{help}</p>}
        </div>
        <div className="flex h-10 shrink-0 items-center">{children}</div>
      </div>
    );
  return (
    <div className={cn("grid gap-3 px-4 py-4 sm:px-5", wide ? "md:grid-cols-[minmax(0,1fr)_22rem]" : "md:grid-cols-[minmax(0,1fr)_16rem]", "md:items-start md:gap-8")}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-sm font-medium">{label ?? LABELS[k]}</span>
          {dirty ? <EditedTag /> : <SourceTag source={source} />}
          {onReset && !dirty && <ResetButton onClick={onReset} />}
        </div>
        {help && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{help}</p>}
      </div>
      <div className="min-w-0 md:pt-px">{children}</div>
    </div>
  );
}

function EditedTag() {
  return <span className="inline-flex h-5 items-center rounded-full border border-warning/40 px-2 text-[11px] leading-none text-warning">edited, not saved</span>;
}

function ResetButton({ onClick }: { onClick(): void }) {
  return (
    <button className="-my-2 inline-flex h-8 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClick}>
      <RotateCcw className="size-3" />Reset to inherited
    </button>
  );
}

/** A non-negative whole number, or nothing (null): "no limit of its own". */
function LimitField({ value, onChange, ariaLabel }: { value: number | null; onChange(v: number | null): void; ariaLabel: string }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => setText((t) => (t.trim() === "" ? value == null : Number(t) === value) ? t : value == null ? "" : String(value)), [value]);
  const invalid = text.trim() !== "" && !/^\d+$/.test(text.trim());
  return (
    <div className="relative">
      <Input
        inputMode="numeric"
        value={text}
        placeholder="No limit of its own"
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const t = e.target.value.trim();
          if (t === "") onChange(null);
          else if (/^\d+$/.test(t)) onChange(Number(t));
        }}
        onBlur={() => invalid && setText(value == null ? "" : String(value))}
        className="tabular h-10 pr-16"
      />
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground">cards</span>
    </div>
  );
}

function NumberField({ value, onChange, min, max, step = 1, suffix, ariaLabel }: { value: number; onChange(v: number): void; min?: number; max?: number; step?: number; suffix?: string; ariaLabel: string }) {
  const [text, setText] = useState(String(value));
  // Keep partial input like "0." while typing; sync only when the value really changed.
  useEffect(() => setText((t) => (Number(t) === value && t.trim() !== "" ? t : String(value))), [value]);
  const invalid = text.trim() === "" || !Number.isFinite(Number(text)) || (min !== undefined && Number(text) < min) || (max !== undefined && Number(text) > max);
  return (
    <div className="relative">
      <Input
        inputMode="decimal"
        value={text}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) onChange(n);
        }}
        onBlur={() => invalid && setText(String(value))}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const n = Number(text) + (e.key === "ArrowUp" ? step : -step);
            if ((min === undefined || n >= min) && (max === undefined || n <= max)) onChange(Math.round(n * 1000) / 1000);
          }
        }}
        className={cn("tabular h-10", suffix && "pr-16")}
      />
      {suffix && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function ChoiceSelect({ value, onChange, options, ariaLabel }: { value: string; onChange(v: string): void; options: [string, string][]; ariaLabel: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-10 w-full" aria-label={ariaLabel}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => (
          <SelectItem key={v} value={v}>{l}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function WeightsGroup({ deck, value, inherited, source, dirty, onChange, onReset }: { deck: string; value: number[] | null; inherited: number[] | null; source: Source; dirty: boolean; onChange(w: number[] | null): void; onReset?: () => void }) {
  const [open, setOpen] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const optimize = async () => {
    setOptimizing(true);
    try {
      setResult(await api.optimizeWeights(deck));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setOptimizing(false);
    }
  };
  const fmt = (w: number[] | null) => JSON.stringify(w ?? DEFAULT_WEIGHTS).replace(/,/g, ", ");
  const [text, setText] = useState(fmt(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(fmt(value));
    setError(null);
  }, [JSON.stringify(value)]);

  const apply = (t: string) => {
    let w: unknown;
    try {
      w = JSON.parse(t);
    } catch {
      return setError("Not valid JSON. Expected an array like [0.212, 1.2931, …].");
    }
    if (!Array.isArray(w) || !w.every((n) => typeof n === "number" && Number.isFinite(n))) return setError("Expected an array of numbers.");
    if (w.length !== 21) return setError(`FSRS-6 uses 21 weights; this has ${w.length}.`);
    setError(null);
    onChange(same(w, DEFAULT_WEIGHTS) && !inherited ? null : (w as number[]));
  };

  return (
    <section>
      <button className="mb-2 flex h-10 w-full items-center gap-2 rounded text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        <h3 className="text-sm font-medium">Advanced: FSRS weights</h3>
        <span className="ml-auto text-xs text-muted-foreground">{value ? "Custom" : "FSRS-6 defaults"}</span>
      </button>
      {open && (
        <div className="rounded-xl border bg-card/40 px-4 py-4 sm:px-5">
          <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="text-sm font-medium">{LABELS.weights}</span>
            {dirty ? <EditedTag /> : <SourceTag source={source} />}
            {onReset && !dirty && <ResetButton onClick={onReset} />}
          </div>
          <p className="mb-3 text-[13px] leading-relaxed text-muted-foreground">
            The 21 parameters of the FSRS-6 memory model. Leave them at the defaults unless you've optimized them on your own review history (for example with the FSRS optimizer).
          </p>
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onBlur={() => apply(text)}
            spellCheck={false}
            aria-label="FSRS weights as a JSON array"
            aria-invalid={!!error || undefined}
            className="min-h-24 font-mono text-[12.5px] leading-relaxed"
          />
          {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="h-9" onClick={() => apply(text)}>Apply</Button>
            <Button variant="ghost" size="sm" className="h-9 text-muted-foreground" disabled={!value} onClick={() => onChange(null)}>Use FSRS-6 defaults</Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1.5 text-muted-foreground"
              onClick={() => navigator.clipboard?.writeText(JSON.stringify(value ?? DEFAULT_WEIGHTS)).then(() => toast.success("Copied weights"))}
            >
              <Copy className="size-3.5" />Copy
            </Button>
          </div>
          <div className="mt-4 border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Optimize</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">Fit the weights to your review history with the FSRS optimizer Anki uses. Every deck that shares these weights counts.</span>
              </div>
              <Button variant="outline" size="sm" className="h-9 gap-1.5" disabled={optimizing} onClick={optimize}>
                <RefreshCw className={cn("size-3.5", optimizing && "animate-spin")} />
                {optimizing ? "Optimizing…" : "Optimize"}
              </Button>
            </div>
            {result && <OptimizeReport result={result} onUse={() => { onChange(result.weights); setResult(null); toast.success(result.source.kind === "preset" ? "New weights in the draft: use Save to preset to share them." : "New weights in the draft: save them below."); }} />}
          </div>
        </div>
      )}
    </section>
  );
}

function OptimizeReport({ result, onUse }: { result: OptimizeResult; onUse(): void }) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return (
    <div className="mt-3 rounded-lg bg-background/60 px-3.5 py-3 text-[13px] leading-relaxed ring-1 ring-border">
      <p>
        {result.reviews.toLocaleString()} reviews of {result.cards.toLocaleString()} cards in {result.decks.length === 1 ? "1 deck" : `${result.decks.length} decks`}.
      </p>
      <p className="mt-1 text-muted-foreground">
        Log loss {result.before.logLoss.toFixed(3)} → <span className="text-foreground">{result.after.logLoss.toFixed(3)}</span> · RMSE {pct(result.before.rmse)} → <span className="text-foreground">{pct(result.after.rmse)}</span>
      </p>
      {result.better ? (
        <Button size="sm" className="mt-3 h-9" onClick={onUse}>Use these weights</Button>
      ) : (
        <p className="mt-2 text-muted-foreground">Your current weights already fit this history at least as well. Keep them.</p>
      )}
    </div>
  );
}

function PresetNameDialog({
  mode,
  preset,
  presets,
  onOpenChange,
  onCreate,
  onRename,
}: {
  mode: null | "create" | "rename";
  preset: Preset | null;
  presets: Preset[];
  onOpenChange(o: boolean): void;
  onCreate(name: string, id: string): Promise<void>;
  onRename(name: string): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (mode === "rename") setName(preset?.name ?? "");
    else if (mode === "create") setName("");
  }, [mode]);
  const id = useMemo(() => {
    const base = slug(name) || "preset";
    let s = base;
    for (let i = 2; presets.some((p) => p.id === s); i++) s = `${base}-${i}`;
    return s;
  }, [name, presets]);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (mode === "create") await onCreate(name.trim(), id);
      else await onRename(name.trim());
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New preset" : "Rename preset"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Starts from this deck's current effective settings. This deck switches to the new preset, and its own overrides move into it."
              : "Decks keep using it; only the name changes."}
          </DialogDescription>
        </DialogHeader>
        <div>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Preset name" className="h-10" />
          {mode === "create" && name.trim() && <p className="mt-1.5 text-xs text-muted-foreground">id: <span className="font-mono">{id}</span></p>}
        </div>
        <DialogFooter>
          <Button className="h-10" onClick={submit} disabled={!name.trim() || busy}>{mode === "create" ? "Create" : "Rename"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
