// ChatGPT plan sign-in: start the OAuth flow, poll until the callback lands, show the account.
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Loader2, LogOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Block, CopyValue, Field, NumberField } from "@/components/settings-ui";
import { CHATGPT_DEFAULT_MODEL, type ChatGptProvider } from "@/components/settings-model";

interface ChatGptStatus {
  signedIn: boolean;
  email: string | null;
  plan: "enabled" | "disabled" | "none";
  planType: string | null;
  expiresAt: string | null;
  needsReauth: boolean;
  usageUrl: string;
  hostId: string | null;
  models: { slug: string; displayName: string }[];
  login: { state: "pending"; url: string } | { state: "error"; error: string } | null;
}

interface LoginReply {
  pending?: boolean;
  url?: string;
  remote?: boolean;
  message?: string;
  cli?: string;
}

const sec = (ms: number | undefined) => (ms == null ? undefined : ms / 1000);
const ms = (s: number) => (Number.isNaN(s) ? NaN : Math.round(s * 1000));

export function ChatGptBlock({ provider, error, onChange }: { provider: ChatGptProvider; error?: string; onChange(patch: Partial<ChatGptProvider>): void }) {
  const [status, setStatus] = useState<ChatGptStatus | null>(null);
  const [busy, setBusy] = useState<"login" | "logout" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [remote, setRemote] = useState<{ message: string; cli: string } | null>(null);
  const [waitingUrl, setWaitingUrl] = useState<string | null>(null);
  const wasSignedIn = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = (await api.chatgptStatus()) as ChatGptStatus;
      setStatus(s);
      if (s.signedIn && !wasSignedIn.current) {
        wasSignedIn.current = true;
        try {
          if (!localStorage.getItem("etude.chatgpt.welcomed")) {
            localStorage.setItem("etude.chatgpt.welcomed", "1");
            toast.success("You're using your ChatGPT plan", { description: "Eligible grading uses your plan. Manage it in ChatGPT settings." });
          }
        } catch {
          // Private mode or a blocked storage API: skip the one-time confirmation.
        }
      }
      if (!s.signedIn) wasSignedIn.current = false;
      return s;
    } catch (e) {
      setFailure((e as Error).message);
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // While a sign-in is open, follow its status until the credentials land or it errors.
  useEffect(() => {
    if (!waitingUrl && status?.login?.state !== "pending") return;
    const t = setInterval(async () => {
      const s = await refresh();
      if (!s) return;
      if (s.signedIn) setWaitingUrl(null);
      else if (s.login?.state === "error") {
        setWaitingUrl(null);
        setFailure(s.login.error);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [waitingUrl, status?.login?.state, refresh]);

  const start = async () => {
    // Opened synchronously inside the click, or the browser blocks it.
    const win = window.open("", "etude-chatgpt-signin");
    if (win) win.opener = null;
    setBusy("login");
    setFailure(null);
    setRemote(null);
    try {
      const r = (await api.chatgptLogin()) as LoginReply;
      if (r.remote) {
        win?.close();
        setRemote({ message: r.message ?? "Sign-in has to finish on the machine running Etude.", cli: r.cli ?? "etude settings chatgpt login" });
        return;
      }
      if (r.url) {
        setWaitingUrl(r.url);
        if (win) win.location.replace(r.url);
        else window.open(r.url, "_blank", "noreferrer");
      } else win?.close();
      await refresh();
    } catch (e) {
      win?.close();
      setFailure((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    setBusy("logout");
    setFailure(null);
    try {
      await api.chatgptLogout();
      await refresh();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const signedIn = !!status?.signedIn;
  const currentModel = provider.model || CHATGPT_DEFAULT_MODEL;
  const modelOptions = (() => {
    const rows = status?.models?.length ? status.models : [{ slug: CHATGPT_DEFAULT_MODEL, displayName: CHATGPT_DEFAULT_MODEL }];
    return rows.some((m) => m.slug === currentModel) ? rows : [{ slug: currentModel, displayName: currentModel }, ...rows];
  })();

  return (
    <Block
      title="ChatGPT plan"
      description={
        signedIn
          ? "Eligible grading uses your ChatGPT plan or credits balance instead of an API key. Manage the limit in ChatGPT settings."
          : "Use your ChatGPT Plus or Pro plan for grading, with no API key. Etude stays free; this only changes who pays for the model."
      }
      stackAside
      aside={
        signedIn && status ? (
          <a href={status.usageUrl} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Manage usage
          </a>
        ) : undefined
      }
    >
      {signedIn && status ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <CircleCheck className={cn("size-4 shrink-0", status.plan === "enabled" ? "text-success" : "text-warning")} />
            <span className="min-w-0 flex-1 truncate text-sm">{status.email ?? "Signed in"}</span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                status.plan === "enabled" ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
              )}
            >
              {status.plan === "enabled" ? "Using ChatGPT plan" : "Plan usage not granted"}
            </span>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={signOut} disabled={busy !== null}>
              {busy === "logout" ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
              Sign out
            </Button>
          </div>
          {status.plan !== "enabled" && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-xl text-xs leading-relaxed text-warning">
                This sign-in doesn't include permission to use your plan for requests. Continue again and allow plan access.
              </p>
              <Button size="sm" variant="outline" className="h-8" onClick={start} disabled={busy !== null || !!waitingUrl}>
                {busy === "login" || waitingUrl ? <Loader2 className="size-4 animate-spin" /> : null}
                Continue with ChatGPT
              </Button>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Model"
              error={error}
              hint={status.models.length ? "From your account's model list. Save to apply." : `Save to apply. Run \`etude settings chatgpt models\` to list what your plan offers.`}
            >
              <Select value={currentModel} onValueChange={(v) => onChange({ model: v })}>
                <SelectTrigger className="h-10 w-full md:h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((m) => (
                    <SelectItem key={m.slug} value={m.slug}>
                      {m.displayName === m.slug ? m.slug : `${m.displayName} · ${m.slug}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <NumberField label="Timeout" suffix="s" value={sec(provider.timeoutMs ?? 60000)} onChange={(v) => onChange({ timeoutMs: ms(v) })} />
          </div>
          {remote && (
            <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/[0.04] px-3.5 py-3">
              <div className="flex gap-2.5 text-sm">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <p className="leading-relaxed">{remote.message}</p>
              </div>
              <CopyValue label="Run on the machine that runs Etude" value={remote.cli} />
            </div>
          )}
          {failure && (
            <div className="flex gap-2.5 rounded-lg border border-destructive/40 px-3.5 py-3 text-sm">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="break-words text-destructive">{failure}</p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              className="h-10 gap-2 bg-foreground px-4 text-background hover:bg-foreground/85"
              onClick={start}
              disabled={busy !== null || !!waitingUrl}
            >
              {busy === "login" || waitingUrl ? <Loader2 className="size-4 animate-spin" /> : null}
              Continue with ChatGPT
            </Button>
            {waitingUrl && (
              <a href={waitingUrl} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
                Waiting for the browser — open the sign-in page
              </a>
            )}
          </div>
          {status?.needsReauth && !waitingUrl && <p className="text-xs text-muted-foreground">Your previous sign-in expired. Continue above to renew it.</p>}
          {remote && (
            <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/[0.04] px-3.5 py-3">
              <div className="flex gap-2.5 text-sm">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <p className="leading-relaxed">{remote.message}</p>
              </div>
              <CopyValue label="Run on the machine that runs Etude" value={remote.cli} />
            </div>
          )}
          {failure && (
            <div className="flex gap-2.5 rounded-lg border border-destructive/40 px-3.5 py-3 text-sm">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="break-words text-destructive">{failure}</p>
            </div>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Sign-in opens auth.openai.com and returns to a callback on 127.0.0.1, so the browser must be on this machine. On a phone or another computer, run{" "}
            <code className="font-mono text-foreground/90">etude settings chatgpt login</code> where Etude runs.
          </p>
        </div>
      )}
    </Block>
  );
}
