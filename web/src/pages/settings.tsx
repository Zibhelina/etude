import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Globe, Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { UpdateSettingsRow } from "@/components/update-bar";
import { Logo, Wordmark } from "@/components/logo";
import { cn } from "@/lib/utils";
import { serverless } from "@/lib/native";
import { PHONE_H1 } from "@/components/page";
import { ONBOARDING_EVENT } from "@/components/onboarding";
import { AiSection } from "@/components/settings-ai";
import { AppearanceSection } from "@/components/settings-appearance";
import { DataSection } from "@/components/settings-data";
import { CleanupSection } from "@/components/settings-cleanup";
import { ShortcutsSection } from "@/components/settings-shortcuts";
import { SyncSection } from "@/components/settings-sync";
import { AccountSection } from "@/components/settings-account";
import { Block, NumberField, Section } from "@/components/settings-ui";
import { draftOf, normalize, validate, type SettingsDraft, type SettingsResponse } from "@/components/settings-model";

const NAV = [
  { id: "about", label: "About" },
  { id: "ai", label: "AI grading" },
  { id: "appearance", label: "Appearance" },
  { id: "study", label: "Study" },
  { id: "data", label: "Data" },
  { id: "cleanup", label: "Clean up" },
  { id: "account", label: "Account" },
  { id: "sync", label: "Sync" },
  { id: "keys", label: "Keyboard" },
];

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

const ABOUT_LINKS = [
  { label: "GitHub", href: "https://github.com/Zibhelina/etude", icon: GithubMark },
  { label: "Website", href: "https://etude.study/", icon: Globe },
  { label: "Docs", href: "https://github.com/Zibhelina/etude/tree/main/docs", icon: BookOpen },
];

