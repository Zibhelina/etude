// Settings → Account: the optional Etude account. Sign in by email code or passkey; then passkeys,
// devices, email, data export and deletion. Selling lives in the Market.
import { useCallback, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { CircleAlert, Fingerprint, KeyRound, Laptop, Loader2, LogOut, Mail, Smartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Block, Field, Section } from "@/components/settings-ui";
import { download } from "@/components/type-editor/starter";
import { account, AccountApiError, createPasskey, getPasskey, passkeysHere, type AccountStatus, type Device, type Passkey } from "@/lib/account";
import { relative } from "@/lib/api";
import { isNativeApp } from "@/lib/platform";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const msg = (e: unknown) => (e instanceof Error ? e.message : "The request failed.");
const needsReauth = (e: unknown) => e instanceof AccountApiError && e.status === 403 && /sign in again/i.test(e.message);
const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

/** Fired after sign-in changes so Settings → Sync can pick up the shared device. */
export const ACCOUNT_EVENT = "etude:account";

export function AccountSection() {
  const [st, setSt] = useState<AccountStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reauth, setReauth] = useState<null | { why: string; retry: () => Promise<void> }>(null);

  const load = useCallback(async () => {
    try {
      setSt(await account.status());
      setLoadError(null);
    } catch (e) {
      setLoadError(msg(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const changed = useCallback(async () => {
    await load();
    window.dispatchEvent(new Event(ACCOUNT_EVENT));
  }, [load]);

  /** Runs an action that may need a fresh sign-in; asks for one and retries. */
  const guarded = useCallback(
    async (why: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        if (needsReauth(e)) setReauth({ why, retry: fn });
        else toast.error("That didn't work", { description: msg(e) });
      }
    },
    [],
  );

  const signedIn = !!st?.signedIn && !!st.me;
  return (
    <Section
      id="account"
      title="Account"
      description="Optional. An Etude account is only needed for Sync and decks from the paid Market. Everything else works without one."
    >
      {!st && !loadError && (
        <Block>
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-10 w-full sm:max-w-md" />
        </Block>
      )}
      {loadError && !st && (
        <Block>
          <Notice>Couldn't read the account: {loadError}</Notice>
          <div>
            <Button variant="outline" size="sm" className="h-10 md:h-8" onClick={() => void load()}>Try again</Button>
          </div>
        </Block>
      )}
      {st && !signedIn && <SignIn st={st} onDone={changed} />}
      {st && signedIn && (
        <>
          <Profile st={st} onChanged={changed} guarded={guarded} />
          <Passkeys rpId={st.offering?.passkeys.rpId} guarded={guarded} />
          <Devices guarded={guarded} onSelfRevoked={changed} />
          {st.offering?.market && <SellingLink />}
          <DataAndDeletion st={st} confirmFresh={(why, fn) => setReauth({ why, retry: fn })} onDeleted={changed} />
        </>
      )}
      {reauth && st?.email && (
        <ReauthDialog
          email={st.email}
          rpId={st.offering?.passkeys.rpId}
          why={reauth.why}
          onClose={() => setReauth(null)}
          onConfirmed={async () => {
            const r = reauth;
            setReauth(null);
            await guarded(r.why, r.retry);
          }}
        />
      )}
    </Section>
  );
}

// ── signed out ──────────────────────────────────────────────────
function SignIn({ st, onDone }: { st: AccountStatus; onDone(): Promise<void> }) {
  const [email, setEmail] = useState(st.email ?? "");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editServer, setEditServer] = useState(false);
  const [server, setServer] = useState(st.server);
  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(null);
    }
  };
  const passkeyOk = passkeysHere(st.offering?.passkeys.rpId);
  return (
    <Block
      title={sent ? "Enter the code" : "Sign in or create an account"}
      description={sent ? <>We sent a code to <span className="text-foreground/90">{email.trim()}</span>. It works once, for 15 minutes.</> : "No password. We email you a one-time code; a new address gets a new account."}
    >
      {st.offline && <Notice>Can't reach {st.server}: {st.offline}</Notice>}
      {!sent ? (
        <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void run("send", async () => (await account.signin(email), setSent(true))))}>
          <TextInput label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" placeholder="you@example.com" />
          {error && <Notice>{error}</Notice>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy || !email.trim()}>
              {busy === "send" ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />} Email me a code
            </Button>
            {passkeyOk && (
              <Button type="button" variant="outline" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy} onClick={() => void run("passkey", async () => {
                const o = await account.passkeyLoginOptions();
                await account.passkeyLoginVerify({ challengeId: o.challengeId, response: await getPasskey(o.options) });
                toast.success("Signed in");
                await onDone();
              })}>
                {busy === "passkey" ? <Loader2 className="size-4 animate-spin" /> : <Fingerprint className="size-4" />} Use a passkey
              </Button>
            )}
          </div>
        </form>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void run("verify", async () => {
          const r = await account.verify(code);
          setCode("");
          toast.success("Signed in", { description: r.email });
          await onDone();
        }))}>
          <TextInput label="Code" value={code} onChange={setCode} autoComplete="one-time-code" mono placeholder="Code from the email" />
          {error && <Notice>{error}</Notice>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!!busy || !code.trim()}>
              {busy === "verify" && <Loader2 className="size-4 animate-spin" />} Sign in
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-10 md:h-8" disabled={!!busy} onClick={() => void run("send", async () => void (await account.signin(email)))}>Send again</Button>
            <Button type="button" variant="ghost" size="sm" className="h-10 md:h-8" disabled={!!busy} onClick={() => (setSent(false), setCode(""), setError(null))}>Use another email</Button>
          </div>
        </form>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
        {!editServer ? (
          <>
            <span>Server</span>
            <span className="font-mono text-[12px] text-foreground/80 [overflow-wrap:anywhere]" data-account-server>{st.server}</span>
            <button className="underline underline-offset-2 hover:text-foreground" onClick={() => setEditServer(true)}>Change</button>
          </>
        ) : (
          <form className="flex w-full flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => (e.preventDefault(), void run("server", async () => {
            await account.setServer(server);
            setEditServer(false);
            await onDone();
          }))}>
            <TextInput label="Etude server" value={server} onChange={setServer} mono placeholder="https://sync.etude.study" hint="Leave empty for sync.etude.study. Self-hosted servers have Sync without the paid Market." />
            <Button type="submit" size="sm" variant="outline" className="h-10 md:h-9" disabled={!!busy}>Save</Button>
          </form>
        )}
      </div>
    </Block>
  );
}

