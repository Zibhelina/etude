// Keyboard reference. Keep in sync with the handlers in pages/study.tsx, pages/browse.tsx,
// runtime/runtime.js and the built-in card scripts in types/*/card.js.
import { toast } from "sonner";
import { BigSwitch, Block, Kbd, Section } from "@/components/settings-ui";
import { setVimMode, useVimMode } from "@/lib/vim";

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** Each entry is one way to do it; "+" joins keys pressed together. */
type Row = { keys: string[]; what: string };

const GROUPS: { title: string; description?: string; rows: Row[] }[] = [
  {
    title: "Studying",
    rows: [
      { keys: [`${mod}+Enter`], what: "Check the answer" },
      { keys: ["Space", "Enter"], what: "Show the answer on self-rated cards" },
      { keys: ["1–4"], what: "Rate Again, Hard, Good or Easy" },
      { keys: ["Space", "Enter"], what: "After grading: take the suggested rating (Good if there is none)" },
      { keys: ["="], what: "Bury all cards of the current note until the next study day" },
      { keys: ["-"], what: "Bury only the current card until the next study day" },
      { keys: ["!"], what: "Suspend all cards of the current note" },
      { keys: ["@"], what: "Suspend only the current card" },
      { keys: ["U", `${mod}+Z`], what: "Undo the last rating, including after advancing to the next card (outside answer fields)" },
      { keys: ["Esc"], what: "Back to decks" },
    ],
  },
  {
    title: "Inside cards",
    description: "Built-in card types. Custom types can add their own.",
    rows: [
      { keys: ["Enter"], what: "Short answer, numeric and cloze: submit, or go to the next blank" },
      { keys: ["1–9", "A–H"], what: "Multiple choice: pick an option; single-answer cards submit at once" },
      { keys: ["Enter"], what: "Multiple choice with several answers: submit" },
      { keys: ["1–9"], what: "Match: pick a left item" },
      { keys: ["A–Z"], what: "Match: pick its partner on the right" },
      { keys: ["↑", "↓"], what: "Order: move between steps" },
      { keys: ["Alt+↑", "Alt+↓"], what: "Order: move the focused step" },
      { keys: ["P", "E"], what: "Drawing: pen, eraser" },
      { keys: [`${mod}+Z`, `${mod}+Shift+Z`], what: "Drawing: undo, redo" },
      { keys: ["Tab"], what: "Code answers: indent" },
    ],
  },
  {
    title: "Browse",
    rows: [
      { keys: [`${mod}+K`], what: "Search" },
      { keys: [`${mod}+S`], what: "Save the item you're editing" },
      { keys: ["Enter", "Space", "Comma"], what: "Tags: add the tag you typed" },
      { keys: ["Backspace"], what: "Tags, when empty: remove the last tag" },
    ],
  },
  {
    title: "Settings",
    rows: [{ keys: [`${mod}+S`], what: "Save" }],
  },
  {
    title: "Notes files",
    description: "Code and text files in Notes (main.py, report.tex).",
    rows: [
      { keys: [`${mod}+S`], what: "Save now (it also saves on its own)" },
      { keys: [`${mod}+F`], what: "Find and replace" },
      { keys: [`${mod}+D`], what: "Select the next match too" },
      { keys: [`${mod}+/`], what: "Comment or uncomment the line" },
      { keys: ["Alt+↑", "Alt+↓"], what: "Move the line up or down" },
      { keys: [`${mod}+Shift+[`, `${mod}+Shift+]`], what: "Fold or unfold the block" },
      { keys: ["Tab", "Shift+Tab"], what: "Indent, outdent" },
    ],
  },
  {
    title: "Anywhere",
    rows: [{ keys: [`${mod}+[`, "["], what: "Collapse or expand the sidebar" }],
  },
];

function Combo({ combo }: { combo: string }) {
  const parts = combo === "+" ? ["+"] : combo.split("+");
  return (
    <span className="flex items-center gap-0.5">
      {parts.map((k, i) => (
        <span key={i} className="flex items-center gap-0.5">
          {i > 0 && <span className="px-0.5 text-xs text-foreground/60">+</span>}
          <Kbd>{k}</Kbd>
        </span>
      ))}
    </span>
  );
}

/** Vim keys in Notes' file editor. Saved with the collection. */
function VimBlock() {
  const on = useVimMode();
  const flip = async (v: boolean) => {
    try {
      await setVimMode(v);
    } catch (e) {
      setVimMode(!v, { save: false });
      toast.error("Couldn't save", { description: (e as Error).message });
    }
  };
  return (
    <Block
      title="Vim keys"
      description={
        <>
          Edit code and text files in Notes the Vim way: normal, insert and visual modes, motions, operators, counts, registers, <Kbd>.</Kbd>, <Kbd>/</Kbd> search and <Kbd>:</Kbd> commands (<Kbd>:w</Kbd> saves). The mode shows under the file. Pages keep the usual editor.
        </>
      }
      aside={<BigSwitch id="vim-keys" checked={on} onCheckedChange={flip} aria-label="Vim keys" />}
    />
  );
}

export function ShortcutsSection() {
  return (
    <Section id="keys" title="Keyboard">
      <VimBlock />
      {GROUPS.map((g) => (
        <Block key={g.title} title={g.title} description={g.description}>
          <dl className="flex flex-col">
            {g.rows.map((r, i) => (
              <div key={i} className="flex flex-col gap-1.5 border-t border-border/60 py-2.5 first:border-t-0 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-6">
                <dt className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 sm:w-60">
                  {r.keys.map((k, j) => (
                    <span key={j} className="flex items-center gap-1.5">
                      {j > 0 && <span className="px-0.5 text-xs text-foreground/60">or</span>}
                      <Combo combo={k} />
                    </span>
                  ))}
                </dt>
                <dd className="text-sm text-foreground/75">{r.what}</dd>
              </div>
            ))}
          </dl>
        </Block>
      ))}
    </Section>
  );
}
