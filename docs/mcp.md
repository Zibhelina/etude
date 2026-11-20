# Etude for AI agents (MCP)

`etude mcp` makes your collection available to any AI agent that speaks the [Model Context Protocol](https://modelcontextprotocol.io): Claude Code, Codex, Claude Desktop, Cursor, Windsurf, Zed, VS Code and others. The agent can find, read, write and edit your notes (pages, files, web files, canvases, kanban boards), organize them, and use everything else in Etude through the CLI.

It runs on your computer and talks to the agent over stdio. Nothing goes anywhere else, and each tool call opens the collection, does one thing and closes it, so the app can stay open: a page you have open takes the change live, merged with what you're typing.

## Set it up

You need the `etude` command: the desktop app installs it (Settings → Desktop app → Install the etude command; the Linux packages put it on the PATH), or `npm install -g @zibhelina/etude`. Settings → Desktop app → Use with an AI agent shows the lines below with the right path filled in.

**Claude Code**

```sh
claude mcp add etude -- etude mcp
```

**Codex**

```sh
codex mcp add etude -- etude mcp
```

**Claude Desktop, Cursor, Windsurf and others** take a JSON entry in their MCP settings (`claude_desktop_config.json`, `.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "etude": { "command": "etude", "args": ["mcp"] }
  }
}
```

Some apps don't see your shell's PATH: use the full path (`which etude`, or the one Settings shows).

Options, added after `mcp`:

- `--db <file>` or the `ETUDE_DB` environment variable: another collection (by default the one the app uses).
- `--read-only`: only the tools that read. The agent can look but not change anything.

## The tools

| Tool | What it does |
| --- | --- |
| `notes_tree` | The tree of notes: title, kind and short id of each. |
| `notes_search` | Notes whose title or text has every word. |
| `notes_read` | A page as Markdown (or numbered blocks), a file's text (or numbered lines), a canvas's elements, a board. |
| `notes_create` | A page (Markdown body, pictures copied in), folder, file, web file, kanban board, canvas or PDF note. |
| `notes_append` | Add to a page (at the end, top, under a heading, before a block) or a file, without touching the rest. |
| `notes_patch` | Find-and-replace on a page's Markdown or a file's text. Only what it touches changes. |
| `notes_block` | One block of a page as the editor's JSON: get, replace, move, delete. For columns, toggles, colours, portals, flashcards. |
| `notes_canvas` | List, add, change and remove canvas elements: shapes with labels, text, arrows between shapes, lines, pictures, frames. |
| `notes_kanban` | Work a board: see it, read a card, add, move, edit (due, labels, cover, its page in part or whole), archive and restore cards; add, rename, colour, limit, move and remove columns. |
| `notes_edit` | Title, icon, cover, width, font and text size, or a whole new body. |
| `notes_organize` | Move, archive, unarchive, delete (with confirm), pin, unpin, and open portals. |
| `notes_view` | What the open app shows (the screen, its Notebook panes with their tabs, tab groups, pins and sizes, the sidebar, Notes' pages and the Ask panel), and changing it the way a person can: open a note or a New tab (as a tab, in place, or in a pane on a side), close a tab, a pane or the others, focus, pin and give a pinned tab an icon, move a tab or a whole group, make, rename, recolour, fold, dissolve and close tab groups, resize a pane, fold or hide the sidebar, show or hide Notes' pages, open or close the Ask panel, and go to another screen. Needs the app open on the same computer; it goes through `etude view`. |
| `etude_help` | Look up any Etude command. |
| `etude_run` | Run any Etude command (decks, cards, practice, stats, themes…) and get its JSON. |

Notes can be named by id, the first 8 characters of the id, exact title, or path (`Fall 2026/Algorithms/Week 1`).

Over MCP, `serve`, `update`, `agent`, `db restore`, key and sign-in commands aren't available, and `--db` can't point a call at another collection.

## Without MCP

Every tool is a CLI command, so an agent with a terminal can do the same: `etude note tree`, `etude note read`, `etude note patch`, `etude note append`, `etude note block`, `etude note canvas …`. [skill/SKILL.md](../skill/SKILL.md) is a skill file an agent can load, and [skill/references/notes.md](../skill/references/notes.md) explains notes in detail, including the JSON shape of every kind of block.