// ── signed in ───────────────────────────────────────────────────
type Guarded = (why: string, fn: () => Promise<void>) => Promise<void>;

function Profile({ st, onChanged, guarded }: { st: AccountStatus; onChanged(): Promise<void>; guarded: Guarded }) {
  const [changing, setChanging] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<{ email: string; expires: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    account.emailPending().then((r) => setPending(r.pending)).catch(() => {});
  }, []);
  const me = st.me!;
  return (
    <Block
      title={<span className="flex items-center gap-2"><span className="[overflow-wrap:anywhere]" data-account-email>{me.email}</span>{me.admin && <span className="rounded-full bg-highlight/15 px-2 py-0.5 text-[11px] font-medium text-highlight">Reviewer</span>}</span>}
      description={<>Account since {date(me.created)} · <span className="font-mono text-[12px]">{st.server.replace(/^https?:\/\//, "")}</span></>}
      aside={
        <Button variant="outline" size="sm" className="h-10 gap-1.5 md:h-8" disabled={busy} onClick={async () => {
          setBusy(true);
          await account.signout().catch(() => {});
          toast.success("Signed out on this device");
          await onChanged();
          setBusy(false);
        }}>
          <LogOut className="size-4" /> Sign out
        </Button>
      }
      stackAside
    >
      {pending && !changing && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Waiting for confirmation from <span className="text-foreground/90">{pending.email}</span>.</span>
          <button className="underline underline-offset-2 hover:text-foreground" onClick={() => setChanging(true)}>Enter the code</button>
          <button className="underline underline-offset-2 hover:text-foreground" onClick={async () => (await account.emailCancel().catch(() => {}), setPending(null))}>Cancel</button>
        </div>
      )}
      {!changing && !pending && (
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 h-10 gap-1.5 text-muted-foreground md:h-8" onClick={() => setChanging(true)}>
            <Mail className="size-4" /> Change email
          </Button>
        </div>
      )}
      {changing && (
        <div className="flex flex-col gap-3 rounded-lg border p-3.5">
          {!pending ? (
            <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => (e.preventDefault(), void guarded("change your email", async () => {
              await account.emailStart(newEmail.trim());
              setPending({ email: newEmail.trim(), expires: "" });
              toast.success("Check the new inbox", { description: "A confirmation link went to the new address." });
            }))}>
              <TextInput label="New email" type="email" value={newEmail} onChange={setNewEmail} autoComplete="email" />
              <Button type="submit" size="sm" className="h-10 md:h-9" disabled={!newEmail.trim()}>Send link</Button>
              <Button type="button" variant="ghost" size="sm" className="h-10 md:h-9" onClick={() => setChanging(false)}>Cancel</Button>
            </form>
          ) : (
            <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => (e.preventDefault(), void guarded("change your email", async () => {
              const r = await account.emailVerify(code);
              toast.success("Email changed", { description: r.email });
              setPending(null);
              setChanging(false);
              setCode("");
              await onChanged();
            }))}>
              <TextInput label={`Code sent to ${pending.email}`} value={code} onChange={setCode} mono />
              <Button type="submit" size="sm" className="h-10 md:h-9" disabled={!code.trim()}>Confirm</Button>
              <Button type="button" variant="ghost" size="sm" className="h-10 md:h-9" onClick={() => setChanging(false)}>Later</Button>
            </form>
          )}
        </div>
      )}
    </Block>
  );
}

