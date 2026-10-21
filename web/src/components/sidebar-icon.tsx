// Sidebar toggle glyph: a square panel with a divider a third of the way in.
export function SidebarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="3.5" />
      <path d="M9.75 3.75v16.5" />
    </svg>
  );
}
