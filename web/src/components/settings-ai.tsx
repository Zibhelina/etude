// AI grading settings: providers, presets, key status and a live test.
import { useEffect, useState } from "react";
import { agentApi, type ModelGroup } from "@/lib/agent";
import { CircleAlert, CircleCheck, FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Markdown } from "@/components/markdown";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { saveLocalKey, serverless } from "@/lib/native";
import { cn } from "@/lib/utils";
import { BigSwitch, Block, Field, NumberField, Section, TextField } from "@/components/settings-ui";
import { ChatGptBlock } from "@/components/settings-chatgpt";
import {
  isChatGpt,
  isOpenAiChat,
  keyVars,
  matchPreset,
  presetAi,
  usesDecisionModel,
  type AiSettings,
  type ChatGptProvider,
  type ChatProvider,
  type Errors,
  type OpenAiChatProvider,
  type PresetId,
  type SettingsResponse,
  type TestResult,
} from "@/components/settings-model";

const PRESETS: { id: PresetId; label: string; hint: string }[] = [
  { id: "openrouter", label: "OpenRouter", hint: "Decision model for verdicts, a chat model for feedback. One key." },
  { id: "openai", label: "OpenAI", hint: "OpenAI's chat API judges and writes feedback. Needs an OpenAI key." },
  { id: "chatgpt", label: "ChatGPT", hint: "Grade with your ChatGPT Plus or Pro plan. No API key." },
  { id: "local", label: "Local", hint: "An OpenAI-compatible server on this machine (llama.cpp, Ollama, vLLM). No key." },
];

const sec = (ms: number | undefined) => (ms == null ? undefined : ms / 1000);
const ms = (s: number) => (Number.isNaN(s) ? NaN : Math.round(s * 1000));

