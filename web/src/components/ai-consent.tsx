// Third-party AI (App Review 5.1.2(i)), in the iPhone app only: before Etude sends anything to an AI provider (cards and
// answers for grading, messages for Ask), the person agrees to it, once per provider, by name. One OK covers both. There
// the engine sends nothing to a provider missing from settings.aiConsent (requireAiConsent, set by
// src/browser/worker-core.ts). It's asked up front: in first-run setup, where the connect buttons are the agreement
// (onboarding.tsx), and once at launch for AI set up before this was asked (AiConsentAtLaunch). The dialogs on a key
// save, ChatGPT sign-in, the test and an Ask message (agent-panel.tsx), and Settings → AI grading, are the fallback.
// Everywhere else nothing here shows and every action runs at once.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type AiConsentStatus } from "@/lib/api";
import { isIOSApp } from "@/lib/platform";
import { launchAsks, putOffList } from "@/lib/consent-launch";
import { aiProviderName } from "@/components/settings-model";
import { Block } from "@/components/settings-ui";

/** Whether the person is asked before anything goes to an AI provider: only in the iPhone app. */
export const asksAiConsent = () => isIOSApp();

const CHANGED = "etude:ai-consent";
const names = (ids: string[]) => ids.map(aiProviderName).join(" and ");
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** What Etude sends a provider, grading and Ask alike. */
export const WHAT_IS_SENT = "your cards and answers, your messages to the assistant and what it reads in Etude (open pages, the card on screen, selected text, pictures of the screen)";

/** The sentence the person agrees to. */
export const consentSentence = (ids: string[]) => `Etude sends ${WHAT_IS_SENT} from this device to ${names(ids)}.`;

/** The small print under it. */
const fine = (ids: string[]) =>
  ids.includes("etude-cloud")
    ? "With Etude AI, requests pass through Etude's server to OpenRouter so we can meter your credits; we don't keep your cards or answers. Nothing is sent until you agree, and you can take it back any time in Settings → AI grading."
    : `It goes straight there, under ${ids.length > 1 ? "their" : "its"} own privacy policy; Etude's servers never see it. Nothing is sent until you agree, and you can take it back any time in Settings → AI grading.`;

