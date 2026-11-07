// Settings → Sync: one card that walks through email → plan (where Sync is bought) → start (a Sync password is
// optional where the server can keep the vault key), then shows what Sync is doing: last sync, plan, storage,
// encryption, and Sync now / Manage / Sign out.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, CircleAlert, Copy, ExternalLink, Loader2, LogOut, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Block, Field, Section } from "@/components/settings-ui";
import { relative } from "@/lib/api";
import { etudeFetch } from "@/lib/transport";
import { shareStatus } from "@/lib/sync";
import { cn } from "@/lib/utils";
import { ACCOUNT_EVENT, SecondStep } from "@/components/settings-account";
import { account, AccountApiError, bytes, openOutside, type AccountStatus } from "@/lib/account";
import { hasWebPortal, storageNote, storeSource } from "@/lib/billing-ui";
import { canShowPurchases, desktopApp, isNativeApp, storeSafeMessage } from "@/lib/platform";
import { NATIVE_COPY } from "@/lib/native-copy";
import { canBuyInApp, inAppProductIds, storeSource as thisStore, STOREKIT_EVENT } from "@/lib/storekit";
import { AppStoreManage, AppStorePlans } from "@/components/app-store-plans";

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
  /** "password": end-to-end, opened with the Sync password. "server": the server keeps the vault key, so devices open it after signing in. */
  mode: "password" | "server" | null;
  /** The server can keep vault keys, so Sync can start without a password. */
  passwordOptional: boolean;
  lastSync: string | null;
  error: string | null;
  pending: number;
  /** The collection's sync: decks, items, cards, history and card type assets. */
  busy: boolean;
  /** While the collection syncs. */
  progress: SyncProgress | null;
  /** Events from other devices since the app started. */
  received?: number;
  /** Media files, which follow the collection in the background. `received` counts the files written from other devices. */
  media?: { active: boolean; progress: SyncProgress | null; error: string | null; received: number };
}

/** snapshot, download and upload count bytes; check counts media files. The total is null when it isn't known ahead. */
export interface SyncProgress {
  step: "snapshot" | "download" | "check" | "upload" | "apply";
  done: number;
  total: number | null;
  /** Bytes per second. */
  rate: number;
}

type UnlockResponse = { recoveryKey?: string; status: SyncStatus };
type Stage = "setup" | "signin" | "code" | "unlock" | "recovery" | "ready";

const errorMessage = (e: unknown) => (e instanceof Error ? storeSafeMessage(e.message, (e as { code?: string }).code) : "The request failed.");
const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

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
    const code = (data as { code?: string; error?: { code?: string } } | null)?.code ?? (typeof err === "object" && err ? (err as { code?: string }).code : undefined);
    throw new AccountApiError(detail || "The sync request failed.", res.status, code);
  }
  return data as T;
}