function Passkeys({ rpId, guarded }: { rpId?: string; guarded: Guarded }) {
  const [list, setList] = useState<Passkey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => account.passkeys().then((r) => setList(r.passkeys)).catch((e) => setError(msg(e))), []);
  useEffect(() => void load(), [load]);
  const here = passkeysHere(rpId);
  return (
    <Block
      title="Passkeys"
      description={here ? "Sign in with your fingerprint, face or device PIN instead of an email code." : `Passkeys for this account belong to ${rpId ?? "the server"}, so they can be added from the Etude app or etude.study.`}
      aside={here ? (
        <Button variant="outline" size="sm" className="h-10 gap-1.5 md:h-8" onClick={() => void guarded("add a passkey", async () => {
          const o = await account.passkeyRegisterOptions();
          await account.passkeyRegisterVerify({ challengeId: o.challengeId, response: await createPasskey(o.options), name: navigator.platform || "Passkey" });
          toast.success("Passkey added");
          await load();
        })}>
          <KeyRound className="size-4" /> Add a passkey
        </Button>
      ) : undefined}
    >
      {error && <Notice>{error}</Notice>}
      {list === null ? <Skeleton className="h-8 w-full" /> : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No passkeys yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {list.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
              <KeyRound className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{p.name}</div>
                <div className="text-xs text-muted-foreground">Added {date(p.created)}{p.lastUsed ? ` · used ${relative(p.lastUsed)}` : ""}{p.backedUp ? " · synced" : ""}</div>
              </div>
              <Button variant="ghost" size="sm" className="h-10 text-muted-foreground md:h-8" onClick={() => void guarded("remove a passkey", async () => (await account.removePasskey(p.id), await load()))}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

function Devices({ guarded, onSelfRevoked }: { guarded: Guarded; onSelfRevoked(): Promise<void> }) {
  const [list, setList] = useState<Device[] | null>(null);
  const load = useCallback(() => account.devices().then((r) => setList(r.devices)).catch(() => setList([])), []);
  useEffect(() => void load(), [load]);
  return (
    <Block title="Devices" description="Everything signed in to this account. Signing a device out stops its Sync and library right away.">
      {list === null ? <Skeleton className="h-8 w-full" /> : (
        <ul className="divide-y rounded-lg border" data-devices>
          {list.map((d) => {
            const Icon = /iphone|android|phone/i.test(d.name) ? Smartphone : Laptop;
            return (
              <li key={d.id} className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{d.name}{d.current && <span className="ml-2 text-xs text-highlight">This device</span>}</div>
                  <div className="text-xs text-muted-foreground">Signed in {date(d.created)} with {d.via === "passkey" ? "a passkey" : "an email code"} · active {relative(d.lastSeen)}</div>
                </div>
                <Button variant="ghost" size="sm" className="h-10 text-muted-foreground md:h-8" onClick={() => void guarded("sign out another device", async () => {
                  await account.revokeDevice(d.id);
                  toast.success(d.current ? "Signed out on this device" : `Signed out ${d.name}`);
                  if (d.current) await onSelfRevoked();
                  else await load();
                })}>
                  {d.current ? "Sign out" : "Revoke"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Block>
  );
}

function SellingLink() {
  return (
    <Block
      title="Selling decks"
      description={isNativeApp() ? "Creators manage their listings from the desktop app or etude.study." : "List a deck from your collection on the paid Market. You keep 80% of each sale."}
      aside={isNativeApp() ? undefined : <Button variant="outline" size="sm" className="h-10 md:h-8" onClick={() => navigate("/market?tab=selling")}>Open Selling</Button>}
    />
  );
}

/** Deleting always asks for a fresh sign-in first (the server requires one within 10 minutes). */
function DataAndDeletion({ st, confirmFresh, onDeleted }: { st: AccountStatus; confirmFresh(why: string, fn: () => Promise<void>): void; onDeleted(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const email = st.me!.email;
  const matches = typed.trim().toLowerCase() === email.toLowerCase();
  return (
    <Block title="Your data" description="Download what the server holds about you, or delete the account. Your collection on this device is not affected either way.">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className="h-10 md:h-8" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            download(`etude-account-${new Date().toISOString().slice(0, 10)}.json`, await account.exportData());
          } catch (e) {
            toast.error("Export failed", { description: msg(e) });
          } finally {
            setBusy(false);
          }
        }}>Export my data</Button>
        <Button variant="ghost" size="sm" className="h-10 gap-1.5 text-destructive hover:text-destructive md:h-8" onClick={() => (setTyped(""), setOpen(true))}>
          <Trash2 className="size-4" /> Delete account
        </Button>
      </div>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your Etude account?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm text-muted-foreground">
                <p>This removes the account, every signed-in device, your passkeys and the encrypted Sync copy on the server, and ends access to decks you bought. A Sync subscription should be canceled first. Orders are kept without your name for tax records.</p>
                <p>The collection on this device stays.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <TextInput label={`Type ${email} to confirm`} value={typed} onChange={setTyped} autoComplete="off" />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={!matches || busy} data-delete-confirm onClick={() => {
              const confirmText = typed;
              setOpen(false);
              confirmFresh("delete the account", async () => {
                setBusy(true);
                try {
                  await account.deleteAccount(confirmText);
                  toast.success("Account deleted");
                  await onDeleted();
                } finally {
                  setBusy(false);
                }
              });
            }}>
              {busy && <Loader2 className="size-4 animate-spin" />} Delete account
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Block>
  );
}

/** "Confirm it's you": a fresh email code or passkey on this device, then the action runs again. */
function ReauthDialog({ email, rpId, why, onClose, onConfirmed }: { email: string; rpId?: string; why: string; onClose(): void; onConfirmed(): Promise<void> }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm it's you</DialogTitle>
          <DialogDescription>To {why}, sign in again on this device. It counts for 10 minutes.</DialogDescription>
        </DialogHeader>
        {sent && <TextInput label={`Code sent to ${email}`} value={code} onChange={setCode} mono autoComplete="one-time-code" />}
        {error && <Notice>{error}</Notice>}
        <DialogFooter className="gap-2">
          {passkeysHere(rpId) && (
            <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
              const o = await account.passkeyLoginOptions();
              await account.passkeyLoginVerify({ challengeId: o.challengeId, response: await getPasskey(o.options) });
              await onConfirmed();
            })}>
              <Fingerprint className="size-4" /> Passkey
            </Button>
          )}
          {!sent ? (
            <Button disabled={busy} onClick={() => void run(async () => (await account.signin(email), setSent(true)))}>Email me a code</Button>
          ) : (
            <Button disabled={busy || !code.trim()} onClick={() => void run(async () => (await account.verify(code), await onConfirmed()))}>
              {busy && <Loader2 className="size-4 animate-spin" />} Confirm
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-destructive/40 px-3.5 py-3 text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 break-words text-destructive">{children}</div>
    </div>
  );
}

export function TextInput({ label, hint, value, onChange, type = "text", placeholder, autoComplete, mono }: {
  label: string;
  hint?: ReactNode;
  value: string;
  onChange(v: string): void;
  type?: "text" | "email" | "password";
  placeholder?: string;
  autoComplete?: string;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id} className="min-w-0 flex-1">
      <Input id={id} type={type} value={value} placeholder={placeholder} autoComplete={autoComplete} autoCapitalize="none" spellCheck={false} className={cn("h-10 md:h-9", mono && "font-mono text-[13px] md:text-[13px]")} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}
