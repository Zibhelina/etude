// The Market's detail page layout, shared by free entries (pages/market.tsx) and paid decks (market-paid.tsx),
// in the App Store's order: back link, the title, the previews side by side in one sideways row, the action with
// the entry's numbers under it, then the long text across the full width of the page.
import { ChevronLeft } from "lucide-react";

/** One fact under the action: a value over its label, like the App Store's ratings / age / size row. */
export type InfoCell = { label: string; value: React.ReactNode; key?: string };

export function DetailLayout({ onBack, head, gallery, actions, info, children }: { onBack(): void; head: React.ReactNode; gallery: React.ReactNode; actions: React.ReactNode; info: InfoCell[]; children: React.ReactNode }) {
  return (
    <div className="mk-detail" data-market-detail>
      <button className="mk-back" onClick={onBack}><ChevronLeft className="size-[18px]" strokeWidth={2.2} />Market</button>
      <header className="mk-head">{head}</header>
      {gallery}
      <div className="mk-act">{actions}</div>
      {info.length > 0 && (
        <dl className="mk-info" data-market-info>
          {info.map((c) => (
            <div key={c.key ?? c.label}>
              <dd>{c.value}</dd>
              <dt>{c.label}</dt>
            </div>
          ))}
        </dl>
      )}
      <div className="mk-body">{children}</div>
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
