// Settings → AI → Agents: one card per agent you can talk to in Ask, Minimi first. Each card is that agent's
// own space: its name, its brain (Hermes, a ChatGPT/OpenRouter/custom model, or another ACP agent), its
// personality and its look. Everything saves as you change it. Below, Providers: the ChatGPT sign-in, the
// OpenRouter key and the custom endpoint that model brains run on.
//
// Hermes and other agents become the card's own entry in this device's `ai.agents` (the server does it, see
// Etude.setAgentBrain): the user never manages that list, and the command never syncs.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, CircleAlert, CircleCheck, Copy, Ellipsis, ExternalLink, Film, ImageMinus, Loader2, LogOut, Plus, Star, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import { Block, Card, Field, GroupLabel, REVEAL_EVENT } from "@/components/settings-ui";
import { AgentAvatar } from "@/components/agent-avatar";
import { ModelPicker } from "@/components/agent-panel";
import { PhotoPanel, readPhoto, savePhoto, type PhotoDraft } from "@/components/avatar";
import { useChatGptSignIn } from "@/components/settings-chatgpt";
import type { SettingsResponse } from "@/components/settings-model";
import { agentApi, type ModelGroup } from "@/lib/agent";
import { api } from "@/lib/api";
import { chatGptSignInHere, saveApiKey, serverless } from "@/lib/native";
import { EtudeImg } from "@/lib/local-url";
import { mediaUrl, MINIMI_PROFILE_ID, profilesApi, useAgentProfiles, type BrainPick, type ProfileView } from "@/lib/agent-profiles";
import { cn } from "@/lib/utils";
import minimiLook from "@/assets/minimi/look.webp";
import { holidayArt } from "@/lib/holiday";
import { ACP_PRESETS } from "../../../src/core/acp-agents.ts";
import {
  CLIP_FILE_NAMES,
  CLIP_NAMES,
  clipProblem,
  PROFILE_NAME_MAX,
  PROFILE_PERSONALITY_MAX,
  type AgentClips,
  type BrainEffort,
  type ClipName,
  type ClipRef,
} from "../../../src/core/agent-profiles.ts";
import { ProfileClips, clipsOk } from "@/components/minimi-clips";

type Models = {
  configured: boolean;
  default: string | null;
  groups: ModelGroup[];
};
type Hermes = { installed: boolean; available: boolean; profiles: string[] };
type Provider = "chatgpt" | "openrouter" | "custom";
type Seg = "hermes" | Provider | "agent";
type AgentPreset = Exclude<(typeof ACP_PRESETS)[number]["id"], "hermes">;

const SEGS: { id: Seg; label: string }[] = [
  { id: "hermes", label: "Hermes" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "custom", label: "Custom" },
  { id: "agent", label: "Other agent" },
];
const PROVIDER_LABEL: Record<Provider, string> = {
  chatgpt: "ChatGPT",
  openrouter: "OpenRouter",
  custom: "a custom endpoint",
};
const AGENT_PRESETS = ACP_PRESETS.filter((p): p is (typeof ACP_PRESETS)[number] & { id: AgentPreset } => p.id !== "hermes");
const HERMES_URL = "https://hermes-agent.nousresearch.com/";

