# Notes for agents

The Notebook is a tree of notes: **pages** (a rich document), **folders**, **files** (code or text kept exactly), **web files** (HTML/CSS/JS shown live), **kanban boards**, **canvases** (Excalidraw whiteboards) and **PDF notes**. Every command that takes a note accepts its id, the first 8 characters of the id, its exact title, or its path through the folders (`Fall 2026/CMPT 307/Week 1`; a title may contain `/` itself, as in `Journal - 8/11/2026`).

## Find and read

```sh
etude note tree                      # the whole tree: title, kind, 8-char id
etude note tree "Fall 2026" --depth 2
etude note tree --paths              # [{ path, id, kind, updated }]
etude note search exchange argument  # title or text has every word
etude note read "Fall 2026/CMPT 307/Week 1"          # a page as Markdown
etude note read "Week 1" --blocks    # its top-level blocks, numbered
etude note read main.py --lines      # a file with line numbers
etude note canvas "Study loop"       # a canvas's elements
etude note kanban "This week"        # a board's columns and cards
```

`note read --blocks` marks a block with `*` and its type when Markdown can't hold it whole (columns, toggles, portals, embeds, coloured or resized text). Edit those with `note block`, or with `note patch` inside one run of their text.

## Change a page

Prefer the smallest edit. A page is only rewritten where you touch it, so everything else (portals, colours, flashcards, columns) stays exactly as the user left it.

```sh
# Find-and-replace on the Markdown `note read` shows. Must match once (or --all). May span blocks.
etude note patch Journal --old "- [ ] Lab 2" --new "- [x] Lab 2"
etude note patch Journal --old $'## Ideas\n\nold line' --new $'## Ideas\n\nnew line'

# Add without touching anything: at the end, --top, --under "Heading", or --at N (before block N).
etude note append Journal --under "TODO" --md "- [ ] read chapter 3"
etude note append Journal --md "![the diagram](~/Pictures/diagram.png)"   # the picture is copied into the media

# One block as the editor's JSON: print it, replace it, move it, delete it.
etude note block Journal 4
etude note block Journal 4 --set '{"type":"callout","attrs":{"kind":"tip"},"content":[{"type":"paragraph","content":[{"type":"text","text":"Done!"}]}]}'
etude note block Journal 4 --md "## A heading instead"
etude note block Journal 4 --to 0            # before block 0 of the page as it is now
etude note block Journal 4 --delete --count 2
etude note append Journal --json '<blocks>'  # add blocks Markdown can't say
```

Whole rewrites (`note edit --md`) drop what Markdown can't say. Use them for pages you just made, not the user's.

Markdown that pages understand: `#`–`###` headings, `-` and `1.` lists, `- [ ]`/`- [x]` to-dos (nest with two spaces), tables, fenced code with a language, `$inline$` and `$$block$$` math, `> quotes`, `> [!note]` callouts (`note`, `tip`, `warning`, `danger`, `question`), `---`, `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[text](url)`, `![alt](picture path or URL)`, and `[[Page title]]` links (they resolve to the note with that title).

### Block shapes (for `--json` and `--set`)

The editor is ProseMirror (Tiptap). Text is `{ "type": "text", "text": "…", "marks": [...] }`. Print a real block with `note block` before building one by hand.

| Block | Shape |
| --- | --- |
| paragraph | `{ type: "paragraph", attrs?: { textAlign: "center" \| "right" \| "justify" }, content: [inline…] }` |
| heading | `{ type: "heading", attrs: { level: 1–3 }, content }` |
| lists | `bulletList` / `orderedList` (`attrs.start`) of `listItem`; `taskList` of `taskItem` (`attrs.checked`); items hold a paragraph and may hold nested lists |
| quote, code, rule | `blockquote` (blocks), `codeBlock` (`attrs.language`, one text child), `horizontalRule` |
| callout | `{ type: "callout", attrs: { kind: "note" \| "tip" \| "warning" \| "danger" \| "question" }, content: [blocks] }` |
| toggle | `{ type: "details", attrs: { open: false }, content: [{ type: "detailsSummary", content: [inline] }, { type: "detailsContent", content: [blocks] }] }` |
| toggle heading | a toggle whose title has a level (1–3): `{ type: "detailsSummary", attrs: { level: 2 }, content: [inline] }` |
| columns | `{ type: "columns", content: [{ type: "column", content: [blocks] }, …] }` (2–4 columns) |
| table | `table` → `tableRow` → `tableHeader` / `tableCell` (each holds paragraphs; `attrs.colspan`, `rowspan`, `colwidth`) |
| math | `{ type: "mathBlock", attrs: { latex } }`; inline `{ type: "mathInline", attrs: { latex } }` |
| picture | `{ type: "image", attrs: { src: "/media/files/<sha>.<ext>" or URL, alt, width? } }` (`etude media add` stores a file and prints its `url`) |
| video, PDF | `{ type: "noteVideo", attrs: { src } }` (a YouTube/Vimeo link or media URL); `{ type: "notePdf", attrs: { src, name, height? } }` |
| HTML | `{ type: "htmlEmbed", attrs: { html } }` (runs sandboxed) |
| portal | `{ type: "portal", attrs: { id, title, height? } }` onto a web file; `canvasEmbed` and `kanbanEmbed` take the same `{ id, title }` for a canvas or board. `etude note portal <note> <page>` makes one for you. |
| flashcards | `{ type: "noteCard", attrs: { item: <item id> } }` one card; `{ type: "noteCards", attrs: { deck, q, n } }` a live list from a deck or search |
| link to a page | inline `{ type: "noteLink", attrs: { id, title, label? } }` |

