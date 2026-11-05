// Coming soon: decks the Etude team is still making, from the catalog's coming-soon.json. A tile and a page like any
// other deck, with "Coming soon" where the price or the button would be. Nothing to install, buy or sign up for, and
// the store apps never show them (canShowPurchases).
import { Hourglass, Layers } from "lucide-react";
import { api, type ComingSoonEntry } from "@/lib/api";
import { EtudeImg } from "@/lib/local-url";
import { DetailLayout, paragraphs, type InfoCell } from "@/components/market-detail";
import { MediaGallery } from "@/components/market-gallery";

/** "1,026 kanji · 6 grades": the first two facts, for a tile. */
export const soonMeta = (e: ComingSoonEntry) => e.facts.slice(0, 2).map((f) => `${f.value} ${f.label.charAt(0).toLowerCase()}${f.label.slice(1)}`).join(" · ") || "Deck";

export function SoonCover({ entry }: { entry: ComingSoonEntry }) {
  if (entry.cover) return <EtudeImg src={api.comingSoonUrl(entry.id, "cover")} alt="" loading="lazy" />;
  return (
    <div className="flex size-full items-center justify-center gap-2 text-muted-foreground">
      <Layers className="size-4" />
      <span className="mk-serif text-[17px] text-foreground">{entry.name}</span>
    </div>
  );
}

export function SoonTile({ entry, onOpen }: { entry: ComingSoonEntry; onOpen(): void }) {
  return (
    <div role="link" tabIndex={0} className="mk-tile" onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen()} data-soon={entry.id}>
      <div className="mk-cover"><SoonCover entry={entry} /></div>
      <div className="mk-tile-body">
        <div className="mk-tile-title"><b>{entry.name}</b><span className="mk-soon-mark">Coming soon</span></div>
        <p>{entry.tagline || "Deck"}</p>
        <div className="mk-tile-meta"><span>{soonMeta(entry)}</span></div>
      </div>
    </div>
  );
}

export function SoonDetail({ entry, onBack }: { entry: ComingSoonEntry; onBack(): void }) {
  const info: InfoCell[] = entry.facts.map((f) => ({ label: f.label, value: f.value }));
  return (
    <DetailLayout
      onBack={onBack}
      head={
        <>
          <div className="mk-eyebrow">Deck · Coming soon</div>
          <h1 className="mk-serif">{entry.name}</h1>
          <div className="mk-by">by <span className="inline-flex items-center gap-1 whitespace-nowrap"><span className="score-serif text-[15px] text-foreground">ε</span>Etude</span></div>
        </>
      }
      gallery={<MediaGallery name={entry.name} media={entry.media} url={(i) => api.comingSoonUrl(entry.id, i)} cover={<SoonCover entry={entry} />} />}
      actions={
        <div className="mk-soon-state" role="status" data-soon-state>
          <Hourglass className="size-[18px]" />
          <div>
            <b>Coming soon</b>
            <span>We're still making this one. It'll show up here when it's ready.</span>
          </div>
        </div>
      }
      info={info}
    >
      <section className="mk-sec">
        <h3 className="mk-serif">About this deck</h3>
        {paragraphs(entry.description || entry.tagline || "No description yet.").map((x, i) => <p key={i}>{x}</p>)}
      </section>
      {entry.parts.length > 0 && (
        <section className="mk-sec">
          <h3 className="mk-serif">What's inside</h3>
          <div className="mk-parts">{entry.parts.map((x, i) => <span key={i}>{x}</span>)}</div>
        </section>
      )}
      {entry.tags.length > 0 && (
        <div className="mk-source">
          <span>{entry.tags.slice(0, 6).map((t) => `#${t}`).join(" ")}</span>
        </div>
      )}
    </DetailLayout>
  );
}
