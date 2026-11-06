import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight, Clock, Database, Globe, Info, Keyboard, Loader2, MessageSquareCheck, Palette, RotateCcw, Save, Search, Shield, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { UpdateSettingsRow } from "@/components/update-bar";
import { Logo, Wordmark } from "@/components/logo";
import { cn } from "@/lib/utils";
import { serverless } from "@/lib/native";
import { ONBOARDING_EVENT } from "@/components/onboarding";
import { AiSection } from "@/components/settings-ai";
import { AppearanceSection } from "@/components/settings-appearance";
import { DataSection } from "@/components/settings-data";
import { CleanupSection } from "@/components/settings-cleanup";
import { ShortcutsSection } from "@/components/settings-shortcuts";
import { SyncSection } from "@/components/settings-sync";
import { ACCOUNT_EVENT, AccountSection } from "@/components/settings-account";
import { DesktopSection } from "@/components/settings-desktop";
import { PrivacySection } from "@/components/settings-privacy";
import { canShowPurchases, desktopApp } from "@/lib/platform";
import { account, type AccountStatus } from "@/lib/account";
import { currentTheme, THEME_EVENT } from "@/lib/theme";
import { Block, Group, NumberField, REVEAL_EVENT, SettingsPageContext } from "@/components/settings-ui";
import { draftOf, matchPreset, normalize, validate, type SettingsDraft, type SettingsResponse } from "@/components/settings-model";

// Desktop shows every section on one scrolling page with a table of contents; iPad (or a narrow window) shows
// a section list beside one section; a phone shows the list, and a tap opens the section on its own page.
type Mode = "page" | "split" | "phone";

const GROUPS = [
  { id: "account", label: "Account & Sync", icon: UserRound },
  { id: "study", label: "Study", icon: Clock },
  { id: "ai", label: "AI grading", icon: MessageSquareCheck },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "data", label: "Data", icon: Database },
  { id: "privacy", label: "Privacy", icon: Shield },
  { id: "keys", label: "Keyboard", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
] as const;
type GroupId = (typeof GROUPS)[number]["id"];
const isGroup = (id: string): id is GroupId => GROUPS.some((g) => g.id === id);
const groupLabel = (id: GroupId) => GROUPS.find((g) => g.id === id)!.label;

/** Old anchors (/settings#sync from first-run setup) and the inner sections they point at. */
const ANCHOR_GROUP: Record<string, GroupId> = { sync: "account", account: "account", cleanup: "data", desktop: "about" };

