// The navigation glyphs, drawn on one 24 px grid with the same 1.8 stroke so the sidebar and tab bar read as one set.
type P = { className?: string; strokeWidth?: number };

function Glyph({ className, strokeWidth = 1.8, children }: P & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

/** Books on a shelf, the last one leaning. */
export const LibraryIcon = (p: P) => (
  <Glyph {...p}>
    <path d="m16 6 4 14" />
    <path d="M12 6v14" />
    <path d="M8 8v12" />
    <path d="M4 4v16" />
  </Glyph>
);

/** Lines of a list with a magnifier. */
export const BrowseIcon = (p: P) => (
  <Glyph {...p}>
    <path d="M3 6h12M3 12h8M3 18h6" />
    <circle cx="16.5" cy="15.5" r="3.5" />
    <path d="m21 20-2-2" />
  </Glyph>
);

/** A baseline with three bars. */
export const StatsIcon = (p: P) => (
  <Glyph {...p}>
    <path d="M4 20h16" />
    <path d="M7 16.5v-4" />
    <path d="M12 16.5V7.5" />
    <path d="M17 16.5V4.5" />
  </Glyph>
);

export const ArchiveIcon = (p: P) => (
  <Glyph {...p}>
    <rect x="3" y="4" width="18" height="4.5" rx="1.3" />
    <path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5" />
    <path d="M10 12.5h4" />
  </Glyph>
);

/** A page with a folded corner and two lines of writing. */
export const NotesIcon = (p: P) => (
  <Glyph {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </Glyph>
);

/** Four tiles, one of them round: card types are shapes you put content into. */
export const TypesIcon = (p: P) => (
  <Glyph {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="3.5" />
  </Glyph>
);

export const MarketIcon = (p: P) => (
  <Glyph {...p}>
    <path d="M4 10v10h16V10" />
    <path d="M2.5 10 5 4h14l2.5 6z" />
    <path d="M10 20v-5h4v5" />
  </Glyph>
);

export const MoreIcon = (p: P) => (
  <Glyph {...p}>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </Glyph>
);

export const SettingsIcon = (p: P) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Glyph>
);