An HTML block or a portal onto a web file has a full screen button. Where its block is narrower than 420 px, or than its content (a canvas of fixed width), it shows as a scaled picture of itself with ▶, which opens it full screen. A widget that needs another width says so in its HTML: `<meta name="etude-min-width" content="640">`; `content="0"` keeps it live at any width.

Marks: `bold`, `italic`, `strike`, `underline`, `code`, `link` (`attrs.href`), and `textStyle` with `color: "var(--nc-<c>)"`, `backgroundColor: "var(--nc-<c>-bg)"` (c: gray, brown, orange, yellow, green, blue, purple, pink, red), `fontFamily: "var(--nf-sans|serif|mono)"`, `fontSize: "0.85em" | "1.25em" | "1.6em"`.

## Files and web files

```sh
etude note patch main.py --old "range(10)" --new "range(n)"
etude note append main.py --md "print('done')"          # at the end; --top or --at LINE
etude note edit main.py --content-file ./main.py        # the whole text
```

## Canvases

```sh
etude note canvas add Board rectangle --x 0 --y 0 --text "Encode" --background blue
etude note canvas add Board ellipse --x 400 --y 0 --text "Retrieve" --background green
etude note canvas add Board arrow --from <rect id> --to <ellipse id> --text "practice"
etude note canvas add Board text --x 0 --y -60 --text "The study loop" --font-size 28
etude note canvas add Board image --file diagram.png --x 700 --y 0 --width 300
etude note canvas edit Board <id> --dx 120 --text "Encode (week 1)" --front
etude note canvas delete Board <id> <id>
```

Types: rectangle, ellipse, diamond, text, arrow, line, image, frame. A shape's `--text` is its label; arrows tied with `--from`/`--to` follow their ends when those move. Colours take Excalidraw's names (blue, green, red, …) or `#rrggbb`; a named `--background` is the toolbar's light shade. Element ids may be shortened to their first 4+ characters. For a drawing in one go, `etude note edit Board --scene-file drawing.excalidraw` replaces the whole scene.

## Kanban boards

```sh
etude note kanban "This week"                                   # columns and cards at a glance
etude note kanban card "This week" "Lab 2"                      # one card, its page as Markdown
etude note kanban add "This week" "Lab 2" --column "To do" --due tomorrow --label "CMPT 371:blue" --md "- [ ] traces"
etude note kanban move "This week" "Lab 2" Doing --at 0
etude note kanban edit "This week" "Lab 2" --old "- [ ] traces" --new "- [x] traces"   # part of the card's page
etude note kanban edit "This week" "Lab 2" --append "- [ ] write-up" --due none
etude note kanban archive "This week" "Lab 2"                   # --restore brings it back
etude note kanban column "This week" Review --color teal --limit 3   # a new name adds a column
```

Cards are named by id or exact title, columns by name, id or number (1 = first). `--label` on edit replaces the card's labels; `--no-labels` takes them all off.

## Organize

```sh
etude note new "Week 2" --parent "Fall 2026/CMPT 307" --md "# Greedy"
etude note new main.py --file --parent "CMPT 307" --content-file ./main.py
etude note new "Plan" --kanban --columns "Backlog,This week,Done"
etude note new "Board" --canvas
etude note move "Week 2" "Fall 2026/CMPT 361" --index 0
etude note edit "Week 2" --title "Week 2 · DP" --icon 📗 --cover ~/Pictures/cover.jpg
etude note portal "Plan" "Week 2"        # the board, live inside the page
etude note pin "Week 2"
etude note archive "Old stuff"           # nothing is deleted; unarchive brings it back
```

The app can stay open while you work: a page open in it takes your change live and merges it with what the user is typing. Changes from outside never go through the user's undo history, so for anything large, `etude db backup` first.

## Shared folders

A folder or page can be shared with other Etude accounts (`docs/sharing.md`). Notes inside one carry `share: { space, role, root, readonly }` in their JSON.

- `readonly: true` (shared as view only, or access removed): every write to it fails with a 403 "this is shared with you as view only". Don't retry or work around it; tell the user who owns it.
- Edits inside a shared folder reach the other members. Say so before bulk changes there, and keep the backup rule.
- `etude share list` shows spaces and invites; `share sync` sends and fetches changes now. Accepting an invite, inviting or removing people and stopping sharing are the user's calls: only do them when asked.
