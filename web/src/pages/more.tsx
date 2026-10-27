// Phone only: the fifth tab. The places you visit less (card types, the Market, Settings) plus the
// import and the update, so the tab bar can stay at four tabs and the ε.
import { useEffect } from "react";
import { Blocks, ChevronRight, CircleArrowUp, Settings, Store } from "lucide-react";
import { navigate } from "@/lib/router";
import { usePhone } from "@/lib/phone";
import { PhoneTitle } from "@/components/phone-shell";
import { Logo, Wordmark } from "@/components/logo";
import { useUpdater } from "@/components/update-bar";
import { ImportButton } from "@/pages/decks";

export function MorePage() {
  const phone = usePhone();
  // On a wide screen everything here is in the sidebar already.
  useEffect(() => {
    if (!phone) navigate("/settings", { replace: true });
  }, [phone]);
  const { st, behind } = useUpdater();
  const rows = [
    { icon: Blocks, label: "Card types", sub: "The kinds of cards, and their code", to: "/types" },
    { icon: Store, label: "Market", sub: "Shared decks, themes and types", to: "/market" },
    { icon: Settings, label: "Settings", sub: behind ? "An update is ready" : "AI grading, appearance, data", to: "/settings", dot: behind > 0 },
  ];
  return (
    <div className="pb-6">
      <PhoneTitle title="More" />
      <div className="score-list">
        {rows.map((r) => (
          <button key={r.to} onClick={() => navigate(r.to)} className="flex min-h-[4.25rem] w-full items-center gap-4 px-5 text-left">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-card"><r.icon className="size-[18px] text-muted-foreground" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[16px]">{r.label}</span>
              <span className="block truncate text-[13px] text-muted-foreground">{r.sub}</span>
            </span>
            {r.dot && <span className="size-2 rounded-full bg-highlight" aria-label="Update available" />}
            <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" />
          </button>
        ))}
      </div>

      <div className="mt-8 px-5">
        <div className="score-kicker mb-3">Bring cards in</div>
        <ImportButton onDone={() => navigate("/")} phone />
        <p className="mt-2 text-[13px] text-muted-foreground">An Etude pack (.json) or an Anki deck (.apkg, .colpkg).</p>
      </div>

      {behind > 0 && st && (
        <button onClick={() => navigate("/settings")} className="mx-5 mt-8 flex w-[calc(100%-2.5rem)] items-center gap-3 rounded-2xl border bg-card px-4 py-3.5 text-left">
          <CircleArrowUp className="size-5 shrink-0 text-highlight" />
          <span className="min-w-0 flex-1 text-[15px]">{st.kind === "git" ? `Update Etude · ${behind} new` : `Etude ${st.latest} is out`}</span>
          <ChevronRight className="size-4 text-muted-foreground" />
        </button>
      )}

      <div className="mt-12 flex items-center gap-3 px-5 text-muted-foreground">
        <Logo tile className="size-9 shrink-0 rounded-[9px]" />
        <div className="min-w-0 text-[13px] leading-snug">
          <Wordmark className="text-[1.05rem] text-foreground" />
          <div>{st?.version ? `Version ${st.version}` : "Practice anything."}</div>
        </div>
      </div>
    </div>
  );
}