/** The one dialog: who, what, and Not now / I agree. `intro` comes before the sentence (the launch sheet says why it asks). */
function ConsentDialog({ ids, intro, onAgree, onCancel }: { ids: string[]; intro?: string; onAgree(): void; onCancel(): void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md" data-ai-consent={ids.join(" ")}>
        <DialogHeader>
          <DialogTitle>Send to {names(ids)}?</DialogTitle>
          <DialogDescription>{intro ? `${intro} ` : ""}{consentSentence(ids)}</DialogDescription>
        </DialogHeader>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{fine(ids)}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} data-ai-not-now>Not now</Button>
          <Button onClick={onAgree} data-ai-agree>I agree</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * `confirm(providers, action)` runs `action` right away when every provider was agreed to, or once the person taps
 * I agree and it's saved; not at all if they don't. Render `dialog`. `agree(providers)` records the OK without a dialog,
 * for a button that says it agrees (first-run setup). `missing(providers)` lists the ones still to agree to.
 */
export function useAiConsent() {
  const asks = asksAiConsent();
  const [agreed, setAgreed] = useState<Record<string, string> | null>(asks ? null : {});
  const [asking, setAsking] = useState<{ ids: string[]; action(): void } | null>(null);
  const load = useCallback(() => api.aiConsent().then((s) => setAgreed(s.agreed), () => setAgreed({})), []);
  useEffect(() => {
    if (!asks) return;
    void load();
    const h = () => void load();
    window.addEventListener(CHANGED, h);
    return () => window.removeEventListener(CHANGED, h);
  }, [load, asks]);

  const missing = (providers: (string | null | undefined)[]) => (asks ? [...new Set(providers.filter((p): p is string => !!p))].filter((p) => !agreed?.[p]) : []);
  /** `ask`: the engine said these aren't agreed to; ask whatever this window last heard. */
  const confirm = (providers: (string | null | undefined)[], action: () => void, ask = false) => {
    if (!asks) return action();
    const ids = ask ? [...new Set(providers.filter((p): p is string => !!p))] : missing(providers);
    if (!ids.length) return action();
    setAsking({ ids, action });
  };
  const agree = async (providers: (string | null | undefined)[]) => {
    const ids = missing(providers);
    if (!ids.length) return true;
    const ok = await recordConsent(ids);
    await load();
    return ok;
  };
  const dialog = asking && (
    <ConsentDialog
      ids={asking.ids}
      onCancel={() => setAsking(null)}
      onAgree={() => {
        const { ids, action } = asking;
        setAsking(null);
        // Saved first, so what the action sends finds the OK there.
        void recordConsent(ids).then((ok) => (ok && action(), load()));
      }}
    />
  );
  return { asks, agreed, missing, confirm, agree, dialog };
}

async function recordConsent(ids: string[]): Promise<boolean> {
  try {
    for (const id of ids) await api.agreeToAi(id);
    return true;
  } catch (e) {
    toast.error("Couldn't save your OK", { description: (e as Error).message });
    return false;
  } finally {
    window.dispatchEvent(new Event(CHANGED));
  }
}

// ------------------------------------------------------------------ at launch

/** Providers this device said Not now to at launch: the launch sheet doesn't ask about them again. */
export const LATER_KEY = "etude.aiConsent.later";
const later = (): string[] => {
  try {
    return putOffList(localStorage.getItem(LATER_KEY));
  } catch {
    return [];
  }
};
const keepLater = (ids: string[]) => {
  try {
    localStorage.setItem(LATER_KEY, JSON.stringify([...new Set([...later(), ...ids])]));
  } catch {
    // Private mode or blocked storage: the sheet may ask again next launch.
  }
};

/**
 * In the iPhone app, once per launch once the collection is ready and first-run setup isn't showing: AI set up before the
 * app asked (an earlier version) gets the same question, in one sheet for every provider in use.
 */
export function AiConsentAtLaunch({ enabled }: { enabled: boolean }) {
  const [ids, setIds] = useState<string[] | null>(null);
  const checked = useRef(false);
  useEffect(() => {
    if (!enabled || checked.current || !asksAiConsent()) return;
    checked.current = true;
    api.aiConsent().then(
      (st) => {
        const need = launchAsks(st, later());
        if (need.length) setIds(need);
      },
      () => {},
    );
  }, [enabled]);
  if (!ids) return null;
  return (
    <ConsentDialog
      ids={ids}
      intro="Etude now asks before anything goes to an AI provider."
      onCancel={() => (keepLater(ids), setIds(null))}
      onAgree={() => void recordConsent(ids).then(() => setIds(null))}
    />
  );
}

// ------------------------------------------------------------------ Settings

/** Settings → AI grading, in the iPhone app: who grading and the assistant send to, and your OK for each. */
export function AiConsentBlocks(props: { savedAi: unknown }) {
  return asksAiConsent() ? <ConsentList {...props} /> : null;
}

function ConsentList({ savedAi }: { savedAi: unknown }) {
  const [st, setSt] = useState<AiConsentStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const key = JSON.stringify(savedAi);
  const load = useCallback(() => api.aiConsent().then(setSt, () => setSt(null)), []);
  useEffect(() => {
    void load();
    const h = () => void load();
    window.addEventListener(CHANGED, h);
    return () => window.removeEventListener(CHANGED, h);
  }, [load, key]);
  const act = async (id: string, agree: boolean) => {
    setBusy(id);
    try {
      setSt(agree ? await api.agreeToAi(id) : await api.withdrawAiConsent(id));
      window.dispatchEvent(new Event(CHANGED));
    } catch (e) {
      toast.error("Couldn't save that", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {(st?.providers ?? []).map((p) => (
        <Block
          key={p.id}
          title={p.agreed ? `Sending to ${p.name}` : `Send to ${p.name}?`}
          description={
            <>
              {consentSentence([p.id])} One OK covers grading and the assistant. {p.agreed ? `You agreed on ${day(p.agreed)}.` : "Nothing is sent until you agree."}
            </>
          }
          stackAside
          aside={
            p.agreed ? (
              <Button size="sm" variant="ghost" className="phone:h-10 h-8 text-muted-foreground" disabled={busy === p.id} onClick={() => void act(p.id, false)}>Withdraw</Button>
            ) : (
              <Button size="sm" className="phone:h-10 h-8" disabled={busy === p.id} onClick={() => void act(p.id, true)} data-ai-agree={p.id}>I agree</Button>
            )
          }
        />
      ))}
    </>
  );
}

/** An Ask message the engine held back: it would go to a provider the person hasn't agreed to (iPhone app). */
export const consentProvider = (e: unknown): string | null => {
  const x = e as { code?: unknown; provider?: unknown } | null;
  return x?.code === "ai_consent" && typeof x.provider === "string" ? x.provider : null;
};
