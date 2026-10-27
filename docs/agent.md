# Ask Etude: the in-app assistant

A chat inside Etude that can do anything the CLI can: make decks from your notes, move and rename decks, change the theme, install from the Market, find and fix cards. It uses the AI you already set up in Settings → AI.

## Using it

- Open it with the round button in the bottom-right corner, or <kbd>Ctrl</kbd>+<kbd>J</kbd> (<kbd>⌘</kbd>+<kbd>J</kbd> on a Mac). <kbd>Esc</kbd> closes it. It isn't shown while you practice.
- On a computer the panel sits on the right and pushes the page over; drag its left edge to resize it. On a phone it opens full screen.
- Pick the model under the message box. The choice belongs to the conversation, and new chats start with the last one you picked.
- Attach files with the paperclip, by dropping them on the panel, or by pasting: images (png, jpg, webp, gif), PDFs, text files (markdown, csv, json, code) and Anki packages (`.apkg`, `.colpkg`). Up to 50 MB each.
- Each command the assistant runs shows as a row; click it to see the output.
- History (the clock icon) lists past conversations; the plus starts a new one.

## Safety

- **Confirmation.** Commands that delete or replace things (the ones the CLI marks as needing `--yes`) never run straight away. The panel shows the command and a dry-run preview with **Allow** and **Deny**. Deny tells the assistant it wasn't done.
- **Undo.** Before the first change in each reply, Etude snapshots the collection (`VACUUM INTO` into `$ETUDE_HOME/agent-snapshots/`, the last 10 are kept). A reply that changed something has an **Undo these changes** button that puts the collection back as it was before that reply. Changes made after it are undone too. Conversations themselves aren't rewound. Media files copied in by the reply stay on disk.
- **Limits.** At most 25 tool calls per message. **Stop** ends a running reply at the next step.
- **Blocked commands.** The assistant can't run `serve`, `update`, `settings chatgpt login/logout/import`, `db restore`, `market publish` or the `agent` commands, and can't point a command at another database with `--db`. Settings output never contains API keys.
- **Outside the collection.** Attached files, deck text and Market entries can carry instructions, so the assistant treats them as material and is limited before a command runs: `settings set/unset` only for day start, learn-ahead, theme, auto feedback, language and model names (never provider URLs, API key names or `market.*`); no `--out`, backup destinations or exports that write files; file paths only from the chat's own attachments; no `--url` on Market commands. The user's own CLI and Settings page aren't limited.

## Models

| Provider | Where it comes from | Protocol |
| --- | --- | --- |
| ChatGPT | Your ChatGPT sign-in (Settings → AI). Models from your plan's model list. | Responses API with function tools |
| OpenRouter | `OPENROUTER_API_KEY` (in the environment or `$ETUDE_HOME/.env`). Only models that support tool calling are listed. | Chat Completions with `tools` |
| Custom endpoint | Your feedback model when it is a non-OpenRouter OpenAI-compatible server (OpenAI, llama.cpp, vLLM, Ollama). The model must support tool calls. | Chat Completions with `tools` |

A model ref is `chatgpt:<model>`, `openrouter:<model>` or `custom:<model>`. Settings → AI → Assistant sets the default (`ai.agent.model`; empty means the feedback model):

```sh
etude settings set ai.agent.model=chatgpt:gpt-6.1-sol
etude agent models --search sonnet
```

## How it works

The model gets four tools:

- `etude_help(query?)` searches the command catalog (`src/cli/registry.ts`): the groups, or the matching commands with their arguments, flags and examples.
- `etude_run(argv, stdin?)` runs one CLI command in-process on the open collection, the same code path as the `etude` binary, and returns its JSON output and exit code.
- `read_attachment(id, page? | offset?)` reads an attachment: PDF text by page, other text in 12,000-character chunks. Images go to vision models directly and are also stored as collection media so cards can use them.
- `ui(action, path?)` navigates the app (a deck, Browse, a type, Market, Stats, Settings, Practice) or refreshes the page.

The system prompt describes Etude, lists the card types and decks, and asks the assistant to look commands up before using them, dry-run big writes, write packs for many cards, only use facts from the material, and reply briefly in the user's language. See `systemPrompt()` in `src/core/agent.ts`.

Conversations are stored in the collection's database (`agent_conversations`, `agent_messages`), attachments in `$ETUDE_HOME/agent-attachments/<conversation>/`.

## HTTP API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/agent/models` | `{ configured, default, groups }` (`?force=1` refreshes the cached list) |
| GET, POST | `/api/agent/conversations` | list; create `{ model? }` |
| GET, PATCH, DELETE | `/api/agent/conversations/:id` | one conversation with messages; `{ model }`; delete |
| POST | `/api/agent/conversations/:id/attachments?name=` | upload (`application/octet-stream`) |
| POST | `/api/agent/conversations/:id/messages` | `{ text, attachments, model?, page? }`, answered as a server-sent event stream |
| POST | `/api/agent/turns/:turn/confirm` | `{ callId, allow }` |
| POST | `/api/agent/turns/:turn/stop` | |
| POST | `/api/agent/conversations/:id/undo` | `{ messageId? }` |

Stream events: `start` (turn id, conversation, the saved user message), `text` (a delta), `tool_start`, `tool_end`, `confirm` (a command waiting for Allow/Deny), `ui`, `changed`, `error`, `done` (the saved reply). Closing the tab doesn't stop a reply; it is saved and shows up when the panel opens again.

## CLI

```sh
etude agent ask "make a deck from these notes" --attach notes.md
etude agent ask -c <id> "now move it under Biology"
etude agent ask --yes "delete the Scratch deck"     # without --yes, confirmations are denied
etude agent list
etude agent show <id>
etude agent undo <id> --yes
etude agent delete <id> --yes
```

`agent ask` prints `{ conversation, reply, commands, changed, canUndo, model, ms }` and lists each command on stderr as it runs. The full reference is in [cli.md](cli.md).
