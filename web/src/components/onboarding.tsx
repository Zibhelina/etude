// First-run setup: comfort level, AI grading, Sync, then something to study. Every step can be
// skipped, and everything chosen here is in Settings afterwards. The comfort level only changes what
// this flow offers; it doesn't hide anything elsewhere in the app.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ChevronLeft,
  CircleAlert,
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
  Settings,
  Smartphone,
  Star,
  Terminal,
  Check,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { Logo } from "@/components/logo";
import { Input } from "@/components/ui/input";
import { CopyValue } from "@/components/settings-ui";
import { useChatGptSignIn } from "@/components/settings-chatgpt";
import { ACCOUNT_EVENT } from "@/components/settings-account";
import { presetAi, type AiSettings, type OnboardingLevel, type PresetId, type SettingsResponse, type TestResult } from "@/components/settings-model";
import { useImportPicker } from "@/pages/decks";
import { announceDataChange } from "@/components/agent-panel";
import { api } from "@/lib/api";
import { account, openOutside } from "@/lib/account";
import { saveApiKey, serverless } from "@/lib/native";
import { canShowPurchases } from "@/lib/platform";
import { etudeFetch } from "@/lib/transport";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

/** Settings → About → Run setup again. */
export const ONBOARDING_EVENT = "etude:onboarding";

type Step = "welcome" | "level" | "ai" | "accounts" | "setup" | "sync" | "done";
type Account = "chatgpt" | "openrouter" | "openai" | "local" | "none";
type SyncChoice = "cloud" | "folder" | "server" | "device";
type AiOutcome = { preset: PresetId | null; tested: boolean } | "off" | "later";
type SyncOutcome = { choice: SyncChoice; next: string | null } | "skipped";

const DEFAULT_SYNC_SERVER = "https://sync.etude.study";
const OPENROUTER_KEYS = "https://openrouter.ai/keys";
const OPENAI_KEYS = "https://platform.openai.com/api-keys";

const LEVELS: { id: OnboardingLevel; icon: typeof Coffee; title: string; hint: string }[] = [
  { id: "simple", icon: Coffee, title: "Keep it simple", hint: "Just let me study. Hide the knobs." },
  { id: "standard", icon: Settings, title: "I know my way around", hint: "Show the useful settings, explain the new ones." },
  { id: "tinker", icon: Terminal, title: "I like to tinker", hint: "Everything: custom card types, schedulers, API keys, the CLI." },
];
const levelTitle = (l: OnboardingLevel) => LEVELS.find((x) => x.id === l)!.title;