const EFFORTS: { value: BrainEffort; label: string }[] = [
  { value: "low", label: "Low (fastest useful)" },
  { value: "minimal", label: "Minimal" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High (slowest)" },
  { value: "default", label: "The model's default" },
];

/** Shell-like words: spaces split, quotes keep a phrase together. */
function splitWords(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}
const joinWords = (a: string[]) => a.map((w) => (/[\s"']/.test(w) || !w ? JSON.stringify(w) : w)).join(" ");
const envText = (env?: Record<string, string>) =>
  Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${/\s/.test(v) ? JSON.stringify(v) : v}`)
    .join(" ");
function parseEnv(s: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const w of splitWords(s)) {
    const i = w.indexOf("=");
    if (i > 0) out[w.slice(0, i)] = w.slice(i + 1);
  }
  return Object.keys(out).length ? out : undefined;
}
const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const providerOf = (ref: string | null | undefined): Provider | null => (ref?.match(/^(chatgpt|openrouter|custom):/)?.[1] as Provider | undefined) ?? null;

/** A card's brain as a pick (what the card shows and changes). */
function pickOf(p: ProfileView): BrainPick {
  const b = p.brain;
  if (b.kind === "model")
    return {
      kind: "model",
      model: b.model,
      ...(b.effort ? { effort: b.effort } : {}),
    };
  const via = p.setup?.via ?? b.via;
  if (via === "hermes")
    return {
      kind: "hermes",
      profile: b.hermes ?? (p.setup?.args[0] === "-p" ? p.setup.args[1] : "default"),
    };
  return {
    kind: "agent",
    preset: via ?? "custom",
    ...(p.setup && via === "custom" ? { command: p.setup.command, args: p.setup.args } : {}),
    ...(p.setup?.env ? { env: p.setup.env } : {}),
  };
}

function segOf(pick: BrainPick, models: Models | null): Seg {
  if (pick.kind === "hermes") return "hermes";
  if (pick.kind === "agent") return "agent";
  return providerOf(pick.model) ?? providerOf(models?.default) ?? "chatgpt";
}

function brainWords(pick: BrainPick, models: Models | null): string {
  if (pick.kind === "hermes") return `Hermes · ${pick.profile}`;
  if (pick.kind === "agent") return AGENT_PRESETS.find((p) => p.id === pick.preset)?.label ?? "an agent";
  const ref = pick.model ?? models?.default ?? null;
  for (const g of models?.groups ?? []) for (const m of g.models) if (m.ref === ref) return m.name;
  return ref ? ref.replace(/^[a-z]+:/, "") : "the default model";
}

/** The Ask part of Settings → AI: the agents, then the providers their models run on. */
export function AskSettings({ saved }: { saved: SettingsResponse }) {
  const { profiles, default: def } = useAgentProfiles();
  const [models, setModels] = useState<Models | null>(null);
  const [hermes, setHermes] = useState<Hermes | null>(null);
  const [adding, setAdding] = useState(false);
  const loadModels = (force = false) => agentApi.models(force).then(setModels, () => setModels({ configured: false, default: null, groups: [] }));
  useEffect(() => {
    void loadModels();
    void profilesApi.hermes().then(setHermes);
  }, []);
  return (
    <>
      <div id="ai-agents" className="scroll-mt-24" data-agents-section data-settings-title aria-label="Agents">
        <GroupLabel>Agents</GroupLabel>
        <div className="flex flex-col gap-4">
          {profiles.map((p) => (
            <AgentCard key={p.id} p={p} isDefault={p.id === def} models={models} hermes={hermes} />
          ))}
          {adding ? (
            <NewAgentCard models={models} hermes={hermes} onDone={() => setAdding(false)} />
          ) : (
            <div>
              <Button size="sm" variant="outline" className="phone:h-10 h-9 gap-1.5 rounded-lg" onClick={() => setAdding(true)} data-agent-new>
                <Plus className="size-3.5" />
                New agent
              </Button>
            </div>
          )}
        </div>
        <p className="mt-2.5 px-0.5 text-[13px] leading-relaxed text-muted-foreground">The default agent sits in the corner and starts new chats. In a chat, tap its name to talk to someone else.</p>
      </div>
      <div id="ai-providers" className="scroll-mt-24" data-settings-title aria-label="Providers">
        <GroupLabel>Providers</GroupLabel>
        <ProvidersCard saved={saved} models={models} onChanged={() => void loadModels(true)} />
      </div>
    </>
  );
}

async function run(fn: () => Promise<unknown>, done?: string) {
  try {
    await fn();
    if (done) toast.success(done);
    return true;
  } catch (e) {
    toast.error("Couldn't save", { description: (e as Error).message });
    return false;
  }
}

/** One agent's space: header (picture, name, default, menu), brain, personality, look. */
function AgentCard({ p, isDefault, models, hermes }: { p: ProfileView; isDefault: boolean; models: Models | null; hermes: Hermes | null }) {
  const minimi = p.id === MINIMI_PROFILE_ID;
  const pick = useMemo(() => pickOf(p), [p]);
  const external = pick.kind !== "model";
  const [lookOpen, setLookOpen] = useState(false);
  // What the brain control shows, which can be ahead of what's saved (a provider or agent still to pick).
  const [shown, setShown] = useState<Seg | null>(null);
  const setBrain = (next: BrainPick) => run(() => profilesApi.setBrain(p.id, next), `${p.name} · ${brainWords(next, models)}`);
  const setupHere = !external || p.available || serverless() ? undefined : () => void setBrain(pick);

  return (
    <div data-agent-card={p.id} className="@container/agent">
      <Card className="flex flex-col">
        <CardHeader p={p} isDefault={isDefault} minimi={minimi} />
        <div className="flex flex-col gap-5 border-t border-border/70 px-4 py-4 sm:px-5">
          <BrainEditor name={p.name} pick={pick} onPick={setBrain} onSeg={setShown} models={models} hermes={hermes} unavailable={external && !p.available ? { setupHere } : undefined} />
          {!serverless() && p.brain.kind === "external" && (p.setup?.via === "hermes" || p.setup?.via === "antigravity" || p.brain.via === "hermes" || p.brain.via === "antigravity") && (
            <HarnessesRow p={p} hermes={hermes} />
          )}
          <PersonalityField p={p} seg={shown ?? segOf(pick, models)} pick={pick} />
        </div>
        <div className="border-t border-border/70">
          <button
            type="button"
            aria-expanded={lookOpen}
            onClick={() => setLookOpen((o) => !o)}
            className="flex w-full items-center gap-2 rounded-b-[14px] px-4 py-3 text-left text-[13.5px] outline-ring transition-colors hover:bg-accent/40 focus-visible:outline-2 sm:px-5"
            data-agent-look-toggle
          >
            <span className="font-medium text-foreground">Look</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">· picture, body, animation, banner</span>
            <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", lookOpen && "rotate-90")} />
          </button>
          {lookOpen && <LookEditor p={p} />}
        </div>
      </Card>
    </div>
  );
}

function CardHeader({ p, isDefault, minimi }: { p: ProfileView; isDefault: boolean; minimi: boolean }) {
  const [name, setName] = useState(p.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setName(p.name), [p.name]);
  const commit = () => {
    const n = name.trim();
    if (!n) return setName(p.name);
    if (n !== p.name) void run(() => profilesApi.edit(p.id, { name: n }), "Renamed");
  };
  return (
    <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
      <AgentAvatar profile={p} size={40} className={cn(!p.available && "opacity-60")} />
      <input
        ref={input}
        aria-label={`Name of ${p.name}`}
        value={name}
        maxLength={PROFILE_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") input.current?.blur();
          if (e.key === "Escape") {
            setName(p.name);
            requestAnimationFrame(() => input.current?.blur());
          }
        }}
        className="h-8 min-w-[5rem] flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[15.5px] font-semibold text-foreground outline-none transition-colors hover:border-border focus:border-ring"
        data-agent-name
      />
      {isDefault ? (
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground" data-agent-default>
          Default
        </span>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="hidden h-8 shrink-0 gap-1.5 px-2 text-[13px] text-muted-foreground hover:text-foreground @[26rem]/agent:inline-flex"
          onClick={() => void run(() => profilesApi.setDefault(p.id), `${p.name} is the default now`)}
          data-agent-make-default
        >
          <Star className="size-3.5" />
          Make default
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label={`More for ${p.name}`} data-agent-menu>
            <Ellipsis className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {!isDefault && (
            <DropdownMenuItem onSelect={() => void run(() => profilesApi.setDefault(p.id), `${p.name} is the default now`)}>
              <Star />
              Make default
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void run(() => profilesApi.duplicate(p.id), "Copied")}>
            <Copy />
            Duplicate
          </DropdownMenuItem>
          {!minimi && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void run(() => profilesApi.remove(p.id), `${p.name} removed`)}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The brain: one segmented control (a select on phones) and what that choice needs. `onPick` gets complete picks
 * only; a choice that still needs something (a provider to connect, an agent to pick) stays on the card until then.
 */
function BrainEditor({
  name,
  pick,
  onPick,
  onSeg,
  models,
  hermes,
  unavailable,
}: {
  name: string;
  pick: BrainPick;
  onPick(p: BrainPick): void;
  onSeg?(s: Seg): void;
  models: Models | null;
  hermes: Hermes | null;
  unavailable?: { setupHere?: () => void };
}) {
  const [seg, setSeg] = useState<Seg>(() => segOf(pick, models));
  // What each choice was last, so going Hermes → OpenRouter → Hermes comes back to the same profile and model.
  const last = useRef<Partial<Record<Seg, BrainPick>>>({});
  const key = JSON.stringify(pick);
  useEffect(() => {
    const s = segOf(pick, models);
    last.current[s] = pick;
    setSeg(s);
  }, [key, !!models]);
  useEffect(() => onSeg?.(seg), [seg]);
  const effort: BrainEffort = (pick.kind === "model" ? pick.effort : undefined) ?? "low";

  const choose = (s: Seg) => {
    if (s === seg) return;
    setSeg(s);
    const remembered = last.current[s];
    if (s === "hermes") {
      const guess = hermes?.profiles.find((x) => x === slug(name)) ?? hermes?.profiles.find((x) => x === "default") ?? hermes?.profiles[0] ?? "default";
      return onPick(remembered ?? { kind: "hermes", profile: guess });
    }
    if (s === "agent") return remembered ? onPick(remembered) : undefined;
    const group = models?.groups.find((g) => g.provider === s);
    if (!group?.models.length) return;
    // The model it had there before, or the default when it's this provider's; else it waits for a pick.
    const model = remembered?.kind === "model" ? remembered.model : providerOf(models?.default) === s ? models!.default : null;
    if (model) onPick({ kind: "model", model, effort });
  };

  return (
    <div className="flex flex-col gap-3" data-agent-brain={seg}>
      {/* Segments when the card has room for all five on one line, else a select (phones, a narrow settings column). */}
      <div className="flex items-center gap-3">
        <span className="hidden w-24 shrink-0 text-xs font-medium text-muted-foreground @[38rem]/agent:block">Brain</span>
        <ToggleGroup type="single" variant="outline" value={seg} onValueChange={(v) => v && choose(v as Seg)} aria-label="Brain" className="hidden @[38rem]/agent:flex">
          {SEGS.map((s) => (
            <ToggleGroupItem key={s.id} value={s.id} className="h-8 px-3 text-[13px]" data-brain-seg={s.id}>
              {s.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="w-full @[38rem]/agent:hidden">
          <Field label="Brain">
            <Select value={seg} onValueChange={(v) => choose(v as Seg)}>
              <SelectTrigger className="phone:h-10 h-9 w-full" aria-label="Brain" data-brain-select>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEGS.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </div>
      <div className="flex flex-col gap-2 @[38rem]/agent:pl-[108px]">
        {unavailable && (seg === "hermes" || seg === "agent") ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted-foreground" data-agent-elsewhere>
            <span>Runs on the computer where it's set up.</span>
            {unavailable.setupHere && (
              <Button size="sm" variant="outline" className="h-8 rounded-lg" onClick={unavailable.setupHere}>
                Set it up here
              </Button>
            )}
          </div>
        ) : seg === "hermes" ? (
          <HermesBrain pick={pick.kind === "hermes" ? pick : null} hermes={hermes} onPick={onPick} />
        ) : seg === "agent" ? (
          <OtherAgentBrain pick={pick.kind === "agent" ? pick : null} onPick={onPick} />
        ) : (
          <ModelBrain provider={seg} pick={pick.kind === "model" && providerOf(pick.model ?? models?.default) === seg ? pick : null} models={models} effort={effort} onPick={onPick} />
        )}
      </div>
    </div>
  );
}

function HermesBrain({ pick, hermes, onPick }: { pick: { kind: "hermes"; profile: string } | null; hermes: Hermes | null; onPick(p: BrainPick): void }) {
  const profile = pick?.profile ?? "";
  const [text, setText] = useState(profile);
  useEffect(() => setText(profile), [profile]);
  const list = hermes?.profiles ?? [];
  const options = profile && !list.includes(profile) ? [profile, ...list] : list;
  const set = (v: string) => v.trim() && v.trim() !== profile && onPick({ kind: "hermes", profile: v.trim() });
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {options.length ? (
          <Select value={profile || undefined} onValueChange={set}>
            <SelectTrigger className="phone:h-10 h-9 w-full sm:w-64" aria-label="Hermes profile" data-hermes-profile>
              <SelectValue placeholder="Pick a profile" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {options.map((x) => (
                <SelectItem key={x} value={x}>
                  {x}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            aria-label="Hermes profile"
            value={text}
            placeholder="default"
            className="phone:h-10 h-9 w-full font-mono text-[13px] sm:w-64"
            onChange={(e) => setText(e.target.value)}
            onBlur={() => set(text || "default")}
            onKeyDown={(e) => e.key === "Enter" && set(text || "default")}
            data-hermes-profile
          />
        )}
      </div>
      {hermes && !hermes.available ? (
        <p className="text-[12.5px] text-muted-foreground">Hermes runs on a computer: pick this in the desktop app there, and the agent shows up here too.</p>
      ) : hermes && !hermes.installed ? (
        <p className="text-[12.5px] text-muted-foreground" data-hermes-missing>
          Hermes isn't installed on this computer.{" "}
          <a href={HERMES_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-foreground underline-offset-4 hover:underline">
            Get Hermes
            <ExternalLink className="size-3" />
          </a>
        </p>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          Runs <code className="font-mono text-foreground/85">hermes -p {profile || "…"} acp</code> on this computer. Personality and memory come from Hermes.
        </p>
      )}
    </>
  );
}

function ModelBrain({
  provider,
  pick,
  models,
  effort,
  onPick,
}: {
  provider: Provider;
  pick: { kind: "model"; model: string | null; effort?: BrainEffort } | null;
  models: Models | null;
  effort: BrainEffort;
  onPick(p: BrainPick): void;
}) {
  const group = models?.groups.find((g) => g.provider === provider);
  if (!models) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  if (!group)
    return (
      <p className="text-[13px] text-muted-foreground" data-provider-missing={provider}>
        <a
          href="#ai-providers"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById("ai-providers")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          className="text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
        >
          Connect {provider === "custom" ? "a custom endpoint" : PROVIDER_LABEL[provider]} below
        </a>
      </p>
    );
  const value = pick?.model ?? (providerOf(models.default) === provider ? models.default : null);
  return (
    <div className="grid gap-3 @[30rem]/agent:grid-cols-[minmax(0,1fr)_12rem]">
      <Field label="Model">
        <ModelPicker
          models={{ groups: [group], default: null }}
          value={value}
          onPick={(ref) => onPick({ kind: "model", model: ref, effort })}
          placeholder="Pick a model"
          side="bottom"
          className="phone:h-10 h-9 w-full max-w-none justify-between rounded-md border border-input px-3 text-[13.5px]"
        />
        {group.error && <p className="text-xs text-destructive">{group.error}</p>}
      </Field>
      <Field label="Reasoning effort" hint={!value ? "Pick a model first." : undefined}>
        <Select value={effort} disabled={!value} onValueChange={(v) => value && onPick({ kind: "model", model: value, effort: v as BrainEffort })}>
          <SelectTrigger className="phone:h-10 h-9 w-full" aria-label="Reasoning effort" data-agent-effort>
            <SelectValue />
          </SelectTrigger>
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
  );
}

function OtherAgentBrain({ pick, onPick }: { pick: Extract<BrainPick, { kind: "agent" }> | null; onPick(p: BrainPick): void }) {
  const [preset, setPreset] = useState<AgentPreset | "">(pick?.preset ?? "");
  const [line, setLine] = useState(() => (pick?.command ? joinWords([pick.command, ...(pick.args ?? [])]) : ""));
  const [env, setEnv] = useState(() => envText(pick?.env));
  const [advanced, setAdvanced] = useState(!!pick?.env);
  useEffect(() => {
    setPreset(pick?.preset ?? "");
    setLine(pick?.command ? joinWords([pick.command, ...(pick.args ?? [])]) : "");
    setEnv(envText(pick?.env));
  }, [JSON.stringify(pick)]);
  const p = AGENT_PRESETS.find((x) => x.id === preset);
  const commit = (next: AgentPreset | "" = preset) => {
    if (!next) return;
    const parsed = parseEnv(env);
    if (next !== "custom")
      return onPick({
        kind: "agent",
        preset: next,
        ...(parsed ? { env: parsed } : {}),
      });
    const words = splitWords(line);
    if (!words.length) return;
    const same = pick?.preset === "custom" && pick.command === words[0] && JSON.stringify(pick.args ?? []) === JSON.stringify(words.slice(1)) && envText(pick.env) === envText(parsed);
    if (!same)
      onPick({
        kind: "agent",
        preset: "custom",
        command: words[0],
        args: words.slice(1),
        ...(parsed ? { env: parsed } : {}),
      });
  };
  return (
    <>
      <Select
        value={preset || undefined}
        onValueChange={(v) => {
          setPreset(v as AgentPreset);
          if (v !== "custom") commit(v as AgentPreset);
        }}
      >
        <SelectTrigger className="phone:h-10 h-9 w-full sm:w-64" aria-label="Agent" data-agent-preset>
          <SelectValue placeholder="Pick an agent" />
        </SelectTrigger>
        <SelectContent>
          {AGENT_PRESETS.map((x) => (
            <SelectItem key={x.id} value={x.id}>
              {x.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {preset === "custom" && (
        <Input
          aria-label="Command"
          value={line}
          placeholder="my-agent --acp"
          spellCheck={false}
          className="phone:h-10 h-9 font-mono text-[13px]"
          onChange={(e) => setLine(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          data-agent-command
        />
      )}
      {p && (
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          {p.hint.replace(/`/g, "")}
          {p.needs && (
            <>
              {" "}
              Needs <code className="font-mono text-foreground/85">{p.needs}</code>.
            </>
          )}{" "}
          It runs on this computer with your account's access, and gets this collection through <code className="font-mono text-foreground/85">etude mcp</code>.
        </p>
      )}
      {p && (
        <div>
          <button
            type="button"
            className="text-[12.5px] text-muted-foreground underline-offset-4 outline-ring hover:text-foreground hover:underline focus-visible:outline-2"
            aria-expanded={advanced}
            onClick={() => setAdvanced((a) => !a)}
          >
            Advanced
          </button>
          {advanced && (
            <Field label="Environment" className="mt-2" hint="NAME=value pairs, for this agent's program only.">
              <Input
                aria-label="Environment"
                value={env}
                placeholder="NAME=value …"
                spellCheck={false}
                className="phone:h-10 h-9 font-mono text-[13px]"
                onChange={(e) => setEnv(e.target.value)}
                onBlur={() => commit()}
                onKeyDown={(e) => e.key === "Enter" && commit()}
              />
            </Field>
          )}
        </div>
      )}
    </>
  );
}

