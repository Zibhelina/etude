# Widget visual design system

This is the design contract for reusable Etude widgets. Functional behavior belongs in `docs/architecture.md`.

## Default: shadcn/ui

Every new Etude widget uses shadcn/ui unless the user asks for another visual system. shadcn/ui is open component code, not a runtime package that Etude imports. Etude stays dependency-free and self-contained by carrying an adapted open-code component layer in `widgets/shadcn.css`.

Use the shared classes before writing widget-local CSS:

- `ui-card`, `ui-card-title`, `ui-card-description`
- `ui-button` plus `ui-button-secondary`, `ui-button-outline`, or `ui-button-ghost`
- `ui-icon-button`
- `ui-input`, `ui-textarea`, `ui-select`
- `ui-badge`, `ui-separator`, `ui-progress`
- `ui-muted`, `ui-tabular`

Custom CSS should describe the widget's data layout, not recreate buttons, cards, inputs, badges, progress tracks, focus rings, or theme colors. When a needed shadcn component is missing, port its open component recipe into `widgets/shadcn.css`, add a contract test, and then compose it from the template.

Authoritative references:

- https://ui.shadcn.com/docs
- https://ui.shadcn.com/docs/theming
- https://ui.shadcn.com/docs/components

## Visual character

The default dark theme follows the attached shadcn dashboard reference: a near-black canvas, charcoal cards, quiet one-pixel borders, large card radii, pill controls, restrained type, white primary actions, Lucide-style line icons, and sparse semantic color.

- Background: near black (`--background`)
- Cards: dark charcoal (`--card`), with nested muted surfaces (`--secondary` or `--muted`)
- Primary actions: light neutral fill with dark text
- Secondary and active states: quiet gray fills
- Borders and dividers: low-contrast `--border`
- Status color: used only when it carries meaning, paired with an icon and label
- Charts: neutral first; use `--chart-1` through `--chart-5` in order
- No gradients, glow, blur, decorative shadows, or arbitrary colors

A widget may use another shadcn preset or a custom theme when the user asks. The component structure and accessibility rules stay the same.

## Theme contract

Every shipped theme defines the shadcn semantic tokens below as literal colors or dimensions:

```css
:root {
  color-scheme: dark;
  --radius: 1rem;
  --background: #090909;
  --foreground: #f5f5f5;
  --card: #171717;
  --card-foreground: #f5f5f5;
  --popover: #1b1b1b;
  --popover-foreground: #f5f5f5;
  --primary: #f1f1f1;
  --primary-foreground: #111111;
  --secondary: #242424;
  --secondary-foreground: #f5f5f5;
  --muted: #242424;
  --muted-foreground: #a0a0a0;
  --accent: #2a2a2a;
  --accent-foreground: #ffffff;
  --destructive: #ef4444;
  --border: #2b2b2b;
  --input: #292929;
  --ring: #777777;
  --chart-1: #d4d4d4;
  --chart-2: #a3a3a3;
  --chart-3: #737373;
  --chart-4: #525252;
  --chart-5: #404040;
}
```

The semantic pair convention is mandatory: a surface token and its `-foreground` token travel together. Components consume semantic names, never raw colors.

Etude also defines status/data tokens (`--green`, `--yellow`, `--red`, `--violet`, accessible `*-text` variants, and `--status-*`). Old `--surface-*`, `--text-*`, and shorter names remain compatibility aliases for existing templates and user overrides. New shared components use shadcn names.

## Choose the display before styling it

| Data shape | Preferred display | Avoid |
|---|---|---|
| One value, optionally with a trend | Metric card | One-bar chart |
| A few key numbers | Metric-card row or grid | Grouped bars with no comparison task |
| Progress toward a limit | Progress bar | Two-slice pie |
| Magnitude comparison | Bar or column chart | Decorative area chart |
| Change over time | Line chart; area only for one series | Bars when continuity matters |
| Several series | Grouped or stacked bars, or multiple lines | Dual Y axes |
| One focal series plus context | One emphasis color; neutral context | A color for every item |
| Part-to-whole | Stacked bar | Pie with more than five slices |
| Ordered records | Table or list | Cards that hide scan order |

After eight categories, group into “Other” or split the display. Most visualizations should use neutrals plus one emphasis color.

## Template contract

Reusable widgets live in `widgets/templates/` and contain both injection markers exactly once:

```html
<style>/*__THEME__*/</style>
<script>const ETUDE = /*__DATA__*/null;</script>
```

The server injects the selected theme, `widgets/shadcn.css`, the data payload, and the shared resize bridge. Templates remain self-contained and use no remote resources. Include `<meta name="color-scheme" content="dark light">`.

Use `data-fit-content` on `<body>` when natural content height should resize the Lotus frame. Design from 320 px upward. Content should fit without a nested scrollbar during normal use.

## Type, spacing, and geometry

- Font stack: Inter or Geist when available, then the system sans stack.
- Body and controls: 14–16 px. Metadata: 12–13 px. Large metrics: 28–40 px.
- Use weight 400 for body text, 500 for controls, and 600 only for a title or primary value.
- Card radius derives from `--radius`; the default shared card uses `calc(var(--radius) * 1.5)`.
- Buttons, compact inputs, badges, switches, and nav selections are pills by default.
- Use a 4 px base and an 8 px visual rhythm. Common card padding is 20 px; common gaps are 8, 12, 16, 20, and 24 px.
- Hierarchy comes from brightness, size, weight, and spacing, in that order.

## Interaction and accessibility

- Use semantic HTML before ARIA: real buttons, labels, inputs, headings, lists, and tables.
- Every action works by keyboard and has a visible `:focus-visible` ring using `--ring`.
- Touch targets are at least 40 px, preferably 44 px, where the user must act.
- Honor `prefers-reduced-motion`.
- Status always includes text and an icon or shape, never color alone.
- Charts use `role="img"`, an accurate `aria-label`, and a text equivalent. Progress uses `role="progressbar"` with min, max, current value, and readable value text.
- Round every displayed number to meaningful precision.
- Preserve unsent work on network failure. Do not submit on every click unless the interaction itself requires it.

## Build and review workflow

1. Choose the display from the data shape.
2. Start with semantic shadcn tokens and shared `ui-*` components.
3. Add only the layout CSS the widget actually needs.
4. Add or update tests for routes, payload safety, component composition, tokens, accessibility, and resize behavior.
5. Render the exact served widget in a real browser at desktop and narrow widths.
6. Check dark and light themes.
7. Confirm no nested scrollbar, clipping, floating-point noise, raw markdown leakage, or broken keyboard path.

## Final gate

- Does the widget use shadcn/ui by default, or name the requested exception?
- Does it compose shared `ui-*` components instead of recreating them?
- Do all colors come from semantic tokens?
- Is the display right for the question?
- Does it work in dark and light themes?
- Are status, charts, and controls accessible without relying on color?
- Does it size to full natural content in Lotus?
- Did the focused tests and full suite pass?
- Was the rendered result inspected at desktop and narrow widths?
