// Etude Sync plans from the store, in the iOS app (App Store) and the Android app (Google Play), via
// lib/storekit.ts. Prices, names and periods come from the store, localized for the person's country;
// nothing here is hard-coded. Apple asks for the plan's name, length and price, the auto-renewal
// terms, Terms and Privacy links, and a way to restore purchases next to the buy button (App Store
// Review Guideline 3.1.2); Google Play's subscription policy asks for the same terms and for how to cancel.
import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { openOutside } from "@/lib/account";
import { buy, loadProducts, manageSubscriptions, periodLabel, restore, storeSource, unavailableHere, type StoreProduct } from "@/lib/storekit";

export const TERMS_URL = "https://etude.study/terms";
export const PRIVACY_URL = "https://etude.study/privacy";

/** The words that change between the two stores. */
function storeWords() {
  if (storeSource() === "google")
    return {
      store: "Google Play",
      account: "Google Play account",
      manage: "Manage or cancel it anytime in the Play Store: Payments & subscriptions → Subscriptions.",
      none: "No Etude Sync subscription on this Google account.",
      ended: "The Google Play subscription on this Google account has ended.",
    };
  return {
    store: "The App Store",
    account: "Apple Account",
    manage: "Manage or cancel it anytime in your Apple Account settings.",
    none: "No Etude Sync subscription on this Apple Account.",
    ended: "The App Store subscription on this Apple Account has ended.",
  };
}

const per = (p: StoreProduct) => (p.period ? (p.period.value === 1 ? `/${p.period.unit}` : ` / ${periodLabel(p.period)}`) : "");

/** The plan list with Subscribe and Restore Purchases. `onActive` runs once the server turned Sync on. */
export function AppStorePlans({ productIds, onActive, compact }: { productIds: string[]; onActive(): void | Promise<void>; compact?: boolean }) {
  const [products, setProducts] = useState<StoreProduct[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState<"buy" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const w = storeWords();

  useEffect(() => {
    let live = true;
    loadProducts(productIds)
      .then((ps) => {
        if (!live) return;
        setProducts(ps);
        // Longest period first in the list, and picked by default.
        const longest = [...ps].sort((a, b) => rank(b) - rank(a))[0];
        setPicked((p) => p ?? longest?.id ?? null);
      })
      .catch((e) => {
        if (!live) return;
        setUnavailable(unavailableHere(e));
        setLoadError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [productIds.join(",")]);

  const doBuy = async () => {
    if (!picked) return;
    setBusy("buy");
    setError(null);
    try {
      const r = await buy(picked);
      if (r.status === "purchased") {
        if (r.sync.active) {
          toast.success("Etude Sync is on");
          await onActive();
        } else setError(`${w.store} took the purchase, but Sync isn't on yet. Try Restore Purchases in a moment.`);
      } else if (r.status === "pending") setError("The purchase is waiting for approval. Sync turns on once it's approved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const doRestore = async () => {
    setBusy("restore");
    setError(null);
    try {
      const r = await restore();
      if (r.cancelled) return;
      if (r.active) {
        toast.success("Etude Sync is on");
        await onActive();
      } else if (r.errors.length) setError(r.errors[0]);
      else setError(r.found ? w.ended : w.none);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const list = [...(products ?? [])].sort((a, b) => rank(b) - rank(a));
  const sel = list.find((p) => p.id === picked);
  return (
    <div className="flex flex-col gap-3" data-appstore-plans>
      {products === null && !loadError && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading plans…
        </div>
      )}
      {loadError && <p className={cn("text-sm", unavailable ? "text-muted-foreground" : "text-destructive")} data-plans-unavailable={unavailable || undefined}>{loadError}</p>}
      {products && !products.length && <p className="text-sm text-muted-foreground" data-plans-empty>{w.store} didn't return any plans. Try again later.</p>}
      {!!list.length && (
        <div role="radiogroup" aria-label="Etude Sync plans" className="flex flex-col gap-2">
          {list.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={picked === p.id}
              data-product={p.id}
              onClick={() => setPicked(p.id)}
              className={cn("flex items-center gap-3 rounded-xl border px-4 text-left transition-colors", compact ? "py-2.5" : "py-3.5", picked === p.id ? "border-highlight bg-highlight/5" : "border-border bg-card hover:border-foreground/30")}
            >
              <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border", picked === p.id ? "border-highlight bg-highlight text-background" : "border-muted-foreground/50")}>
                {picked === p.id && <Check className="size-3.5" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium text-foreground">{p.displayName}</span>
                <span className="block text-[13px] text-muted-foreground">{p.period ? `Renews every ${periodLabel(p.period)}` : p.description}</span>
              </span>
              <span className="shrink-0 text-[15px] font-medium tabular-nums text-foreground">
                {p.displayPrice}
                <span className="text-[13px] font-normal text-muted-foreground">{per(p)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <Button className="h-11 rounded-xl text-[15px]" disabled={!sel || !!busy} onClick={() => void doBuy()} data-subscribe>
        {busy === "buy" && <Loader2 className="size-4 animate-spin" />}
        {sel ? `Subscribe · ${sel.displayPrice}${per(sel)}` : "Subscribe"}
      </Button>
      <p className="text-[12px] leading-relaxed text-muted-foreground" data-subscription-terms>
        {sel ? `${sel.displayName}: ${sel.displayPrice} every ${periodLabel(sel.period)}. ` : ""}
        Payment is charged to your {w.account} when you confirm the purchase. The subscription renews automatically at the same price unless you cancel it at least 24 hours before the end of the current period, and the renewal is charged within the 24 hours before the period ends. {w.manage} Sync is linked to the Etude account you're signed in to and works on all your devices.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline disabled:opacity-50" disabled={!!busy} onClick={() => void doRestore()} data-restore>
          {busy === "restore" ? "Restoring…" : "Restore Purchases"}
        </button>
        <button type="button" className="text-muted-foreground underline-offset-4 hover:underline" onClick={() => openOutside(TERMS_URL)}>Terms of Use</button>
        <button type="button" className="text-muted-foreground underline-offset-4 hover:underline" onClick={() => openOutside(PRIVACY_URL)}>Privacy Policy</button>
      </div>
    </div>
  );
}

/** For an account whose Sync came from the App Store: the system's subscription sheet, and Restore Purchases. */
export function AppStoreManage({ onChanged }: { onChanged(): void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" className="h-10" onClick={() => void manageSubscriptions()?.catch((e: Error) => toast.error("Couldn't open subscriptions", { description: e.message }))}>
        Manage subscription
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-10"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await restore();
            if (!r.cancelled) await onChanged();
          } catch (e) {
            toast.error("Couldn't restore", { description: (e as Error).message });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <Loader2 className="size-4 animate-spin" />} Restore Purchases
      </Button>
    </div>
  );
}

const DAYS = { day: 1, week: 7, month: 30, year: 365, unknown: 0 } as const;
const rank = (p: StoreProduct) => (p.period ? DAYS[p.period.unit] * p.period.value : 0);
