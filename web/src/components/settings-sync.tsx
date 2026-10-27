// Settings → Sync: connect a server or folder, sign in, unlock the vault and sync on demand.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, CircleAlert, Copy, Loader2, LogOut, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Block, Field, Section } from "@/components/settings-ui";
import { relative } from "@/lib/api";
import { etudeFetch } from "@/lib/transport";
import { cn } from "@/lib/utils";
import { ACCOUNT_EVENT } from "@/components/settings-account";
import { account } from "@/lib/account";

const DEFAULT_SERVER = "https://sync.etude.study";

export interface SyncStatus {
  configured: boolean;
  kind: "folder" | "cloud" | null;
  server?: string;
  folder?: string;
  signedIn: boolean;
  /** Signed in through the Etude account rather than Sync's own code. */
  account?: boolean;
  email?: string;
  unlocked: boolean;
  hasKeys: boolean;
  lastSync: string | null;
  error: string | null;
  pending: number;
  busy: boolean;
}

type UnlockResponse = { recoveryKey?: string; status: SyncStatus };
type Stage = "setup" | "signin" | "code" | "unlock" | "recovery" | "ready";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "The request failed.");

async function callSync<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await etudeFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: unknown } | null)?.error;
    const nested = err && typeof err === "object" ? (err as { message?: unknown }).message : undefined;
    const detail = typeof err === "string" ? err : typeof nested === "string" ? nested : res.statusText;
    throw new Error(detail || "The sync request failed.");
  }
  return data as T;
}