export function AiSection({ ai, saved, errors, onChange }: { ai: AiSettings; saved: SettingsResponse; errors: Errors; onChange(ai: AiSettings): void }) {
  const defaults = saved.defaults?.ai;
  const preset = matchPreset(ai, defaults);
  const decisionOn = usesDecisionModel(ai);
  const set = (patch: Partial<AiSettings>) => onChange({ ...ai, ...patch });
  const fb = ai.feedback;
  const fbOpen = isOpenAiChat(fb) ? fb : null;
  const fbGpt = isChatGpt(fb) ? fb : null;
  const setFb = (patch: Partial<OpenAiChatProvider>) => set({ feedback: { ...(fbOpen ?? { kind: "openai-chat", url: "", model: "" }), ...patch } });
  const visionOpen = isOpenAiChat(ai.vision) ? ai.vision : null;
  const visionTarget = ai.vision ?? (fb?.vision ? fb : null);

  return (
    <Section
      id="ai"
      title="AI grading"
      description={
        <>
          Open answers are graded in two steps. A small <em>decision model</em> reads the card, the reference and your answer and returns the verdict (correct, partial or
          incorrect) in about a second for a fraction of a cent. A <em>language model</em> then writes a few lines of feedback. Drawings skip the decision model and go
          to a <em>vision model</em>, which judges and explains in one call.
        </>
      }
    >
      <Block title="Quick setup" description="Fills the provider fields below. Feedback timing and language stay as they are.">
        <div className={cn("grid gap-2 sm:grid-cols-2", serverless() ? "lg:grid-cols-3" : "lg:grid-cols-4")}>
          {PRESETS.filter((p) => !(serverless() && p.id === "chatgpt")).map((p) => (
            <button
              key={p.id}
              onClick={() => defaults && onChange(presetAi(p.id, defaults, ai))}
              disabled={!defaults}
              className={cn(
                "flex min-h-11 flex-col items-start gap-1 rounded-lg border px-3.5 py-3 text-left transition-colors hover:border-ring/60 hover:bg-accent/40 disabled:opacity-50",
                preset === p.id && "border-highlight/50 bg-highlight/[0.06]",
              )}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className={cn("text-sm font-medium", preset === p.id && "text-highlight")}>{p.label}</span>
                {preset === p.id && <span className="text-[11px] text-highlight/80">current</span>}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">{p.hint}</span>
            </button>
          ))}
        </div>
      </Block>

      {fbGpt && serverless() && (
        <p className="text-sm text-warning">Signing in with ChatGPT needs the desktop app. Pick OpenRouter or OpenAI above and paste a key below.</p>
      )}
      {fbGpt && !serverless() && (
        <ChatGptBlock
          provider={fbGpt}
          error={errors["feedback.model"]}
          onChange={(patch: Partial<ChatGptProvider>) => set({ feedback: { ...fbGpt, ...patch } })}
        />
      )}

      <Block
        title="Decision model"
        description={
          decisionOn ? (
            <>Returns the verdict as calibrated probabilities, through OpenRouter's <code className="font-mono">openrouter-decisions</code> endpoint. Text answers only.</>
          ) : (
            "Off. The feedback model judges the answer and writes feedback in one call."
          )
        }
        aside={
          <BigSwitch
            checked={decisionOn}
            aria-label="Use a decision model"
            onCheckedChange={(on) =>
              set({ decision: on ? { ...(defaults?.decision ?? { kind: "openrouter-decisions" }), ...(ai.decision?.kind === "openrouter-decisions" ? ai.decision : {}), kind: "openrouter-decisions" } : null })
            }
          />
        }
      >
        {decisionOn && ai.decision && (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="URL" mono className="sm:col-span-2" value={ai.decision.url ?? ""} error={errors["decision.url"]} onChange={(v) => set({ decision: { ...ai.decision!, url: v } })} />
            <TextField label="Model" mono value={ai.decision.model ?? ""} error={errors["decision.model"]} onChange={(v) => set({ decision: { ...ai.decision!, model: v } })} placeholder="liquid/d1-ultra" />
            <TextField
              label="API key variable"
              mono
              value={ai.decision.apiKeyEnv ?? ""}
              error={errors["decision.apiKeyEnv"]}
              onChange={(v) => set({ decision: { ...ai.decision!, apiKeyEnv: v } })}
              placeholder="OPENROUTER_API_KEY"
            />
            <NumberField label="Timeout" suffix="s" value={sec(ai.decision.timeoutMs ?? 8000)} error={errors["decision.timeoutMs"]} onChange={(v) => set({ decision: { ...ai.decision!, timeoutMs: ms(v) } })} />
          </div>
        )}
      </Block>

      <Block
        title="Feedback model"
        description={fbGpt ? "Grading runs through your ChatGPT plan. The account and model are above." : "Any OpenAI-compatible chat completions endpoint."}
      >
        {fb ? (
          fbGpt ? (
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="fb-vision" className="min-w-0">
                <span className="block text-sm">Accepts images</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">On when the model can see, so drawings can be graded without a separate vision model.</span>
              </label>
              <BigSwitch id="fb-vision" checked={fbGpt.vision !== false} onCheckedChange={(v) => set({ feedback: { ...fbGpt, vision: v } })} />
            </div>
          ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="URL" mono className="sm:col-span-2" value={fbOpen?.url ?? ""} error={errors["feedback.url"]} onChange={(v) => setFb({ url: v })} placeholder="https://openrouter.ai/api/v1/chat/completions" />
            <TextField label="Model" mono value={fbOpen?.model ?? ""} error={errors["feedback.model"]} onChange={(v) => setFb({ model: v })} placeholder={preset === "local" ? "the name your server reports" : ""} />
            <TextField
              label="API key variable"
              mono
              value={fbOpen?.apiKeyEnv ?? ""}
              error={errors["feedback.apiKeyEnv"]}
              hint={!fbOpen?.apiKeyEnv ? "Empty: no Authorization header is sent." : undefined}
              onChange={(v) => setFb({ apiKeyEnv: v })}
              placeholder="none"
            />
            <NumberField label="Timeout" suffix="s" value={sec(fbOpen?.timeoutMs ?? 45000)} error={errors["feedback.timeoutMs"]} onChange={(v) => setFb({ timeoutMs: ms(v) })} />
            <NumberField label="Temperature" step={0.1} value={fbOpen?.temperature ?? 0.3} error={errors["feedback.temperature"]} hint="0 to 2. Lower is steadier." onChange={(v) => setFb({ temperature: v })} />
            <div className="flex items-center justify-between gap-4 border-t pt-4 sm:col-span-2">
              <label htmlFor="fb-vision" className="min-w-0">
                <span className="block text-sm">Accepts images</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">On if this model can see, so drawings can be graded without a separate vision model.</span>
              </label>
              <BigSwitch id="fb-vision" checked={!!fbOpen?.vision} onCheckedChange={(v) => setFb({ vision: v })} />
            </div>
          </div>
          )
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            No feedback model. AI-graded cards can't be graded without one.
            <Button size="sm" variant="outline" onClick={() => defaults?.feedback && set({ feedback: structuredClone(defaults.feedback) })}>Add the default</Button>
          </div>
        )}
      </Block>

      <Block
        title="Vision model"
        description={
          ai.vision
            ? "Used for drawings and image answers instead of the feedback model."
            : visionTarget
              ? "Drawings go to the feedback model, which accepts images."
              : "None. Drawing cards will fall back to self-rating until a model that accepts images is set."
        }
        aside={
          <BigSwitch
            checked={!!ai.vision}
            aria-label="Use a separate vision model"
            onCheckedChange={(on) => set({ vision: on ? { kind: "openai-chat", url: fbOpen?.url ?? "", model: "", apiKeyEnv: fbOpen?.apiKeyEnv, vision: true, temperature: 0.3, timeoutMs: 60000 } : null })}
          />
        }
      >
        {visionOpen && (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="URL" mono className="sm:col-span-2" value={visionOpen.url} error={errors["vision.url"]} onChange={(v) => set({ vision: { ...visionOpen, url: v } })} />
            <TextField label="Model" mono value={visionOpen.model} error={errors["vision.model"]} onChange={(v) => set({ vision: { ...visionOpen, model: v } })} />
            <TextField label="API key variable" mono value={visionOpen.apiKeyEnv ?? ""} error={errors["vision.apiKeyEnv"]} onChange={(v) => set({ vision: { ...visionOpen, apiKeyEnv: v } })} placeholder="none" />
            <NumberField label="Timeout" suffix="s" value={sec(visionOpen.timeoutMs ?? 45000)} error={errors["vision.timeoutMs"]} onChange={(v) => set({ vision: { ...visionOpen, timeoutMs: ms(v) } })} />
          </div>
        )}
      </Block>

      <Block title="Feedback">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Write feedback automatically">
            <Select value={ai.autoFeedback} onValueChange={(v) => set({ autoFeedback: v as AiSettings["autoFeedback"] })}>
              <SelectTrigger className="h-10 w-full md:h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ai-graded">After AI-graded answers</SelectItem>
                <SelectItem value="always">After every graded answer</SelectItem>
                <SelectItem value="never">Only when I ask</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <TextField
            label="Feedback language"
            value={ai.language}
            error={errors.language}
            hint="Plain words, e.g. English, Portuguese, or “the language the card is written in”."
            onChange={(v) => set({ language: v })}
          />
        </div>
      </Block>

      <AgentBlock ai={ai} onChange={(patch) => set({ agent: { model: ai.agent?.model ?? null, effort: ai.agent?.effort ?? "low", ...patch } })} />

      <KeysBlock ai={ai} saved={saved} />
      <TestBlock ai={ai} saved={saved} />
    </Section>
  );
}

