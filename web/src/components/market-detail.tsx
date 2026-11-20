// The Market's detail page layout, shared by free entries (pages/market.tsx) and paid decks (market-paid.tsx),
// in the App Store's order: back link, the title, the previews side by side in one sideways row, the action with
// the entry's numbers under it, then the long text across the full width of the page.
// Every entry has a menu: Copy link, Report (an email to the team) and, for other people's, Hide everything from them.
import { ChevronLeft, Eye, EyeOff, Flag, Link2, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { openMail } from "@/lib/account";
import { CONTACT_EMAIL, entryLink, reportMail } from "@/lib/contact";

/** One fact under the action: a value over its label, like the App Store's ratings / age / size row. */
export type InfoCell = { label: string; value: React.ReactNode; key?: string };

/** Everything in the Market fits a 13+ rating, so every entry says so where the App Store shows its age. */
export const AGE_CELL: InfoCell = { key: "age", label: "Age", value: <span data-age-rating>13+</span> };

export function DetailLayout({ onBack, head, gallery, actions, info, menu, notice, children }: { onBack(): void; head: React.ReactNode; gallery: React.ReactNode; actions: React.ReactNode; info: InfoCell[]; menu?: React.ReactNode; notice?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mk-detail" data-market-detail>
      <div className="mk-top">
        <button className="mk-back" onClick={onBack}><ChevronLeft className="size-[18px]" strokeWidth={2.2} />Market</button>
        {menu}
      </div>
      {notice}
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

/**
 * The entry's menu. `author` is set for entries other people made (not Etude's own): it offers to hide everything
 * from them, or to show it again when they're hidden.
 */
export function EntryMenu({ name, entryKey, author, hidden, onHide, onShow }: { name: string; entryKey: string; author?: string | null; hidden?: boolean; onHide?(): void; onShow?(): void }) {
  const copy = () =>
    navigator.clipboard.writeText(entryLink(entryKey)).then(
      () => toast.success("Link copied", { description: "It opens this page in Etude." }),
      () => toast.error("Couldn't copy", { description: "The browser blocked clipboard access." }),
    );
  const report = () => {
    openMail(reportMail({ name, key: entryKey }));
    toast("Write what's wrong and send it", { description: `The Etude team reads every report. No email app? Write to ${CONTACT_EMAIL}.` });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="mk-more" aria-label="More options" data-entry-menu><MoreHorizontal className="size-[18px]" /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void copy()} data-copy-link><Link2 className="size-4" />Copy link</DropdownMenuItem>
        <DropdownMenuItem onSelect={report} data-report-entry><Flag className="size-4" />Report…</DropdownMenuItem>
        {author && (
          <>
            <DropdownMenuSeparator />
            {hidden ? (
              <DropdownMenuItem onSelect={onShow} data-show-author><Eye className="size-4" />Show {author}'s entries again</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={onHide} data-hide-author><EyeOff className="size-4" />Hide everything from {author}</DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** On the page of an author you hid (opened from a link or from Yours). */
export function HiddenNotice({ author, onShow }: { author: string; onShow(): void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-3 text-[13.5px] text-muted-foreground ring-1 ring-border ring-inset" data-hidden-notice>
      <EyeOff className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">You hid everything from {author}. Their entries are left out of the Market.</span>
      <button type="button" className="font-semibold text-foreground underline-offset-2 hover:underline" onClick={onShow}>Show them again</button>
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