const PRESET_LABEL: Record<PresetId, string> = { chatgpt: "ChatGPT", openrouter: "OpenRouter", openai: "OpenAI", local: "Local server" };
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
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.settings().then((s: SettingsResponse) => {
      setSettings(s);
      if (s.onboarding?.level) setLevel(s.onboarding.level);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, [step]);

  // The steps this run goes through, for the progress dots.
  const steps: Step[] = syncOnly ? ["sync"] : wantsAi === false ? ["level", "ai", "sync"] : ["level", "ai", "accounts", "setup", "sync"];
  const at = steps.indexOf(step);

  const go = (s: Step) => setHistory((h) => [...h, s]);
  const back = () => setHistory((h) => {
    const next = h.length > 1 ? h.slice(0, -1) : h;
    if (next[next.length - 1] === "welcome") setSyncOnly(false);
    return next;
  });

  const finish = async (then?: () => void) => {
    try {
      await api.saveSettings({ onboarding: { done: true, level } });
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
    // Came to sign in: the rest of Sync (sign-in code, password) is in Settings.
    if (syncOnly && outcome !== "skipped" && outcome.next) return void finish(() => navigate("/settings#sync"));
    go("done");
  };

  return (
    <div ref={scroller} className="fixed inset-0 z-40 overflow-y-auto bg-background text-foreground" data-onboarding={step}>
      <div
        className={cn(
          "mx-auto flex min-h-full w-full max-w-[420px] flex-col px-5 pt-[calc(env(safe-area-inset-top)+1rem)] pb-[calc(env(safe-area-inset-bottom)+1.25rem)]",
          "md:min-h-0 md:px-0 md:pt-[72px] md:pb-14",
        )}
      >
        {step === "welcome" ? (
          <Welcome
            onStart={() => go("level")}
            onSignIn={() => {
              setSyncOnly(true);
              go("sync");
            }}
            onSkip={() => finish()}
          />
        ) : (
          <>
            <TopBar
              onBack={step === "done" ? undefined : back}
              total={steps.length}
              filled={step === "done" ? steps.length : at + 1}
              skipLabel={step === "done" ? undefined : step === "setup" ? "Later" : "Skip"}
              onSkip={() => {
                if (step === "level") go("ai");
                else if (step === "ai") {
                  setWantsAi(false);
                  afterAi("off");
                } else if (step === "accounts") afterAi("later");
                else if (step === "setup") afterAi(ai && ai !== "off" && ai !== "later" && ai.tested ? ai : "later");
                else if (step === "sync") afterSync("skipped");
              }}
            />
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
            {step === "done" && <DoneStep level={level} ai={ai} sync={sync} onFinish={finish} />}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ chrome

function TopBar({ onBack, total, filled, skipLabel, onSkip }: { onBack?: () => void; total: number; filled: number; skipLabel?: string; onSkip(): void }) {
  return (
    <div className="mb-6 flex h-9 items-center justify-between">
      <div className="w-14">
        {onBack && (
          <button onClick={onBack} aria-label="Back" className="-ml-2 flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground">
            <ChevronLeft className="size-5" />
          </button>
        )}
      </div>
      <div className="flex gap-[5px]" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={filled} aria-label={`Step ${Math.min(filled, total)} of ${total}`}>
        {Array.from({ length: total }, (_, i) => (
          <i key={i} className={cn("block h-[3px] w-5 rounded-full transition-colors", i < filled ? "bg-highlight" : "bg-muted")} />
        ))}
      </div>
      <div className="flex w-14 justify-end">
        {skipLabel && (
          <button onClick={onSkip} className="-mr-2 h-9 rounded-full px-2 text-[13.5px] text-muted-foreground transition-colors hover:text-foreground">
            {skipLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function Title({ children, lead }: { children: React.ReactNode; lead?: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-[24px] leading-[1.22] font-semibold tracking-[-0.015em] text-balance md:text-[22px]">{children}</h1>
      {lead && <p className="mt-2 text-[14.5px] leading-normal text-pretty text-muted-foreground md:text-[14px]">{lead}</p>}
    </div>
  );
}

/** Pushes the main button to thumb reach on a phone; on a desktop the button sits right under the content. */
const Spacer = () => <div className="min-h-8 flex-1 md:hidden" />;

function Primary({ children, onClick, disabled, busy }: { children: React.ReactNode; onClick(): void; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className="flex h-12 w-full shrink-0 items-center justify-center gap-2 rounded-full bg-primary text-[15px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40 md:mt-8"
    >
      {busy && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

function Ghost({ children, onClick, className }: { children: React.ReactNode; onClick(): void; className?: string }) {
  return (
    <button onClick={onClick} className={cn("mt-1.5 flex h-10 w-full items-center justify-center rounded-full text-[14px] font-medium text-muted-foreground transition-colors hover:text-foreground", className)}>
      {children}
    </button>
  );
}

function Note({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mt-3 rounded-xl border bg-card px-3.5 py-2.5 text-[12.5px] leading-[1.45] text-muted-foreground [&_b]:font-medium [&_b]:text-foreground", className)}>{children}</div>;
}

function Option({ icon: Icon, title, hint, selected, onClick, kind, disabled, children }: {
  icon: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  hint?: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
  kind?: "radio" | "check";
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-[14px] border bg-card transition-colors", selected && "border-highlight/55 bg-highlight/[0.07]", disabled && "opacity-45")}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        role={kind === "check" ? "checkbox" : kind === "radio" ? "radio" : undefined}
        aria-checked={kind ? !!selected : undefined}
        className={cn("flex w-full items-start gap-3 px-3.5 py-3 text-left", !disabled && !selected && "hover:bg-accent/40", "rounded-[14px] disabled:cursor-not-allowed")}
      >
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-[9px] bg-muted text-foreground", selected && "bg-highlight/[0.18] text-highlight")}>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block text-[15px] font-medium md:text-[14px]", selected && "text-highlight")}>{title}</span>
          {hint && <span className="mt-0.5 block text-[13px] leading-[1.4] text-pretty text-muted-foreground md:text-[12.5px]">{hint}</span>}
        </span>
        {kind === "radio" && <span className={cn("mt-2 size-4 shrink-0 rounded-full border-[1.5px] border-input", selected && "border-[5px] border-highlight")} />}
        {kind === "check" && (
          <span className={cn("mt-2 grid size-4 shrink-0 place-items-center rounded-[5px] border-[1.5px] border-input", selected && "border-highlight bg-highlight text-primary-foreground")}>
            {selected && <Check className="size-3" strokeWidth={3} />}
          </span>
        )}
      </button>
      {children}
    </div>
  );
}

const Options = ({ children, className, role }: { children: React.ReactNode; className?: string; role?: string }) => (
  <div role={role} className={cn("mt-5 flex flex-col gap-2.5", className)}>
    {children}
  </div>
);

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="mt-4 flex flex-col gap-2.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5 text-[13.5px] leading-[1.45] text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-foreground">{i + 1}</span>
          <div className="min-w-0">{it}</div>
        </li>
      ))}
    </ol>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex gap-2 rounded-xl border border-destructive/40 px-3 py-2.5 text-[13px] leading-normal">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <p className="min-w-0 break-words text-destructive">{children}</p>
    </div>
  );
}

const Loading = () => (
  <div className="flex flex-1 items-center justify-center py-16 text-muted-foreground">
    <Loader2 className="size-5 animate-spin" />
  </div>
);

// ------------------------------------------------------------------ steps

function Welcome({ onStart, onSignIn, onSkip }: { onStart(): void; onSignIn(): void; onSkip(): void }) {
  return (
    <>
      <div className="flex h-9 justify-end">
        <button onClick={onSkip} className="-mr-2 h-9 rounded-full px-2 text-[13.5px] text-muted-foreground transition-colors hover:text-foreground">
          Skip
        </button>
      </div>
      <div className="mt-12 flex flex-col items-center text-center md:mt-10">
        <Logo className="size-28" />
        <div className="mt-3 text-[32px] font-semibold tracking-[-0.02em]">Etude</div>
        <p className="mt-2.5 max-w-[22rem] px-2 text-[15px] leading-normal text-muted-foreground">
          Flashcards that check your answers, schedule your reviews and adapt to what you actually know.
        </p>
      </div>
      <Spacer />
      <Primary onClick={onStart}>Get started</Primary>
      <Ghost onClick={onSignIn}>I already use Etude · Sign in to Sync</Ghost>
    </>
  );
}

function LevelStep({ level, onChange, onNext }: { level: OnboardingLevel; onChange(l: OnboardingLevel): void; onNext(): void }) {
  return (
    <>
      <Title lead="We'll show more or fewer options. You can switch anytime.">How do you like your apps?</Title>
      <Options role="radiogroup">
        {LEVELS.map((l) => (
          <Option key={l.id} kind="radio" icon={l.icon} title={l.title} hint={l.hint} selected={level === l.id} onClick={() => onChange(l.id)} />
        ))}
      </Options>
      <Spacer />
      <Primary onClick={onNext}>Continue</Primary>
    </>
  );
}

function AiStep({ value, onChange, onNext }: { value: boolean | null; onChange(v: boolean): void; onNext(): void }) {
  return (
    <>
      <Title lead="It reads what you wrote, says if it's right and tells you what you missed. It needs an account with an AI service.">Want AI to grade your typed answers?</Title>
      <Options role="radiogroup">
        <Option kind="radio" icon={CircleCheck} title="Yes, use AI" hint="Grading and feedback on open answers and drawings." selected={value === true} onClick={() => onChange(true)} />
        <Option kind="radio" icon={NotebookText} title="No AI" hint="Classic flashcards: you flip and rate yourself. Nothing leaves your device." selected={value === false} onClick={() => onChange(false)} />
      </Options>
      <Note>
        <b>Either way</b> you get spaced repetition, the Market, Anki import and Sync. AI can be turned on later in Settings.
      </Note>
      <Spacer />
      <Primary onClick={onNext} disabled={value === null}>Continue</Primary>
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
    // ChatGPT sign-in needs the loopback callback of a desktop server.
    ...(serverless() ? [] : [{ id: "chatgpt" as const, icon: MessageCircle, title: "ChatGPT Plus or Pro", hint: "Sign in, no key. Uses your plan's limits." }]),
    { id: "openrouter", icon: ArrowLeftRight, title: "OpenRouter", hint: "Paste a key. Pay per use, fractions of a cent." },
    { id: "openai", icon: Key, title: "OpenAI API key", hint: "Not the same as ChatGPT. Pay per use." },
    ...(level === "tinker" ? [{ id: "local" as const, icon: Server, title: "Local server", hint: "llama.cpp, Ollama or vLLM on this machine. No key." }] : []),
    { id: "none", icon: CircleHelp, title: "None of these", hint: "We'll walk you through the easiest one." },
  ];
  return (
    <>
      <Title lead="Pick all that apply.">Do you have any of these?</Title>
      <Options className="mt-4 gap-2">
        {rows.map((r) => (
          <Option key={r.id} kind="check" icon={r.icon} title={r.title} hint={r.hint} selected={ticked.has(r.id)} onClick={() => toggle(r.id)} />
        ))}
      </Options>
      <Spacer />
      <Primary onClick={onNext} disabled={ticked.size === 0}>Continue</Primary>
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
  if (guided) return <GuidedOpenRouter onOpened={() => setGuided(false)} onSkip={() => onDone("off")} />;
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
      <p className="mt-2.5 flex items-center gap-1.5 text-[13px] text-success" data-test-result="ok">
        <span className="size-2 rounded-full bg-success" />
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
      <Title lead="A browser window opens, you sign in, and come back here. Etude never sees your password.">Connect ChatGPT</Title>
      <Steps items={[<>Tap <b>Sign in with ChatGPT</b></>, <>Approve Etude on the OpenAI page</>, <>We grade a sample answer to make sure it works</>]} />
      <Note>Grading counts toward your ChatGPT usage, like any chat. Free ChatGPT accounts don't work.</Note>
      {signedIn && status && (
        <p className="mt-3 flex items-center gap-1.5 text-[13px] text-foreground/90">
          <CircleCheck className="size-4 text-success" />
          Signed in{status.email ? ` as ${status.email}` : ""}
          {testing && <span className="text-muted-foreground"> · testing…</span>}
        </p>
      )}
      <Verdict result={result} />
      {remote && (
        <div className="mt-3 flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/[0.04] px-3.5 py-3">
          <p className="text-[13px] leading-relaxed">{remote.message}</p>
          <CopyValue label="Run on the machine that runs Etude" value={remote.cli} />
        </div>
      )}
      {failure && <Problem>{failure}</Problem>}
      {waitingUrl && !signedIn && (
        <a href={waitingUrl} target="_blank" rel="noreferrer" className="mt-3 text-center text-[12.5px] text-muted-foreground underline underline-offset-4 hover:text-foreground">
          Waiting for the browser · open the sign-in page
        </a>
      )}
      <Spacer />
      {signedIn ? (
        <Primary onClick={() => onDone({ preset: "chatgpt", tested: !!result?.ok })} busy={testing}>Continue</Primary>
      ) : (
        <Primary onClick={start} busy={busy === "login" || !!waitingUrl}>Sign in with ChatGPT</Primary>
      )}
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
        <button onClick={() => setHelp((h) => !h)} aria-expanded={help} className="mt-2 self-start text-[13px] text-highlight underline-offset-4 hover:underline">
          {help ? "Hide the steps" : "How do I get one?"}
        </button>
      )}
      {help && <OpenRouterHowTo />}
      <form
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
            className="h-11 rounded-xl bg-card pr-16 font-mono text-[13px]"
          />
          {!key && "clipboard" in navigator && (
            <button type="button" onClick={paste} className="absolute top-1/2 right-2 h-8 -translate-y-1/2 rounded-lg px-2.5 text-[13px] text-muted-foreground hover:text-foreground">
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
      <p className="mt-3 text-[12px] leading-normal text-muted-foreground">
        {serverless() ? "Kept only on this device, in the app's private storage." : <>Saved to <span className="font-mono">~/.etude/.env</span> as <span className="font-mono">{env}</span>, readable only by you.</>}
      </p>
      <Spacer />
      {result?.ok ? (
        <Primary onClick={() => onDone({ preset: provider, tested: true })}>Continue</Primary>
      ) : (
        <Primary onClick={test} busy={busy} disabled={!key.trim()}>{result ? "Test again" : "Save and test"}</Primary>
      )}
      {!result?.ok && (
        <a
          href={provider === "openrouter" ? OPENROUTER_KEYS : OPENAI_KEYS}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 flex h-10 items-center justify-center text-[14px] font-medium text-muted-foreground hover:text-foreground"
        >
          Open {provider === "openrouter" ? "openrouter.ai" : "platform.openai.com"}
        </a>
      )}
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
      <Title lead="A site that sells access to AI models by the cent. About 3 minutes.">The easiest way: OpenRouter</Title>
      <OpenRouterHowTo />
      <Spacer />
      <Primary
        onClick={() => {
          openOutside(OPENROUTER_KEYS);
          onOpened();
        }}
      >
        Open openrouter.ai
      </Primary>
      <Ghost onClick={onSkip}>Skip for now, study without AI</Ghost>
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
      <Title lead="Any OpenAI-compatible chat endpoint: llama.cpp, Ollama, vLLM. No key is sent.">Use a local server</Title>
      <div className="mt-4 flex flex-col gap-3">
        <label className="text-[12.5px] text-muted-foreground">
          URL
          <Input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} className="mt-1.5 h-11 rounded-xl bg-card font-mono text-[13px] text-foreground" />
        </label>
        <label className="text-[12.5px] text-muted-foreground">
          Model
          <Input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} placeholder="the name your server reports" className="mt-1.5 h-11 rounded-xl bg-card font-mono text-[13px] text-foreground" />
        </label>
      </div>
      <Verdict result={result} />
      <Spacer />
      {result?.ok ? (
        <Primary onClick={() => onDone({ preset: "local", tested: true })}>Continue</Primary>
      ) : (
        <Primary onClick={test} busy={busy} disabled={!url.trim() || !model.trim()}>{result ? "Test again" : "Save and test"}</Primary>
      )}
    </>
  );
}

function SyncStep({ level, onDone }: { level: OnboardingLevel; onDone(o: SyncOutcome): void }) {
  const [choice, setChoice] = useState<SyncChoice | null>(null);
  const [folder, setFolder] = useState("");
  const [server, setServer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noFolder = serverless();
  /** Etude Sync: sign in and subscribe without leaving the setup. */
  const [cloud, setCloud] = useState<CloudStage | null>(null);

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
      // Only the destination is chosen here; signing in and the password are in Settings → Sync.
      const st = await postJson<{ kind: string | null; signedIn: boolean; unlocked: boolean }>("/api/sync/setup", body);
      if (st.kind === "cloud") return setCloud(st.signedIn ? "plan" : "email");
      onDone({ choice, next: !st.unlocked ? "password next" : null });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (cloud) return <CloudSignup stage={cloud} onStage={setCloud} onDone={(next) => onDone({ choice: "cloud", next })} />;

  return (
    <>
      <Title lead="Your cards and reviews stay the same on the phone and the computer.">Use Etude on more than one device?</Title>
      <Options role="radiogroup">
        <Option
          kind="radio"
          icon={CloudLock}
          title="Etude Sync"
          hint={canShowPurchases() ? "Encrypted, works everywhere. US$5/month or US$40/year." : "Encrypted, works everywhere."}
          selected={choice === "cloud"}
          onClick={() => setChoice("cloud")}
        />
        <Option
          kind="radio"
          icon={FolderSync}
          title="My own folder"
          hint={noFolder ? "Desktop app only. Free: point it at Dropbox, iCloud Drive or Syncthing." : "Free: point it at Dropbox, iCloud Drive or Syncthing."}
          selected={choice === "folder"}
          disabled={noFolder}
          onClick={() => setChoice("folder")}
        >
          {choice === "folder" && (
            <div className="px-3.5 pb-3">
              <Input autoFocus value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/home/you/Dropbox/Etude" spellCheck={false} aria-label="Folder" className="h-10 rounded-xl bg-background font-mono text-[13px]" />
            </div>
          )}
        </Option>
        {level === "tinker" && (
          <Option kind="radio" icon={Server} title="My own server" hint="An Etude Sync server you run yourself." selected={choice === "server"} onClick={() => setChoice("server")}>
            {choice === "server" && (
              <div className="px-3.5 pb-3">
                <Input autoFocus value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://sync.example.com" spellCheck={false} aria-label="Server address" className="h-10 rounded-xl bg-background font-mono text-[13px]" />
              </div>
            )}
          </Option>
        )}
        <Option kind="radio" icon={Smartphone} title="Just this device" hint="No sync. You can turn it on later." selected={choice === "device"} onClick={() => setChoice("device")} />
      </Options>
      {error && <Problem>{error}</Problem>}
      <Spacer />
      <Primary onClick={next} disabled={!choice} busy={busy}>Continue</Primary>
    </>
  );
}

type CloudStage = "email" | "code" | "plan" | "waiting";

/** Etude Sync inside the setup: email code, then the plan and checkout on etude.study, then back here. */
function CloudSignup({ stage, onStage, onDone }: { stage: CloudStage; onStage(s: CloudStage): void; onDone(next: string | null): void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [plan, setPlan] = useState<"monthly" | "yearly">("yearly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  /** Signed in: subscribe if this server charges and the account has no Sync yet, otherwise go on to the password. */
  const afterSignIn = async () => {
    window.dispatchEvent(new Event(ACCOUNT_EVENT));
    const a = await account.status();
    if (a.me?.sync.active || !a.offering?.billing) return onDone("password next");
    if (!canShowPurchases()) return onDone("subscribe on etude.study");
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
        onDone("password next");
      }
    }, 3000);
    return () => window.clearInterval(t);
  }, [stage, onDone]);

  if (stage === "email")
    return (
      <>
        <Title lead="We'll email you a code. No password to remember.">Sign in to Etude Sync</Title>
        <form className="mt-5" onSubmit={(e) => (e.preventDefault(), void run(async () => {
          if (!email.trim()) throw new Error("Enter your email address.");
          await postJson("/api/sync/signin", { email: email.trim() });
          onStage("code");
        }))}>
          <Input autoFocus type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Email" className="h-12 rounded-xl bg-card text-[15px]" />
          {error && <Problem>{error}</Problem>}
          <Spacer />
          <Primary busy={busy} disabled={!email.trim()} onClick={() => {}}>Send code</Primary>
        </form>
      </>
    );

  if (stage === "code")
    return (
      <>
        <Title lead={<>Sent to <span className="text-foreground">{email.trim()}</span>. It works for a few minutes.</>}>Enter the code</Title>
        <form className="mt-5" onSubmit={(e) => (e.preventDefault(), void run(async () => {
          if (!code.trim()) throw new Error("Enter the code from the email.");
          // Without a subscription the server refuses the vault check after signing in; the plan step is for that.
          await postJson("/api/sync/verify", { code: code.trim() }).catch(async (e) => {
            if (!(await account.status().catch(() => null))?.signedIn) throw e;
          });
          await afterSignIn();
        }))}>
          <Input autoFocus autoComplete="one-time-code" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from the email" aria-label="Sign-in code" className="h-12 rounded-xl bg-card font-mono text-[15px]" />
          {error && <Problem>{error}</Problem>}
          <Spacer />
          <Primary busy={busy} disabled={!code.trim()} onClick={() => {}}>Verify</Primary>
        </form>
        <Ghost onClick={() => void run(async () => void (await postJson("/api/sync/signin", { email: email.trim() })))}>Send again</Ghost>
      </>
    );

  if (stage === "plan")
    return (
      <>
        <Title lead="1 GB, end-to-end encrypted: only your devices can read it. Cancel anytime.">Pick a plan</Title>
        <Options role="radiogroup">
          <Option kind="radio" icon={CalendarDays} title="Yearly · US$40" hint="US$3.33 a month, four months free." selected={plan === "yearly"} onClick={() => setPlan("yearly")} />
          <Option kind="radio" icon={CalendarClock} title="Monthly · US$5" hint="Billed every month." selected={plan === "monthly"} onClick={() => setPlan("monthly")} />
        </Options>
        <Note>Payment opens on etude.study, handled by Polar. Come back here when it's done.</Note>
        {error && <Problem>{error}</Problem>}
        <Spacer />
        <Primary busy={busy} onClick={() => void run(async () => {
          openOutside((await account.checkout(plan)).url);
          onStage("waiting");
        })}>Subscribe</Primary>
        <Ghost onClick={() => onDone("subscribe later")}>Later</Ghost>
      </>
    );

  return (
    <>
      <Title lead="Finish the payment in the browser. This page moves on by itself once Sync is active.">Waiting for the payment</Title>
      <div className="mt-8 flex items-center gap-3 text-[14px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking every few seconds…
      </div>
      <Spacer />
      <Primary onClick={() => void run(async () => {
        const a = await account.status();
        if (a.me?.sync.active) onDone("password next");
        else throw new Error("Sync isn't active yet. If you paid, give it a few seconds.");
      })} busy={busy}>I've paid</Primary>
      {error && <Problem>{error}</Problem>}
      <Ghost onClick={() => onStage("plan")}>Back to plans</Ghost>
    </>
  );
}

function DoneStep({ level, ai, sync, onFinish }: { level: OnboardingLevel; ai: AiOutcome | null; sync: SyncOutcome | null; onFinish(then?: () => void): Promise<void> }) {
  const [importing, setImporting] = useState(false);
  const pickFile = useImportPicker(() => announceDataChange());

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
      <Title>You're set</Title>
      <div className="mt-5 divide-y rounded-[14px] border bg-card text-[13.5px]">
        <Row label="Setup level" value={levelTitle(level)} />
        <Row label="AI grading" value={aiRow.value} pill={aiRow.pill} onClick={ai && ai !== "off" && !(typeof ai === "object" && ai.tested) ? () => void onFinish(() => navigate("/settings#ai")) : undefined} />
        <Row label="Sync" value={syncRow.value} pill={syncRow.pill} onClick={syncRow.pill ? () => void onFinish(() => navigate("/settings#sync")) : undefined} />
      </div>
      <p className="mt-6 text-[14.5px] font-medium">Start with something</p>
      <Options className="mt-2.5">
        <Option icon={importing ? Spinner : Star} title="Try the Showcase deck" hint="Every card type in 5 minutes." onClick={importing ? undefined : showcase} />
        <Option icon={Download} title="Browse the Market" hint="Countries, periodic table, Morse…" onClick={() => void onFinish(() => navigate("/market"))} />
        <Option
          icon={FileInput}
          title="Import from Anki"
          hint="Bring your .apkg with history."
          onClick={() => {
            // The file picker has to open inside the click.
            pickFile();
            void onFinish(() => navigate("/"));
          }}
        />
      </Options>
      <Spacer />
      <Primary onClick={() => void onFinish(() => navigate("/"))}>Go to my decks</Primary>
    </>
  );
}

function Row({ label, value, pill, onClick }: { label: string; value: string; pill?: string | null; onClick?: () => void }) {
  const inner = (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-right">
        <span className="truncate">{value}</span>
        {pill && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{pill}</span>}
        {onClick && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
      </span>
    </>
  );
  return onClick ? (
    <button onClick={onClick} className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left first:rounded-t-[14px] last:rounded-b-[14px] hover:bg-accent/40">
      {inner}
    </button>
  ) : (
    <div className="flex items-center justify-between gap-3 px-3.5 py-3">{inner}</div>
  );
}

const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn(className, "animate-spin")} />;

/** A cloud with a padlock, for the end-to-end encrypted Sync (lucide's stroke style; lucide has no such glyph). */
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
