// First-run setup: comfort level, AI grading, Sync, your picture and name, then something to study. Every step can
// be skipped, and everything chosen here is in Settings afterwards. The comfort level only changes what this flow
// offers; it doesn't hide anything elsewhere in the app.
//
// Layout and motion ("E · Open", Design Lab round 25): the question sits on the page in one 520 px column, the main
// button stays in one spot at the bottom, and each step morphs into the next (onboarding-ui.tsx).
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ChevronLeft,
  CircleCheck,
  CircleHelp,
  Coffee,
  Download,
  FileInput,
  Folder,
  Key,
  Loader2,
  CalendarClock,
  CalendarDays,
  MessageCircle,
  NotebookText,
  Server,
  SlidersHorizontal,
  Smartphone,
  Star,
  Terminal,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { Logo, Wordmark } from "@/components/logo";
import { Input } from "@/components/ui/input";
import { CopyValue } from "@/components/settings-ui";
import { useChatGptSignIn } from "@/components/settings-chatgpt";
import { ACCOUNT_EVENT } from "@/components/settings-account";
import { ChooseFolder } from "@/components/settings-sync";
import { presetAi, type AiSettings, type OnboardingLevel, type PresetId, type SettingsResponse, type TestResult } from "@/components/settings-model";
import { useImportPicker } from "@/pages/decks";
import { announceDataChange } from "@/components/agent-panel";
import { api } from "@/lib/api";
import { account, openOutside } from "@/lib/account";
import { chatGptSignInHere, saveApiKey, serverless } from "@/lib/native";
import { canShowPurchases, isNativeApp } from "@/lib/platform";
import { canBuyInApp, inAppProductIds } from "@/lib/storekit";
import { AppStorePlans } from "@/components/app-store-plans";
import { etudeFetch } from "@/lib/transport";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { NATIVE_COPY } from "@/lib/native-copy";
import { AvatarStep } from "@/components/avatar-studio";
import { AvatarPic } from "@/components/avatar";
import { avatarLabel, useAvatar, useMyName } from "@/lib/avatar";
import { useFunMode } from "@/lib/fun";
import { track } from "@/lib/telemetry";
import { BackCtx, FootSlot, Foot, Ghost, MorphCtx, Note, Option, Options, Primary, Problem, Steps, Title, fieldClass, useMorph } from "@/components/onboarding-ui";
import cheer from "@/assets/library/minimi-cheer.webp";

/** Settings → About → Run setup again. */
export const ONBOARDING_EVENT = "etude:onboarding";

type Step = "welcome" | "avatar" | "level" | "ai" | "accounts" | "setup" | "sync" | "done";
type Account = "chatgpt" | "openrouter" | "openai" | "local" | "none";
type SyncChoice = "cloud" | "folder" | "server" | "device";
type AiOutcome = { preset: PresetId | null; tested: boolean } | "off" | "later";
type SyncOutcome = { choice: SyncChoice; next: string | null } | "skipped";

const DEFAULT_SYNC_SERVER = "https://sync.etude.study";
const OPENROUTER_KEYS = "https://openrouter.ai/keys";
const OPENAI_KEYS = "https://platform.openai.com/api-keys";

const LEVELS: { id: OnboardingLevel; icon: typeof Coffee; title: string; hint: string }[] = [
  { id: "simple", icon: Coffee, title: "Keep it simple", hint: "Just let me study. Hide the knobs." },
  { id: "standard", icon: SlidersHorizontal, title: "I know my way around", hint: "Show the useful settings, explain the new ones." },
  { id: "tinker", icon: Terminal, title: "I like to tinker", hint: "Everything: custom card types, schedulers, API keys, the CLI." },
];
const levelTitle = (l: OnboardingLevel) => LEVELS.find((x) => x.id === l)!.title;

const PRESET_LABEL: Record<PresetId, string> = { chatgpt: "ChatGPT", openrouter: "OpenRouter", openai: "OpenAI", local: "Local server", commandcode: "Command Code" };
const KEY_ENV: Record<"openrouter" | "openai", string> = { openrouter: "OPENROUTER_API_KEY", openai: "OPENAI_API_KEY" };

/** The one path the ticked boxes lead to: ChatGPT, then OpenRouter, then OpenAI, then a local server. */
function pickPath(ticked: Set<Account>): Account {
  for (const a of ["chatgpt", "openrouter", "openai", "local"] as const) if (ticked.has(a)) return a;
  return "none";
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await etudeFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : data?.error?.message ?? res.statusText);
  return data as T;
}

const fmtSec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE_OUT = "cubic-bezier(.2,.8,.2,1)";

/** What the column looked like right before a change, for the morph. */
type Snap = { clone: HTMLElement; h: number; top: number; left: number; w: number; back: boolean };