export function SyncSection() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [acct, setAcct] = useState<AccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Set when the server asks for a fresh sign-in, with what it was for.
  const [reauth, setReauth] = useState<false | "unlock" | "protect" | "unprotect">(false);

  const [server, setServer] = useState(DEFAULT_SERVER);
  const [folder, setFolder] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  // Two-step sign-in: the email code went through, the authenticator (or a recovery code) is next.
  const [second, setSecond] = useState<string[] | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  // A new vault: start without a password unless one is asked for (or the server can't keep keys).
  const [withPassword, setWithPassword] = useState(false);
  // Ready: the form that adds a Sync password, and the dialog that removes it.
  const [protecting, setProtecting] = useState(false);
  const [confirmUnprotect, setConfirmUnprotect] = useState(false);
  const [recoveryFor, setRecoveryFor] = useState<"setup" | "protect">("setup");
  const [advanced, setAdvanced] = useState(false);
  const [acctLoaded, setAcctLoaded] = useState(false);
  const seeded = useRef(false);
  const suggested = useRef<string | null>(null);
  const seenPlan = useRef(false);

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

  const loadAccount = useCallback(async () => {
    setAcct(await account.status().catch(() => null));
    setAcctLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    void loadAccount();
    // Signing in to the Etude account also signs Sync in when both use the same server.
    const h = () => {
      void load(true);
      account.status().then((a) => {
        setAcct(a);
        // Not set up yet and not edited by hand: follow the account's server.
        setServer((cur) => (cur === DEFAULT_SERVER || cur === suggested.current ? (suggested.current = a.server) : cur));
      }).catch(() => setAcct(null));
    };
    window.addEventListener(ACCOUNT_EVENT, h);
    return () => window.removeEventListener(ACCOUNT_EVENT, h);
  }, [load, loadAccount]);

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

  // The app watches media that comes in after a sync started here.
  useEffect(() => {
    if (status) shareStatus(status);
  }, [status]);

  // A running sync, or media still coming in, is reported by status; look again until it settles.
  const mediaActive = !!status?.media?.active;
  useEffect(() => {
    if (!status?.busy && !mediaActive) return;
    const t = window.setInterval(() => void load(true), 1000);
    return () => window.clearInterval(t);
  }, [status?.busy, mediaActive, load]);

  // Storage used changes with each sync.
  useEffect(() => {
    if (status?.lastSync) void loadAccount();
  }, [status?.lastSync, loadAccount]);

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
      if ((name === "unlock" || name === "protect" || name === "unprotect") && e instanceof AccountApiError && e.code === "reauth_required") {
        setReauth(name);
        setCodeSent(false);
        setEmail(status?.email ?? acct?.email ?? "");
        // The sign-in step already says why.
        if (name !== "unlock") return null;
      }
      setError(errorMessage(e));
      return null;
    } finally {
      setBusy(null);
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
    const s = await withBusy("verify", () => callSync<SyncStatus & { secondStep?: { methods: string[] } }>("POST", "/api/sync/verify", { code: c }));
    setCode("");
    if (s?.secondStep) return setSecond(s.secondStep.methods);
    if (s) await signedIn(s);
  };

  const signedIn = async (s: SyncStatus) => {
    setStatus(s);
    if (!s.signedIn) return;
    // Signed in again to change the password: back to where that was.
    if (reauth === "unprotect") setConfirmUnprotect(true);
    setReauth(false);
    setCodeSent(false);
    setSecond(null);
    setAcctLoaded(false);
    await loadAccount();
    window.dispatchEvent(new Event(ACCOUNT_EVENT));
  };

  /** The first step in one go: connect to the server (or folder), then send the code. */
  const start = async () => {
    if (busy || !status) return;
    if (!status.configured) {
      const f = folder.trim();
      if (!f) {
        if (!email.trim()) {
          setError("Enter your email address.");
          return;
        }
      }
      const url = server.trim() || DEFAULT_SERVER;
      if (!f) {
        try {
          const u = new URL(url);
          if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
        } catch {
          setError("Enter a full http or https server address.");
          return;
        }
      }
      const s = await withBusy("setup", () => callSync<SyncStatus>("POST", "/api/sync/setup", f ? { folder: f } : { server: url }));
      if (!s) return;
      setStatus(s);
      setCodeSent(false);
      if (s.kind !== "cloud" || s.signedIn) return;
    }
    await signin();
  };

  /** Opens the vault, or makes it. With noPassword, the server keeps (or already keeps) the vault key. */
  const unlock = async (noPassword = false) => {
    if (busy) return;
    const body: Record<string, string> = {};
    if (noPassword) {
      // Nothing to send.
    } else if (status?.hasKeys && useRecovery) {
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
      setWithPassword(false);
      if (r.recoveryKey) {
        setRecoveryFor("setup");
        setRecoveryKey(r.recoveryKey);
        setRecoveryConfirmed(false);
        setCopied(false);
      }
      // "Start syncing" means it: run the first sync right away instead of waiting for the background one.
      void callSync<SyncStatus>("POST", "/api/sync/now", {}).then(setStatus, () => void load(true));
    }
  };

  /** Adds a Sync password to a vault whose key the server keeps: it becomes end-to-end and gets a recovery key. */
  const protect = async () => {
    if (busy) return;
    if (!password) {
      setError("Choose a sync password.");
      return;
    }
    if (password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    const r = await withBusy("protect", () => callSync<UnlockResponse>("POST", "/api/sync/protect", { password }));
    // Kept on failure, so signing in again (or fixing a typo) doesn't mean typing it twice more.
    if (!r) return;
    setPassword("");
    setConfirm("");
    setProtecting(false);
    setStatus(r.status);
    if (r.recoveryKey) {
      setRecoveryFor("protect");
      setRecoveryKey(r.recoveryKey);
      setRecoveryConfirmed(false);
      setCopied(false);
    }
  };

  /** Removes the Sync password: the server keeps the vault key again. */
  const unprotect = async () => {
    if (busy) return;
    setConfirmUnprotect(false);
    const r = await withBusy("unprotect", () => callSync<UnlockResponse>("POST", "/api/sync/unprotect", {}));
    if (r) {
      setStatus(r.status);
      toast.success("Sync password removed", { description: "New devices sync after signing in." });
    }
  };

  const syncNow = async () => {
    if (busy) return;
    setBusy("now");
    setError(null);
    try {
      setStatus(await callSync<SyncStatus>("POST", "/api/sync/now", {}));
    } catch (e) {
      // A failed run leaves its error in the status; keep the request's own message only when the status can't be read.
      try {
        setStatus(await callSync<SyncStatus>("GET", "/api/sync/status"));
      } catch {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    if (busy) return;
    setConfirmOff(false);
    const s = await withBusy("off", () => callSync<SyncStatus>("POST", "/api/sync/off", {}));
    if (s) {
      seenPlan.current = false;
      setStatus(s);
      setReauth(false);
      setCodeSent(false);
      setSecond(null);
      setCode("");
      setPassword("");
      setConfirm("");
      setRecoveryInput("");
      setUseRecovery(false);
      setWithPassword(false);
      setProtecting(false);
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
    toast.success(recoveryFor === "protect" ? "Sync password added" : "Sync is set up", recoveryFor === "protect" ? { description: "Sync is end-to-end now. New devices need the password." } : undefined);
  };

  const stage: Stage = !status
    ? "setup"
    : !status.configured
      ? "setup"
      : recoveryKey
        ? "recovery"
        : status.kind === "cloud" && (!status.signedIn || reauth)
          ? codeSent
            ? "code"
            : "signin"
          : !status.unlocked
            ? "unlock"
            : "ready";

  const newVault = !!status && !status.hasKeys;
  // A vault whose key the server keeps opens after signing in, and a new one starts that way unless a password is asked for.
  const serverVault = !!status && status.hasKeys && status.mode === "server";
  const noPasswordStart = newVault && !!status?.passwordOptional && !withPassword;
  const endToEnd = status?.mode === "password";
  // While signing in again to add or remove the password, the setup steps don't apply.
  const changing = reauth === "protect" || reauth === "unprotect";
  const syncing = !!status && (status.busy || busy === "now");
  // One notice: this form's own error first, then the last sync run's. None while a new run is going.
  // A run that failed for want of a plan says so until the next run; once the plan is active that's stale.
  const lastRunError = status?.error && acct?.me?.sync.active && /needs an active subscription/i.test(status.error) ? null : (status?.error ?? null);
  const rawProblem = syncing ? null : (error ?? lastRunError);
  const problem = rawProblem && storeSafeMessage(rawProblem);
  const stateLabel = syncing
    ? "Syncing…"
    : problem
      ? "Needs attention"
      : status && status.pending > 0
        ? `${status.pending} ${status.pending === 1 ? "change" : "changes"} waiting`
        : !status?.lastSync
          ? "Not synced yet"
          : "Up to date";

  // Etude Sync on a server that charges: the plan step comes between the code and the password.
  const billingOn = !!acct?.offering?.billing;
  const planActive = !!acct?.me?.sync.active;
  const cloud = status?.kind === "cloud";
  const needsPlan = cloud && billingOn && !planActive;
  const waitingForAccount = !!status && cloud && status.signedIn && !status.unlocked && !acctLoaded;
  const flow: Flow = stage === "setup" || stage === "signin" || stage === "code"
    ? "email"
    : stage === "unlock" && waitingForAccount
      ? "loading"
      : stage === "unlock" && needsPlan
        ? "plan"
        : stage === "unlock"
          ? "password"
          : stage === "recovery"
            ? "recovery"
            : "ready";
  // The plan step shows in the progress only where Sync is bought, and only until it's paid.
  // Before sign-in it shows unless the server is known not to charge (or a folder is the choice).
  const folderSetup = status?.kind === "folder" || (!status?.configured && !!folder.trim());
  // Once the plan step was part of this setup it stays in the bar (as done) until the end.
  const showPlan = !folderSetup && (seenPlan.current || flow === "plan" || !acctLoaded || (billingOn && !planActive));
  if (showPlan && flow !== "ready") seenPlan.current = true;
  const steps: Flow[] = showPlan ? ["email", "plan", "password"] : ["email", "password"];

  const afterPlan = useCallback(() => {
    void loadAccount();
    window.dispatchEvent(new Event(ACCOUNT_EVENT));
  }, [loadAccount]);

  return (
    <Section id="sync" title="Sync" description={endToEnd ? "The same collection on every device, end-to-end encrypted: only your devices can read it." : status?.mode === "server" ? "The same collection on every device, encrypted before it leaves each one. Add a Sync password to make it end-to-end." : "The same collection on every device, encrypted before it leaves each one."}>
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
            <Button variant="outline" size="sm" className="phone:h-10 h-8" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        </Block>
      )}

      {status && flow !== "ready" && flow !== "recovery" && (
        <Block>
          {!changing && <StepBar steps={steps} current={flow === "loading" ? "plan" : flow} passwordLabel={serverVault || (newVault && status.passwordOptional) ? "Start" : "Password"} />}

          {flow === "email" && stage !== "code" && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void start();
              }}
            >
              <StepTitle title={reauth ? "Confirm it's you" : "Turn on Etude Sync"} lead={changing ? `Sign in again to ${reauth === "protect" ? "add" : "remove"} the Sync password.` : reauth ? (serverVault ? "Sign in again to start syncing on this device." : "Sign in again before unlocking sync. Then enter your sync password or recovery key.") : status.configured && status.kind === "cloud" && status.server && status.server !== DEFAULT_SERVER ? <>Codes are sent by <span className="font-mono text-[13px] text-foreground/85">{status.server}</span>.</> : "We'll email you a code. No account password to remember."} />
              {(!status.configured ? !folder.trim() : status.kind === "cloud") && (
                <TextInput label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" inputMode="email" placeholder="you@example.com" />
              )}
              {!status.configured && (
                <details className="group text-sm" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
                  <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">Your own server{!(globalThis as any).__etudeLocal && !isNativeApp() ? " or a folder" : ""}</summary>
                  <div className="mt-3 flex flex-col gap-4">
                    <p className="text-muted-foreground">{isNativeApp() ? NATIVE_COPY.syncSetup : "Etude syncs through a server, or through a folder on this computer in the desktop app."}</p>
                    <TextInput label="Server" value={server} onChange={setServer} placeholder={DEFAULT_SERVER} mono autoComplete="url" hint="Leave it as it is to use Etude Sync." />
                    {!(globalThis as any).__etudeLocal && !isNativeApp() && <TextInput label="Folder (optional)" value={folder} onChange={setFolder} placeholder="/home/you/Etude" mono autoComplete="off" hint="Desktop app only. Syncs through this folder instead of a server." action={<ChooseFolder onPick={setFolder} />} />}
                  </div>
                </details>
              )}
              {problem && <Notice>{problem}</Notice>}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" className="phone:h-10 gap-1.5 h-8" disabled={!!busy}>
                  {(busy === "setup" || busy === "signin") && <Loader2 className="size-4 animate-spin" />}
                  {!status.configured && folder.trim() ? "Use this folder" : "Send code"}
                </Button>
                {changing ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="phone:h-10 h-8"
                    disabled={!!busy}
                    onClick={() => {
                      setReauth(false);
                      setError(null);
                    }}
                  >
                    Cancel
                  </Button>
                ) : status.configured && (
                  <Button type="button" variant="ghost" size="sm" className="phone:h-10 h-8" disabled={!!busy} onClick={() => void signOut()}>
                    Change server
                  </Button>
                )}
              </div>
            </form>
          )}

          {stage === "code" && second && (
            <div className="flex flex-col gap-4">
              <StepTitle title="One more step" lead="Two-step sign-in is on for this account." />
              <SecondStep
                methods={second}
                onSubmit={async (input) => void (await signedIn(await callSync<SyncStatus>("POST", "/api/sync/second-factor", input)))}
                onRestart={() => {
                  setSecond(null);
                  setCodeSent(false);
                  setCode("");
                  setError(null);
                }}
              />
            </div>
          )}

          {stage === "code" && !second && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void verify();
              }}
            >
              <StepTitle title="Enter the code" lead={<>Sent to <span className="text-foreground/90">{email.trim() || status.email}</span>. It works for 15 minutes.</>} />
              <TextInput label="Sign-in code" value={code} onChange={setCode} autoComplete="one-time-code" inputMode="numeric" placeholder="6-digit code" mono />
              {problem && <Notice>{problem}</Notice>}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" className="phone:h-10 gap-1.5 h-8" disabled={!!busy}>
                  {busy === "verify" && <Loader2 className="size-4 animate-spin" />}
                  Verify
                </Button>
                <Button type="button" variant="ghost" size="sm" className="phone:h-10 gap-1.5 h-8" disabled={!!busy} onClick={() => void signin()}>
                  Send again
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="phone:h-10 gap-1.5 h-8"
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
          )}

          {flow === "loading" && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-16 w-full sm:max-w-md" />
            </div>
          )}

          {flow === "plan" && acct && (
            <div className="flex flex-col gap-4" data-sync-step="plan">
              <StepTitle
                title={canShowPurchases() ? "Pick a plan" : "Etude Sync"}
                lead={<>Signed in{status.email ? <> as <span className="text-foreground/90">{status.email}</span></> : null}. 1 GB of encrypted storage.</>}
              />
              <PlanChooser st={acct} onActive={afterPlan} onRefresh={loadAccount} />
              <div>
                <Button type="button" variant="ghost" size="sm" className="phone:h-10 h-8" disabled={!!busy} onClick={() => void signOut()}>
                  Use another email
                </Button>
              </div>
            </div>
          )}

          {flow === "password" && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void unlock(noPasswordStart || serverVault);
              }}
            >
              <StepTitle
                title={noPasswordStart || serverVault ? "Start syncing" : newVault ? "Create your sync password" : "Unlock sync"}
                lead={
                  serverVault
                    ? <>Signed in{status.email ? <> as <span className="text-foreground/90">{status.email}</span></> : null}. Your devices sync without a password, so this one doesn't need one either.</>
                    : noPasswordStart
                      ? "Your collection is encrypted on this device before it's sent. The server keeps the key, so your other devices only need to sign in."
                      : newVault && status.passwordOptional
                        ? "End-to-end: only your devices can read your collection, not the server. You'll type it once on each new device. If you lose both the password and the recovery key, the copy on the server can't be opened."
                        : newVault
                          ? "It encrypts your collection before it leaves this device. You'll type it once on each new device; Etude never sees it."
                          : <>Signed in{status.email ? <> as <span className="text-foreground/90">{status.email}</span></> : null}. Enter the sync password you chose on your first device.</>
                }
              />
              {noPasswordStart || serverVault ? (
                <>
                  {problem && <Notice>{problem}</Notice>}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" size="sm" className="phone:h-10 gap-1.5 h-8" disabled={!!busy}>
                      {busy === "unlock" && <Loader2 className="size-4 animate-spin" />}
                      Start syncing
                    </Button>
                    {noPasswordStart && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="phone:h-10 gap-1.5 h-8"
                        disabled={!!busy}
                        onClick={() => {
                          setWithPassword(true);
                          setError(null);
                        }}
                      >
                        Use a Sync password instead
                      </Button>
                    )}
                  </div>
                </>
              ) : status.hasKeys && useRecovery ? (
                <>
                  <TextInput label="Recovery key" value={recoveryInput} onChange={setRecoveryInput} autoComplete="off" mono placeholder="Your recovery key" />
                  {problem && <Notice>{problem}</Notice>}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" size="sm" className="phone:h-10 gap-1.5 h-8" disabled={!!busy}>
                      {busy === "unlock" && <Loader2 className="size-4 animate-spin" />}
                      Unlock
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="phone:h-10 gap-1.5 h-8"
                      disabled={!!busy}
                      onClick={() => {
                        setUseRecovery(false);
                        setRecoveryInput("");
                        setError(null);
                      }}
                    >
                      Use the password
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <TextInput label={newVault ? "Sync password" : "Password"} type="password" value={password} onChange={setPassword} autoComplete={newVault ? "new-password" : "current-password"} />
                  {newVault && <TextInput label="Confirm password" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" />}
                  {problem && <Notice>{problem}</Notice>}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" size="sm" className="phone:h-10 gap-1.5 h-8" disabled={!!busy}>
                      {busy === "unlock" && <Loader2 className="size-4 animate-spin" />}
                      {newVault ? "Start syncing" : "Unlock"}
                    </Button>
                    {newVault && status.passwordOptional && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="phone:h-10 gap-1.5 h-8"
                        disabled={!!busy}
                        onClick={() => {
                          setWithPassword(false);
                          setPassword("");
                          setConfirm("");
                          setError(null);
                        }}
                      >
                        Sync without a password
                      </Button>
                    )}
                    {status.hasKeys && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="phone:h-10 gap-1.5 h-8"
                        disabled={!!busy}
                        onClick={() => {
                          setUseRecovery(true);
                          setPassword("");
                          setConfirm("");
                          setError(null);
                        }}
                      >
                        Forgot it? Use the recovery key
                      </Button>
                    )}
                  </div>
                </>
              )}
              {status.kind === "cloud" && (
                <p className="text-xs text-muted-foreground">
                  Not you?{" "}
                  <button type="button" className="underline underline-offset-2 hover:text-foreground" disabled={!!busy} onClick={() => void signOut()}>
                    Sign out
                  </button>
                </p>
              )}
            </form>
          )}
        </Block>
      )}

      {status && flow === "recovery" && recoveryKey && (
        <Block title="Save your recovery key" description="If you forget the sync password, this key is the only way to unlock your collection on a new device. It's shown only once.">
          <div className="rounded-lg border border-warning/40 bg-warning/5 p-3.5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <code className="min-w-0 flex-1 select-all font-mono text-[13px] leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">{recoveryKey}</code>
              <Button type="button" variant="outline" size="sm" className="phone:h-10 shrink-0 gap-1.5 h-8" onClick={() => void copyRecovery()}>
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
            <Button type="button" size="sm" className="phone:h-10 gap-1.5 h-8" disabled={!recoveryConfirmed} onClick={finishRecovery}>
              Continue
            </Button>
          </div>
        </Block>
      )}

      {status && flow === "ready" && (
        <>
          <Block>
            <div className="flex items-center gap-2.5" data-sync-state={syncing ? "syncing" : problem ? "problem" : "ok"}>
              <span className={cn("size-2 shrink-0 rounded-full", syncing ? "animate-pulse bg-highlight" : problem || (cloud && billingOn && acct && !planActive) ? "bg-destructive" : "bg-success")} />
              <h3 className="text-[15px] font-semibold">{cloud && billingOn && acct && !planActive ? "Sync is off for this account" : stateLabel}</h3>
            </div>
            {problem && !protecting && <Notice>{problem}</Notice>}
            {syncing && status.progress && <ProgressRow p={status.progress} />}
            {!syncing && status.media?.active && (
              <div className="flex flex-col gap-1.5" data-sync-media="active">
                <span className="text-sm">Your collection is up to date. Media files are still coming in.</span>
                {status.media.progress && <ProgressRow p={status.media.progress} label="Media sync progress" />}
              </div>
            )}
            {!syncing && !status.media?.active && status.media?.error && (
              <p className="text-sm text-muted-foreground" data-sync-media="error">
                Some media files didn't sync ({storeSafeMessage(status.media.error)}). They'll be tried again on the next sync.
              </p>
            )}
            <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
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
              {cloud && acct?.signedIn && acct.me && <PlanRows st={acct} />}
              {status.email && (
                <>
                  <dt className="text-muted-foreground">Account</dt>
                  <dd className="[overflow-wrap:anywhere]">{status.email}</dd>
                </>
              )}
              {status.mode && (
                <>
                  <dt className="text-muted-foreground">Encryption</dt>
                  <dd data-sync-mode={status.mode}>
                    {endToEnd ? "End-to-end, with your Sync password" : "Encrypted, with the key kept by the server"}
                    <span className="block text-xs text-muted-foreground">
                      {endToEnd ? "Only your devices can read it." : "New devices only need to sign in. With a Sync password, only your devices could read it."}
                    </span>
                    {cloud && !protecting && (status.mode === "server" || status.passwordOptional) && (
                      <button
                        type="button"
                        className="mt-1 text-xs underline underline-offset-2 hover:text-foreground disabled:opacity-60"
                        disabled={!!busy || status.busy}
                        onClick={() => {
                          if (endToEnd) return setConfirmUnprotect(true);
                          setProtecting(true);
                          setError(null);
                        }}
                      >
                        {endToEnd ? "Remove the Sync password" : "Add a Sync password"}
                      </button>
                    )}
                  </dd>
                </>
              )}
              {(status.kind === "folder" || (status.server && status.server !== DEFAULT_SERVER)) && (
                <>
                  <dt className="text-muted-foreground">{status.kind === "folder" ? "Folder" : "Server"}</dt>
                  <dd className="font-mono text-[13px] [overflow-wrap:anywhere]" title={status.kind === "folder" ? (isNativeApp() ? NATIVE_COPY.syncFolder : "Syncing through a folder on this computer.") : undefined}>
                    {status.kind === "folder" ? status.folder ?? "Not set" : status.server}
                  </dd>
                </>
              )}
            </dl>
            {cloud && billingOn && acct && !planActive && <PlanChooser st={acct} onActive={afterPlan} onRefresh={loadAccount} />}
            {protecting && (
              <form
                className="flex flex-col gap-4 border-t pt-4"
                data-sync-step="protect"
                onSubmit={(e) => {
                  e.preventDefault();
                  void protect();
                }}
              >
                <StepTitle title="Add a Sync password" lead="End-to-end: your collection is encrypted with a key only your devices can open, and the server drops its copy. New devices will need the password, and you'll get a recovery key in case you forget it." />
                <TextInput label="Sync password" type="password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters." />
                <TextInput label="Confirm password" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
                {error && <Notice>{storeSafeMessage(error)}</Notice>}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" size="sm" className="phone:h-10 gap-1.5 h-8" disabled={!!busy}>
                    {busy === "protect" && <Loader2 className="size-4 animate-spin" />}
                    Add password
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="phone:h-10 h-8"
                    disabled={!!busy}
                    onClick={() => {
                      setProtecting(false);
                      setPassword("");
                      setConfirm("");
                      setError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <Button type="button" size="sm" className="phone:h-10 gap-1.5 h-8" disabled={!!busy || status.busy || (cloud && billingOn && !!acct && !planActive)} onClick={() => void syncNow()}>
                {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Sync now
              </Button>
              {cloud && acct?.me && <ManagePlan st={acct} onChanged={loadAccount} />}
              <Button type="button" variant="ghost" size="sm" className="phone:h-10 gap-1.5 h-8" disabled={!!busy || status.busy} onClick={() => setConfirmOff(true)}>
                <LogOut className="size-4" />
                Sign out
              </Button>
            </div>
          </Block>

          <AlertDialog open={confirmUnprotect} onOpenChange={setConfirmUnprotect}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove the Sync password?</AlertDialogTitle>
                <AlertDialogDescription>Sync stops being end-to-end: the server keeps the key to your collection, so whoever runs it could read it. New devices only need to sign in. Your recovery key stops working; adding a password again makes a new one.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep the password</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void unprotect()}>
                  Remove it
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

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

type Flow = "email" | "loading" | "plan" | "password" | "recovery" | "ready";
const STEP_LABEL: Partial<Record<Flow, string>> = { email: "Email", plan: "Plan", password: "Password" };

function StepBar({ steps, current, passwordLabel }: { steps: Flow[]; current: Flow; passwordLabel: string }) {
  const at = Math.max(0, steps.indexOf(current));
  // One pill per step across the card: green where you are, a softer green for the steps behind you, a visible track ahead.
  return (
    <ol className="-mb-1 flex gap-1.5" aria-label="Sync setup steps" data-sync-steps={steps.join(",")}>
      {steps.map((s, i) => (
        <li key={s} className="flex min-w-0 flex-1 flex-col gap-2" aria-current={i === at ? "step" : undefined}>
          <span className={cn("h-1.5 rounded-full transition-colors duration-300", i === at ? "bg-highlight" : i < at ? "bg-highlight/40" : "bg-foreground/15")} />
          <span className={cn("truncate text-[12px] font-medium", i === at ? "text-foreground" : i < at ? "text-muted-foreground" : "text-muted-foreground/70")}>
            {s === "password" ? passwordLabel : STEP_LABEL[s]}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepTitle({ title, lead }: { title: ReactNode; lead?: ReactNode }) {
  return (
    <div>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      {lead && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{lead}</p>}
    </div>
  );
}

const REASON: Record<string, string> = {
  billing_off: "Included on this server",
  active: "Active",
  canceled_until_end: "Canceled, active until the period ends",
  grace: "Payment failed, still syncing for a few days",
  past_due: "Paused: the payment failed",
  expired: "Ended",
  revoked: "Ended",
  none: "Not subscribed",
};
// The store apps say what the account has, never how to pay for it.
const NATIVE_REASON: Record<string, string> = { none: "Not active", past_due: "Paused", grace: "Syncing for a few more days" };

/** Plan and storage, as rows of the Sync card. */
function PlanRows({ st }: { st: AccountStatus }) {
  const b = st.billing;
  const active = !!st.me?.sync.active;
  const reason = st.me?.sync.reason ?? "none";
  const quota = st.vault?.quotaBytes ?? st.offering?.quotaBytes ?? 1024 ** 3;
  // The server only reports storage while Sync is active; without it there's no number to show.
  const used = st.vault ? st.vault.usedBytes : null;
  const pct = used == null ? 0 : Math.min(100, (used / quota) * 100);
  const purchases = canShowPurchases();
  const when = b?.expires ? (reason === "active" ? `Renews ${date(b.expires)}` : reason === "canceled_until_end" ? `Ends ${date(b.expires)}` : reason === "grace" ? `Syncing until ${date(b.graceUntil)}` : reason === "expired" || reason === "revoked" ? date(b.expires) : "") : "";
  return (
    <>
      <dt className="text-muted-foreground">Plan</dt>
      <dd className={cn(active ? "text-foreground" : "text-muted-foreground")} data-plan-state={reason}>
        {(!purchases && NATIVE_REASON[reason]) || REASON[reason] || reason}
        {when && <span className="text-muted-foreground"> · {when}</span>}
        {purchases && active && storeSource(b) && <span className="block text-xs text-muted-foreground" data-store-source={b!.source}>{storeSource(b)}</span>}
      </dd>
      <dt className="text-muted-foreground">Storage</dt>
      <dd>
        {used == null ? (
          <span className="text-muted-foreground" data-storage="unknown">
            — <span className="text-xs">· {storageNote(st, active)}</span>
          </span>
        ) : (
          <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-3">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10 sm:min-w-24 sm:max-w-56 sm:flex-1" role="meter" aria-valuemin={0} aria-valuemax={quota} aria-valuenow={used} aria-label="Storage used">
              <div className="h-full rounded-full bg-highlight" style={{ width: `${Math.max(pct, used ? 1.5 : 0)}%` }} />
            </div>
            <span className="shrink-0 tabular-nums text-muted-foreground">{bytes(used)} of {bytes(quota)}</span>
          </div>
        )}
      </dd>
    </>
  );
}

/** "Manage subscription": the website portal for a Polar subscription, the store's own sheet in the phone apps. */
function ManagePlan({ st, onChanged }: { st: AccountStatus; onChanged(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const b = st.billing;
  const purchases = canShowPurchases();
  const active = !!st.me?.sync.active;
  const appStore = !!st.offering?.billing && !purchases && canBuyInApp() && !!inAppProductIds(st.offering).length;
  if (appStore && active && b?.source === thisStore()) return <AppStoreManage onChanged={onChanged} />;
  if (!(st.offering?.billing && purchases && hasWebPortal(b) && true)) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="phone:h-10 gap-1.5 h-8"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          openOutside((await account.portal()).url);
        } catch (e) {
          toast.error("Couldn't open the page", { description: errorMessage(e) });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />} Manage subscription
    </Button>
  );
}

/**
 * Buying Sync: on the desktop and the web, the two plans and a checkout on etude.study that this card
 * waits for; in the store apps, the App Store or Google Play plans; anywhere else, just that it isn't on.
 */
function PlanChooser({ st, onActive, onRefresh }: { st: AccountStatus; onActive(): void; onRefresh(): Promise<void> }) {
  const [plan, setPlan] = useState<"monthly" | "yearly">("yearly");
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const purchases = canShowPurchases();
  const storeIds = inAppProductIds(st.offering);
  const appStore = !purchases && canBuyInApp() && !!storeIds.length;

  useEffect(() => {
    if (!appStore) return;
    const h = () => void onRefresh();
    window.addEventListener(STOREKIT_EVENT, h);
    return () => window.removeEventListener(STOREKIT_EVENT, h);
  }, [appStore, onRefresh]);

  // While the checkout is open in the browser, look for the subscription every few seconds and on return.
  useEffect(() => {
    if (!waiting) return;
    const check = async () => {
      const a = await account.status().catch(() => null);
      if (a?.me?.sync.active) {
        setWaiting(false);
        toast.success("Sync is active");
        onActive();
      }
    };
    const t = window.setInterval(() => void check(), 3000);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", check);
    };
  }, [waiting, onActive]);

  if (appStore) return <AppStorePlans productIds={storeIds} onActive={onActive} />;
  if (!purchases)
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">Sync isn't active on this account.</p>
        <div>
          <Button variant="outline" size="sm" className="phone:h-10 h-8" onClick={() => void onRefresh()}>Check again</Button>
        </div>
      </div>
    );

  if (waiting)
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-highlight/30 bg-highlight/5 p-4" data-sync-step="waiting">
        <div className="flex items-center gap-2.5 text-sm">
          <Loader2 className="size-4 animate-spin text-highlight" />
          <span>Finish the payment in your browser. This moves on by itself once it goes through.</span>
        </div>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="phone:h-10 h-8"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const a = await account.status().catch(() => null);
              setBusy(false);
              if (a?.me?.sync.active) {
                setWaiting(false);
                onActive();
              } else setNote("Not active yet. If you just paid, give it a few seconds.");
            }}
          >
            {busy && <Loader2 className="size-4 animate-spin" />} I've paid
          </Button>
          <Button variant="ghost" size="sm" className="phone:h-10 h-8" onClick={() => setWaiting(false)}>Back to plans</Button>
        </div>
      </div>
    );

  const options = [
    { id: "yearly" as const, price: "US$40", per: "/ year", hint: "US$3.33 a month · save 33%" },
    { id: "monthly" as const, price: "US$5", per: "/ month", hint: "Cancel anytime" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Plan" className="grid gap-2.5 sm:grid-cols-2 sm:max-w-lg">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={plan === o.id}
            data-plan-option={o.id}
            onClick={() => setPlan(o.id)}
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-xl border px-4 py-3 text-left transition-colors",
              plan === o.id ? "border-highlight bg-highlight/5 ring-1 ring-highlight" : "hover:border-foreground/25",
            )}
          >
            <span className="flex w-full items-baseline gap-1">
              <span className="text-lg font-semibold tabular-nums">{o.price}</span>
              <span className="text-sm text-muted-foreground">{o.per}</span>
              {plan === o.id && <Check className="ml-auto size-4 self-center text-highlight" />}
            </span>
            <span className="text-xs text-muted-foreground">{o.hint}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <div>
          <Button
            size="sm"
            className="phone:h-10 gap-1.5 h-8"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                openOutside((await account.checkout(plan)).url);
                setNote(null);
                setWaiting(true);
              } catch (e) {
                toast.error("Couldn't open the checkout", { description: errorMessage(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />} Continue to checkout
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Payment opens on etude.study, handled by Polar.</p>
      </div>
    </div>
  );
}

const STEP: Record<SyncProgress["step"], string> = { snapshot: "Downloading your collection", download: "Downloading", check: "Checking media", upload: "Uploading", apply: "Applying changes" };

function ProgressRow({ p, label = "Sync progress" }: { p: SyncProgress; label?: string }) {
  const transfer = p.step === "snapshot" || p.step === "download" || p.step === "upload";
  // The download total is the server's estimate, so it never claims 100% before the step ends.
  const pct = p.total ? Math.min(p.step === "download" ? 99 : 100, Math.floor((p.done / p.total) * 100)) : null;
  const detail = p.step === "check"
    ? `${p.done.toLocaleString()} of ${(p.total ?? 0).toLocaleString()} files`
    : transfer
      ? p.total ? `${bytes(p.done)} of ${p.step === "download" ? "about " : ""}${bytes(p.total)}` : bytes(p.done)
      : "";
  const rate = transfer && p.rate > 0 ? `${p.step === "upload" ? "↑" : "↓"} ${bytes(p.rate)}/s` : "";
  return (
    <div className="flex flex-col gap-1.5" data-sync-progress={p.step}>
      <div className="h-1.5 w-full max-w-72 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div className={cn("h-full rounded-full bg-highlight transition-[width] duration-700", pct === null && "w-1/3 animate-pulse")} style={pct === null ? undefined : { width: `${Math.max(pct, 1.5)}%` }} />
      </div>
      <span className="tabular-nums text-muted-foreground">{[STEP[p.step] + (pct === null ? "" : ` ${pct}%`), detail, rate].filter(Boolean).join(" · ")}</span>
    </div>
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

function TextInput({ label, hint, error, value, onChange, type = "text", placeholder, autoComplete, inputMode, mono, action }: {
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
  /** Beside the field, like a Choose… button. */
  action?: ReactNode;
}) {
  const id = useId();
  const input = (
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
      className={cn("phone:h-10 h-9", mono && "font-mono text-[13px] md:text-[13px]", action && "min-w-0 flex-1")}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      {action ? (
        <div className="flex gap-2">
          {input}
          {action}
        </div>
      ) : (
        input
      )}
    </Field>
  );
}

/** The system's folder picker, in the desktop app only. */
export function ChooseFolder({ onPick, className }: { onPick(folder: string): void; className?: string }) {
  const app = desktopApp();
  if (!app) return null;
  return (
    <Button
      type="button"
      variant="outline"
      className={cn("phone:h-10 shrink-0 h-9", className)}
      onClick={async () => {
        const folder = await app.pickFolder();
        if (folder) onPick(folder);
      }}
    >
      Choose…
    </Button>
  );
}
