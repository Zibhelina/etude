// The paid side of the Market: paid deck tiles and their detail, the Library of purchased decks,
// Selling (creator onboarding, listings, sales) and Review for admins.
// Store rule: the iOS and Android apps never sell. They show no prices, no buy buttons and no links
// to buy; only the Library of decks the account already owns.
import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Check, Download, ExternalLink, Layers, Loader2, RefreshCw, ShoppingBag, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CoverGallery } from "@/components/market-gallery";
import { DetailLayout, niceDate, paragraphs, type InfoCell } from "@/components/market-detail";
import { Comments, socialCells, TileCounts, useEntryStats, Votes } from "@/components/market-social";
import type { EntryCounts } from "@/lib/market-social";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { appleDecks, buyDeck, type AppleDeck } from "@/lib/storekit";
import { account, bytes, IMMEDIATE_ACCESS_TEXT, money, openOutside, type Creator, type LibraryItem, type Listing, type PaidEntry, type RevokedItem, type Sales } from "@/lib/account";
import { etudeFetch } from "@/lib/transport";
import { api } from "@/lib/api";
import { canShowPurchases } from "@/lib/platform";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useFunMode } from "@/lib/fun";
import minimiShop from "@/assets/market/minimi-shop.webp";

const msg = (e: unknown) => (e instanceof Error ? e.message : "The request failed.");
/** Selling needs two-step sign-in (or a passkey): the server answers `two_factor_required` until the account has one. */
const needsTwoFactor = (e: unknown) => (e as { code?: unknown } | null)?.code === "two_factor_required";
const openAccountSettings = () => navigate("/settings#account");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The Selling tab before a Stripe account is set up: what selling means, in three steps, then the setup itself. */
function SellPitch({ again, country, setCountry, busy, disabled, onStart }: { again?: boolean; country?: string; setCountry?(c: string): void; busy: boolean; disabled?: boolean; onStart?(): void }) {
  const fun = useFunMode();
  return (
    <section className="mk-panel mk-sell" data-creator-setup={onStart ? (again ? "again" : "new") : undefined}>
      <div className="min-w-0">
        <div className="mk-eyebrow">Selling</div>
        <h2 className="mk-serif">{again ? "Set up selling again" : "Made a deck people would pay for?"}</h2>
        {again && <p className="mb-4 max-w-prose rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground/90" data-setup-again>Etude now sells through your own Stripe account, so your earlier payout setup no longer works. Set it up once more; your decks stay as they are.</p>}
        <p className="mk-sell-lead">You set the price, from US$5. Etude keeps 20% and Stripe's processing fee comes out of each sale; the rest goes to your own Stripe account. Refunds, disputes and your own sales tax are yours to handle there, and payouts follow your Stripe settings.</p>
        <ol className="mk-steps">
          <li><b>Connect Stripe</b><span>Stripe verifies your identity and holds your bank details; Etude never sees them.</span></li>
          <li><b>List a deck and set a price</b><span>The Etude team looks at it before it goes on sale.</span></li>
          <li><b>People buy it on etude.study</b><span>It works on every device they sign in on, with every version you upload later.</span></li>
        </ol>
        {onStart && setCountry ? (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                Where you live or your business is registered
                <Select value={country} onValueChange={setCountry}>
                  <SelectTrigger className="h-10 w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>{COUNTRIES.map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                </Select>
              </label>
              <Button className="h-10 gap-1.5" disabled={disabled} data-start-selling onClick={onStart}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />} Set up with Stripe
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Open to creators in the US, Canada, the UK, the EEA and Switzerland.</p>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button className="h-10" onClick={() => navigate("/settings#account")}>Sign in to start</Button>
            <span className="text-xs text-muted-foreground">Selling is tied to your Etude account.</span>
          </div>
        )}
      </div>
      {fun && (
        <div className="mk-keeper" aria-hidden="true">
          <div className="mk-bubble">I take my cut in <b>naps</b>.</div>
          <img src={minimiShop} alt="" />
        </div>
      )}
    </section>
  );
}