const EFFORTS: { value: string; label: string }[] = [
  { value: "low", label: "Low (fastest useful)" },
  { value: "minimal", label: "Minimal" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High (slowest)" },
  { value: "default", label: "The model's default" },
];

function AgentBlock({ ai, onChange }: { ai: AiSettings; onChange(patch: { model?: string | null; effort?: string }): void }) {
  const [groups, setGroups] = useState<ModelGroup[] | null>(null);
  useEffect(() => {
    agentApi.models().then((m) => setGroups(m.groups)).catch(() => setGroups([]));
  }, []);
  const value = ai.agent?.model ?? "";
  const known = (groups ?? []).some((g) => g.models.some((m) => m.ref === value));
  return (
    <Block title="Assistant" description="The model Ask Etude starts new chats with, and how long it thinks before acting. You can switch the model per chat; the last one you picked is remembered. Lower effort answers much faster.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Default model">
          <Select value={value || "__feedback"} onValueChange={(v) => onChange({ model: v === "__feedback" ? null : v })}>
            <SelectTrigger className="h-10 w-full md:h-9"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-80">
              <SelectItem value="__feedback">Same as the feedback model</SelectItem>
              {value && !known && <SelectItem value={value}>{value}</SelectItem>}
              {(groups ?? []).map((g) =>
                g.models.slice(0, g.provider === "openrouter" ? 60 : 50).map((m) => (
                  <SelectItem key={m.ref} value={m.ref}>
                    {g.label} · {m.name}
                  </SelectItem>
                )),
              )}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Reasoning effort">
          <Select value={ai.agent?.effort ?? "low"} onValueChange={(v) => onChange({ effort: v })}>
            <SelectTrigger className="h-10 w-full md:h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {EFFORTS.map((e) => (
                <SelectItem key={e.value} value={e.value}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
    </Block>
  );
}

function KeysBlock({ ai, saved }: { ai: AiSettings; saved: SettingsResponse }) {
  const vars = keyVars(ai);
  if (serverless()) return <LocalKeysBlock vars={vars.length ? vars : [{ name: "OPENROUTER_API_KEY", usedBy: ["feedback"] }]} saved={saved} />;
  return (
    <Block
      title="API keys"
      description={
        <>
          Etude never stores or shows keys. Put them in <code className="font-mono text-foreground/90">~/.etude/.env</code>, one per line, then restart the server:
        </>
      }
    >
      <pre className="overflow-x-auto rounded-md bg-background/70 px-3.5 py-3 ring-1 ring-border font-mono text-[13px] leading-relaxed text-foreground/80">
        {(vars.length ? vars.map((v) => `${v.name}=...`) : ["OPENROUTER_API_KEY=..."]).join("\n")}
      </pre>
      {vars.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {vars.map((v) => {
            const known = v.name in saved.keyStatus;
            const set = saved.keyStatus[v.name];
            return (
              <li key={v.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                {!known ? (
                  <CircleAlert className="size-4 shrink-0 text-muted-foreground" />
                ) : set ? (
                  <CircleCheck className="size-4 shrink-0 text-success" />
                ) : (
                  <CircleAlert className="size-4 shrink-0 text-warning" />
                )}
                <span className="font-mono text-[13px]">{v.name}</span>
                <span className={cn("text-xs", !known ? "text-muted-foreground" : set ? "text-success" : "text-warning")}>{!known ? "save to check" : set ? "set" : "missing"}</span>
                <span className="text-xs text-muted-foreground">· {v.usedBy.join(", ")}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">The current setup doesn't need any key.</p>
      )}
    </Block>
  );
}

/** No server here (browser build, phone apps): keys are pasted in and kept in the app's private storage. */
function LocalKeysBlock({ vars, saved }: { vars: { name: string; usedBy: string[] }[]; saved: SettingsResponse }) {
  const [status, setStatus] = useState<Record<string, boolean>>(saved.keyStatus);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const save = async (name: string, value: string) => {
    setBusy(name);
    try {
      await saveLocalKey(name, value);
      setStatus((s) => ({ ...s, [name]: !!value.trim() }));
      setValues((v) => ({ ...v, [name]: "" }));
      toast.success(value.trim() ? `${name} saved on this device` : `${name} removed`);
    } catch (e) {
      toast.error("Couldn't save the key", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Block title="API keys" description="Stored only on this device, in the app's private storage. Etude never shows a key again after you save it.">
      <ul className="flex flex-col gap-4">
        {vars.map((v) => (
          <li key={v.name} className="flex flex-col gap-2" data-local-key={v.name}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {status[v.name] ? <CircleCheck className="size-4 shrink-0 text-success" /> : <CircleAlert className="size-4 shrink-0 text-warning" />}
              <span className="font-mono text-[13px]">{v.name}</span>
              <span className={cn("text-xs", status[v.name] ? "text-success" : "text-warning")}>{status[v.name] ? "set" : "missing"}</span>
              <span className="text-xs text-muted-foreground">· {v.usedBy.join(", ")}</span>
            </div>
            <div className="flex gap-2">
              <Input
                type="password"
                aria-label={`Value for ${v.name}`}
                autoComplete="off"
                spellCheck={false}
                placeholder={status[v.name] ? "Paste a new key to replace it" : "Paste the key"}
                className="h-10 font-mono text-[13px] md:h-9"
                value={values[v.name] ?? ""}
                onChange={(e) => setValues((x) => ({ ...x, [v.name]: e.target.value }))}
              />
              <Button size="sm" className="h-10 md:h-9" disabled={busy === v.name || !(values[v.name] ?? "").trim()} onClick={() => save(v.name, values[v.name] ?? "")}>
                Save
              </Button>
              {status[v.name] && (
                <Button size="sm" variant="outline" className="h-10 md:h-9" disabled={busy === v.name} onClick={() => save(v.name, "")}>
                  Remove
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Block>
  );
}

function TestBlock({ ai, saved }: { ai: AiSettings; saved: SettingsResponse }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsaved = JSON.stringify(ai) !== JSON.stringify(saved.ai);
  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.testAi());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const v = result?.verdict;
  const f = result?.feedback;
  const cost = (v?.cost ?? 0) + (f?.cost ?? 0);
  const hasCost = v?.cost != null || f?.cost != null;
  const sameError = !!result?.verdictError && result.verdictError === result.feedbackError;
  return (
    <Block
      title="Test"
      description={<>Grades the answer “hypertext transfer protocol” to “What does HTTP stand for?” with the saved settings{unsaved ? ". Save first to test your edits" : ""}.</>}
      stackAside
      aside={
        <Button size="sm" variant="outline" className="h-10 gap-1.5 md:h-8" onClick={run} disabled={running || unsaved}>
          {running ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
          {running ? "Testing…" : "Run test"}
        </Button>
      }
    >
      {error && <p className="text-sm text-destructive">{error}</p>}
      {result && sameError && (
        <div className="flex gap-3 rounded-lg border border-destructive/40 px-3.5 py-3 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="break-words text-destructive">{result.verdictError}</p>
            {/ is not set$/.test(result.verdictError ?? "") && !serverless() && <p className="mt-1 text-xs text-muted-foreground">Add it to ~/.etude/.env and restart the server, then run the test again.</p>}
          </div>
        </div>
      )}
      {result && !sameError && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TestPart title="Verdict" error={result.verdictError}>
            {v && (
              <>
                <div className="flex items-baseline gap-2">
                  <span className={cn("text-base font-medium capitalize", v.verdict === "correct" ? "text-success" : v.verdict === "partial" ? "text-warning" : "text-danger")}>{v.verdict}</span>
                  <span className="tabular text-sm text-muted-foreground">score {v.score.toFixed(2)}{v.confidence != null ? `, confidence ${v.confidence.toFixed(2)}` : ""}</span>
                </div>
                <Meta model={v.model} ms={v.ms} cost={v.cost} />
              </>
            )}
          </TestPart>
          <TestPart title="Feedback" error={result.feedbackError}>
            {f && (
              <>
                <Markdown className="text-sm">{f.feedback}</Markdown>
                <Meta model={f.model} ms={f.ms} cost={f.cost} />
              </>
            )}
          </TestPart>
          {hasCost && <p className="text-xs text-muted-foreground sm:col-span-2">This test cost <span className="tabular text-foreground/85">{fmtCost(cost)}</span> in total, as reported by the providers.</p>}
        </div>
      )}
    </Block>
  );
}

function TestPart({ title, error, children }: { title: string; error?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-3 rounded-lg border p-3.5", error && "border-destructive/40")}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {error && <CircleAlert className="size-3.5 text-destructive" />}
        {title}
      </div>
      {error ? <p className="break-words text-sm text-destructive">{error}</p> : children}
    </div>
  );
}

function Meta({ model, ms, cost }: { model: string; ms: number; cost?: number }) {
  return (
    <dl className="mt-auto grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-2.5 text-xs">
      <dt className="text-muted-foreground">Model</dt>
      <dd className="min-w-0 break-all font-mono text-foreground/85">{model}</dd>
      <dt className="text-muted-foreground">Time</dt>
      <dd className="tabular text-foreground/85">{fmtMs(ms)}</dd>
      {cost != null && (
        <>
          <dt className="text-muted-foreground">Cost</dt>
          <dd className="tabular text-foreground/85">{fmtCost(cost)}</dd>
        </>
      )}
    </dl>
  );
}

// Two significant digits, written out: $0.0000057 reads better than 5.7e-6.
const fmtCost = (c: number) => (c <= 0 ? "$0" : `$${c.toFixed(Math.min(10, Math.max(2, 1 - Math.floor(Math.log10(c)))))}`);

const fmtMs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