/** What search knows: [section, row title as shown, extra words]. A row inside a fold names the fold. */
const INDEX: { g: GroupId; label: string; words: string; fold?: string }[] = [
  { g: "account", label: "Sync", words: "sync now synced encrypted devices storage plan subscription billing server folder" },
  { g: "account", label: "Sign in or create an account", words: "account email login sign in code" },
  { g: "account", label: "Passkeys", words: "passkey fingerprint face touch id login" },
  { g: "account", label: "Devices", words: "device iphone mac sign out" },
  { g: "account", label: "Your data", words: "download export delete account gdpr" },
  { g: "account", label: "Selling decks", words: "sell market creator payouts" },
  { g: "study", label: "Next day starts at", words: "midnight hour late night day start reviews count" },
  { g: "study", label: "Learn-ahead limit", words: "learn ahead early learning cards minutes" },
  { g: "ai", label: "Who grades your answers", words: "provider openrouter openai chatgpt local ollama preset quick setup" },
  { g: "ai", label: "API keys", words: "key token openrouter openai" },
  { g: "ai", label: "ChatGPT plan", words: "chatgpt plus pro sign in" },
  { g: "ai", label: "Feedback", words: "feedback automatically language explanation" },
  { g: "ai", label: "Assistant", words: "ask etude agent chat model reasoning effort thinking" },
  { g: "ai", label: "Test", words: "test try check grading works" },
  { g: "ai", label: "Decision model", words: "decision verdict model url timeout endpoint advanced", fold: "ai-endpoints" },
  { g: "ai", label: "Feedback model", words: "feedback model url timeout temperature endpoint advanced", fold: "ai-endpoints" },
  { g: "ai", label: "Vision model", words: "vision drawings images endpoint advanced", fold: "ai-endpoints" },
  { g: "appearance", label: "Theme", words: "theme dark light mode system night snow paper midnight colour color" },
  { g: "appearance", label: "Accent color", words: "accent color colour highlight primary button tint brand" },
  { g: "appearance", label: "Fun mode", words: "fun minimi cat mascot" },
  { g: "appearance", label: "Minimi's personality", words: "minimi personality character behaviour behavior tone voice mascot prompt" },
  { g: "appearance", label: "Custom themes", words: "custom theme css editor import market" },
  { g: "data", label: "Backup", words: "backup download restore copy database" },
  { g: "data", label: "Import packs", words: "import anki apkg colpkg pack" },
  { g: "data", label: "Export", words: "export pack share" },
  { g: "data", label: "Leftover cards", words: "clean up orphan leftover" },
  { g: "data", label: "Unused media", words: "clean up media files images audio" },
  { g: "privacy", label: "Send error reports", words: "crash errors telemetry" },
  { g: "privacy", label: "Share usage stats", words: "usage analytics telemetry" },
  { g: "keys", label: "Studying", words: "shortcuts keyboard space enter undo bury suspend keys" },
  { g: "keys", label: "Anywhere", words: "shortcuts keyboard ask search sidebar keys" },
  { g: "about", label: "Etude", words: "version update check new about" },
  { g: "about", label: "First-run setup", words: "setup onboarding first run again" },
  { g: "about", label: "The etude command", words: "cli terminal command line agents" },
  { g: "about", label: "Logs", words: "logs debug problem report" },
];

function searchHits(q: string) {
  const w = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!w.length) return [];
  return INDEX.filter((e) => desktopApp() || (e.label !== "The etude command" && e.label !== "Logs"))
    .filter((e) => {
      const t = `${e.label} ${e.words} ${groupLabel(e.g)}`.toLowerCase();
      return w.every((v) => t.includes(v));
    })
    .slice(0, 8);
}
type Hit = (typeof INDEX)[number];

function Marked({ text, q }: { text: string; q: string }) {
  const words = q.trim().split(/\s+/).filter((v) => v.length > 1);
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  return <>{text.split(re).map((part, i) => (i % 2 ? <b key={i} className="font-bold text-foreground">{part}</b> : part))}</>;
}

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

const hour12 = (h: number) => (h === 0 ? "midnight" : h < 12 ? `${h} am` : h === 12 ? "noon" : `${h - 12} pm`);
const PRESET_NAME = { openrouter: "OpenRouter", openai: "OpenAI", chatgpt: "your ChatGPT plan", local: "a model on this computer" } as const;