export function Onboarding({ onFinish }: { onFinish(): void }) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [history, setHistory] = useState<Step[]>(["welcome"]);
  const step = history[history.length - 1];
  const [level, setLevel] = useState<OnboardingLevel>("standard");
  const [wantsAi, setWantsAi] = useState<boolean | null>(true);
  const [ticked, setTicked] = useState<Set<Account>>(new Set());
  const [ai, setAi] = useState<AiOutcome | null>(null);
  const [sync, setSync] = useState<SyncOutcome | null>(null);
  /** Came in through "Sign in to Sync": only the Sync step. */
  const [syncOnly, setSyncOnly] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const [foot, setFoot] = useState<HTMLElement | null>(null);
  const backHandler = useRef<(() => boolean) | null>(null);

  useEffect(() => {
    api.settings().then((s: SettingsResponse) => {
      setSettings(s);
      if (s.onboarding?.level) setLevel(s.onboarding.level);
    }).catch(() => {});
  }, []);

  // ---- the morph between steps
  const pending = useRef<Snap | null>(null);
  const [, setTick] = useState(0);
  const morph = useCallback((back = false) => {
    const c = col.current;
    if (!c || reducedMotion()) return;
    const clone = c.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[id]").forEach((e) => e.removeAttribute("id"));
    clone.removeAttribute("data-ob-col");
    clone.setAttribute("aria-hidden", "true");
    clone.setAttribute("inert", "");
    clone.setAttribute("data-ob-old", "");
    pending.current = { clone, h: c.offsetHeight, top: c.offsetTop - (stage.current?.scrollTop ?? 0), left: c.offsetLeft, w: c.offsetWidth, back };
    setTick((t) => t + 1);
  }, []);

  useLayoutEffect(() => {
    const p = pending.current;
    const c = col.current;
    const s = stage.current;
    if (!p || !c || !s) return;
    pending.current = null;
    s.scrollTop = 0;
    // The old content fades where it was, over the new one, and is gone before the new one shows.
    const old = p.clone;
    Object.assign(old.style, { position: "absolute", top: `${p.top}px`, left: `${p.left}px`, width: `${p.w}px`, margin: "0", pointerEvents: "none", zIndex: "6" });
    s.append(old);
    const fades = Array.from(old.children).map((el) => el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${p.back ? 6 : -6}px)` }], { duration: 110, easing: "ease-in", fill: "forwards" }));
    Promise.all(fades.map((a) => a.finished)).then(() => old.remove(), () => old.remove());
    // The column eases from the old height to the new one, and the new lines rise one after the other.
    const nh = c.offsetHeight;
    if (Math.abs(nh - p.h) > 1) {
      c.style.overflow = "clip";
      c.animate([{ height: `${p.h}px` }, { height: `${nh}px` }], { duration: 420, easing: EASE_OUT }).finished.then(
        () => (c.style.overflow = ""),
        () => (c.style.overflow = ""),
      );
    }
    Array.from(c.children).forEach((el, i) =>
      el.animate([{ opacity: 0, transform: `translateY(${p.back ? -8 : 8}px)` }, { opacity: 1, transform: "none" }], { duration: 300, delay: 100 + Math.min(i, 10) * 28, easing: EASE_OUT, fill: "backwards" }),
    );
  });

  // The steps this run goes through, for the progress bar.
  const steps: Step[] = syncOnly ? ["sync"] : wantsAi === false ? ["level", "ai", "sync", "avatar"] : ["level", "ai", "accounts", "setup", "sync", "avatar"];
  const at = steps.indexOf(step);

  const go = (s: Step) => {
    morph(false);
    setHistory((h) => [...h, s]);
  };
  const back = () => {
    if (backHandler.current?.()) return;
    if (history.length <= 1) return;
    morph(true);
    setHistory((h) => {
      const next = h.length > 1 ? h.slice(0, -1) : h;
      if (next[next.length - 1] === "welcome") setSyncOnly(false);
      return next;
    });
  };
  // The last step's "Help improve Etude" box: on unless unticked.
  const [shareUsage, setShareUsage] = useState(true);

  const finish = async (then?: () => void) => {
    try {
      const done = history[history.length - 1] === "done";
      await api.saveSettings({ onboarding: { done: true, level }, ...(done ? { privacy: { usageStats: shareUsage } } : {}) });
      track(done ? "onboarding.finish" : "onboarding.skip");
    } catch (e) {
      toast.error("Couldn't save setup", { description: (e as Error).message });
    }
    onFinish();
    then?.();
  };

  const afterAi = (outcome: AiOutcome) => {
    setAi(outcome);
    go("sync");
  };

  const afterSync = (outcome: SyncOutcome) => {
    setSync(outcome);
    // Came to sign in: the rest of Sync (sign-in code, starting it) is in Settings.
    if (syncOnly && outcome !== "skipped" && outcome.next) return void finish(() => navigate("/settings#sync"));
    // The face comes last, right before Done.
    go(syncOnly ? "done" : "avatar");
  };

  const skip = () => {
    if (step === "avatar") go("done");
    else if (step === "level") go("ai");
    else if (step === "ai") {
      setWantsAi(false);
      afterAi("off");
    } else if (step === "accounts") afterAi("later");
    else if (step === "setup") afterAi(ai && ai !== "off" && ai !== "later" && ai.tested ? ai : "later");
    else if (step === "sync") afterSync("skipped");
  };

  // Keys: Enter presses the main button, 1–5 pick an answer, Escape goes back.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (document.querySelector("[role=dialog]") || t?.closest?.("[role=dialog]")) return;
      const field = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if (e.key === "Enter" && !e.shiftKey) {
        if (t?.tagName === "TEXTAREA" || t?.closest?.("a, header, [data-ob-foot]")) return;
        if (field && t?.closest?.("form")) return; // the form submits itself
        if (t?.tagName === "BUTTON" && !t.closest("[data-ob-tile]") && !t.hasAttribute("data-ob-opt") && !field) return;
        const b = document.querySelector<HTMLButtonElement>("[data-ob-foot] [data-ob-primary]");
        if (b && !b.disabled) {
          e.preventDefault();
          b.click();
        }
        return;
      }
      if (field) return;
      if (/^[1-5]$/.test(e.key)) {
        const opts = col.current?.querySelectorAll<HTMLButtonElement>("[data-ob-opt]:not(:disabled)");
        const b = opts?.[+e.key - 1];
        if (b) (e.preventDefault(), b.click(), b.focus());
      } else if (e.key === "Escape" && step !== "welcome" && step !== "done") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const fun = useFunMode();

  return (
    <MorphCtx.Provider value={morph}>
      <BackCtx.Provider value={backHandler}>
        <FootSlot.Provider value={foot}>
          <div className="ob fixed inset-0 z-40 flex flex-col bg-background text-foreground" data-onboarding={step}>
            <header className="mx-auto flex h-[calc(58px+env(safe-area-inset-top))] w-full max-w-[604px] shrink-0 items-center gap-3.5 px-3.5 pt-[env(safe-area-inset-top)] md:h-16 md:px-5">
              <div className="flex w-16 shrink-0">
                {step !== "welcome" && step !== "done" && (
                  <button onClick={back} aria-label="Back" className="-ml-1.5 grid size-[38px] place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                    <ChevronLeft className="size-[18px]" />
                  </button>
                )}
              </div>
              {step === "welcome" ? (
                <div className="flex-1" />
              ) : (
                <div className="ob-bar flex-1" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={step === "done" ? steps.length : at} aria-label={step === "done" ? "Done" : `Step ${at + 1} of ${steps.length}`}>
                  <i style={{ width: `${(step === "done" ? 1 : Math.max(0, at) / steps.length) * 100}%` }} />
                </div>
              )}
              <div className="flex w-16 shrink-0 justify-end">
                {step !== "done" && (
                  <button onClick={step === "welcome" ? () => void finish() : skip} className="-mr-2 h-9 rounded-full px-2.5 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" data-ob-skip>
                    {step === "setup" || step === "accounts" ? "Later" : "Skip"}
                  </button>
                )}
              </div>
            </header>
            <div ref={stage} className="ob-stage relative flex min-h-0 flex-1 flex-col items-center overflow-x-hidden overflow-y-auto px-4 pt-3.5 pb-10 md:px-5 md:pt-6">
              <div ref={col} data-ob-col className={cn("relative flex w-full max-w-[520px] flex-col px-0.5 my-auto md:mt-[6vh] md:mb-auto md:px-1", step === "welcome" && "items-center text-center")}>
                {step === "welcome" && (
                  <Welcome
                    fun={fun}
                    onStart={() => go("level")}
                    onSignIn={() => {
                      setSyncOnly(true);
                      go("sync");
                    }}
                  />
                )}
                {step === "avatar" && <AvatarStep onNext={() => go("done")} />}
                {step === "level" && <LevelStep level={level} onChange={setLevel} onNext={() => go("ai")} />}
                {step === "ai" && (
                  <AiStep
                    value={wantsAi}
                    onChange={setWantsAi}
                    onNext={() => {
                      if (wantsAi) go("accounts");
                      else afterAi("off");
                    }}
                  />
                )}
                {step === "accounts" && <AccountsStep level={level} ticked={ticked} onChange={setTicked} onNext={() => go("setup")} />}
                {step === "setup" && settings && <SetupStep path={pickPath(ticked)} level={level} settings={settings} onSettings={setSettings} onDone={afterAi} />}
                {step === "setup" && !settings && <Loading />}
                {step === "sync" && <SyncStep level={level} onDone={afterSync} />}
                {step === "done" && <DoneStep level={level} ai={ai} sync={sync} profile={!syncOnly} onFinish={finish} shareUsage={shareUsage} onShareUsage={setShareUsage} />}
              </div>
            </div>
            <footer
              ref={setFoot}
              data-ob-foot
              className="mx-auto flex w-full max-w-[432px] shrink-0 flex-col items-stretch px-4 pt-2.5 pb-[calc(env(safe-area-inset-bottom)+14px)] md:px-4 md:pt-3 md:pb-[22px]"
            />
          </div>
        </FootSlot.Provider>
      </BackCtx.Provider>
    </MorphCtx.Provider>
  );
}

const Loading = () => (
  <div className="flex items-center justify-center py-16 text-muted-foreground">
    <Loader2 className="size-5 animate-spin" />
  </div>
);

// ------------------------------------------------------------------ steps

function Welcome({ fun, onStart, onSignIn }: { fun: boolean; onStart(): void; onSignIn(): void }) {
  return (
    <>
      {fun ? <img src={cheer} alt="" draggable={false} className="ob-cheer w-[92px] md:w-[110px]" /> : <Logo className="size-[84px]" />}
      <Wordmark className="mt-2.5 block text-[40px] leading-none" />
      <h1 className="ob-serif mt-5 text-[28px] leading-[1.18] font-normal tracking-[-0.005em] text-balance md:mt-[22px] md:text-[34px]">Flashcards that check your answers.</h1>
      <p className="mt-2.5 max-w-[26rem] text-[14px] leading-normal text-pretty text-muted-foreground md:text-[15px]">
        Etude schedules your reviews, grades what you write and adapts to what you actually know.
      </p>
      <Foot ghost={<Ghost onClick={onSignIn}>I already use Etude · Sign in to Sync</Ghost>}>
        <Primary onClick={onStart}>Get started</Primary>
      </Foot>
    </>
  );
}

function LevelStep({ level, onChange, onNext }: { level: OnboardingLevel; onChange(l: OnboardingLevel): void; onNext(): void }) {
  return (
    <>
      <Title eyebrow="Setup" lead="We'll show more or fewer options. You can switch anytime.">How do you like your apps?</Title>
      <Options role="radiogroup">
        {LEVELS.map((l) => (
          <Option key={l.id} kind="radio" icon={l.icon} title={l.title} hint={l.hint} selected={level === l.id} onClick={() => onChange(l.id)} />
        ))}
      </Options>
      <Foot>
        <Primary onClick={onNext}>Continue</Primary>
      </Foot>
    </>
  );
}

function AiStep({ value, onChange, onNext }: { value: boolean | null; onChange(v: boolean): void; onNext(): void }) {
  return (
    <>
      <Title eyebrow="AI grading" lead="It reads what you wrote, says if it's right and tells you what you missed. It needs an account with an AI service.">Want AI to grade your typed answers?</Title>
      <Options role="radiogroup">
        <Option kind="radio" icon={CircleCheck} title="Yes, use AI" hint="Grading and feedback on open answers and drawings." selected={value === true} onClick={() => onChange(true)} />
        <Option kind="radio" icon={NotebookText} title="No AI" hint="Classic flashcards: you flip and rate yourself. Nothing leaves your device." selected={value === false} onClick={() => onChange(false)} />
      </Options>
      <Note>
        <b>Either way</b> you get spaced repetition, the Market, Anki import and Sync. AI can be turned on later in Settings.
      </Note>
      <Foot>
        <Primary onClick={onNext} disabled={value === null}>Continue</Primary>
      </Foot>
    </>
  );
}

function AccountsStep({ level, ticked, onChange, onNext }: { level: OnboardingLevel; ticked: Set<Account>; onChange(s: Set<Account>): void; onNext(): void }) {
  const toggle = (a: Account) => {
    const next = new Set(ticked);
    if (a === "none") {
      onChange(next.has("none") ? new Set() : new Set(["none"]));
      return;
    }
    next.delete("none");
    if (next.has(a)) next.delete(a);
    else next.add(a);
    onChange(next);
  };
  const rows: { id: Account; icon: typeof Key; title: string; hint: string }[] = [
    // ChatGPT sign-in needs a 127.0.0.1 listener: the desktop server's, or the phone app's own.
    ...(!chatGptSignInHere() ? [] : [{ id: "chatgpt" as const, icon: MessageCircle, title: "ChatGPT Plus or Pro", hint: "Sign in, no key. Uses your plan's limits." }]),
    { id: "openrouter", icon: ArrowLeftRight, title: "OpenRouter", hint: "Paste a key. Pay per use, fractions of a cent." },
    { id: "openai", icon: Key, title: "OpenAI API key", hint: "Not the same as ChatGPT. Pay per use." },
    ...(level === "tinker" ? [{ id: "local" as const, icon: Server, title: "Local server", hint: "llama.cpp, Ollama or vLLM on this machine. No key." }] : []),
    { id: "none", icon: CircleHelp, title: "None of these", hint: "We'll walk you through the easiest one." },
  ];
  return (
    <>
      <Title eyebrow="AI grading" lead="Pick all that apply.">Do you have any of these?</Title>
      <Options>
        {rows.map((r) => (
          <Option key={r.id} kind="check" icon={r.icon} title={r.title} hint={r.hint} selected={ticked.has(r.id)} onClick={() => toggle(r.id)} />
        ))}
      </Options>
      <Foot>
        <Primary onClick={onNext} disabled={ticked.size === 0}>Continue</Primary>
      </Foot>
    </>
  );
}

function SetupStep({ path, level, settings, onSettings, onDone }: {
  path: Account;
  level: OnboardingLevel;
  settings: SettingsResponse;
  onSettings(s: SettingsResponse): void;
  onDone(outcome: AiOutcome): void;
}) {
  const morph = useMorph();
  const [guided, setGuided] = useState(path === "none" && level === "simple");
  // Applies a preset with the existing presetAi(), the same as Settings → AI grading → Quick setup.
  const apply = async (id: PresetId, patch?: (ai: AiSettings) => AiSettings) => {
    const defaults = settings.defaults?.ai;
    if (!defaults) throw new Error("couldn't read the default AI settings");
    let next = presetAi(id, defaults, settings.ai);
    if (patch) next = patch(next);
    await api.saveSettings({ ai: next });
    const s = (await api.settings()) as SettingsResponse;
    onSettings(s);
  };
  if (path === "chatgpt") return <ChatGptSetup apply={apply} onDone={onDone} />;
  if (path === "local") return <LocalSetup apply={apply} onDone={onDone} />;
  if (guided)
    return (
      <GuidedOpenRouter
        onOpened={() => {
          morph();
          setGuided(false);
        }}
        onSkip={() => onDone("off")}
      />
    );
  return <KeySetup provider={path === "openai" ? "openai" : "openrouter"} newcomer={path === "none"} apply={apply} onDone={onDone} />;
}

type Apply = (id: PresetId, patch?: (ai: AiSettings) => AiSettings) => Promise<void>;

/** Runs the Settings test (a sample answer graded with the saved settings) and reads the verdict. */
async function runTest(): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
  try {
    const r = (await api.testAi()) as TestResult;
    if (r.verdict) return { ok: true, ms: r.verdict.ms };
    return { ok: false, error: r.verdictError ?? r.feedbackError ?? "the test didn't return a verdict" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function Verdict({ result }: { result: { ok: true; ms: number } | { ok: false; error: string } | null }) {
  if (!result) return null;
  if (result.ok)
    return (
      <p className="mt-3 flex items-center gap-[7px] text-[13.5px] font-medium text-success" data-test-result="ok">
        <CircleCheck className="size-4" />
        Works · sample answer graded in {fmtSec(result.ms)}
      </p>
    );
  return <Problem>{result.error}</Problem>;
}

function ChatGptSetup({ apply, onDone }: { apply: Apply; onDone(o: AiOutcome): void }) {
  const { status, busy, failure, remote, waitingUrl, start } = useChatGptSignIn();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof runTest>> | null>(null);
  const tested = useRef(false);
  const signedIn = !!status?.signedIn;

  useEffect(() => {
    if (!signedIn || tested.current) return;
    tested.current = true;
    setTesting(true);
    apply("chatgpt")
      .then(runTest)
      .catch((e: Error) => ({ ok: false as const, error: e.message }))
      .then((r) => setResult(r))
      .finally(() => setTesting(false));
  }, [signedIn, apply]);

  return (
    <>
      <Title eyebrow="AI grading" lead="A browser window opens, you sign in, and come back here. Etude never sees your password.">Connect ChatGPT</Title>
      <Steps items={[<>Tap <b>Sign in with ChatGPT</b></>, <>Approve Etude on the OpenAI page</>, <>We grade a sample answer to make sure it works</>]} />
      {signedIn && status && (
        <p className="mt-3 flex items-center gap-1.5 text-[13.5px] text-foreground/90">
          <CircleCheck className="size-4 text-success" />
          Signed in{status.email ? ` as ${status.email}` : ""}
          {testing && <span className="text-muted-foreground"> · testing…</span>}
        </p>
      )}
      <Verdict result={result} />
      {remote && (
        <div className="mt-3 flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/[0.04] px-3.5 py-3">
          <p className="text-[13px] leading-relaxed">{remote.message}</p>
          {remote.cli && <CopyValue label="Run on the machine that runs Etude" value={remote.cli} />}
        </div>
      )}
      {failure && <Problem>{failure}</Problem>}
      {waitingUrl && !signedIn && (
        <a href={waitingUrl} target="_blank" rel="noreferrer" className="mt-3 self-start text-[13px] text-muted-foreground underline underline-offset-4 hover:text-foreground">
          Waiting for the browser · open the sign-in page
        </a>
      )}
      <Note>Grading counts toward your ChatGPT usage, like any chat. Free ChatGPT accounts don't work.</Note>
      <Foot>
        {signedIn ? (
          <Primary onClick={() => onDone({ preset: "chatgpt", tested: !!result?.ok })} busy={testing}>Continue</Primary>
        ) : (
          <Primary onClick={start} busy={busy === "login" || !!waitingUrl}>Sign in with ChatGPT</Primary>
        )}
      </Foot>
    </>
  );
}

function KeySetup({ provider, newcomer, apply, onDone }: { provider: "openrouter" | "openai"; newcomer: boolean; apply: Apply; onDone(o: AiOutcome): void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof runTest>> | null>(null);
  const [help, setHelp] = useState(false);
  const env = KEY_ENV[provider];
  const name = provider === "openrouter" ? "OpenRouter" : "OpenAI";
  const prefix = provider === "openrouter" ? "sk-or-" : "sk-";

  const test = async () => {
    const v = key.trim();
    if (!v) return;
    setBusy(true);
    setResult(null);
    try {
      await saveApiKey(env, v);
      await apply(provider);
      const r = await runTest();
      setResult(r);
      if (r.ok) setKey("");
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      setKey((await navigator.clipboard.readText()).trim());
    } catch {
      toast.error("Couldn't read the clipboard", { description: "Paste into the box instead." });
    }
  };

  return (
    <>
      <Title
        eyebrow="AI grading"
        lead={
          provider === "openrouter" ? (
            <>openrouter.ai → Keys → Create key. It starts with <span className="whitespace-nowrap"><span className="font-mono text-foreground">{prefix}</span>.</span></>
          ) : (
            <>platform.openai.com → API keys → Create new secret key. It starts with <span className="whitespace-nowrap"><span className="font-mono text-foreground">{prefix}</span>.</span></>
          )
        }
      >
        Paste your {name}&nbsp;key
      </Title>
      {newcomer && (
        <button type="button" onClick={() => setHelp((h) => !h)} aria-expanded={help} className="mt-2.5 self-start text-[13.5px] font-medium text-primary underline-offset-4 hover:underline">
          {help ? "Hide the steps" : "How do I get one?"}
        </button>
      )}
      {help && <OpenRouterHowTo />}
      <form
        id="ob-key-form"
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void test();
        }}
      >
        <label htmlFor="ob-key" className="text-[12.5px] text-muted-foreground">API key</label>
        <div className="relative mt-1.5">
          <Input
            id="ob-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setResult(null);
            }}
            placeholder={result?.ok ? "Saved. Paste another to replace it" : `${prefix}…`}
            className={cn(fieldClass, "pr-16 font-mono text-[13.5px] md:text-[13.5px]")}
          />
          {!key && "clipboard" in navigator && (
            <button type="button" onClick={paste} className="absolute top-1/2 right-1.5 h-8 -translate-y-1/2 rounded-lg px-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground">
              Paste
            </button>
          )}
        </div>
        <Verdict result={result} />
      </form>
      <Note>
        {provider === "openrouter" ? (
          <><b>About the cost:</b> a graded answer costs a fraction of a cent, so a few dollars of credit goes a long way.</>
        ) : (
          <><b>About the cost:</b> OpenAI bills the API separately from ChatGPT. A graded answer costs a fraction of a cent.</>
        )}
      </Note>
      <p className="mt-2.5 text-[12px] leading-[1.45] text-muted-foreground">
        {serverless() ? "Kept only on this device, in the app's private storage." : <>Saved to <span className="font-mono">~/.etude/.env</span> as <span className="font-mono">{env}</span>, readable only by you.</>}
      </p>
      <Foot ghost={!result?.ok ? <Ghost href={provider === "openrouter" ? OPENROUTER_KEYS : OPENAI_KEYS}>Open {provider === "openrouter" ? "openrouter.ai" : "platform.openai.com"}</Ghost> : undefined}>
        {result?.ok ? (
          <Primary onClick={() => onDone({ preset: provider, tested: true })}>Continue</Primary>
        ) : (
          <Primary form="ob-key-form" busy={busy} disabled={!key.trim()}>{result ? "Test again" : "Save and test"}</Primary>
        )}
      </Foot>
    </>
  );
}

function OpenRouterHowTo() {
  return (
    <Steps
      items={[
        <><b>Create an account</b> at openrouter.ai (Google login works)</>,
        <><b>Add US$5 of credit</b>. It isn't a subscription; it only goes down when you study.</>,
        <><b>Create a key</b> and copy it</>,
        <>Come back and <b>paste it</b>. We'll test it for you.</>,
      ]}
    />
  );
}

function GuidedOpenRouter({ onOpened, onSkip }: { onOpened(): void; onSkip(): void }) {
  return (
    <>
      <Title eyebrow="AI grading" lead="A site that sells access to AI models by the cent. About 3 minutes.">The easiest way: OpenRouter</Title>
      <OpenRouterHowTo />
      <Foot ghost={<Ghost onClick={onSkip}>Skip for now, study without AI</Ghost>}>
        <Primary
          onClick={() => {
            openOutside(OPENROUTER_KEYS);
            onOpened();
          }}
        >
          Open openrouter.ai
        </Primary>
      </Foot>
    </>
  );
}

function LocalSetup({ apply, onDone }: { apply: Apply; onDone(o: AiOutcome): void }) {
  const [url, setUrl] = useState("http://127.0.0.1:8080/v1/chat/completions");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof runTest>> | null>(null);
  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      await apply("local", (ai) => ({ ...ai, feedback: ai.feedback && ai.feedback.kind === "openai-chat" ? { ...ai.feedback, url: url.trim(), model: model.trim() } : ai.feedback }));
      setResult(await runTest());
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Title eyebrow="AI grading" lead="Any OpenAI-compatible chat endpoint: llama.cpp, Ollama, vLLM. No key is sent.">Use a local server</Title>
      <div className="mt-4 flex flex-col gap-3.5">
        <label className="text-[12.5px] text-muted-foreground">
          URL
          <Input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} className={cn(fieldClass, "mt-1.5 font-mono text-[13.5px] text-foreground md:text-[13.5px]")} />
        </label>
        <label className="text-[12.5px] text-muted-foreground">
          Model
          <Input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} placeholder="the name your server reports" className={cn(fieldClass, "mt-1.5 font-mono text-[13.5px] text-foreground md:text-[13.5px]")} />
        </label>
      </div>
      <Verdict result={result} />
      <Foot>
        {result?.ok ? (
          <Primary onClick={() => onDone({ preset: "local", tested: true })}>Continue</Primary>
        ) : (
          <Primary onClick={test} busy={busy} disabled={!url.trim() || !model.trim()}>{result ? "Test again" : "Save and test"}</Primary>
        )}
      </Foot>
    </>
  );
}

function SyncStep({ level, onDone }: { level: OnboardingLevel; onDone(o: SyncOutcome): void }) {
  const morph = useMorph();
  const [choice, setChoice] = useState<SyncChoice | null>(null);
  const [folder, setFolder] = useState("");
  const [server, setServer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noFolder = serverless();
  /** Etude Sync: sign in and subscribe without leaving the setup. */
  const [cloud, setCloudRaw] = useState<CloudStage | null>(null);
  const setCloud = (s: CloudStage | null, back = false) => {
    morph(back);
    setCloudRaw(s);
  };

  const next = async () => {
    if (!choice) return;
    if (choice === "device") return onDone({ choice, next: null });
    setBusy(true);
    setError(null);
    try {
      let body: Record<string, string>;
      if (choice === "folder") {
        if (!folder.trim()) throw new Error("Enter the folder to sync through.");
        body = { folder: folder.trim() };
      } else if (choice === "server") {
        const u = server.trim();
        try {
          if (!/^https?:$/.test(new URL(u).protocol)) throw new Error();
        } catch {
          throw new Error("Enter a full http or https address.");
        }
        body = { server: u };
      } else {
        // The server the Etude account uses, like Settings → Sync suggests.
        const s = await account.status().then((a) => a.server).catch(() => DEFAULT_SYNC_SERVER);
        body = { server: s || DEFAULT_SYNC_SERVER };
      }
      // Only the destination is chosen here; signing in and starting (with or without a password) are in Settings → Sync.
      const st = await postJson<{ kind: string | null; signedIn: boolean; unlocked: boolean }>("/api/sync/setup", body);
      if (st.kind === "cloud") return setCloud(st.signedIn ? "plan" : "email");
      onDone({ choice, next: !st.unlocked ? "finish in Settings" : null });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (cloud) return <CloudSignup stage={cloud} onStage={setCloud} onDone={(next) => onDone({ choice: "cloud", next })} />;

  return (
    <>
      <Title eyebrow="Sync" lead="Your cards and reviews stay the same on the phone and the computer.">Use Etude on more than one device?</Title>
      <Options role="radiogroup">
        <Option
          kind="radio"
          icon={CloudLock}
          title="Etude Sync"
          hint={canShowPurchases() ? "Encrypted, works everywhere. US$5/month or US$40/year." : "Encrypted, works everywhere."}
          selected={choice === "cloud"}
          onClick={() => setChoice("cloud")}
        />
        {/* A phone has no folder to pick, so the store apps leave this option out. */}
        {!isNativeApp() && <Option
            kind="radio"
            icon={FolderSync}
            title="My own folder"
            hint={noFolder ? "Desktop app only. Free: point it at Dropbox, iCloud Drive or Syncthing." : "Free: point it at Dropbox, iCloud Drive or Syncthing."}
            selected={choice === "folder"}
            disabled={noFolder}
            onClick={() => setChoice("folder")}
          >
            {choice === "folder" && (
              <div className="flex gap-2 px-3 pb-3 md:px-[15px]">
                <Input autoFocus value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/home/you/Dropbox/Etude" spellCheck={false} aria-label="Folder" className="h-10 min-w-0 flex-1 rounded-xl bg-background font-mono text-[13px]" />
                <ChooseFolder onPick={setFolder} className="rounded-xl md:h-10" />
              </div>
            )}
          </Option>}
        {level === "tinker" && (
          <Option kind="radio" icon={Server} title="My own server" hint="An Etude Sync server you run yourself." selected={choice === "server"} onClick={() => setChoice("server")}>
            {choice === "server" && (
              <div className="px-3 pb-3 md:px-[15px]">
                <Input autoFocus value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://sync.example.com" spellCheck={false} aria-label="Server address" className="h-10 rounded-xl bg-background font-mono text-[13px]" />
              </div>
            )}
          </Option>
        )}
        <Option kind="radio" icon={Smartphone} title="Just this device" hint="No sync. You can turn it on later." selected={choice === "device"} onClick={() => setChoice("device")} />
      </Options>
      {error && <Problem>{error}</Problem>}
      <Foot>
        <Primary onClick={next} disabled={!choice} busy={busy}>Continue</Primary>
      </Foot>
    </>
  );
}

type CloudStage = "email" | "code" | "plan" | "waiting";

/** Etude Sync inside the setup: email code, then the plan and checkout on etude.study, then back here. */
function CloudSignup({ stage, onStage, onDone }: { stage: CloudStage; onStage(s: CloudStage | null, back?: boolean): void; onDone(next: string | null): void }) {
  const morph = useMorph();
  const backer = useContext(BackCtx);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [plan, setPlan] = useState<"monthly" | "yearly">("yearly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appleProducts, setAppleProducts] = useState<string[] | null>(null);
  // Two-step sign-in: after the email code, the authenticator code (or a recovery code).
  const [second, setSecondRaw] = useState<string[] | null>(null);
  const setSecond = (m: string[] | null, back = false) => {
    morph(back);
    setSecondRaw(m);
  };
  const [useRecovery, setUseRecovery] = useState(false);
  const [secondValue, setSecondValue] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Back walks these pages before leaving Sync: the code goes back to the email, the rest back to the choices.
  useEffect(() => {
    backer.current = () => {
      setError(null);
      if (stage === "code" && second) setSecond(null, true);
      else if (stage === "code") onStage("email", true);
      else if (stage === "waiting") onStage("plan", true);
      else onStage(null, true);
      return true;
    };
    return () => {
      backer.current = null;
    };
  });

  /** Signed in: subscribe if this server charges and the account has no Sync yet, otherwise go on to starting Sync. */
  const afterSignIn = async () => {
    window.dispatchEvent(new Event(ACCOUNT_EVENT));
    const a = await account.status();
    if (a.me?.sync.active || !a.offering?.billing) return onDone("finish in Settings");
    // Native apps can't point at an outside purchase (App Store 3.1.1/3.1.3): just say Sync isn't on for this account.
    if (!canShowPurchases()) {
      // The store apps sell Sync through the App Store or Google Play; without the plugin they only say it isn't on.
      if (canBuyInApp() && inAppProductIds(a.offering).length) {
        setAppleProducts(inAppProductIds(a.offering));
        return onStage("plan");
      }
      return onDone("not active");
    }
    onStage("plan");
  };

  // While the checkout is open in the browser, look for the subscription to land.
  useEffect(() => {
    if (stage !== "waiting") return;
    const t = window.setInterval(async () => {
      const a = await account.status().catch(() => null);
      if (a?.me?.sync.active) {
        window.clearInterval(t);
        window.dispatchEvent(new Event(ACCOUNT_EVENT));
        onDone("finish in Settings");
      }
    }, 3000);
    return () => window.clearInterval(t);
  }, [stage, onDone]);

  if (stage === "email")
    return (
      <>
        <Title eyebrow="Etude Sync" lead="We'll email you a code. No password to remember.">Sign in to Etude Sync</Title>
        <form id="ob-email" className="mt-5" onSubmit={(e) => (e.preventDefault(), void run(async () => {
          if (!email.trim()) throw new Error("Enter your email address.");
          await postJson("/api/sync/signin", { email: email.trim() });
          onStage("code");
        }))}>
          <Input autoFocus type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Email" className={fieldClass} />
        </form>
        {error && <Problem>{error}</Problem>}
        <Foot>
          <Primary form="ob-email" busy={busy} disabled={!email.trim()}>Send code</Primary>
        </Foot>
      </>
    );

  if (stage === "code" && second) {
    const hasApp = second.includes("authenticator");
    const recovery = useRecovery || !hasApp;
    return (
      <>
        <Title eyebrow="Etude Sync" lead={recovery ? "Two-step sign-in is on for this account. Enter one of the recovery codes you saved; each one works once." : "Two-step sign-in is on for this account. Enter the code your authenticator app shows for Etude."}>One more step</Title>
        <form id="ob-second" className="mt-5" onSubmit={(e) => (e.preventDefault(), void run(async () => {
          const v = secondValue.trim();
          if (!v) throw new Error(recovery ? "Enter a recovery code." : "Enter the code from the app.");
          try {
            await postJson("/api/sync/second-factor", recovery ? { recoveryCode: v } : { code: v.replace(/\s+/g, "") });
          } catch (err) {
            if (/expired|too many/i.test((err as Error).message)) (setSecond(null), setSecondValue(""), onStage("email"));
            throw err;
          }
          setSecondRaw(null);
          await afterSignIn();
        }))}>
          <Input key={recovery ? "recovery" : "code"} autoFocus inputMode={recovery ? "text" : "numeric"} autoComplete="one-time-code" spellCheck={false} value={secondValue} onChange={(e) => setSecondValue(e.target.value)} placeholder={recovery ? "xxxx-xxxx-xxxx" : "6-digit code"} aria-label={recovery ? "Recovery code" : "Code from the app"} className={cn(fieldClass, "text-center font-mono tracking-[0.3em] placeholder:font-sans placeholder:tracking-normal")} />
        </form>
        {error && <Problem>{error}</Problem>}
        <Foot ghost={hasApp ? <Ghost onClick={() => (setUseRecovery(!useRecovery), setSecondValue(""), setError(null))}>{recovery ? "Use the authenticator app" : "Use a recovery code"}</Ghost> : undefined}>
          <Primary form="ob-second" busy={busy} disabled={!secondValue.trim()}>Continue</Primary>
        </Foot>
      </>
    );
  }

  if (stage === "code")
    return (
      <>
        <Title eyebrow="Etude Sync" lead={<>Sent to <span className="text-foreground">{email.trim()}</span>. It works for 15 minutes.</>}>Enter the code</Title>
        <form id="ob-code" className="mt-5" onSubmit={(e) => (e.preventDefault(), void run(async () => {
          if (!code.trim()) throw new Error("Enter the code from the email.");
          const r = await postJson<{ secondStep?: { methods: string[] } }>("/api/sync/verify", { code: code.trim() });
          if (r?.secondStep) return void (setSecond(r.secondStep.methods), setCode(""));
          await afterSignIn();
        }))}>
          <Input autoFocus inputMode="numeric" autoComplete="one-time-code" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" aria-label="Sign-in code" className={cn(fieldClass, "text-center font-mono text-[18px] tracking-[0.35em] placeholder:font-sans placeholder:text-[15px] placeholder:tracking-normal md:text-[18px]")} />
        </form>
        {error && <Problem>{error}</Problem>}
        <Foot ghost={<Ghost onClick={() => void run(async () => void (await postJson("/api/sync/signin", { email: email.trim() })))}>Send again</Ghost>}>
          <Primary form="ob-code" busy={busy} disabled={!code.trim()}>Verify</Primary>
        </Foot>
      </>
    );

  // The store apps have no plan page: an account that already has Sync goes on, any other gets "not active".
  if (stage === "plan" && !canShowPurchases() && appleProducts)
    return (
      <>
        <Title eyebrow="Etude Sync" lead="1 GB of encrypted storage, end-to-end with a Sync password. Cancel anytime.">Pick a plan</Title>
        <div className="mt-5">
          <AppStorePlans productIds={appleProducts} onActive={() => { window.dispatchEvent(new Event(ACCOUNT_EVENT)); onDone("finish in Settings"); }} />
        </div>
        <Foot ghost={<Ghost onClick={() => onDone("not active")}>Not now</Ghost>} />
      </>
    );
  if (stage === "plan" && !canShowPurchases()) return <NativePlanGate onCheck={() => void run(afterSignIn)} error={error} />;

  if (stage === "plan")
    return (
      <>
        <Title eyebrow="Etude Sync" lead="1 GB of encrypted storage, end-to-end with a Sync password. Cancel anytime.">Pick a plan</Title>
        <Options role="radiogroup">
          <Option kind="radio" icon={CalendarDays} title="Yearly · US$40" hint="Works out to US$3.33 a month." selected={plan === "yearly"} onClick={() => setPlan("yearly")} />
          <Option kind="radio" icon={CalendarClock} title="Monthly · US$5" hint="Billed every month." selected={plan === "monthly"} onClick={() => setPlan("monthly")} />
        </Options>
        <Note>Payment opens on etude.study, handled by Polar. Come back here when it's done.</Note>
        {error && <Problem>{error}</Problem>}
        <Foot ghost={<Ghost onClick={() => onDone("subscribe later")}>Later</Ghost>}>
          <Primary busy={busy} onClick={() => void run(async () => {
            openOutside((await account.checkout(plan)).url);
            onStage("waiting");
          })}>Subscribe</Primary>
        </Foot>
      </>
    );

  return (
    <>
      <Title eyebrow="Etude Sync" lead="Finish the payment in the browser. This page moves on by itself once Sync is active.">Waiting for the payment</Title>
      <div className="mt-6 flex items-center gap-3 text-[14px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking every few seconds…
      </div>
      {error && <Problem>{error}</Problem>}
      <Foot ghost={<Ghost onClick={() => onStage("plan", true)}>Back to plans</Ghost>}>
        <Primary onClick={() => void run(async () => {
          const a = await account.status();
          if (a.me?.sync.active) onDone("finish in Settings");
          else throw new Error("Sync isn't active yet. If you paid, give it a few seconds.");
        })} busy={busy}>I've paid</Primary>
      </Foot>
    </>
  );
}

function NativePlanGate({ onCheck, error }: { onCheck(): void; error: string | null }) {
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    onCheck();
  }, [onCheck]);
  return (
    <>
      <Title eyebrow="Etude Sync">Etude Sync</Title>
      {error ? <Problem>{error}</Problem> : <div className="mt-6 flex items-center gap-3 text-[14px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Checking your account…</div>}
      <Foot />
    </>
  );
}

function DoneStep({ level, ai, sync, profile, onFinish, shareUsage, onShareUsage }: {
  level: OnboardingLevel;
  ai: AiOutcome | null;
  sync: SyncOutcome | null;
  /** This run had the face step, so the summary shows the picture and name. */
  profile: boolean;
  onFinish(then?: () => void): Promise<void>;
  shareUsage: boolean;
  onShareUsage(v: boolean): void;
}) {
  const [importing, setImporting] = useState(false);
  const pickFile = useImportPicker(() => announceDataChange());
  const avatar = useAvatar();
  const name = useMyName();

  const aiRow = useMemo(() => {
    if (!ai || ai === "off") return { value: "Off", pill: null };
    if (ai === "later" || !ai.preset) return { value: "Not set up", pill: "later" };
    return { value: PRESET_LABEL[ai.preset], pill: ai.tested ? "tested" : "not tested" };
  }, [ai]);
  const syncRow = useMemo(() => {
    if (!sync || sync === "skipped") return { value: "Not set up", pill: null };
    const label = { cloud: "Etude Sync", folder: "My own folder", server: "My own server", device: "Just this device" }[sync.choice];
    return { value: label, pill: sync.next };
  }, [sync]);

  const showcase = async () => {
    setImporting(true);
    try {
      const pack = JSON.parse((await import("../../../examples/showcase.pack.json?raw")).default);
      await api.importPack(pack);
      await onFinish(() => navigate(`/deck?name=${encodeURIComponent(pack.decks?.[0]?.name ?? "Etude Showcase")}`));
    } catch (e) {
      setImporting(false);
      toast.error("Couldn't add the Showcase deck", { description: (e as Error).message.slice(0, 300) });
    }
  };

  return (
    <>
      <Title eyebrow="All set">You're set</Title>
      <div className="mt-4 divide-y overflow-hidden rounded-[14px] border text-[13.5px]" data-ob-summary>
        {profile && (
          <Row
            label="Profile"
            value={
              avatar || name.trim() ? (
                <>
                  {avatar && <AvatarPic value={avatar} size={22} className="shrink-0" />}
                  <span className="truncate" data-ob-profile-name>{name.trim() || avatarLabel(avatar)}</span>
                </>
              ) : (
                "Not set"
              )
            }
          />
        )}
        <Row label="Setup level" value={levelTitle(level)} />
        <Row label="AI grading" value={aiRow.value} pill={aiRow.pill} ok={aiRow.pill === "tested"} onClick={ai && ai !== "off" && !(typeof ai === "object" && ai.tested) ? () => void onFinish(() => navigate("/settings#ai")) : undefined} />
        <Row label="Sync" value={syncRow.value} pill={syncRow.pill} onClick={syncRow.pill ? () => void onFinish(() => navigate("/settings#sync")) : undefined} />
      </div>
      <label className="mt-[18px] flex cursor-pointer items-start gap-[11px] text-[13.5px]">
        <input type="checkbox" className="mt-0.5 size-[17px] shrink-0 accent-primary" checked={shareUsage} onChange={(e) => onShareUsage(e.target.checked)} data-testid="share-usage" />
        <span>
          <span className="block font-semibold">{NATIVE_COPY.privacyOnboarding}</span>
          <span className="mt-0.5 block text-[12.5px] leading-[1.4] text-muted-foreground">{NATIVE_COPY.privacyOnboardingHint}</span>
        </span>
      </label>
      <p className="mt-[22px] text-[14.5px] font-semibold md:mt-7">Start with something</p>
      <div className="mt-2.5 flex flex-col gap-2">
        <Start icon={importing ? Spinner : Star} title="Try the Showcase deck" hint="Every card type in 5 minutes." onClick={importing ? undefined : showcase} />
        <Start icon={Download} title="Browse the Market" hint="Countries, periodic table, Morse…" onClick={() => void onFinish(() => navigate("/market"))} />
        <Start
          icon={FileInput}
          title="Import from Anki"
          hint="Bring your .apkg with history."
          onClick={() => {
            // The file picker has to open inside the click.
            pickFile();
            void onFinish(() => navigate("/"));
          }}
        />
      </div>
      <Foot>
        <Primary onClick={() => void onFinish(() => navigate("/"))}>Go to my decks</Primary>
      </Foot>
    </>
  );
}

function Start({ icon: Icon, title, hint, onClick }: { icon: React.ComponentType<{ className?: string }>; title: string; hint: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className="ob-start flex items-center gap-3 rounded-[13px] px-[13px] py-[11px] text-left">
      <span className="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-muted">
        <Icon className="size-[18px]" />
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold">{title}</span>
        <span className="mt-px block text-[12.5px] text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function Row({ label, value, pill, ok, onClick }: { label: string; value: React.ReactNode; pill?: string | null; ok?: boolean; onClick?: () => void }) {
  const inner = (
    <>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-[7px] text-right">
        {typeof value === "string" ? <span className="truncate">{value}</span> : value}
        {pill && <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px]", ok ? "bg-primary/[0.14] text-primary" : "bg-muted text-muted-foreground")}>{pill}</span>}
        {onClick && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
      </span>
    </>
  );
  return onClick ? (
    <button onClick={onClick} className="flex w-full items-center justify-between gap-3 px-3.5 py-[11px] text-left hover:bg-accent/40">
      {inner}
    </button>
  ) : (
    <div className="flex items-center justify-between gap-3 px-3.5 py-[11px]">{inner}</div>
  );
}

const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn(className, "animate-spin")} />;

/** A cloud with a padlock, for the encrypted Sync (lucide's stroke style; lucide has no such glyph). */
function CloudLock({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9a4 4 0 0 1 0 9z" />
      <rect x="9.75" y="12" width="5.5" height="3.75" rx="1" />
      <path d="M10.75 12v-.9a1.75 1.75 0 0 1 3.5 0v.9" />
    </svg>
  );
}

/** A folder, for "My own folder". */
function FolderSync({ className }: { className?: string }) {
  return <Folder className={className} />;
}