// ── paid tiles in Browse ────────────────────────────────────────
/** The deck's cover, or its first sample cards when it has none. Fills whatever frame it's put in. */
export function PaidCover({ entry }: { entry: PaidEntry }) {
  if (entry.cover) return <img src={entry.cover} alt="" loading="lazy" className="size-full object-cover" />;
  return (
    <div className="flex size-full min-w-0 flex-col justify-center gap-1.5 overflow-hidden p-4">
      {(entry.preview.length ? entry.preview : [{ fields: { front: entry.name } }]).slice(0, 2).map((p: any, i: number) => (
        <div key={i} className="mk-serif truncate rounded-md border bg-card px-3 py-2 text-[15px] text-card-foreground shadow-sm" style={{ marginLeft: i * 10, opacity: 1 - i * 0.3 }}>
          {String(Object.values(p.fields ?? {})[0] ?? entry.name).replace(/<[^>]+>/g, "")}
        </div>
      ))}
    </div>
  );
}

/** Owned, or the price where purchases may be shown; nothing in the store apps. */
export function PriceMark({ entry }: { entry: PaidEntry }) {
  if (entry.owned) return <span className="mk-state"><BadgeCheck className="size-3.5" />Owned</span>;
  if (!canShowPurchases()) return null;
  return <span className="mk-price paid" data-price>{money(entry.price, entry.currency)}</span>;
}

export function PaidTile({ entry, counts, onOpen }: { entry: PaidEntry; counts?: EntryCounts; onOpen(): void }) {
  const items = entry.summary?.items ?? 0;
  return (
    <button onClick={onOpen} data-paid={entry.id} className="mk-tile">
      <div className="mk-cover" data-hs-anchor><PaidCover entry={entry} /></div>
      <div className="mk-tile-body">
        <div className="mk-tile-title">
          <b>{entry.name}</b>
          {entry.installed === "installed" ? <span className="mk-state"><Check className="size-3.5" strokeWidth={3} />Installed</span> : entry.installed === "update" ? <span className="mk-state update">Update</span> : <PriceMark entry={entry} />}
        </div>
        <p>{firstSentence(entry.description) || "Deck"}</p>
        <div className="mk-tile-meta"><span>{plural(items, "card")}</span><span aria-hidden="true">·</span><span>{entry.author}</span><TileCounts c={counts} /></div>
      </div>
    </button>
  );
}

const firstSentence = (d: string) => {
  let s = (d || "").split(/(?<=[.!?])\s/)[0] ?? "";
  if (s.length > 120) s = s.slice(0, 117).replace(/\s\S*$/, "") + "…";
  return s;
};

