// The paid side of the Market: paid deck tiles and their detail, the Library of purchased decks,
// Selling (creator onboarding, listings, sales) and Review for admins.
// Store rule: the iOS and Android apps never sell. They show no prices, no buy buttons and no links
// to buy; only the Library of decks the account already owns.
import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, Check, Download, ExternalLink, Layers, Loader2, RefreshCw, ShoppingBag, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { account, bytes, money, openOutside, type Creator, type LibraryItem, type Listing, type PaidEntry, type Sales } from "@/lib/account";
import { api } from "@/lib/api";
import { canShowPurchases } from "@/lib/platform";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const msg = (e: unknown) => (e instanceof Error ? e.message : "The request failed.");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function SignInFirst({ what }: { what: string }) {
  return (
    <div className="rounded-xl border px-5 py-10 text-center">
      <ShoppingBag className="mx-auto mb-3 size-6 text-muted-foreground" />
      <div className="text-sm font-medium">Sign in to see {what}</div>
      <div className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">Purchased decks and selling are tied to your Etude account.</div>
      <Button variant="outline" size="sm" className="mt-4" onClick={() => navigate("/settings#account")}>Sign in</Button>
    </div>
  );
}

// ── paid tiles in Browse ────────────────────────────────────────
export function PaidCover({ entry, large }: { entry: PaidEntry; large?: boolean }) {
  if (entry.cover)
    return (
      <div className={cn("aspect-[16/10] min-w-0 overflow-hidden rounded-lg bg-[#070707]", large && "rounded-xl")}>
        <img src={entry.cover} alt="" loading="lazy" className="size-full object-contain" />
      </div>
    );
  return (
    <div className={cn("flex aspect-[16/10] min-w-0 flex-col justify-center gap-1.5 overflow-hidden rounded-lg bg-muted/50 p-3.5", large && "rounded-xl p-5")}>
      {(entry.preview.length ? entry.preview : [{ fields: { front: entry.name } }]).slice(0, 2).map((p: any, i: number) => (
        <div key={i} className="truncate rounded-md border bg-card px-3 py-2 font-[Latin_Modern_Roman,CMU_Serif,Georgia,serif] text-[15px] text-card-foreground shadow-sm" style={{ marginLeft: i * 10, opacity: 1 - i * 0.3 }}>
          {String(Object.values(p.fields ?? {})[0] ?? entry.name).replace(/<[^>]+>/g, "")}
        </div>
      ))}
    </div>
  );
}

export function PriceMark({ entry }: { entry: PaidEntry }) {
  if (entry.owned) return <span className="inline-flex items-center gap-1 rounded-full bg-success/12 px-2 py-0.5 text-[11px] font-medium text-success"><BadgeCheck className="size-3" />Owned</span>;
  if (!canShowPurchases()) return null;
  return <span className="rounded-full bg-highlight/15 px-2 py-0.5 text-[11px] font-medium text-highlight tabular-nums" data-price>{money(entry.price, entry.currency)}</span>;
}

export function PaidTile({ entry, onOpen }: { entry: PaidEntry; onOpen(): void }) {
  return (
    <button onClick={onOpen} data-paid={entry.id} className="group flex min-w-0 flex-col gap-3 rounded-xl border p-2 text-left transition-colors hover:border-ring/70 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
      <PaidCover entry={entry} />
      <div className="flex flex-col gap-1 px-1.5 pb-1.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.name}</span>
          <PriceMark entry={entry} />
        </div>
        <div className="line-clamp-2 min-h-[2.5em] text-[13px] leading-snug text-muted-foreground">{entry.description || "Deck"}</div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">Deck · {plural(entry.summary?.items ?? 0, "card")}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">by {entry.author}</span>
        </div>
      </div>
    </button>
  );
}