export function SettingsPage() {
  const [saved, setSaved] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState(NAV[0].id);
  const navRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    try {
      const s = (await api.settings()) as SettingsResponse;
      setSaved(s);
      setDraft(draftOf(s));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const errors = useMemo(() => (draft ? validate(draft) : {}), [draft]);
  const dirty = !!saved && !!draft && JSON.stringify(normalize(draft)) !== JSON.stringify(normalize(draftOf(saved)));
  const invalid = Object.keys(errors).length > 0;

  const save = useCallback(async () => {
    if (!draft || !dirty) return;
    if (invalid) {
      toast.error("Fix the highlighted fields first");
      return;
    }
    setSaving(true);
    try {
      await api.saveSettings(normalize(draft));
      // Reload so key status covers any new variable names.
      const s = (await api.settings()) as SettingsResponse;
      setSaved(s);
      setDraft(draftOf(s));
      toast.success("Settings saved");
    } catch (e) {
      toast.error("Couldn't save", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [draft, dirty, invalid]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [save]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // Highlight the section under the sticky nav.
  useEffect(() => {
    if (!saved) return;
    const onScroll = () => {
      const top = (navRef.current?.getBoundingClientRect().bottom ?? 0) + 120;
      let cur = NAV[0].id;
      for (const n of NAV) {
        const el = document.getElementById(n.id);
        if (el && el.getBoundingClientRect().top <= top) cur = n.id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = NAV[NAV.length - 1].id;
      setActive(cur);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [saved]);

  useEffect(() => {
    navRef.current?.querySelector(`[data-id="${active}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [active]);

  // /settings#sync (from first-run setup): open at that section once it has rendered.
  useEffect(() => {
    if (!saved || !location.hash) return;
    const id = decodeURIComponent(location.hash.slice(1));
    // Sections above it (Account, Sync's plan) load on their own and push it down: follow it until the page settles or the user scrolls.
    let userScrolled = false;
    const stop = () => (userScrolled = true);
    window.addEventListener("wheel", stop, { passive: true, once: true });
    window.addEventListener("touchmove", stop, { passive: true, once: true });
    const go = () => !userScrolled && document.getElementById(id)?.scrollIntoView({ block: "start" });
    const timers = [0, 250, 600, 1200, 2000].map((ms) => window.setTimeout(go, ms));
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchmove", stop);
    };
  }, [saved]);

  // Saved settings can't be invalid, so errors only show once something was edited.
  const shown = dirty ? errors : {};

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-10 max-md:pt-[calc(1.25rem+env(safe-area-inset-top))] sm:px-8">
      <div className="mb-6">
        <h1 className={cn("text-2xl font-semibold tracking-tight", PHONE_H1)}>Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">For the whole collection. Scheduling options live on each deck.</p>
      </div>

      {loadError && (
        <div className="rounded-xl border border-destructive/40 p-6 text-sm">
          <p className="text-destructive">Couldn't load settings: {loadError}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={load}>Try again</Button>
        </div>
      )}

      {!saved && !loadError && (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-9 w-80 max-w-full rounded-full" />
          <Skeleton className="h-80 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      )}

      {saved && draft && (
        <>
          <nav
            ref={navRef}
            className="sticky top-0 z-10 -mx-5 mb-8 flex gap-1.5 overflow-x-auto border-b bg-background px-5 py-3 [mask-image:linear-gradient(to_right,#000_85%,transparent)] [scrollbar-width:none] sm:-mx-8 sm:px-8 sm:[mask-image:none]"
            aria-label="Sections"
          >
            {NAV.map((n) => (
              <a
                key={n.id}
                data-id={n.id}
                href={`#${n.id}`}
                aria-current={active === n.id ? "true" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(n.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className={cn(
                  "flex h-10 shrink-0 items-center rounded-full border border-transparent px-4 text-sm text-muted-foreground transition-colors hover:text-foreground md:h-8 md:px-3.5",
                  active === n.id && "border-border bg-accent text-foreground",
                )}
              >
                {n.label}
              </a>
            ))}
          </nav>

          <div className="flex flex-col gap-12">
            <Section id="about" title="About">
              <Block>
                <div className="flex items-center gap-3.5">
                  <Logo tile className="size-11 shrink-0 rounded-[10px]" />
                  <div className="min-w-0 flex-1">
                    <Wordmark className="text-[1.35rem] leading-none" />
                    <div className="mt-1 text-xs text-muted-foreground">
                      Version <span className="font-mono text-[12px] text-foreground/90">{saved.version ?? "unknown"}</span> · FSRS-6 · AGPL-3.0
                    </div>
                  </div>
                </div>
                <UpdateSettingsRow />
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm" data-about-links>
                  {ABOUT_LINKS.map((l) => (
                    <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground">
                      <l.icon className="size-3.5" />
                      {l.label}
                    </a>
                  ))}
                </div>
                {!serverless() && <p className="text-xs text-muted-foreground">
                  From a terminal: <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px] text-foreground/85">etude update --check</code>
                </p>}
              </Block>
              <Block
                title="First-run setup"
                description="The questions Etude asks on a new install: AI grading, Sync, and something to start with. Your decks stay as they are."
                stackAside
                aside={
                  <Button variant="outline" size="sm" className="h-10 gap-1.5 md:h-8" onClick={() => window.dispatchEvent(new Event(ONBOARDING_EVENT))}>
                    <RotateCcw className="size-4" />
                    Run setup again
                  </Button>
                }
              />
            </Section>

            <AiSection ai={draft.ai} saved={saved} errors={shown} onChange={(ai) => setDraft({ ...draft, ai })} />

            <AppearanceSection />

            <Section id="study" title="Study">
              <Block>
                <div className="grid gap-4 sm:grid-cols-2">
                  <NumberField
                    label="Next day starts at"
                    suffix="h"
                    value={draft.dayStartHour}
                    error={shown.dayStartHour}
                    hint="Hour, 0–23. Reviews before this count toward the previous day."
                    onChange={(v) => setDraft({ ...draft, dayStartHour: v })}
                  />
                  <NumberField
                    label="Learn-ahead limit"
                    suffix="min"
                    value={draft.learnAheadMinutes}
                    error={shown.learnAheadMinutes}
                    hint="When nothing else is due, learning cards due this soon are shown early."
                    onChange={(v) => setDraft({ ...draft, learnAheadMinutes: v })}
                  />
                </div>
              </Block>
            </Section>

            <DataSection dbPath={saved.dbPath} mediaDir={saved.mediaDir} />

            <CleanupSection />
            <AccountSection />
            <SyncSection />

            <ShortcutsSection />

          </div>

          <div
            className={cn(
              "sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 -mx-5 mt-10 flex items-center gap-2 border-t bg-background/95 px-5 py-3 backdrop-blur transition-opacity sm:-mx-8 sm:px-8 md:bottom-0",
              dirty ? "opacity-100" : "pointer-events-none opacity-0",
            )}
            aria-hidden={!dirty}
          >
            <span className="min-w-0 truncate text-sm">{invalid ? <span className="text-destructive">Some fields need fixing</span> : <span className="text-muted-foreground">Unsaved changes</span>}</span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" className="h-10 gap-1.5 md:h-8" onClick={() => setDraft(draftOf(saved))} tabIndex={dirty ? 0 : -1}>
              <RotateCcw className="size-4" />Discard
            </Button>
            <Button size="sm" className="h-10 gap-1.5 md:h-8" onClick={save} disabled={saving || invalid} tabIndex={dirty ? 0 : -1}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}Save <kbd className="hidden text-[10px] opacity-60 sm:inline">Ctrl S</kbd>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