/** Lets an external Hermes or Antigravity profile also switch to the other harness in the chat's message box. */
function HarnessesRow({ p, hermes }: { p: ProfileView; hermes: Hermes | null }) {
  const brain = p.brain;
  if (brain.kind !== "external") return null;
  const ownVia = p.setup?.via ?? brain.via;
  const other: "antigravity" | "hermes" = ownVia === "hermes" ? "antigravity" : "hermes";
  const otherLabel = other === "antigravity" ? "Antigravity" : "Hermes";
  const enabled = (brain.harnesses ?? []).some((h) => h.agent !== brain.agent && h.name.toLowerCase() === otherLabel.toLowerCase());
  const [profile, setProfile] = useState(() => hermes?.profiles.find((x) => x === slug(p.name)) ?? hermes?.profiles.find((x) => x === "default") ?? hermes?.profiles[0] ?? "default");
  const toggle = (on: boolean) =>
    void run(
      () => profilesApi.toggleHarness(p.id, other, on, other === "hermes" ? profile : undefined),
      on ? `${p.name} can also run in ${otherLabel}` : `Removed ${otherLabel} harness`,
    );
  return (
    <div className="flex flex-col gap-2 @[38rem]/agent:flex-row @[38rem]/agent:items-center @[38rem]/agent:gap-3" data-agent-harnesses>
      <span className="text-xs font-medium text-muted-foreground @[38rem]/agent:w-24 @[38rem]/agent:shrink-0">Harnesses</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-[13.5px] text-foreground">
          <Switch checked={enabled} onCheckedChange={toggle} aria-label={`Also run ${p.name} in ${otherLabel}`} />
          <span>Also run in {otherLabel}</span>
        </label>
        {other === "hermes" && enabled && (hermes?.profiles.length ?? 0) > 0 && (
          <Select value={profile} onValueChange={(v) => (setProfile(v), void run(() => profilesApi.toggleHarness(p.id, "hermes", true, v), `Hermes harness · ${v}`))}>
            <SelectTrigger className="h-8 w-44 text-xs" aria-label="Hermes harness profile">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {hermes!.profiles.map((x) => (
                <SelectItem key={x} value={x}>{x}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="text-[12px] text-muted-foreground">Switch between Hermes and Antigravity right in the chat box.</span>
      </div>
    </div>
  );
}

/** Personality for a model brain; for Hermes or another agent, notes added in Etude. Follows the brain shown on the card. */
function PersonalityField({ p, seg, pick }: { p: ProfileView; seg: Seg; pick: BrainPick }) {
  const [text, setText] = useState(p.personality);
  useEffect(() => setText(p.personality), [p.personality]);
  const external = seg === "hermes" || seg === "agent";
  const where = seg === "hermes" ? "Hermes" : seg === "agent" && pick.kind === "agent" ? (AGENT_PRESETS.find((x) => x.id === pick.preset)?.label ?? null) : null;
  return (
    <Field
      label={external ? `Notes for ${p.name}` : "Personality"}
      htmlFor={`agent-personality-${p.id}`}
      hint={
        external
          ? where
            ? `${p.name}'s personality lives in ${where}; these notes are added in Etude.`
            : "These notes go to the agent with each message."
          : !text.trim()
          ? p.id === MINIMI_PROFILE_ID
            ? "Empty keeps Minimi his usual self."
            : "Empty: clear, brief and friendly."
          : undefined
      }
    >
      <Textarea
        id={`agent-personality-${p.id}`}
        value={text}
        maxLength={PROFILE_PERSONALITY_MAX}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() !== p.personality.trim() && void run(() => profilesApi.edit(p.id, { personality: text.trim() }), "Saved")}
        placeholder={external ? "e.g. Call me Sam. Keep answers short while I study." : "e.g. A grumpy old wizard who calls me “apprentice” and answers in two lines."}
        className="min-h-20 text-[14px] md:text-[14px]"
      />
    </Field>
  );
}

/** A new agent, before it exists: name, brain, personality; Create makes it. */
function NewAgentCard({ models, hermes, onDone }: { models: Models | null; hermes: Hermes | null; onDone(): void }) {
  const [name, setName] = useState("");
  const [personality, setPersonality] = useState("");
  const [busy, setBusy] = useState(false);
  const firstModel = (prov: Provider) => {
    const g = models?.groups.find((x) => x.provider === prov);
    return g?.models.length ? (providerOf(models?.default) === prov ? models!.default : g.models[0].ref) : null;
  };
  const initial = (): BrainPick => {
    const gpt = firstModel("chatgpt");
    if (gpt) return { kind: "model", model: gpt, effort: "low" };
    if (hermes?.installed)
      return {
        kind: "hermes",
        profile: hermes.profiles.includes("default") ? "default" : hermes.profiles[0] ?? "default",
      };
    for (const prov of ["openrouter", "custom"] as const) {
      const m = firstModel(prov);
      if (m) return { kind: "model", model: m, effort: "low" };
    }
    return { kind: "model", model: null, effort: "low" };
  };
  const [pick, setPick] = useState<BrainPick>(initial);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setPick(initial());
  }, [!!models, !!hermes]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const create = async () => {
    const n = name.trim();
    if (!n) return toast.error("Give it a name");
    setBusy(true);
    const ok = await run(async () => {
      const r = await profilesApi.add({
        name: n,
        personality: personality.trim(),
        avatar: null,
        body: null,
        banner: null,
        ...(pick.kind === "model"
          ? {
              brain: {
                kind: "model",
                model: pick.model,
                ...(pick.effort ? { effort: pick.effort } : {}),
              },
            }
          : {}),
      });
      if (pick.kind !== "model" && r.created) await profilesApi.setBrain(r.created, pick);
    }, `${n} is ready in Ask`);
    setBusy(false);
    if (ok) onDone();
  };
  const view = { id: "new", name: name || "?", avatar: null };
  return (
    <div data-agent-card="new" className="@container/agent">
      <Card className="flex flex-col">
        <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
          <AgentAvatar profile={view} size={40} />
          <input
            ref={input}
            aria-label="Name"
            value={name}
            maxLength={PROFILE_NAME_MAX}
            placeholder="Name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
              if (e.key === "Escape") onDone();
            }}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-transparent px-1.5 text-[15.5px] font-semibold text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground focus:border-ring"
            data-agent-new-name
          />
        </div>
        <div className="flex flex-col gap-5 border-t border-border/70 px-4 py-4 sm:px-5">
          <BrainEditor
            name={name}
            pick={pick}
            onPick={(p) => {
              touched.current = true;
              setPick(p);
            }}
            models={models}
            hermes={hermes}
          />
          <Field
            label={pick.kind === "model" ? "Personality" : name.trim() ? `Notes for ${name.trim()}` : "Notes"}
            htmlFor="agent-personality-new"
            hint={pick.kind !== "model" ? `Its personality lives in ${pick.kind === "hermes" ? "Hermes" : "the agent"}; these notes are added in Etude.` : undefined}
          >
            <Textarea
              id="agent-personality-new"
              value={personality}
              maxLength={PROFILE_PERSONALITY_MAX}
              onChange={(e) => setPersonality(e.target.value)}
              placeholder="Who it is, in your words."
              className="min-h-20 text-[14px] md:text-[14px]"
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/70 px-4 py-3 sm:px-5">
          <Button variant="ghost" disabled={busy} onClick={onDone}>
            Cancel
          </Button>
          <Button disabled={busy || !name.trim()} onClick={create} data-agent-create>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        </div>
      </Card>
    </div>
  );
}

const CLIP_LABEL: Record<ClipName, string> = {
  read: "Reading",
  lookUp: "Looking up",
  look: "Looking at you",
  lookDown: "Looking down",
};
const CLIP_HINT: Record<ClipName, string> = {
  read: "loops while idle",
  lookUp: "plays once",
  look: "loops while you're on it",
  lookDown: "plays once, back to reading",
};

/** Picture, body and animation, each saved as soon as it's picked. */
function LookEditor({ p }: { p: ProfileView }) {
  const minimi = p.id === MINIMI_PROFILE_ID;
  const [draft, setDraft] = useState<PhotoDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [clips, setClips] = useState<Partial<AgentClips>>(p.clips ?? {});
  useEffect(() => setClips(p.clips ?? {}), [JSON.stringify(p.clips)]);
  const avatarInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);
  const bodyPicture = !!p.body && p.body !== "minimi";
  const edit = async (patch: Parameters<typeof profilesApi.edit>[1], done: string) => {
    setBusy(true);
    await run(() => profilesApi.edit(p.id, patch), done);
    setBusy(false);
  };
  const pickAvatar = async (f: File | undefined) => {
    if (!f) return;
    try {
      setDraft(await readPhoto(f));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const useDraft = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await savePhoto(draft);
      if (saved.kind === "photo") await profilesApi.edit(p.id, { avatar: saved.media });
      toast.success("Picture saved");
      setDraft(null);
    } catch (e) {
      toast.error("Couldn't save", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const pickBody = async (f: File | undefined) => {
    if (!f) return;
    if (!/^image\/(png|webp)$/.test(f.type) && !/\.(png|webp)$/i.test(f.name)) return toast.error("A body needs a transparent PNG or WebP.");
    setBusy(true);
    try {
      const m = await api.uploadMedia(f);
      await profilesApi.edit(p.id, { body: m.file });
      toast.success("Body saved");
    } catch (e) {
      toast.error("Couldn't upload it", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const pickBanner = async (f: File | undefined) => {
    if (!f) return;
    if (!/^image\//.test(f.type)) return toast.error("A banner is an image.");
    setBusy(true);
    try {
      const m = await api.uploadMedia(f);
      await profilesApi.edit(p.id, { banner: m.file });
      toast.success("Banner saved");
    } catch (e) {
      toast.error("Couldn't upload it", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const onClips = (next: Partial<AgentClips>) => {
    setClips(next);
    const set = CLIP_NAMES.filter((k) => next[k]);
    if (set.length === CLIP_NAMES.length) void edit({ clips: next as AgentClips }, "Animation saved");
    else if (!set.length && p.clips) void edit({ clips: null }, "Animation removed");
  };

  return (
    <div className="flex flex-col gap-5 px-4 pt-1 pb-4 sm:px-5" data-agent-look>
      {draft ? (
        <div className="flex flex-col items-center gap-3" data-agent-crop>
          <PhotoPanel draft={draft} onDraft={setDraft} saved={null} onRemove={() => setDraft(null)} />
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={useDraft} data-agent-crop-save>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Use picture
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-x-10 gap-y-5">
          <Field label="Picture">
            <div className="flex items-center gap-3">
              <AgentAvatar profile={p} size={64} />
              <div className="flex flex-col items-start gap-1">
                <Button size="sm" variant="outline" className="h-8 gap-1.5 rounded-lg" disabled={busy} onClick={() => avatarInput.current?.click()} data-agent-avatar-upload>
                  <Upload className="size-3.5" />
                  Upload
                </Button>
                <div className="flex gap-1">
                  {p.avatar !== "minimi" && minimi && (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[12.5px]" disabled={busy} onClick={() => void edit({ avatar: "minimi" }, "Saved")}>
                      His faces
                    </Button>
                  )}
                  {p.avatar && (
                    <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[12.5px]" disabled={busy} onClick={() => void edit({ avatar: null }, "Saved")}>
                      <ImageMinus className="size-3.5" />
                      Letter
                    </Button>
                  )}
                </div>
              </div>
            </div>
            <input ref={avatarInput} type="file" accept="image/*" hidden aria-label="Picture file" onChange={(e) => (void pickAvatar(e.target.files?.[0]), (e.target.value = ""))} />
          </Field>
          <Field label="Body in the corner" hint={p.body ? "Shown at Minimi's size." : "None: the corner shows the picture in a round button."}>
            <div className="flex items-end gap-3">
              <div className="agent-body-well grid h-[124px] w-[84px] place-items-end overflow-hidden rounded-xl" data-agent-body-preview>
                {p.body === "minimi" ? (
                  <img src={holidayArt(minimiLook)} alt="" className="size-full object-contain object-bottom" />
                ) : p.body ? (
                  <EtudeImg src={mediaUrl(p.body)} alt="" className="size-full object-contain object-bottom" />
                ) : null}
              </div>
              <div className="flex flex-col items-start gap-1">
                <Button size="sm" variant="outline" className="h-8 gap-1.5 rounded-lg" disabled={busy} onClick={() => bodyInput.current?.click()} data-agent-body-upload>
                  <Upload className="size-3.5" />
                  PNG
                </Button>
                {p.body !== "minimi" && minimi && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[12.5px]" disabled={busy} onClick={() => void edit({ body: "minimi" }, "Saved")}>
                    His body
                  </Button>
                )}
                {p.body && (
                  <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[12.5px]" disabled={busy} onClick={() => void edit({ body: null }, "Saved")}>
                    <ImageMinus className="size-3.5" />
                    None
                  </Button>
                )}
              </div>
            </div>
            <input ref={bodyInput} type="file" accept="image/png,image/webp" hidden aria-label="Body file" onChange={(e) => (void pickBody(e.target.files?.[0]), (e.target.value = ""))} />
          </Field>
          <Field label="Banner on a new chat" hint={p.banner ? "Shown alone before the first message." : "None: a new chat opens with a greeting and a few ideas."}>
            <div className="flex items-end gap-3">
              <div className="agent-body-well grid h-[84px] w-[200px] place-items-center overflow-hidden rounded-xl" data-agent-banner-preview>
                {p.banner ? <EtudeImg src={mediaUrl(p.banner)} alt="" className="size-full object-cover" /> : null}
              </div>
              <div className="flex flex-col items-start gap-1">
                <Button size="sm" variant="outline" className="h-8 gap-1.5 rounded-lg" disabled={busy} onClick={() => bannerInput.current?.click()} data-agent-banner-upload>
                  <Upload className="size-3.5" />
                  Upload
                </Button>
                {p.banner && (
                  <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[12.5px]" disabled={busy} onClick={() => void edit({ banner: null }, "Saved")}>
                    <ImageMinus className="size-3.5" />
                    None
                  </Button>
                )}
              </div>
            </div>
            <input ref={bannerInput} type="file" accept="image/*" hidden aria-label="Banner file" onChange={(e) => (void pickBanner(e.target.files?.[0]), (e.target.value = ""))} />
          </Field>
        </div>
      )}
      {!draft && bodyPicture && <AnimationField clips={clips} poster={p.body!} onClips={onClips} busy={busy} />}
    </div>
  );
}

/** Which clip and height a file is, from its name: read-loop-248.webm, look-up-533.webm, look-loop.webm… */
function clipOf(name: string): { k: ClipName; h: "248" | "533" | null } | null {
  const n = name.toLowerCase().replace(/\.webm$/, "");
  for (const k of CLIP_NAMES) {
    const base = CLIP_FILE_NAMES[k];
    if (n === base) return { k, h: null };
    const m = n.match(new RegExp(`^${base}-(248|533)$`));
    if (m) return { k, h: m[1] as "248" | "533" };
  }
  return null;
}

/**
 * The body's animation: four slots (reading, looking up, looking at you, looking down), each one WebM or the two
 * sizes Minimi's come in (pick both files at once). "Choose all…" takes a folder's eight files and sorts them by
 * name. The preview plays them as the corner will: hover it to make the body look up.
 */
function AnimationField({ clips, poster, onClips, busy }: { clips: Partial<AgentClips>; poster: string; onClips(c: Partial<AgentClips>): void; busy: boolean }) {
  const [uploading, setUploading] = useState<ClipName | "all" | null>(null);
  const [hover, setHover] = useState(false);
  const one = useRef<HTMLInputElement>(null);
  const all = useRef<HTMLInputElement>(null);
  const slot = useRef<ClipName>("read");
  const complete = CLIP_NAMES.every((k) => clips[k]);
  const playable = clipsOk();

  const upload = async (f: File) => {
    const why = clipProblem(new Uint8Array(await f.arrayBuffer()));
    if (why) throw new Error(`${f.name}: ${why}`);
    return (await api.uploadMedia(f)).file;
  };
  /** Files for one clip: one WebM, or two (the smaller and bigger sizes, by name or by file size). */
  const refFor = async (files: File[]): Promise<ClipRef> => {
    if (files.length === 1) return upload(files[0]);
    const named = (h: string) => files.find((f) => clipOf(f.name)?.h === h);
    const [small, big] = named("248") && named("533") ? [named("248")!, named("533")!] : [...files].sort((a, b) => a.size - b.size);
    return { "248": await upload(small), "533": await upload(big) };
  };
  const pickOne = async (list: FileList | null) => {
    const files = [...(list ?? [])].slice(0, 2);
    if (!files.length) return;
    const k = slot.current;
    setUploading(k);
    try {
      onClips({ ...clips, [k]: await refFor(files) });
    } catch (e) {
      toast.error("Couldn't add that clip", {
        description: (e as Error).message,
      });
    } finally {
      setUploading(null);
    }
  };
  const pickAll = async (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (!files.length) return;
    const by = new Map<ClipName, File[]>();
    for (const f of files) {
      const c = clipOf(f.name);
      if (c) by.set(c.k, [...(by.get(c.k) ?? []), f]);
    }
    if (!by.size)
      return toast.error("None of those are named like clips", {
        description: "read-loop, look-up, look-loop, look-down (-248/-533).webm",
      });
    setUploading("all");
    try {
      const next = { ...clips };
      for (const [k, fs] of by) next[k] = await refFor(fs.slice(0, 2));
      onClips(next);
      const left = CLIP_NAMES.filter((k) => !next[k]);
      if (left.length) toast(`Still missing: ${left.map((k) => CLIP_LABEL[k]).join(", ")}`);
    } catch (e) {
      toast.error("Couldn't add the clips", {
        description: (e as Error).message,
      });
    } finally {
      setUploading(null);
    }
  };

  return (
    <Field
      label="Animation"
      hint={
        complete
          ? playable
            ? "Hover the preview: it looks up at you, and back down when you leave."
            : "Plays in Chrome, Edge and Firefox; Safari and reduced motion show the picture."
          : "Optional. Four VP9 WebM clips with transparency, up to 4 MB each. Saved once all four are in."
      }
    >
      <div className="flex flex-col gap-3 @[30rem]/agent:flex-row @[30rem]/agent:items-start" data-agent-animation>
        <div
          className="minimi agent-body-well relative h-[124px] w-[84px] shrink-0 self-start overflow-hidden rounded-xl transform-none!"
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          data-agent-clip-preview
        >
          <div className="minimi-btn relative size-full">
            {complete ? (
              <ProfileClips clips={clips as AgentClips} poster={poster} attention={hover} />
            ) : (
              <EtudeImg src={mediaUrl(poster)} alt="" className="size-full object-contain object-bottom opacity-50" />
            )}
          </div>
        </div>
        <div className="flex w-full min-w-0 flex-1 flex-col gap-1">
          <ul className="flex flex-col">
            {CLIP_NAMES.map((k) => (
              <li key={k} className="flex min-h-8 items-center gap-2 py-1 text-[13px] @[30rem]/agent:py-0.5" data-clip-slot={k}>
                {clips[k] ? <Check className="size-3.5 shrink-0 text-primary" aria-label="added" /> : <Film className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />}
                {/* One line on a wide card; on a narrow one what the clip does goes under its name. */}
                <span className="min-w-0 flex-1 @[30rem]/agent:truncate">
                  {CLIP_LABEL[k]} <span className="block text-[12px] text-muted-foreground @[30rem]/agent:inline @[30rem]/agent:text-[13px]"><span className="hidden @[30rem]/agent:inline">· </span>{CLIP_HINT[k]}</span>
                </span>
                {uploading === k ? (
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[12.5px]"
                    disabled={busy || !!uploading}
                    onClick={() => {
                      slot.current = k;
                      one.current?.click();
                    }}
                  >
                    {clips[k] ? "Replace" : "Add"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="h-8 gap-1.5 rounded-lg" disabled={busy || !!uploading} onClick={() => all.current?.click()} data-agent-clips-all>
              {uploading === "all" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              Choose all…
            </Button>
            {CLIP_NAMES.some((k) => clips[k]) && (
              <Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-[12.5px]" disabled={busy || !!uploading} onClick={() => onClips({})}>
                <X className="size-3.5" />
                Remove
              </Button>
            )}
          </div>
        </div>
        <input ref={one} type="file" accept="video/webm,.webm" multiple hidden aria-label="Clip file" onChange={(e) => (void pickOne(e.target.files), (e.target.value = ""))} />
        <input ref={all} type="file" accept="video/webm,.webm" multiple hidden aria-label="Clip files" data-agent-clips-input onChange={(e) => (void pickAll(e.target.files), (e.target.value = ""))} />
      </div>
    </Field>
  );
}

/** Where model brains run: the ChatGPT sign-in, the OpenRouter key and a custom endpoint. */
function ProvidersCard({ saved, models, onChanged }: { saved: SettingsResponse; models: Models | null; onChanged(): void }) {
  const custom = models?.groups.find((g) => g.provider === "custom");
  return (
    <Card>
      {chatGptSignInHere() ? <ChatGptRow onChanged={onChanged} /> : <Block title="ChatGPT" description="Signing in with ChatGPT needs the desktop app." />}
      <OpenRouterRow saved={saved} onChanged={onChanged} />
      <Block
        title="Custom endpoint"
        description={
          custom ? (
            <>
              <span className="font-mono text-foreground/85">{custom.label}</span> · {custom.models.map((m) => m.name).join(", ")}. It's the feedback model under AI grading › Models and endpoints.
            </>
          ) : (
            "An OpenAI-compatible server (llama.cpp, Ollama, vLLM). Set it as the feedback model under AI grading › Models and endpoints."
          )
        }
        stackAside
        aside={
          <Button
            size="sm"
            variant="outline"
            className="phone:h-10 h-8"
            onClick={() => {
              window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: "ai-endpoints" }));
              requestAnimationFrame(() => document.querySelector('[data-disclosure="ai-endpoints"]')?.scrollIntoView({ behavior: "smooth", block: "start" }));
            }}
            data-provider-custom
          >
            {custom ? "Change" : "Set up"}
          </Button>
        }
      />
    </Card>
  );
}

function ChatGptRow({ onChanged }: { onChanged(): void }) {
  const { status, busy, failure, remote, waitingUrl, start, signOut } = useChatGptSignIn();
  const signedIn = !!status?.signedIn;
  const was = useRef<boolean | null>(null);
  useEffect(() => {
    if (status && was.current !== null && was.current !== signedIn) onChanged();
    if (status) was.current = signedIn;
  }, [status, signedIn]);
  return (
    <Block
      title="ChatGPT"
      description={signedIn ? undefined : "Use your ChatGPT Plus or Pro plan, with no API key."}
      stackAside
      aside={
        signedIn ? (
          <Button size="sm" variant="ghost" className="phone:h-10 h-8 gap-1.5" onClick={signOut} disabled={busy !== null}>
            {busy === "logout" ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
            Sign out
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="phone:h-10 h-8" onClick={start} disabled={busy !== null || !!waitingUrl} data-provider-chatgpt>
            {busy === "login" || waitingUrl ? <Loader2 className="size-4 animate-spin" /> : null}
            Sign in
          </Button>
        )
      }
    >
      {signedIn && status && (
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <CircleCheck className={cn("size-4 shrink-0", status.plan === "enabled" ? "text-success" : "text-warning")} />
          <span className="min-w-0 truncate">{status.email ?? "Signed in"}</span>
          {status.plan !== "enabled" && <span className="text-xs text-warning">· plan usage not granted</span>}
        </div>
      )}
      {waitingUrl && <p className="text-[13px] text-muted-foreground">Finish signing in in the browser window that opened.</p>}
      {remote && (
        <p className="text-[13px] text-muted-foreground">
          {remote.message}
          {remote.cli && (
            <>
              {" "}
              <code className="font-mono text-foreground/85">{remote.cli}</code>
            </>
          )}
        </p>
      )}
      {failure && <p className="text-[13px] text-destructive">{failure}</p>}
    </Block>
  );
}

function OpenRouterRow({ saved, onChanged }: { saved: SettingsResponse; onChanged(): void }) {
  const NAME = "OPENROUTER_API_KEY";
  const [set, setSet] = useState(!!saved.keyStatus?.[NAME]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (v: string) => {
    setBusy(true);
    try {
      await saveApiKey(NAME, v);
      setSet(!!v.trim());
      setValue("");
      toast.success(v.trim() ? "OpenRouter key saved" : "OpenRouter key removed");
      onChanged();
    } catch (e) {
      toast.error("Couldn't save the key", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Block
      title="OpenRouter"
      description={
        serverless() ? (
          "One key for hundreds of models. Stored only on this device."
        ) : (
          <>
            One key for hundreds of models. Saved to <code className="font-mono text-foreground/90">~/.etude/.env</code>, readable only by you.
          </>
        )
      }
    >
      <div className="@container/key flex flex-col gap-2" data-provider-openrouter>
        <div className="flex items-center gap-2 text-sm">
          {set ? <CircleCheck className="size-4 shrink-0 text-success" /> : <CircleAlert className="size-4 shrink-0 text-muted-foreground" />}
          <span className="font-mono text-[13px]">{NAME}</span>
          <span className={cn("text-xs", set ? "text-success" : "text-muted-foreground")}>{set ? "set" : "not set"}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            type="password"
            aria-label={`Value for ${NAME}`}
            autoComplete="off"
            spellCheck={false}
            placeholder={set ? "Paste a new key to replace it" : "Paste the key"}
            className="phone:h-10 h-9 w-full font-mono text-[13px] @[28rem]/key:w-auto @[28rem]/key:flex-1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && value.trim() && void save(value)}
          />
          <Button size="sm" className="phone:h-10 h-9" disabled={busy || !value.trim()} onClick={() => save(value)}>
            Save
          </Button>
          {set && (
            <Button size="sm" variant="outline" className="phone:h-10 h-9" disabled={busy} onClick={() => save("")}>
              Remove
            </Button>
          )}
        </div>
      </div>
    </Block>
  );
}
