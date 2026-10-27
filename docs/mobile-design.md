# Etude on a phone: "Score"

Below 768 px Etude has its own layout instead of a narrow desktop. The language is called Score because Etude is a practice piece: titles are set like a score, the current place is marked in pink, and the counts carry their meaning in their shape.

Desktop (768 px and up) is unchanged. Every phone-only branch goes through `usePhone()` (`web/src/lib/phone.ts`) or a `max-md:` class, so the two can't drift into each other.

## Rules

- **Type.** Page titles are Computer Modern (`score-serif score-display`, ~36 px, regular weight with a hairline stroke so it holds on dark themes). Small labels are tracked caps (`score-kicker`). Everything else stays Inter.
- **Counts by shape.** New is an open ring, learning a half ring, due a filled dot (`Mark`, `Tally` in `components/phone-shell.tsx`). Zeros drop out of rows. Colour still follows the theme (`--new`, `--learn`, `--review`), so every theme works, but the shapes read without it.
- **One level at a time.** Decks shows the top level; a deck's page shows its subdecks. No indented trees on a phone.
- **Tap to open, hold for the rest.** Deck rows open on tap; press and hold (450 ms, `useLongPress`) opens an action sheet with Practice, Practice ahead, Rename, Move to…, Move up/down, Out one level, Make it a deck of its own. In Browse, holding a row starts selection; then taps select, and the bulk bar appears. No grips, ⋯ or checkboxes sit on rows by default.
- **Thumb zone.** Primary actions are 52 px pills at the bottom: Practice everything, Check, the four ratings, Go again / Next. Undo sits beside Check. Bury, suspend and edit move from the study header into a sheet behind ⋯.
- **Sheets, not menus.** `ActionSheet` is one rounded surface from the bottom: grab handle, serif title, a line of context, grouped rows. Swipe down or tap outside to close.
- **Navigation.** Four tabs and the ε: Decks, Browse, Ask (the ε disc rises out of the bar and opens Ask Etude), Stats, More. More holds Card types, Market, Settings, import and the update. The active tab is a pink icon.
- **Titles fold.** `PhoneTitle` puts the big title in the page; when it scrolls away a slim bar fades in with the same title (and the back chevron on deck pages).
- **Toasts** sit at the bottom above the tab bar or the study controls.

## Pieces

| File | What |
|---|---|
| `web/src/lib/phone.ts` | `usePhone()` (below 768 px), `useLongPress()` |
| `web/src/components/phone-shell.tsx` | `PhoneTabBar`, `PhoneTitle`, `PhoneIconButton`, `ActionSheet`, `Tally`, `Mark` |
| `web/src/components/phone-decks.tsx` | Phone Decks: Today card, `DeckList` (also used for subdecks), rows |
| `web/src/pages/more.tsx` | The More tab (redirects to Settings on wide screens) |
| `web/src/index.css` | `score-*` utilities and classes |

Pages that keep their desktop structure on a phone (Stats, Settings, Market, Card types, deck Options/Manage) only take the serif title (`PHONE_H1`) and the safe-area padding.
