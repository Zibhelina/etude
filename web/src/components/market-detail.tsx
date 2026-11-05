// The Market's detail page layout, shared by free entries (pages/market.tsx) and paid decks (market-paid.tsx):
// back link, gallery with facts beneath, the action box beside it, then the long text.
import { ChevronLeft } from "lucide-react";

export function DetailLayout({ onBack, gallery, facts, box, children }: { onBack(): void; gallery: React.ReactNode; facts: [string, React.ReactNode][]; box: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mk-detail" data-market-detail>
      <button className="mk-back" onClick={onBack}><ChevronLeft className="size-[18px]" strokeWidth={2.2} />Market</button>
      <div className="mk-detail-top">
        <div className="min-w-0">
          {gallery}
          <dl className="mk-facts">
            {facts.map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        </div>
        <div className="mk-box">{box}</div>
      </div>
      <div className="mk-body">{children}</div>
    </div>
  );
}

/** Two big numbers that say what you get. */
export function Hook({ items }: { items: [string, string][] }) {
  if (!items.length) return null;
  return (
    <div className="mk-hook">
      {items.map(([n, w], i) => (
        <div key={i}><b className="mk-serif">{n}</b><span>{w}</span></div>
      ))}
    </div>
  );
}

/** Splits a long description into readable paragraphs: its own blank lines first, then about every 230 characters. */
export function paragraphs(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    let cur = "";
    for (const s of block.trim().split(/(?<=\.)\s+(?=[A-Z])/)) {
      cur += (cur ? " " : "") + s;
      if (cur.length > 230) (out.push(cur), (cur = ""));
    }
    if (cur) out.push(cur);
  }
  return out;
}

export function niceDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