export function SyncSection() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [server, setServer] = useState(DEFAULT_SERVER);
  const [folder, setFolder] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const seeded = useRef(false);
  const suggested = useRef<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const s = await callSync<SyncStatus>("GET", "/api/sync/status");
      setStatus(s);
      setLoadError(null);
    } catch (e) {
      if (!quiet) setLoadError(errorMessage(e));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Signing in to the Etude account also signs Sync in when both use the same server.
    const h = () => {
      void load(true);
      // Not set up yet and not edited by hand: follow the account's server.
      account.status().then((a) => setServer((cur) => (cur === DEFAULT_SERVER || cur === suggested.current ? (suggested.current = a.server) : cur))).catch(() => {});
    };
    window.addEventListener(ACCOUNT_EVENT, h);
    return () => window.removeEventListener(ACCOUNT_EVENT, h);
  }, [load]);

  // Fill the forms once from the server, without overwriting anything being typed.
  useEffect(() => {
    if (!status || seeded.current) return;
    seeded.current = true;
    setServer(status.server ?? DEFAULT_SERVER);
    // Not set up yet: offer the server the Etude account uses.
    if (!status.server) account.status().then((a) => setServer((cur) => (cur === DEFAULT_SERVER ? (suggested.current = a.server) : cur))).catch(() => {});
    setFolder(status.folder ?? "");
    setEmail(status.email ?? "");
  }, [status]);

  // A running sync is reported by status; look again until it settles.
  useEffect(() => {
    if (!status?.busy) return;
    const t = window.setInterval(() => void load(true), 2500);
    return () => window.clearInterval(t);
  }, [status?.busy, load]);

  // Keep "3m ago" current while the page is open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // The recovery key is shown once; warn before a reload throws it away.
  useEffect(() => {
    if (!recoveryKey) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [recoveryKey]);

  const withBusy = async <T,>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(name);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    if (busy) return;
    const url = server.trim();
    if (!url) {
      setError("Enter the sync server address.");
      return;
    }
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      setError("Enter a full http or https address.");
      return;
    }
    const f = folder.trim();
    const s = await withBusy("setup", () => callSync<SyncStatus>("POST", "/api/sync/setup", f ? { folder: f } : { server: url }));
    if (s) {
      setStatus(s);
      setCodeSent(false);
    }
  };

  const signin = async () => {
    if (busy) return;
    const addr = email.trim();
    if (!addr) {
      setError("Enter your email address.");
      return;
    }
    const s = await withBusy("signin", () => callSync<SyncStatus>("POST", "/api/sync/signin", { email: addr }));
    if (s) {
      setStatus(s);
      setCodeSent(true);
      setCode("");
    }
  };

  const verify = async () => {
    if (busy) return;
    const c = code.trim();
    if (!c) {
      setError("Enter the code from the email.");
      return;
    }
    const s = await withBusy("verify", () => callSync<SyncStatus>("POST", "/api/sync/verify", { code: c }));
    setCode("");
    if (s) {
      setStatus(s);
      if (s.signedIn) setCodeSent(false);
    }
  };

  const unlock = async () => {
    if (busy) return;
    const body: Record<string, string> = {};
    if (status?.hasKeys && useRecovery) {
      const r = recoveryInput.trim();
      if (!r) {
        setError("Enter your recovery key.");
        return;
      }
      body.recovery = r;
    } else {
      if (!password) {
        setError(status?.hasKeys ? "Enter your sync password." : "Choose a sync password.");
        return;
      }
      if (!status?.hasKeys && password !== confirm) {
        setError("The passwords don't match.");
        return;
      }
      body.password = password;
    }
    const r = await withBusy("unlock", () => callSync<UnlockResponse>("POST", "/api/sync/unlock", body));
    setPassword("");
    setConfirm("");
    setRecoveryInput("");
    if (r) {
      setStatus(r.status);
      setUseRecovery(false);
      if (r.recoveryKey) {
        setRecoveryKey(r.recoveryKey);
        setRecoveryConfirmed(false);
        setCopied(false);
      }
    }
  };

  const syncNow = async () => {
    if (busy) return;
    const s = await withBusy("now", () => callSync<SyncStatus>("POST", "/api/sync/now", {}));
    if (s) setStatus(s);
  };

  const signOut = async () => {
    if (busy) return;
    setConfirmOff(false);
    const s = await withBusy("off", () => callSync<SyncStatus>("POST", "/api/sync/off", {}));
    if (s) {
      setStatus(s);
      setCodeSent(false);
      setCode("");
      setPassword("");
      setConfirm("");
      setRecoveryInput("");
      setUseRecovery(false);
      setRecoveryKey(null);
      setRecoveryConfirmed(false);
      setCopied(false);
      setEmail("");
      if (s.server) setServer(s.server);
    }
  };

  const copyRecovery = async () => {
    if (!recoveryKey) return;
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy", { description: "The browser blocked clipboard access." });
    }
  };

  const finishRecovery = () => {
    setRecoveryKey(null);
    setRecoveryConfirmed(false);
    setCopied(false);
    toast.success("Sync is set up");
  };

  const stage: Stage = !status
    ? "setup"
    : !status.configured
      ? "setup"
      : recoveryKey
        ? "recovery"
        : status.kind === "cloud" && !status.signedIn
          ? codeSent
            ? "code"
            : "signin"
          : !status.unlocked
            ? "unlock"
            : "ready";

  const newVault = !!status && !status.hasKeys;
  const syncing = !!status && (status.busy || busy === "now");
  const stateLabel = syncing
    ? "Syncing…"
    : status?.error || error
      ? "Needs attention"
      : status && status.pending > 0
        ? `${status.pending} ${status.pending === 1 ? "change" : "changes"} waiting`
        : !status?.lastSync
          ? "Not synced yet"
          : "Up to date";

  return (
    <Section id="sync" title="Sync" description="Keep the same collection on more than one device. Sign in, unlock it with your sync password, and changes sync in the background.">
      {loading && !status && !loadError && (
        <Block>
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-10 w-full sm:max-w-md" />
          </div>
        </Block>
      )}

      {loadError && !status && (
        <Block>
          <p className="text-sm text-destructive">Couldn't read sync status: {loadError}</p>
          <div>
            <Button variant="outline" size="sm" className="h-10 md:h-8" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        </Block>
      )}

      {status && stage === "setup" && (
        <Block title="Set up sync" description="Etude syncs through a server, or through a folder on this computer in the desktop app.">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
          >
            <TextInput label="Server" value={server} onChange={setServer} placeholder={DEFAULT_SERVER} mono autoComplete="url" hint="The sync server address. Change it to use one of your own." />
            {!(globalThis as any).__etudeLocal && <TextInput label="Folder (optional)" value={folder} onChange={setFolder} placeholder="/home/you/Etude" mono autoComplete="off" hint="Desktop app only. Leave empty to sync through the server." />}
            {error && <Notice>{error}</Notice>}
            {status.error && <Notice>{status.error}</Notice>}
            <div>
              <Button type="submit" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy}>
                {busy === "setup" && <Loader2 className="size-4 animate-spin" />}
                Connect
              </Button>
            </div>
          </form>
        </Block>
      )}

      {status && stage === "signin" && (
        <Block
          title="Sign in"
          description={
            status.kind === "folder"
              ? "Etude emails a one-time code to confirm the address."
              : <>Codes are sent by <span className="font-mono text-[13px] text-foreground/85">{status.server ?? "the sync server"}</span>.</>
          }
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void signin();
            }}
          >
            <TextInput label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" inputMode="email" placeholder="you@example.com" />
            {error && <Notice>{error}</Notice>}
            {status.error && <Notice>{status.error}</Notice>}
            <div>
              <Button type="submit" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy}>
                {busy === "signin" && <Loader2 className="size-4 animate-spin" />}
                Send code
              </Button>
            </div>
          </form>
        </Block>
      )}

      {status && stage === "code" && (
        <Block title="Enter the code" description={<>Sent to <span className="text-foreground/90">{email.trim() || status.email}</span>.</>}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
          >
            <TextInput label="Sign-in code" value={code} onChange={setCode} autoComplete="one-time-code" inputMode="text" placeholder="Code from the email" mono />
            {error && <Notice>{error}</Notice>}
            {status.error && <Notice>{status.error}</Notice>}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy}>
                {busy === "verify" && <Loader2 className="size-4 animate-spin" />}
                Verify
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy} onClick={() => void signin()}>
                Send again
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-10 gap-1.5 md:h-8"
                disabled={!!busy}
                onClick={() => {
                  setCodeSent(false);
                  setCode("");
                  setError(null);
                }}
              >
                Use another email
              </Button>
            </div>
          </form>
        </Block>
      )}

      {status && stage === "unlock" && (
        <Block
          title={newVault ? "Create a sync password" : "Unlock sync"}
          description={
            newVault
              ? "Choose a password for this collection. A recovery key is shown once after the vault is created."
              : <>Signed in{status.email ? <> as <span className="text-foreground/90">{status.email}</span></> : null}. Enter the sync password for this collection.</>
          }
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void unlock();
            }}
          >
            {status.hasKeys && useRecovery ? (
              <>
                <TextInput label="Recovery key" value={recoveryInput} onChange={setRecoveryInput} autoComplete="off" mono placeholder="Your recovery key" />
                {error && <Notice>{error}</Notice>}
                {status.error && <Notice>{status.error}</Notice>}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy}>
                    {busy === "unlock" && <Loader2 className="size-4 animate-spin" />}
                    Unlock
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-10 gap-1.5 md:h-8"
                    disabled={!!busy}
                    onClick={() => {
                      setUseRecovery(false);
                      setRecoveryInput("");
                      setError(null);
                    }}
                  >
                    Use the password
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy} onClick={() => void signOut()}>
                    Sign out
                  </Button>
                </div>
              </>
            ) : (
              <>
                <TextInput
                  label={newVault ? "Sync password" : "Password"}
                  type="password"
                  value={password}
                  onChange={setPassword}
                  autoComplete={newVault ? "new-password" : "current-password"}
                  hint={newVault ? "You'll need it on every device that syncs this collection." : undefined}
                />
                {newVault && <TextInput label="Confirm password" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" />}
                {error && <Notice>{error}</Notice>}
                {status.error && <Notice>{status.error}</Notice>}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy}>
                    {busy === "unlock" && <Loader2 className="size-4 animate-spin" />}
                    {newVault ? "Create vault" : "Unlock"}
                  </Button>
                  {status.hasKeys && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-10 gap-1.5 md:h-8"
                      disabled={!!busy}
                      onClick={() => {
                        setUseRecovery(true);
                        setPassword("");
                        setConfirm("");
                        setError(null);
                      }}
                    >
                      Use a recovery key
                    </Button>
                  )}
                  {status.hasKeys && (
                    <Button type="button" variant="ghost" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy} onClick={() => void signOut()}>
                      Sign out
                    </Button>
                  )}
                </div>
              </>
            )}
          </form>
        </Block>
      )}

      {status && stage === "recovery" && recoveryKey && (
        <Block title="Save your recovery key" description="This key unlocks sync on another device if you forget the password. It is shown only once.">
          <div className="rounded-lg border border-warning/40 bg-warning/5 p-3.5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <code className="min-w-0 flex-1 select-all font-mono text-[13px] leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">{recoveryKey}</code>
              <Button type="button" variant="outline" size="sm" className="h-10 shrink-0 gap-1.5 md:h-8" onClick={() => void copyRecovery()}>
                {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--highlight)]"
              checked={recoveryConfirmed}
              onChange={(e) => setRecoveryConfirmed(e.target.checked)}
            />
            <span>I've saved this key somewhere safe.</span>
          </label>
          <div>
            <Button type="button" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!recoveryConfirmed} onClick={finishRecovery}>
              Continue
            </Button>
          </div>
        </Block>
      )}

      {status && stage === "ready" && (
        <>
          <Block
            title="Connection"
            description={status.kind === "folder" ? "Syncing through a folder on this computer." : "Syncing through your server."}
          >
            {error && <Notice>{error}</Notice>}
            {status.error && <Notice>{status.error}</Notice>}
            <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
              <dt className="text-muted-foreground">Status</dt>
              <dd className={cn(status.error && "text-destructive")}>{stateLabel}</dd>
              <dt className="text-muted-foreground">Last sync</dt>
              <dd>
                {status.lastSync ? (
                  <>
                    <time dateTime={status.lastSync}>{relative(status.lastSync)}</time>
                    <span className="text-muted-foreground"> · {new Date(status.lastSync).toLocaleString()}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Never</span>
                )}
              </dd>
              {status.email && (
                <>
                  <dt className="text-muted-foreground">Account</dt>
                  <dd className="[overflow-wrap:anywhere]">{status.email}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{status.kind === "folder" ? "Folder" : "Server"}</dt>
              <dd className="font-mono text-[13px] [overflow-wrap:anywhere]">
                {status.kind === "folder" ? status.folder ?? "Not set" : status.server ?? "Not set"}
              </dd>
            </dl>
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <Button type="button" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy || status.busy} onClick={() => void syncNow()}>
                {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Sync now
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy || status.busy} onClick={() => setConfirmOff(true)}>
                <LogOut className="size-4" />
                Sign out
              </Button>
            </div>
          </Block>

          <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Sign out of sync?</AlertDialogTitle>
                <AlertDialogDescription>This device stops syncing until you sign in again. The collection on this device stays as it is.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void signOut()}>
                  Sign out
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </Section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-destructive/40 px-3.5 py-3 text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 break-words text-destructive">{children}</div>
    </div>
  );
}

function TextInput({ label, hint, error, value, onChange, type = "text", placeholder, autoComplete, inputMode, mono }: {
  label: string;
  hint?: ReactNode;
  error?: string;
  value: string;
  onChange(v: string): void;
  type?: "text" | "email" | "password";
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "text" | "email" | "numeric";
  mono?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={!!error}
        className={cn("h-10 md:h-9", mono && "font-mono text-[13px] md:text-[13px]")}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