export function PaidDialog({ entry, signedIn, onClose, onChanged }: { entry: PaidEntry; signedIn: boolean; onClose(): void; onChanged(): void }) {
  const [busy, setBusy] = useState<null | "buy" | "install">(null);
  const buy = async () => {
    if (!signedIn) return navigate("/settings#account");
    setBusy("buy");
    try {
      openOutside((await account.buy(entry.listing)).url);
      toast("Finish the purchase in your browser", { description: "The deck shows up in your Library once it's paid." });
    } catch (e) {
      toast.error("Couldn't start the purchase", { description: msg(e) });
    } finally {
      setBusy(null);
    }
  };
  const install = async () => {
    setBusy("install");
    try {
      const r = await account.install(entry.listing);
      toast.success(r.result === "unchanged" ? "You already have the latest version" : `${r.result === "updated" ? "Updated" : "Installed"} ${entry.name}`, { description: `${r.report.items.created} new, ${r.report.items.updated} updated.` });
      onChanged();
    } catch (e) {
      toast.error("Install failed", { description: msg(e) });
    } finally {
      setBusy(null);
    }
  };
  const s = entry.summary ?? {};
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="market-detail" aria-describedby="paid-about">
        <div className="market-detail-scroll">
          <DialogHeader className="text-left">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-8 text-xs text-muted-foreground [&>span]:whitespace-nowrap">
              <span>Deck</span><span aria-hidden="true">·</span><span>by {entry.author}</span><span aria-hidden="true">·</span><span>v{entry.version}</span>
              <PriceMark entry={entry} />
            </div>
            <DialogTitle className="pr-6 text-2xl leading-tight tracking-tight sm:text-3xl">{entry.name}</DialogTitle>
          </DialogHeader>
          <div className="market-facts">
            <div className="market-fact"><span>Includes</span><strong>{plural(s.items ?? 0, "card")}</strong></div>
            <div className="market-fact"><span>Updates</span><strong>Included</strong></div>
            <div className="market-fact"><span>Download</span><strong>{bytes(entry.bytes)}</strong></div>
            <div className="market-fact"><span>Creator</span><strong>{entry.author}</strong></div>
          </div>
          <div className="mb-6"><PaidCover entry={entry} large /></div>
          <section id="paid-about" className="market-description mb-6">
            <h3 className="mb-3 text-base font-semibold">About this deck</h3>
            <div className="text-sm leading-relaxed whitespace-pre-line text-muted-foreground">{entry.description || "No description yet."}</div>
          </section>
          {entry.preview.length > 0 && (
            <section className="mb-6">
              <h3 className="mb-3 text-base font-semibold">Sample cards</h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                {entry.preview.map((p: any, i: number) => (
                  <li key={i} className="rounded-lg border bg-card px-3 py-2 text-sm">
                    {Object.entries(p.fields ?? {}).slice(0, 2).map(([k, v]) => (
                      <div key={k} className="truncate"><span className="text-xs text-muted-foreground">{k} </span>{String(v).replace(/<[^>]+>/g, "")}</div>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {canShowPurchases() && !entry.owned && <p className="text-xs text-muted-foreground">Prices in US dollars before tax. Sold to buyers in Canada and the United States. Buying gives you every future version.</p>}
        </div>
        <DialogFooter className="flex-row items-center justify-end gap-2 border-t bg-background px-5 py-4">
          {entry.owned ? (
            <Button className="gap-1.5" disabled={!!busy || entry.installed === "installed"} onClick={install}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : entry.installed === "installed" ? <Check className="size-4" /> : <Download className="size-4" />}
              {entry.installed === "installed" ? "Installed" : entry.installed === "update" ? "Update" : "Install"}
            </Button>
          ) : canShowPurchases() ? (
            <Button className="gap-1.5" disabled={!!busy} onClick={buy} data-buy>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
              {signedIn ? `Buy on etude.study · ${money(entry.price, entry.currency)}` : "Sign in to buy"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Paid entries for Browse. Native apps only see decks the account already owns. */
export function usePaidIndex() {
  const [entries, setEntries] = useState<PaidEntry[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [available, setAvailable] = useState(false);
  const load = useCallback(async () => {
    try {
      const st = await account.status();
      setSignedIn(!!st.me);
      if (!st.offering?.market) return setAvailable(false), setEntries([]);
      setAvailable(true);
      const r = await account.market();
      setEntries(canShowPurchases() ? r.entries : r.entries.filter((e) => e.owned));
    } catch {
      setEntries([]);
    }
  }, []);
  useEffect(() => void load(), [load]);
  return { entries, signedIn, available, reload: load };
}

// ── Library ─────────────────────────────────────────────────────
export function LibraryView() {
  const [lib, setLib] = useState<LibraryItem[] | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const st = await account.status();
      setSignedIn(!!st.me);
      if (!st.me) return;
      setLib((await account.library()).library);
      setError(null);
    } catch (e) {
      setError(msg(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  if (signedIn === false) return <SignInFirst what="your library" />;
  if (error) return <div className="rounded-xl border p-6 text-sm text-destructive">{error}</div>;
  if (!lib) return <div className="grid gap-3">{[0, 1].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>;
  if (!lib.length)
    return (
      <div className="rounded-xl border px-5 py-10 text-center text-sm text-muted-foreground" data-library-empty>
        Decks you buy appear here, on every device signed in to your account.
      </div>
    );
  const install = async (l: LibraryItem) => {
    setBusy(l.listing);
    try {
      const r = await account.install(l.listing);
      toast.success(`${r.result === "updated" ? "Updated" : r.result === "unchanged" ? "Already up to date:" : "Installed"} ${l.name}`, { description: `${r.report.items.created} new, ${r.report.items.updated} updated.` });
      await load();
    } catch (e) {
      toast.error("Install failed", { description: msg(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <ul className="flex flex-col gap-3" data-library>
      {lib.map((l) => (
        <li key={l.listing} className="flex items-center gap-4 rounded-xl border p-3" data-library-item={l.slug}>
          <div className="h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-muted">{l.cover ? <img src={l.cover} alt="" className="size-full object-cover" /> : <Layers className="m-auto mt-5 size-6 text-muted-foreground" />}</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{l.name}</div>
            <div className="text-xs text-muted-foreground">
              v{l.version}
              {l.installed === "update" && <span className="text-highlight"> · update from v{l.installedVersion}</span>}
              {l.installed === "update" && l.changelog && <span> · {l.changelog}</span>}
              {l.bytes ? ` · ${bytes(l.bytes)}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {l.installed && <Button variant="outline" size="sm" className="h-10 md:h-8" onClick={() => navigate("/")}>Open</Button>}
            <Button size="sm" className="h-10 gap-1.5 md:h-8" disabled={busy === l.listing || l.installed === "installed"} onClick={() => void install(l)} data-install={l.slug}>
              {busy === l.listing ? <Loader2 className="size-4 animate-spin" /> : l.installed === "installed" ? <Check className="size-4" /> : l.installed === "update" ? <RefreshCw className="size-4" /> : <Download className="size-4" />}
              {l.installed === "installed" ? "Installed" : l.installed === "update" ? "Update" : "Install"}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Selling ─────────────────────────────────────────────────────
const STATUS: Record<Listing["status"], { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
  review: { label: "In review", cls: "bg-warning/15 text-warning" },
  live: { label: "On sale", cls: "bg-success/12 text-success" },
  rejected: { label: "Changes needed", cls: "bg-destructive/12 text-destructive" },
  hidden: { label: "Hidden", cls: "bg-muted text-muted-foreground" },
};
const COUNTRIES = [["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["IE", "Ireland"], ["DE", "Germany"], ["FR", "France"], ["NL", "Netherlands"], ["ES", "Spain"], ["IT", "Italy"], ["PT", "Portugal"], ["SE", "Sweden"], ["CH", "Switzerland"], ["NO", "Norway"]];

export function SellingView() {
  const [state, setState] = useState<{ signedIn: boolean; admin: boolean; creator: Creator | null; listings: Listing[]; sales: Sales | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [country, setCountry] = useState("US");
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [versioning, setVersioning] = useState<Listing | null>(null);
  const load = useCallback(async () => {
    try {
      const st = await account.status();
      if (!st.me) return setState({ signedIn: false, admin: false, creator: null, listings: [], sales: null });
      const { creator } = await account.creator();
      const [listings, sales] = creator ? await Promise.all([account.listings().then((r) => r.listings), account.sales()]) : [[], null];
      setState({ signedIn: true, admin: st.me.admin, creator, listings, sales });
      setError(null);
    } catch (e) {
      setError(msg(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const act = async (name: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(name);
    try {
      await fn();
      if (done) toast.success(done);
      await load();
    } catch (e) {
      toast.error("That didn't work", { description: msg(e) });
    } finally {
      setBusy(null);
    }
  };
  if (error) return <div className="rounded-xl border p-6 text-sm text-destructive">{error}</div>;
  if (!state) return <Skeleton className="h-48 rounded-xl" />;
  if (!state.signedIn) return <SignInFirst what="selling" />;
  const c = state.creator;
  return (
    <div className="flex flex-col gap-6" data-selling>
      {!c ? (
        <div className="rounded-xl border p-5">
          <h3 className="text-base font-semibold">Sell your decks</h3>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">Set a price of US$5 or more. Etude keeps 20% and handles sales tax; you get the rest every month through Stripe once it reaches US$25. Payouts reach the US, Canada, the UK, the EEA and Switzerland.</p>
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              Where you get paid
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger className="h-10 w-56 md:h-9"><SelectValue /></SelectTrigger>
                <SelectContent>{COUNTRIES.map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <Button className="h-10 gap-1.5 md:h-9" disabled={!!busy} onClick={() => void act("start", async () => {
              await account.becomeCreator(country);
              openOutside((await account.onboarding()).url);
            }, "Finish setting up payouts with Stripe")}>
              {busy === "start" ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />} Set up payouts
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3" data-sales>
            <Stat label="Payouts" value={c.payoutsEnabled ? "Ready" : c.detailsSubmitted ? "Under review by Stripe" : "Setup not finished"} tone={c.payoutsEnabled ? "ok" : "warn"} />
            <Stat label="Sales" value={String(state.sales?.totals.count ?? 0)} />
            <Stat label="Your earnings" value={money(state.sales?.totals.earnings ?? 0)} sub={state.sales?.totals.gross ? `of ${money(state.sales.totals.gross)} gross` : undefined} />
          </div>
          <div className="flex flex-wrap gap-2">
            {!c.chargesEnabled && <Button variant="outline" size="sm" className="h-10 gap-1.5 md:h-8" onClick={() => void act("onb", async () => openOutside((await account.onboarding()).url))}><ExternalLink className="size-4" />Finish Stripe setup</Button>}
            {c.detailsSubmitted && <Button variant="outline" size="sm" className="h-10 gap-1.5 md:h-8" onClick={() => void act("dash", async () => openOutside((await account.dashboard()).url))}><ExternalLink className="size-4" />Payouts and tax forms</Button>}
            <Button size="sm" className="h-10 gap-1.5 md:h-8" onClick={() => setCreating(true)} data-new-listing><Upload className="size-4" />List a deck</Button>
          </div>
          {state.listings.length === 0 ? (
            <div className="rounded-xl border px-5 py-8 text-center text-sm text-muted-foreground">No listings yet.</div>
          ) : (
            <ul className="flex flex-col gap-3" data-listings>
              {state.listings.map((l) => (
                <li key={l.id} className="flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center" data-listing={l.slug}>
                  <div className="h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-muted">{l.cover && <img src={l.cover} alt="" className="size-full object-cover" />}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{l.name}</span>
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS[l.status].cls)} data-status={l.status}>{STATUS[l.status].label}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {money(l.price, l.currency)} · {l.version ? `v${l.version} on sale` : "not on sale yet"}{l.pending?.length ? ` · v${l.pending.join(", v")} waiting for review` : ""}
                    </div>
                    {l.reviewNotes && <div className="mt-1 text-xs text-foreground/80">Reviewer: {l.reviewNotes}</div>}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {(l.status === "draft" || l.status === "rejected" || l.status === "hidden") && <Button size="sm" className="h-10 md:h-8" disabled={!!busy} onClick={() => void act("submit" + l.id, () => account.submit(l.id), "Sent for review")} data-submit={l.slug}>Submit for review</Button>}
                    {(l.status === "live" || l.status === "review") && <Button variant="outline" size="sm" className="h-10 md:h-8" disabled={!!busy} onClick={() => setVersioning(l)} data-new-version={l.slug}>Upload new version</Button>}
                    {l.status !== "hidden" && <Button variant="ghost" size="sm" className="h-10 text-muted-foreground md:h-8" disabled={!!busy} onClick={() => void act("hide" + l.id, () => account.hide(l.id), "Taken off sale")}>Hide</Button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {state.sales && state.sales.sales.length > 0 && (
            <div className="overflow-hidden rounded-xl border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-3 py-2 text-left font-medium">Date</th><th className="px-3 py-2 text-left font-medium">Deck</th><th className="px-3 py-2 text-right font-medium">Price</th><th className="px-3 py-2 text-right font-medium">You get</th></tr></thead>
                <tbody>
                  {state.sales.sales.map((s) => (
                    <tr key={s.order} className="border-t">
                      <td className="px-3 py-2 text-muted-foreground">{new Date(s.at).toLocaleDateString()}</td>
                      <td className="max-w-40 truncate px-3 py-2">{state.listings.find((l) => l.id === s.listing)?.name ?? s.listing}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(s.amount, s.currency)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(s.earnings, s.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {state.admin && <ReviewQueue />}
      {creating && <NewListingDialog onClose={() => setCreating(false)} onCreated={() => (setCreating(false), void load())} />}
      {versioning && <NewVersionDialog listing={versioning} onClose={() => setVersioning(null)} onDone={() => (setVersioning(null), void load())} />}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" }) {
  return (
    <div className="rounded-xl border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-lg font-semibold tabular-nums", tone === "ok" && "text-success", tone === "warn" && "text-warning")}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function NewListingDialog({ onClose, onCreated }: { onClose(): void; onCreated(): void }) {
  const decks = useDeckNames();
  const [deck, setDeck] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("10");
  const [cover, setCover] = useState<{ type: string; data: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = Math.round(Number(price) * 100);
  const ok = !!deck && Number.isFinite(cents) && cents >= 500;
  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/webp,image/png,image/jpeg";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 600 * 1024) return setError("The cover must be 600 KB or less.");
      const buf = new Uint8Array(await f.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      setCover({ type: f.type, data: btoa(s), name: f.name });
    };
    input.click();
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await account.createListing({ deck, name: name.trim() || undefined, description, price: cents, cover: cover ? { type: cover.type, data: cover.data } : undefined });
      toast.success("Listing created", { description: "Submit it for review when you're ready." });
      onCreated();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>List a deck</DialogTitle>
          <DialogDescription>Etude exports the deck as it is now. Buyers get later versions you upload, after review.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
            Deck
            <Select value={deck} onValueChange={(v) => (setDeck(v), name || setName(v))}>
              <SelectTrigger className="h-10" data-deck-select><SelectValue placeholder="Choose a deck" /></SelectTrigger>
              <SelectContent>{decks.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">Name<Input className="h-10" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">Description<Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's in it, who it's for, where the material comes from." /></label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              Price (US$)
              <Input className="h-10 w-32 tabular-nums" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} data-price-input />
            </label>
            <div className="pb-2.5 text-xs text-muted-foreground">{ok ? <>You get {money(cents - Math.round(cents * 0.2))} per sale</> : "At least US$5"}</div>
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="sm" className="h-10 md:h-8" onClick={pick}>{cover ? "Change cover" : "Add a cover"}</Button>
            <span className="truncate text-xs text-muted-foreground">{cover ? cover.name : "16:10 image, webp, png or jpg"}</span>
          </div>
          {error && <div className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!ok || busy} onClick={() => void submit()} data-create-listing>{busy && <Loader2 className="size-4 animate-spin" />}Create listing</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useDeckNames() {
  const [decks, setDecks] = useState<string[]>([]);
  useEffect(() => {
    api.decks().then((tree) => setDecks(tree.map((d: any) => d.name).filter((n: string) => n && n !== "Default"))).catch(() => {});
  }, []);
  return decks;
}

function NewVersionDialog({ listing, onClose, onDone }: { listing: Listing; onClose(): void; onDone(): void }) {
  const decks = useDeckNames();
  const [deck, setDeck] = useState("");
  const [changelog, setChangelog] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!deck && decks.includes(listing.name)) setDeck(listing.name);
  }, [decks, deck, listing.name]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New version of {listing.name}</DialogTitle>
          <DialogDescription>The deck is exported again as it is now. Buyers get it after review; the current version stays on sale meanwhile.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
            Deck
            <Select value={deck} onValueChange={setDeck}>
              <SelectTrigger className="h-10"><SelectValue placeholder="Choose a deck" /></SelectTrigger>
              <SelectContent>{decks.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">What changed<Textarea rows={3} value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="Shown to buyers with the update." data-changelog /></label>
          {error && <div className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!deck || busy} data-upload-version onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await account.newVersion(listing.id, { deck, changelog });
              toast.success("New version sent for review");
              onDone();
            } catch (e) {
              setError(msg(e));
            } finally {
              setBusy(false);
            }
          }}>{busy && <Loader2 className="size-4 animate-spin" />}Upload</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Admin review. João approves; the same queue answers at GET /v1/admin/review and `etude account review`. */
function ReviewQueue() {
  const [queue, setQueue] = useState<Listing[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = useCallback(() => account.review().then((r) => setQueue(r.queue)).catch(() => setQueue([])), []);
  useEffect(() => void load(), [load]);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.success(done);
      await load();
    } catch (e) {
      toast.error("That didn't work", { description: msg(e) });
    }
  };
  const count = useMemo(() => queue?.length ?? 0, [queue]);
  return (
    <section className="rounded-xl border p-4" data-review>
      <h3 className="text-base font-semibold">Review queue <span className="text-sm font-normal text-muted-foreground">{count}</span></h3>
      <p className="mt-1 text-xs text-muted-foreground">Check rights to the material, quality, and that the preview is honest. Approving publishes every pending version.</p>
      {!queue ? <Skeleton className="mt-3 h-16" /> : queue.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">Nothing waiting.</p> : (
        <ul className="mt-3 flex flex-col gap-3">
          {queue.map((l) => (
            <li key={l.id} className="flex flex-col gap-2 rounded-lg border p-3" data-review-item={l.slug}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{l.name}</span>
                <span className="text-muted-foreground">{money(l.price)} · {l.pending?.length ? `pending v${l.pending.join(", v")}` : "no new version"} · {l.versions?.at(-1) ? bytes(l.versions.at(-1)!.bytes) : ""}</span>
              </div>
              {l.description && <p className="line-clamp-3 text-xs text-muted-foreground">{l.description}</p>}
              <Input className="h-9" placeholder="Note to the creator (needed to reject)" value={notes[l.id] ?? ""} onChange={(e) => setNotes({ ...notes, [l.id]: e.target.value })} />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void act(() => account.approve(l.id, notes[l.id]), `Approved ${l.name}`)} data-approve={l.slug}>Approve</Button>
                <Button size="sm" variant="outline" disabled={!notes[l.id]?.trim()} onClick={() => void act(() => account.reject(l.id, notes[l.id]), `Sent back ${l.name}`)}>Request changes</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