/** A paid deck's page in the Market: the same layout as a free entry, with Buy where purchases may be shown. */
export function PaidDetail({ entry, signedIn, onBack, onChanged }: { entry: PaidEntry; signedIn: boolean; onBack(): void; onChanged(): void }) {
  const [busy, setBusy] = useState<null | "buy" | "install">(null);
  const [confirming, setConfirming] = useState(false);
  // In the iPhone app, a deck Etude also sells on the App Store is bought there, at the App Store's price.
  const [apple, setApple] = useState<AppleDeck | null>(null);
  useEffect(() => {
    if (canShowPurchases() || entry.owned) return;
    let live = true;
    appleDecks().then((ds) => { if (live) setApple(ds.find((d) => d.listing === entry.listing && d.product) ?? null); }).catch(() => {});
    return () => { live = false; };
  }, [entry.listing, entry.owned]);
  const buyInApp = async () => {
    if (!apple) return;
    if (!signedIn) return navigate("/settings#account");
    setBusy("buy");
    try {
      const r = await buyDeck(apple.productId);
      if (r.status === "purchased") {
        toast.success(`${entry.name} is yours`, { description: "Install it from here or from your Library." });
        onChanged();
      } else if (r.status === "pending") toast("The purchase is waiting for approval", { description: "It shows up here once the App Store confirms it." });
    } catch (e) {
      toast.error("Couldn't complete the purchase", { description: msg(e) });
    } finally {
      setBusy(null);
    }
  };
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
  const install = async (immediateAccess = false) => {
    if (entry.needsDeliveryConfirmation && !immediateAccess) return setConfirming(true);
    setConfirming(false);
    setBusy("install");
    try {
      const r = await account.install(entry.listing, immediateAccess);
      toast.success(r.result === "unchanged" ? "You already have the latest version" : `${r.result === "updated" ? "Updated" : "Installed"} ${entry.name}`, { description: `${r.report.items.created} new, ${r.report.items.updated} updated.` });
      onChanged();
    } catch (e) {
      toast.error("Install failed", { description: msg(e) });
    } finally {
      setBusy(null);
    }
  };
  const s = entry.summary ?? {};
  const parts: string[] = (s.decks ?? []).filter((d: string) => d.includes("::")).map((d: string) => d.split("::").pop()!);
  const sKey = `paid/${entry.listing}`;
  const [stats, setStats] = useEntryStats(sKey);
  const n = s.items ?? 0;
  const info: InfoCell[] = [
    ...socialCells(stats),
    { label: n === 1 ? "Card" : "Cards", value: n.toLocaleString("en-US") },
    { label: "Updates", value: "Included" },
    { label: "Size", value: bytes(entry.bytes) },
    ...(entry.updated ? [{ label: "Updated", value: niceDate(entry.updated) }] : []),
    { label: "Version", value: `v${entry.version}` },
  ];
  const action = entry.owned ? (
    <>
      <Button className="mk-big gap-1.5" disabled={!!busy || entry.installed === "installed"} onClick={() => void install()}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : entry.installed === "installed" ? <Check className="size-4" /> : <Download className="size-4" />}
        {entry.installed === "installed" ? "Installed" : entry.installed === "update" ? "Update" : "Install"}
      </Button>
      {entry.installed && <Button variant="outline" className="mk-big" onClick={() => navigate("/")}>Open</Button>}
      {confirming && <DeliveryConfirmDialog name={entry.name} onClose={() => setConfirming(false)} onConfirm={() => void install(true)} />}
    </>
  ) : apple?.product ? (
    <Button className="mk-big gap-1.5" disabled={!!busy} onClick={() => void buyInApp()} data-buy-in-app>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <ShoppingBag className="size-4" />}
      {signedIn ? `Buy · ${apple.product.displayPrice}` : "Sign in to buy"}
    </Button>
  ) : canShowPurchases() ? (
    <Button className="mk-big gap-1.5" disabled={!!busy} onClick={buy} data-buy>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
      {signedIn ? `Buy · ${money(entry.price, entry.currency)}` : "Sign in to buy"}
    </Button>
  ) : null;
  return (
    <DetailLayout
      onBack={onBack}
      head={
        <>
          <div className="mk-eyebrow">Deck{canShowPurchases() ? " · paid" : ""}</div>
          <h1 className="mk-serif">{entry.name}</h1>
          <div className="mk-by">by {entry.author}{entry.owned && <span className="mk-pill"><BadgeCheck className="size-3" />Owned</span>}{entry.installed === "update" && <span className="mk-pill update">Update</span>}</div>
        </>
      }
      gallery={<CoverGallery cover={<PaidCover entry={entry} />} />}
      actions={
        <>
          {canShowPurchases() && !entry.owned && (
            <div className="mk-pricebig"><b className="mk-serif">{money(entry.price, entry.currency)}</b><span>once · every future version included</span></div>
          )}
          {action && <div className="mk-actions">{action}</div>}
          <Votes k={sKey} stats={stats} setStats={setStats} signedIn={signedIn} />
          {canShowPurchases() && !entry.owned && <p className="mk-fine">{entry.soldBy === "etude" ? "Prices in US dollars before tax. Sold by Etude through Polar, in every country. Buying gives you every future version." : "Prices in US dollars before tax. Sold to buyers in Canada and the United States. Buying gives you every future version."}</p>}
        </>
      }
      info={info}
    >
      <section id="paid-about" className="mk-sec">
        <h3 className="mk-serif">About this deck</h3>
        {paragraphs(entry.description || "No description yet.").map((p, i) => <p key={i}>{p}</p>)}
      </section>
      {parts.length > 1 && <section className="mk-sec"><h3 className="mk-serif">What's inside</h3><div className="mk-parts">{parts.map((p, i) => <span key={i}>{p}</span>)}</div></section>}
      {entry.preview.length > 0 && (
        <section className="mk-sec">
          <h3 className="mk-serif">Sample cards</h3>
          <ul className="mk-samples">
            {entry.preview.map((p: any, i: number) => (
              <li key={i}>
                {Object.entries(p.fields ?? {}).slice(0, 2).map(([k, v]) => (
                  <div key={k} className="truncate"><span className="text-xs text-muted-foreground">{k} </span>{String(v).replace(/<[^>]+>/g, "")}</div>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      <Comments k={sKey} signedIn={signedIn} onCount={(d) => stats && setStats({ ...stats, comments: Math.max(0, stats.comments + d) })} />
      {entry.tags.length > 0 && <div className="mk-source"><span>{entry.tags.slice(0, 6).map((t) => `#${t}`).join(" ")}</span></div>}
    </DetailLayout>
  );
}

/** Paid entries for Browse. Native apps only see decks the account already owns. */
export function usePaidIndex() {
  const [entries, setEntries] = useState<PaidEntry[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [available, setAvailable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    try {
      const st = await account.status();
      setSignedIn(!!st.me);
      if (!st.offering?.market) return setAvailable(false), setEntries([]);
      setAvailable(true);
      const r = await account.market();
      // The iPhone app sells the decks Etude also sells on the App Store; elsewhere in the store apps only owned decks show.
      const ios = canShowPurchases() ? [] : await appleDecks().catch(() => []);
      setEntries(canShowPurchases() ? r.entries : r.entries.filter((e) => e.owned || ios.some((d) => d.listing === e.listing && d.product)));
    } catch {
      setEntries([]);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  return { entries, signedIn, available, loaded, reload: load };
}

// ── Library ─────────────────────────────────────────────────────
/** Decks the account owns, as the "Bought" section of the Market's Yours tab. */
export function LibraryView() {
  const [lib, setLib] = useState<LibraryItem[] | null>(null);
  const [revoked, setRevoked] = useState<RevokedItem[]>([]);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const st = await account.status();
      setSignedIn(!!st.me);
      if (!st.me) return;
      const r = await account.library();
      setLib(r.library);
      setRevoked(r.revoked ?? []);
      for (const name of r.changes?.locked ?? []) toast(`${name} was refunded`, { description: "Its cards are suspended. Buy it again to study them; your progress is kept." });
      setError(null);
    } catch (e) {
      setError(msg(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const [confirming, setConfirming] = useState<LibraryItem | null>(null);
  const install = async (l: LibraryItem, immediateAccess = false) => {
    if (l.needsDeliveryConfirmation && !immediateAccess) return setConfirming(l);
    setConfirming(null);
    setBusy(l.listing);
    try {
      const r = await account.install(l.listing, immediateAccess);
      toast.success(`${r.result === "updated" ? "Updated" : r.result === "unchanged" ? "Already up to date:" : "Installed"} ${l.name}`, { description: `${r.report.items.created} new, ${r.report.items.updated} updated.` });
      await load();
    } catch (e) {
      toast.error("Install failed", { description: msg(e) });
    } finally {
      setBusy(null);
    }
  };
  const head = (
    <div className="mk-lhead">
      <span>Bought{lib && lib.length > 0 && <i>{lib.length}</i>}</span>
      <small>Tied to your Etude account, on every device.</small>
    </div>
  );
  let body: React.ReactNode;
  if (signedIn === false)
    body = (
      <div className="mk-li">
        <div className="mk-li-thumb"><ShoppingBag className="size-5" /></div>
        <div className="mk-li-text"><b>Sign in to see your decks</b><small>Purchased decks are tied to your Etude account.</small></div>
        <button className="mk-get" onClick={() => navigate("/settings#account")}>Sign in</button>
      </div>
    );
  else if (error) body = <div className="px-3 py-3 text-sm text-destructive">{error}</div>;
  else if (!lib) body = <Skeleton className="h-16 rounded-lg" />;
  else if (!lib.length && !revoked.length)
    body = (
      <div className="px-3 py-3 text-sm text-muted-foreground" data-library-empty>
        {canShowPurchases() ? "Decks you buy appear here, on every device signed in to your account." : "Decks on your Etude account appear here."}
      </div>
    );
  else
    body = [...lib.map((l) => (
      <div key={l.listing} className="mk-li" data-library-item={l.slug}>
        <div className="mk-li-thumb">{l.cover ? <img src={l.cover} alt="" /> : <Layers className="size-5" />}</div>
        <div className="mk-li-text">
          <b>{l.name}</b>
          <small>
            v{l.version}
            {l.installed === "update" && <em> · update from v{l.installedVersion}</em>}
            {l.installed === "update" && l.changelog && <span> · {l.changelog}</span>}
            {l.bytes ? ` · ${bytes(l.bytes)}` : ""}
          </small>
        </div>
        <div className="mk-li-acts">
          {l.installed && <button className="mk-get ghost" onClick={() => navigate("/")}>Open</button>}
          {l.installed !== "installed" && (
            <button className="mk-get" disabled={busy === l.listing} onClick={() => void install(l)} data-install={l.slug}>
              {busy === l.listing ? <Loader2 className="size-4 animate-spin" /> : l.installed === "update" ? <RefreshCw className="size-3.5" /> : <Download className="size-3.5" />}
              {l.installed === "update" ? "Update" : "Install"}
            </button>
          )}
        </div>
      </div>
    )), ...revoked.map((r) => (
      // Refunded or disputed: no longer on the account. Its cards stay in the collection, suspended, with their history.
      <div key={`revoked-${r.listing}`} className="mk-li opacity-70" data-library-revoked={r.slug}>
        <div className="mk-li-thumb">{r.cover ? <img src={r.cover} alt="" /> : <Layers className="size-5" />}</div>
        <div className="mk-li-text">
          <b>{r.name}</b>
          <small>{r.reason === "disputed" ? "Payment disputed" : "Refunded"}{r.locked ? " · its cards are suspended; buy it again to study them" : ""}</small>
        </div>
      </div>
    ))];
  return (
    <section className="mk-lsec" data-library>
      {head}
      <div className="mk-panel mk-list">{body}</div>
      {confirming && <DeliveryConfirmDialog name={confirming.name} onClose={() => setConfirming(null)} onConfirm={() => void install(confirming, true)} />}
    </section>
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
  const [editing, setEditing] = useState<Listing | null>(null);
  const [server, setServer] = useState("");
  const load = useCallback(async () => {
    try {
      const st = await account.status();
      setServer(st.server);
      if (!st.me) return setState({ signedIn: false, admin: false, creator: null, listings: [], sales: null });
      const { creator } = await account.creator();
      const [listings, sales] = creator ? await Promise.all([account.listings().then((r) => r.listings), account.sales()]) : [[], null];
      setState({ signedIn: true, admin: st.me.admin, creator, listings, sales });
      if (creator?.setupRequired && COUNTRIES.some(([k]) => k === creator.country)) setCountry(creator.country);
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
      toast.error(needsTwoFactor(e) ? "Turn on two-step sign-in to sell" : "That didn't work", { description: msg(e), ...(needsTwoFactor(e) ? { action: { label: "Open Settings", onClick: openAccountSettings } } : {}) });
    } finally {
      setBusy(null);
    }
  };
  if (error) return <div className="rounded-xl border p-6 text-sm text-destructive">{error}</div>;
  if (!state) return <Skeleton className="h-48 rounded-xl" />;
  const start = () => void act("start", async () => {
    await account.becomeCreator(country);
    openOutside((await account.onboarding()).url);
  }, "Finish setting up your Stripe account in the browser");
  if (!state.signedIn) return <SellPitch busy={false} />;
  const c = state.creator;
  return (
    <div className="flex flex-col gap-6" data-selling>
      {!c || c.setupRequired ? <SellPitch again={!!c} country={country} setCountry={setCountry} busy={busy === "start"} disabled={!!busy} onStart={start} /> : null}
      {c && (
        <>
          <div className="grid gap-3 sm:grid-cols-3" data-sales>
            <Stat label="Stripe account" value={c.setupRequired ? "Set up again" : c.chargesEnabled ? "Ready to sell" : c.detailsSubmitted ? "Under review by Stripe" : "Setup not finished"} tone={c.chargesEnabled && !c.setupRequired ? "ok" : "warn"} />
            <Stat label="Sales" value={String(state.sales?.totals.count ?? 0)} />
            <Stat label="Your earnings" value={money(state.sales?.totals.earnings ?? 0)} sub={state.sales?.totals.gross ? `of ${money(state.sales.totals.gross)} gross, before Stripe's fees` : "after Etude's 20%, before Stripe's fees"} />
          </div>
          <div className="flex flex-wrap gap-2">
            {!c.setupRequired && !c.chargesEnabled && <Button variant="outline" size="sm" className="phone:h-10 gap-1.5 h-8" onClick={() => void act("onb", async () => openOutside((await account.onboarding()).url))}><ExternalLink className="size-4" />Finish Stripe setup</Button>}
            {!c.setupRequired && c.detailsSubmitted && <Button variant="outline" size="sm" className="phone:h-10 gap-1.5 h-8" onClick={() => void act("dash", async () => openOutside((await account.dashboard()).url))} data-stripe-dashboard><ExternalLink className="size-4" />Open Stripe dashboard</Button>}
            {!c.setupRequired && <Button size="sm" className="phone:h-10 gap-1.5 h-8" onClick={() => setCreating(true)} data-new-listing><Upload className="size-4" />List a deck</Button>}
          </div>
          {!c.setupRequired && c.detailsSubmitted && <p className="-mt-3 text-xs text-muted-foreground">Sign in to the Stripe Dashboard with the Stripe login you made during setup. Refunds, disputes and payouts are managed there.</p>}
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
                    {/* Notes on the listing itself matter while it isn't on sale; after that, versions and page changes carry their own. */}
                    {l.reviewNotes && l.status === "rejected" && <div className="mt-1 text-xs text-foreground/80">Reviewer: {l.reviewNotes}</div>}
                    <VersionNote l={l} />
                    {l.revision && <ChangesNote l={l} busy={!!busy} onEdit={() => setEditing(l)} onWithdraw={() => void act("withdraw" + l.id, () => account.withdrawChanges(l.id), "Changes withdrawn")} />}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {(l.status === "draft" || l.status === "rejected" || l.status === "hidden") && <Button size="sm" className="phone:h-10 h-8" disabled={!!busy} onClick={() => void act("submit" + l.id, () => account.submit(l.id), "Sent for review")} data-submit={l.slug}>Submit for review</Button>}
                    {(l.status === "live" || l.status === "review") && <Button variant="outline" size="sm" className="phone:h-10 h-8" disabled={!!busy} onClick={() => setVersioning(l)} data-new-version={l.slug}>Upload new version</Button>}
                    <Button variant="outline" size="sm" className="phone:h-10 h-8" disabled={!!busy} onClick={() => setEditing(l)} data-edit-listing={l.slug}>Edit page</Button>
                    {l.status !== "hidden" && <Button variant="ghost" size="sm" className="phone:h-10 text-muted-foreground h-8" disabled={!!busy} onClick={() => void act("hide" + l.id, () => account.hide(l.id), "Taken off sale")}>Hide</Button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {state.sales && state.sales.sales.length > 0 && (
            <div className="overflow-hidden rounded-xl border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-3 py-2 text-left font-medium">Date</th><th className="px-3 py-2 text-left font-medium">Deck</th><th className="px-3 py-2 text-right font-medium">Price</th><th className="px-3 py-2 text-right font-medium" title="After Etude's 20%, before Stripe's processing fee">Yours</th></tr></thead>
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
              <div className="border-t px-3 py-2 text-xs text-muted-foreground">Yours: after Etude's 20%, before Stripe's processing fee.</div>
            </div>
          )}
        </>
      )}
      {state.admin && <ReviewQueue server={server} />}
      {creating && <NewListingDialog onClose={() => setCreating(false)} onCreated={() => (setCreating(false), void load())} />}
      {versioning && <NewVersionDialog listing={versioning} onClose={() => setVersioning(null)} onDone={() => (setVersioning(null), void load())} />}
      {editing && <EditListingDialog listing={editing} onClose={() => setEditing(null)} onDone={() => (setEditing(null), void load())} />}
    </div>
  );
}

const FIELD: Record<string, string> = { name: "name", description: "description", tags: "tags", preview: "preview cards", price: "price", cover: "cover" };
const coverHash = (url: string | null | undefined) => url?.match(/[0-9a-f]{64}$/)?.[0] ?? null;

/** A cover that isn't public yet (waiting for review): fetched with the account's token through the app's server. */
function PrivateCover({ url, className }: { url: string | null; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const hash = coverHash(url);
    if (!hash) return;
    let objectUrl: string | null = null;
    let live = true;
    etudeFetch(`/api/account/covers/${hash}`)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b && live) setSrc((objectUrl = URL.createObjectURL(b)));
      })
      .catch(() => {});
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  return <div className={cn("overflow-hidden rounded-md bg-muted", className)}>{src && <img src={src} alt="" className="size-full object-cover" />}</div>;
}

/** The newest pack version, when it was turned down: the reviewer's notes. */
function VersionNote({ l }: { l: Listing }) {
  const last = l.versions?.at(-1);
  if (!last || last.status !== "rejected" || !last.reviewNotes) return null;
  return <div className="mt-1 text-xs text-destructive" data-version-rejected={last.version}>v{last.version} wasn't approved: <span className="text-foreground/80">{last.reviewNotes}</span></div>;
}

/** Page changes waiting for review, or the last ones turned down, under a listing. */
function ChangesNote({ l, busy, onEdit, onWithdraw }: { l: Listing; busy: boolean; onEdit(): void; onWithdraw(): void }) {
  const r = l.revision!;
  const what = r.changed.map((k) => FIELD[k] ?? k).join(", ");
  const detail = r.changed.includes("price") ? ` (${money(l.price, l.currency)} → ${money(r.price, l.currency)})` : "";
  if (r.status === "pending")
    return (
      <div className="mt-2 flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs sm:flex-row sm:items-center" data-changes-pending>
        {r.changed.includes("cover") && <PrivateCover url={r.cover} className="h-10 w-16 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="font-medium text-warning">Changes waiting for review</div>
          <div className="text-foreground/80">New {what}{detail}. Buyers still see the approved page until the Etude team approves this.</div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button variant="outline" size="sm" className="h-7 phone:h-9" disabled={busy} onClick={onEdit}>Edit</Button>
          <Button variant="ghost" size="sm" className="h-7 phone:h-9 text-muted-foreground" disabled={busy} onClick={onWithdraw}>Withdraw</Button>
        </div>
      </div>
    );
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs sm:flex-row sm:items-center" data-changes-rejected>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-destructive">Your changes to the {what} weren't approved</div>
        <div className="text-foreground/80">Reviewer: {r.reviewNotes}</div>
        <div className="text-muted-foreground">Buyers see the approved page, as before.</div>
      </div>
      <Button variant="outline" size="sm" className="h-7 phone:h-9 shrink-0" disabled={busy} onClick={onEdit}>Edit again</Button>
    </div>
  );
}

/** Edit the Market page. After a listing has been on sale, the edit goes to review and buyers keep the approved page. */
function EditListingDialog({ listing, onClose, onDone }: { listing: Listing; onClose(): void; onDone(): void }) {
  // The form starts from the changes waiting or turned down; what's sent is compared with what the server builds on:
  // the pending revision when there is one, otherwise the approved page (so a re-edit after a rejection resends them).
  const base = listing.revision ?? listing;
  const server = listing.revision?.status === "pending" ? listing.revision : listing;
  const [name, setName] = useState(base.name);
  const [description, setDescription] = useState(base.description);
  const [tags, setTags] = useState(base.tags.join(", "));
  const [price, setPrice] = useState(String(base.price / 100));
  const [cover, setCover] = useState<{ type: string; data: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewed = !!listing.liveAt;
  const cents = Math.round(Number(price) * 100);
  const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
  const patch: { name?: string; description?: string; tags?: string[]; price?: number } = {};
  if (name.trim() !== server.name) patch.name = name.trim();
  if (description !== server.description) patch.description = description;
  if (tagList.join(",").toLowerCase() !== server.tags.join(",")) patch.tags = tagList;
  if (cents !== server.price) patch.price = cents;
  const changed = name.trim() !== base.name || description !== base.description || tagList.join(",").toLowerCase() !== base.tags.join(",") || cents !== base.price || !!cover || (base !== server && Object.keys(patch).length > 0);
  const ok = name.trim().length >= 2 && Number.isFinite(cents) && cents >= 500 && changed;
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
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (Object.keys(patch).length) await account.updateListing(listing.id, patch);
      if (cover) await account.setCover(listing.id, { type: cover.type, data: cover.data });
      toast.success(reviewed ? "Changes sent for review" : "Listing updated", reviewed ? { description: "Buyers see the approved page until the Etude team approves them." } : undefined);
      onDone();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" data-edit-dialog>
        <DialogHeader>
          <DialogTitle>Edit {listing.name}</DialogTitle>
          <DialogDescription>
            {reviewed
              ? "Every change to a deck on the Market is checked by the Etude team first. Until it's approved, buyers see the page as it is now."
              : "This listing hasn't been on sale yet, so changes apply right away. It's reviewed when you submit it."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {listing.revision?.status === "pending" && <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground/80">You're editing the changes already waiting for review. Buyers still see {money(listing.price, listing.currency)} and the current page.</div>}
          {listing.revision?.status === "rejected" && <div className="rounded-lg border border-destructive/40 px-3 py-2 text-xs text-foreground/80">Reviewer: {listing.revision.reviewNotes}</div>}
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">Name<Input className="h-10" value={name} onChange={(e) => setName(e.target.value)} data-edit-name /></label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">Description<Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} data-edit-description /></label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">Tags<Input className="h-10" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. medicine, pharmacology" /></label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              Price (US$)
              <Input className="h-10 w-32 tabular-nums" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} data-edit-price />
            </label>
            <div className="pb-2.5 text-xs text-muted-foreground">{Number.isFinite(cents) && cents >= 500 ? <>You keep {money(cents - Math.round(cents * 0.2))} per sale, less Stripe's fee</> : "At least US$5"}</div>
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="sm" className="phone:h-10 h-8" onClick={pick}>New cover</Button>
            <span className="truncate text-xs text-muted-foreground">{cover ? cover.name : "16:10 image, webp, png or jpg"}</span>
          </div>
          {error && <div className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!ok || busy} onClick={() => void save()} data-save-listing>{busy && <Loader2 className="size-4 animate-spin" />}{reviewed ? "Send for review" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
            <div className="pb-2.5 text-xs text-muted-foreground">{ok ? <>You keep {money(cents - Math.round(cents * 0.2))} per sale, less Stripe's fee</> : "At least US$5"}</div>
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="sm" className="phone:h-10 h-8" onClick={pick}>{cover ? "Change cover" : "Add a cover"}</Button>
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

/**
 * Admin review. The review itself happens on the server's review screen (/account/admin/review), which shows both
 * copies of each page, the automatic flags and the pack diff, and approves the exact hashes it showed. This lists what
 * is waiting and opens it there; `etude account review` gives the same queue.
 */
function ReviewQueue({ server }: { server: string }) {
  const [queue, setQueue] = useState<any[] | null>(null);
  const load = useCallback(() => account.review().then((r) => setQueue(r.queue)).catch(() => setQueue([])), []);
  useEffect(() => void load(), [load]);
  const open = (path: string) => openOutside(`${server.replace(/\/$/, "")}/account/admin/review${path}`);
  const what = (l: any) => [l.review?.submission ? (l.review.submission.firstReview ? "new deck" : "resubmitted") : null, ...(l.review?.versions ?? []).map((v: any) => `pack v${v.version}`), l.review?.revision ? `page: ${l.review.revision.changed.map((k: string) => FIELD[k] ?? k).join(", ")}` : null].filter(Boolean).join(" · ");
  return (
    <section className="rounded-xl border p-4" data-review>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">Review queue <span className="text-sm font-normal text-muted-foreground">{queue?.length ?? 0}</span></h3>
        <Button variant="outline" size="sm" className="phone:h-10 gap-1.5 h-8" onClick={() => open("")}><ExternalLink className="size-4" />Open review screen</Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">New decks, new versions and page changes all wait here. The review screen shows the before and after, the automatic flags and the card-type code that changed.</p>
      {!queue ? <Skeleton className="mt-3 h-16" /> : queue.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">Nothing waiting.</p> : (
        <ul className="mt-3 flex flex-col gap-2">
          {queue.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm" data-review-item={l.slug}>
              <span className="font-medium">{l.name}</span>
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">{what(l)}</span>
              <Button size="sm" className="h-7 phone:h-9" onClick={() => open(`/${encodeURIComponent(l.id)}`)}>Review</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Before the first download of a deck sold by Etude: the buyer asks for it to be delivered now and acknowledges that,
 * once it is, they can no longer cancel where the law allows that (EU/UK right of withdrawal). The text comes from the
 * server (marketRules.immediateAccess), with a built-in copy as the fallback. The server won't hand out the deck before.
 */
function DeliveryConfirmDialog({ name, onClose, onConfirm }: { name: string; onClose(): void; onConfirm(): void }) {
  const [ok, setOk] = useState(false);
  const [text, setText] = useState(IMMEDIATE_ACCESS_TEXT);
  useEffect(() => {
    let live = true;
    account.status().then((st) => { const t = st.offering?.marketRules?.immediateAccess?.text; if (live && t) setText(t); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-delivery-dialog>
        <DialogHeader>
          <DialogTitle>Download {name}</DialogTitle>
          <DialogDescription>Until you download it, you can still cancel this purchase where the law gives you that right. We email you a copy of this confirmation.</DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm" data-immediate-access>
          <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-current" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>{text}</span>
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!ok} onClick={onConfirm} data-confirm-delivery><Download className="size-4" />Download</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