function useMode(ref: React.RefObject<HTMLElement | null>): Mode {
  const phoneQuery = "(max-width: 767px)";
  const [phone, setPhone] = useState(() => matchMedia(phoneQuery).matches);
  const [wide, setWide] = useState(() => window.innerWidth >= 1280);
  useEffect(() => {
    const mq = matchMedia(phoneQuery);
    const h = () => setPhone(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  useLayoutEffect(() => {
    // Measure the page's container: it stays put while this page swaps layouts inside it.
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= 1000));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return phone ? "phone" : wide ? "page" : "split";
}

/** Scroll so `el` sits a little below the top, then flash its row. */
function land(el: Element | null, smooth = true) {
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 96;
  window.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  const row = el.closest("[data-settings-row]") ?? el;
  row.classList.remove("settings-flash");
  void (row as HTMLElement).offsetWidth;
  row.classList.add("settings-flash");
}

function findRow(g: GroupId, label: string): Element | null {
  const root = document.querySelector(`[data-group="${g}"]`);
  if (!root) return null;
  const want = label.toLowerCase();
  const titles = [...root.querySelectorAll("[data-settings-title], [data-settings-section]")];
  return (
    titles.find((t) => (t.getAttribute("aria-label") ?? t.textContent ?? "").trim().toLowerCase() === want) ??
    titles.find((t) => (t.getAttribute("aria-label") ?? t.textContent ?? "").trim().toLowerCase().startsWith(want)) ??
    root
  );
}

export function SettingsPage() {
  const [saved, setSaved] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acct, setAcct] = useState<AccountStatus | null>(null);
  const [themeName, setThemeName] = useState(() => currentTheme().name);
  const rootRef = useRef<HTMLDivElement>(null);
  const mode = useMode(rootRef);
  const initial = decodeURIComponent(location.hash.slice(1));
  const initialGroup: GroupId | null = isGroup(initial) ? initial : ANCHOR_GROUP[initial] ?? null;
  // The section shown in split and phone mode (null on a phone: the list), and the one under the TOC on desktop.
  const [active, setActive] = useState<GroupId | null>(initialGroup);
  const [spy, setSpy] = useState<GroupId>(initialGroup ?? "account");
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

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

  // Only for the opening sentence and the phone's account row; the Account section loads its own.
  useEffect(() => {
    const get = () => account.status().then(setAcct, () => setAcct(null));
    void get();
    window.addEventListener(ACCOUNT_EVENT, get);
    return () => window.removeEventListener(ACCOUNT_EVENT, get);
  }, []);
  useEffect(() => {
    const h = () => setThemeName(currentTheme().name);
    window.addEventListener(THEME_EVENT, h);
    return () => window.removeEventListener(THEME_EVENT, h);
  }, []);

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
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]");
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && !typing && mode === "phone" && active) {
        backToList();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // Split mode always shows a section; a phone starts on the list unless a link named one.
  useEffect(() => {
    if (mode === "split" && !active) setActive(spy);
  }, [mode, active, spy]);

  // A phone opens a section as a new history entry, so the system back gesture returns to the list.
  useEffect(() => {
    const h = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      const g = isGroup(id) ? id : ANCHOR_GROUP[id] ?? null;
      setActive((cur) => (mode === "phone" ? g : g ?? cur));
    };
    window.addEventListener("popstate", h);
    return () => window.removeEventListener("popstate", h);
  }, [mode]);

  // Only step back through history when this page added the entry; a deep link just returns to the list.
  const pushed = useRef(false);
  const push = (g: GroupId) => {
    history.pushState({ settings: g }, "", `#${g}`);
    pushed.current = true;
  };
  const backToList = () => {
    if (pushed.current && history.state?.settings) {
      pushed.current = false;
      history.back();
    } else {
      history.replaceState(null, "", location.pathname + location.search);
      setActive(null);
    }
  };

  const open = (g: GroupId) => {
    setQ("");
    if (mode === "page") {
      setSpy(g);
      history.replaceState(null, "", `#${g}`);
      jumping.current = window.setTimeout(() => (jumping.current = null), 900);
      document.querySelector(`[data-group="${g}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (mode === "phone") push(g);
    else history.replaceState(null, "", `#${g}`);
    setActive(g);
    setSpy(g);
    window.scrollTo(0, 0);
  };

  const pending = useRef<Hit | null>(null);
  const goHit = (h: Hit) => {
    setQ("");
    searchRef.current?.blur();
    if (h.fold) window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: h.fold }));
    if (mode === "page") {
      setSpy(h.g);
      jumping.current = window.setTimeout(() => (jumping.current = null), 900);
      requestAnimationFrame(() => land(findRow(h.g, h.label)));
      return;
    }
    if (mode === "phone" && active !== h.g) push(h.g);
    pending.current = h;
    setActive(h.g);
    setSpy(h.g);
  };
  // After a search hit opens its section: the fold is revealed on mount, then land on the row.
  useEffect(() => {
    const h = pending.current;
    if (!h || active !== h.g) return;
    pending.current = null;
    if (h.fold) window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: h.fold }));
    const t = window.setTimeout(() => land(findRow(h.g, h.label), false), 60);
    return () => window.clearTimeout(t);
  }, [active]);

  // Desktop: highlight the section at the top of the window in the table of contents.
  const jumping = useRef<number | null>(null);
  useEffect(() => {
    if (!saved || mode !== "page") return;
    const onScroll = () => {
      if (jumping.current) return;
      let cur: GroupId = GROUPS[0].id;
      for (const g of GROUPS) {
        const el = document.querySelector(`[data-group="${g.id}"]`);
        if (el && el.getBoundingClientRect().top <= 180) cur = g.id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = GROUPS[GROUPS.length - 1].id;
      setSpy(cur);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [saved, mode]);

  // /settings#sync (from first-run setup): open at that spot once it has rendered. Sections above it load on their
  // own and push it down, so follow it until the page settles or the user scrolls.
  useEffect(() => {
    if (!saved || !initial) return;
    let userScrolled = false;
    const stop = () => (userScrolled = true);
    window.addEventListener("wheel", stop, { passive: true, once: true });
    window.addEventListener("touchmove", stop, { passive: true, once: true });
    const go = () => {
      if (userScrolled) return;
      const el = isGroup(initial) ? document.querySelector(`[data-group="${initial}"]`) : document.getElementById(initial);
      if (!el) return;
      if (mode === "page" || !isGroup(initial)) el.scrollIntoView({ block: "start" });
    };
    const timers = [0, 250, 600, 1200, 2000].map((ms) => window.setTimeout(go, ms));
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchmove", stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  // Saved settings can't be invalid, so errors only show once something was edited.
  const shown = dirty ? errors : {};

  if (!saved || !draft) {
    return (
      <div ref={rootRef} className="mx-auto w-full max-w-[1140px] px-5 py-10 max-md:pt-[calc(1.25rem+env(safe-area-inset-top))] sm:px-8 lg:px-12">
        <h1 className="score-serif score-display mb-6 text-[2rem] leading-[1.1] text-foreground">Settings</h1>
        {loadError ? (
          <div className="rounded-[14px] p-6 text-sm ring-1 ring-destructive/40 ring-inset">
            <p className="text-destructive">Couldn't load settings: {loadError}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={load}>Try again</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-6 w-80 max-w-full" />
            <Skeleton className="h-80 w-full rounded-[14px]" />
            <Skeleton className="h-40 w-full rounded-[14px]" />
          </div>
        )}
      </div>
    );
  }

  const signedIn = !!acct?.signedIn && !!acct.me;
  const email = acct?.me?.email ?? acct?.email ?? null;
  const preset = matchPreset(draft.ai, saved.defaults?.ai);
  const day = draft.dayStartHour;
  const dayOk = typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 23;

  const intro: Record<GroupId, React.ReactNode> = {
    account: signedIn ? (
      <>Signed in as <b>{email}</b>. Sync keeps the same collection on every device you sign in on, encrypted.</>
    ) : (
      <>You're not signed in, and that's fine. Everything works without an account. You only need one for <b>Sync</b> and <b>paid decks</b>.</>
    ),
    study: dayOk ? (
      <>Your day starts at <b>{hour12(day)}</b>{day > 0 && day < 7 ? `, so a session just after midnight still counts as the day before` : ""}. New cards a day and the scheduler live with each deck.</>
    ) : (
      <>When your study day starts, and how early learning cards come back. New cards a day and the scheduler live with each deck.</>
    ),
    ai: !draft.ai.feedback ? (
      <>AI grading is <b>off</b>. Open answers show the reference and you rate yourself.</>
    ) : preset ? (
      <>Typed answers and drawings are graded by <b>{PRESET_NAME[preset]}</b>. You can switch any time; your cards don't change.</>
    ) : (
      <>Typed answers and drawings are graded by your own setup. Its models and endpoints are at the bottom.</>
    ),
    appearance: (
      <>
        You're using <b>{themeName}</b>. The theme is saved with your collection, so every device and the CLI look the same, and cards follow it too.
      </>
    ),
    data: serverless() ? (
      <>Your cards, history and media live in this browser. Keep a backup, or turn on Sync.</>
    ) : (
      <>Your cards, history and media live in one file on this computer. Back it up, bring cards in, or tidy what's left over.</>
    ),
    privacy: <>Etude never sends what you study. The two switches below are anonymous and help fix bugs.</>,
    keys: <>Etude works without a mouse. These are every shortcut, by where they work.</>,
    about: (
      <>
        Etude <b>{saved.version ?? ""}</b>, open source under AGPL-3.0.
      </>
    ),
  };

  const summary: Record<GroupId, string> = {
    account: signedIn ? `${email ?? "Signed in"}` : "Not signed in",
    study: dayOk ? `Day starts at ${hour12(day)}` : "Day start, learn ahead",
    ai: !draft.ai.feedback ? "Off" : preset ? { openrouter: "OpenRouter", openai: "OpenAI", chatgpt: "ChatGPT plan", local: "On this computer" }[preset] : "Your own setup",
    appearance: themeName,
    data: "Backup, import, clean up",
    privacy: "What Etude sends",
    keys: "Every shortcut",
    about: `Version ${saved.version ?? ""}`.trim(),
  };

  const body = (g: GroupId) => {
    switch (g) {
      case "account":
        return (
          <SettingsPageContext.Provider value="account-sync">
            <SyncSection />
            <AccountSection />
          </SettingsPageContext.Provider>
        );
      case "study":
        return (
          <Group>
            <Block
              title="Next day starts at"
              description="Hour, 0–23. Reviews before this count toward the day before."
              stackAside
              aside={<NumberField label="Next day starts at" hideLabel className="sm:w-32" suffix="h" value={draft.dayStartHour} error={shown.dayStartHour} onChange={(v) => setDraft({ ...draft, dayStartHour: v })} />}
            />
            <Block
              title="Learn-ahead limit"
              description="When nothing else is due, learning cards due this soon come early."
              stackAside
              aside={<NumberField label="Learn-ahead limit" hideLabel className="sm:w-32" suffix="min" value={draft.learnAheadMinutes} error={shown.learnAheadMinutes} onChange={(v) => setDraft({ ...draft, learnAheadMinutes: v })} />}
            />
          </Group>
        );
      case "ai":
        return <AiSection ai={draft.ai} saved={saved} errors={shown} onChange={(ai) => setDraft({ ...draft, ai })} />;
      case "appearance":
        return <AppearanceSection />;
      case "data":
        return (
          <>
            <DataSection dbPath={saved.dbPath} mediaDir={saved.mediaDir} />
            <CleanupSection />
          </>
        );
      case "privacy":
        return <PrivacySection />;
      case "keys":
        return <ShortcutsSection />;
      case "about":
        return (
          <>
            <Group>
              <Block>
                <div className="flex items-center gap-3.5">
                  <Logo tile className="size-11 shrink-0 rounded-[12px]" />
                  <div className="min-w-0 flex-1">
                    <span data-settings-title className="sr-only">Etude</span>
                    <Wordmark className="text-[1.35rem] leading-none" />
                    <div className="mt-1 text-[13px] text-muted-foreground">
                      Version <span className="font-mono text-[12px] text-foreground/90">{saved.version ?? "unknown"}</span> · FSRS-6 · AGPL-3.0
                    </div>
                  </div>
                </div>
                <UpdateSettingsRow />
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm" data-about-links>
                  {/* The website sells Sync and paid decks, so the store apps don't link to it. */}
                  {ABOUT_LINKS.filter((l) => canShowPurchases() || l.label !== "Website").map((l) => (
                    <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-muted-foreground transition-colors hover:text-foreground">
                      <l.icon className="size-3.5" />
                      {l.label}
                    </a>
                  ))}
                </div>
                {!serverless() && (
                  <p className="text-[13px] text-muted-foreground">
                    From a terminal: <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px] text-foreground/85">etude update --check</code>
                  </p>
                )}
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
            </Group>
            <DesktopSection />
          </>
        );
    }
  };

  const sectionView = (g: GroupId, headingLevel: "h1" | "h2" = "h2") => {
    const H = headingLevel;
    return (
      <section key={g} data-group={g} aria-labelledby={`settings-h-${g}`} className="scroll-mt-6">
        <H id={`settings-h-${g}`} className={cn("score-serif score-display text-foreground", H === "h1" ? "text-[2rem] leading-[1.1]" : "text-[1.625rem] leading-[1.15] max-lg:text-[1.5rem]")}>
          {groupLabel(g)}
        </H>
        <p data-settings-intro className="mt-2 mb-6 max-w-[600px] text-[15px] leading-normal text-pretty text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">
          {intro[g]}
        </p>
        <SettingsPageContext.Provider value={g}>
          <div className="flex flex-col gap-7">{body(g)}</div>
        </SettingsPageContext.Provider>
      </section>
    );
  };

  const hits = searchHits(q);
  const searchBox = (placeholder: string, className?: string, big = false) => (
    <div className={cn("relative", className)}>
      <Search className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground", big ? "left-4 size-[18px]" : "left-3 size-4")} />
      <input
        ref={searchRef}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) {
            e.preventDefault();
            goHit(hits[0]);
          } else if (e.key === "Escape") {
            setQ("");
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder}
        aria-label="Search settings"
        autoComplete="off"
        spellCheck={false}
        className={cn("w-full rounded-[10px] bg-card pr-9 pl-9 text-[16px] text-foreground ring-[1.5px] ring-border outline-none ring-inset placeholder:text-muted-foreground focus:ring-foreground/40 md:text-[14.5px] [&::-webkit-search-cancel-button]:hidden", big ? "h-12 rounded-[12px] pl-11 pr-12 md:text-[15.5px]" : "h-10")}
      />
      {big && !q && (
        <kbd className="pointer-events-none absolute top-1/2 right-3 grid h-6 min-w-6 -translate-y-1/2 place-items-center rounded-md px-1.5 font-mono text-[12px] text-muted-foreground ring-1 ring-border ring-inset">/</kbd>
      )}
      {q && (
        <button type="button" aria-label="Clear search" onClick={() => setQ("")} className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
  const results = (
    <div role="listbox" aria-label="Search results" data-settings-results className="flex flex-col gap-0.5">
      {hits.length ? (
        hits.map((h) => (
          <button
            key={`${h.g}-${h.label}`}
            role="option"
            aria-selected={false}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => goHit(h)}
            className="flex flex-col items-start gap-px rounded-[10px] px-3 py-2 text-left text-[14.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <span><Marked text={h.label} q={q} /></span>
            <span className="text-xs font-medium text-muted-foreground/80">{groupLabel(h.g)}</span>
          </button>
        ))
      ) : (
        <p className="px-3 py-2 text-[13.5px] leading-snug text-muted-foreground">Nothing called “{q}”. Try “dark”, “backup” or “sync”.</p>
      )}
    </div>
  );

  const saveBar = (
    <div
      className={cn(
        "sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 mt-10 flex items-center gap-2 rounded-[14px] bg-card/95 px-4 py-2.5 shadow-[0_8px_30px_rgb(0_0_0/0.12)] ring-1 ring-border backdrop-blur ring-inset transition-opacity md:bottom-4",
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
  );

  if (mode === "phone") {
    return (
      <div ref={rootRef} className="mx-auto w-full max-w-xl px-5 pt-[calc(1.25rem+env(safe-area-inset-top))] pb-6" data-settings-mode="phone">
        {active ? (
          <>
            <button
              type="button"
              onClick={backToList}
              className="-ml-1.5 mb-3 inline-flex h-10 items-center gap-0.5 pr-2 text-[15px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="size-5" />
              Settings
            </button>
            {sectionView(active, "h1")}
          </>
        ) : (
          <>
            <h1 className="score-serif score-display mb-4 text-[2rem] leading-[1.1] text-foreground">Settings</h1>
            {searchBox("Search settings", "mb-3")}
            {q ? (
              <div className="rounded-[14px] bg-card p-1.5 ring-1 ring-border ring-inset">{results}</div>
            ) : (
              <nav aria-label="Sections" className="flex flex-col gap-[18px]">
                <PhoneList>
                  <PhoneRow onClick={() => open("account")} icon={signedIn ? <span className="grid size-8 place-items-center rounded-full bg-muted text-sm font-bold text-foreground ring-1 ring-border ring-inset">{(acct?.me?.displayName || email || "?").slice(0, 1).toUpperCase()}</span> : undefined} Icon={signedIn ? undefined : UserRound} title={signedIn ? acct?.me?.displayName || email || "Account" : "Account & Sync"} sub={signedIn ? `${email ?? ""}${acct?.me?.sync.active ? " · Sync on" : ""}` : "Not signed in"} />
                </PhoneList>
                <PhoneList>
                  {GROUPS.filter((g) => g.id !== "account").map((g) => (
                    <PhoneRow key={g.id} onClick={() => open(g.id)} Icon={g.icon} title={g.label} sub={summary[g.id]} />
                  ))}
                </PhoneList>
              </nav>
            )}
          </>
        )}
        {saveBar}
      </div>
    );
  }

  if (mode === "split") {
    const cur = active ?? spy;
    return (
      <div ref={rootRef} className="mx-auto w-full max-w-[1040px] px-8 py-10" data-settings-mode="split">
        <h1 className="score-serif score-display mb-6 text-[2rem] leading-[1.1] text-foreground">Settings</h1>
        <div className="grid grid-cols-[200px_minmax(0,1fr)] items-start gap-8">
          <nav aria-label="Sections" className="sticky top-6 flex flex-col gap-0.5">
            {searchBox("Search", "mb-3")}
            {q
              ? results
              : GROUPS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    data-id={g.id}
                    aria-current={cur === g.id ? "page" : undefined}
                    onClick={() => open(g.id)}
                    className={cn(
                      "flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[14.5px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                      cur === g.id && "font-semibold text-foreground",
                    )}
                  >
                    <g.icon className="size-[18px] shrink-0" strokeWidth={1.9} />
                    <span className="truncate">{g.label}</span>
                  </button>
                ))}
          </nav>
          <div className="min-w-0 max-w-[660px]">
            {sectionView(cur)}
            {saveBar}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="mx-auto w-full max-w-[1140px] px-12 py-10" data-settings-mode="page">
      <div className="grid grid-cols-[minmax(0,1fr)_180px] items-start gap-x-14">
        <div className="relative mb-11">
          <h1 className="score-serif score-display mb-5 text-[2rem] leading-[1.1] text-foreground">Settings</h1>
          {searchBox("Search settings", undefined, true)}
          {q && <div className="absolute top-full right-0 left-0 z-30 mt-2 rounded-[14px] bg-popover p-1.5 shadow-[0_10px_30px_rgb(0_0_0/0.14)] ring-1 ring-border ring-inset">{results}</div>}
        </div>
        <div />
        <div className="flex min-w-0 flex-col gap-[54px]">
          {GROUPS.map((g) => sectionView(g.id))}
          {saveBar}
        </div>
        <nav aria-label="On this page" className="sticky top-8 flex flex-col gap-px pt-1">
          <div className="px-2.5 pb-2 text-[11.5px] font-bold tracking-[0.12em] text-muted-foreground/70 uppercase">On this page</div>
          {GROUPS.map((g) => (
            <a
              key={g.id}
              href={`#${g.id}`}
              data-id={g.id}
              aria-current={spy === g.id ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                open(g.id);
              }}
              className={cn("rounded-lg px-2.5 py-1.5 text-[14px] text-muted-foreground transition-colors hover:text-foreground", spy === g.id && "font-semibold text-foreground")}
            >
              {g.label}
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}

function PhoneList({ children }: { children: React.ReactNode }) {
  return <div className="settings-card overflow-hidden rounded-[14px] bg-card ring-1 ring-border ring-inset">{children}</div>;
}

function PhoneRow({ title, sub, Icon, icon, onClick }: { title: string; sub: string; Icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>; icon?: React.ReactNode; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="settings-block relative flex min-h-[66px] w-full items-center gap-3.5 px-4 py-3 text-left transition-colors active:bg-accent"
    >
      {icon ?? (Icon && (
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-muted text-foreground">
          <Icon className="size-[18px]" strokeWidth={1.9} />
        </span>
      ))}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15.5px] font-medium text-foreground">{title}</span>
        <span className="mt-px block truncate text-[13px] text-muted-foreground">{sub}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
    </button>
  );
}
