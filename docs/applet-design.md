# Applet visual design system

This is the design contract for reusable Etude applets and in-chat widgets. It governs visual hierarchy, data-display choices, themes, accessibility, and final review. Functional behavior still belongs in `docs/architecture.md`.

## Choose the display before styling it

| Data shape | Preferred display | Avoid |
|---|---|---|
| One value, optionally with a trend | Metric card | One-bar chart |
| A few key numbers | Row or grid of metric cards | Grouped bars with no comparison task |
| Progress toward a limit | One-color meter or progress bar | Two-slice pie |
| Magnitude comparison | Bar or column chart | Decorative area chart |
| Change over time | Line chart; area only for one series | Bars when continuity matters |
| Several distinct series | Grouped/stacked bars or multiple lines | Dual Y axes |
| One focal series plus context | One accent color; context in neutral tones | A different color for every item |
| Part-to-whole | Stacked bar, horizontal for long labels | Pie with more than five slices |
| Ordered records | Table or list | Cards that hide scan order |

If a ninth category would be needed, group it into “Other” or split the display. A visualization should normally use one accent plus neutrals, and never more than three chromatic colors without a real categorical reason.

## Theme contract

Every shipped theme defines these variables in `:root`:

```css
:root {
  color-scheme: dark;
  --surface-0: #1a1a19;
  --surface-1: #232322;
  --surface-2: #2a2a29;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --text-muted: #a3a19a;
  --border: rgba(255,255,255,0.10);
  --border-strong: rgba(255,255,255,0.16);
  --radius-control: 8px;
  --radius-card: 12px;
  --accent: #3987e5;
  --orange: #d95926;
  --aqua: #199e70;
  --yellow: #c98500;
  --magenta: #d55181;
  --green: #0ca30c;
  --violet: #9085e9;
  --red: #e66767;
  --accent-text: #6aa8ee;
  --yellow-text: #e1b84e;
  --green-text: #2acb2a;
  --red-text: #f07b7b;
  --violet-text: #b2a9f2;
  --accent-strong: #3987e5;
  --on-accent: #0b0b0b;
  --status-good: #0ca30c;
  --status-warning: #fab219;
  --status-severe: #ec835a;
  --status-critical: #d03b3b;
  --mono: ui-monospace, "SFMono-Regular", Menlo, monospace;
  --sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
```

Templates use only variables for color. The old `--bg`, `--panel`, `--panel2`, `--text`, `--dim`, `--faint`, and `--purple` names remain as compatibility aliases in shipped themes, but new code uses the contract above.

Palette order for categorical series is fixed: accent blue, orange, aqua, yellow, magenta, green, violet, red. Do not generate random colors or walk the hue wheel. Sequential scales use one hue from low to high. Diverging scales use blue and red around a neutral midpoint. Status color must always appear with an icon and a written label, never by itself.

Palette tokens such as `--accent`, `--yellow`, and `--red` are for fills, lines, borders, and indicators. They are not guaranteed to meet normal-text contrast. Each theme also defines `--accent-text`, `--yellow-text`, `--green-text`, `--red-text`, and `--violet-text` for small text, plus `--accent-strong` and `--on-accent` for primary controls. Use those paired tokens instead of putting palette colors directly on text.

## Style rules

- No gradients, decorative shadows, blur, glow, or colored outer containers.
- Borders are `0.5px solid var(--border)`. Use `var(--border-strong)` for emphasis and a 2px accent border only for keyboard focus or a single recommended option.
- Controls use `var(--radius-control)`; cards and panels use `var(--radius-card)`. Fully rounded tracks and compact pills may use `999px`.
- Use sentence case for interface labels. Preserve real acronyms and identifiers.
- Use only weights 400 and 500. A larger size, spacing, or color should establish hierarchy before heavier type.
- Default body copy is 16px with line-height 1.7. Dense tables may use smaller metadata text, but primary content and controls stay readable.
- Counts are integers. Percentages usually show zero or one decimal place. Format displayed values with `Math.round`, `toFixed`, or `toLocaleString`; never expose floating-point noise.
- Color carries meaning, not decoration. Text and shape must still explain the state without color.

## Accessibility

- Every interactive control needs a visible label or an `aria-label`, keyboard operation, and a clear `:focus-visible` treatment.
- Honor `prefers-reduced-motion`; remove nonessential animation and transition.
- A chart or custom visualization needs `role="img"`, a descriptive `aria-label`, and a text equivalent containing the important values. Progress meters use `role="progressbar"`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and `aria-valuetext`.
- Never distinguish series by color alone. Combine color with line style, marker shape, pattern, direct label, or another visible cue.
- Keep touch targets at least 44px high where the user must act.
- Use semantic HTML first: headings in order, real buttons, labels, tables with scoped headers, and live regions for asynchronous feedback.

## Charts

Etude templates are self-contained and cannot depend on a CDN. Prefer semantic HTML, CSS, SVG, or Canvas. If a host project deliberately permits Chart.js, pin the version and follow the same contract:

- Give the wrapper a fixed or bounded height; keep the canvas responsive and do not set canvas dimensions in CSS.
- Use one Y axis. Split the chart or normalize the data instead of adding a second scale.
- Time axes do not use vertical grid lines.
- Hide the built-in legend when it cannot show values or non-color cues; render a clear HTML legend instead.
- Round every displayed number.
- Keep the visual to two or three colors unless categories require more.

## Etude template requirements

Reusable applets live in `applets/templates/` and keep both injection markers exactly once:

```html
<style>/*__THEME__*/</style>
<script>const ETUDE = /*__DATA__*/null;</script>
```

They remain self-contained, use no external resources, use only theme variables for color, and include `<meta name="color-scheme" content="dark light">`. Add `data-fit-content` when the natural content height should drive Lotus resizing. Design for a useful width from 320px upward and let the shared `ResizeObserver` bridge remove nested scrolling.

Interactive templates should keep one main action, show immediate feedback, preserve unsent work on network failure, and avoid submitting on every click. Read-only widgets should lead with the answer, then supporting context. Do not turn a metric into a chart merely to fill space.

## Review checklist

1. Is this the right display for the data and the user’s question?
2. Do all colors come from theme variables?
3. Does it remain legible in the shipped light and dark themes?
4. Are labels sentence case and type weights limited to 400/500?
5. Are numbers rounded to meaningful precision?
6. Are there no gradients, decorative shadows, blur, glow, or arbitrary color cycling?
7. Does every visualization have an accessible text equivalent?
8. Can every action be completed by keyboard with visible focus?
9. Does status include an icon and label rather than color alone?
10. Does the applet fit its content without nested scrolling in Lotus?
11. Did the visual-contract tests and full test suite pass?
12. Was the rendered result inspected in a real browser at desktop and narrow widths?
