# Ask Etude: the in-app assistant

A chat inside Etude that can do anything the CLI can: make decks from your notes, move and rename decks, change the theme, install from the Market, find and fix cards. It uses the AI you already set up in Settings → AI.

## Using it

- Open it with the round button in the bottom-right corner, or <kbd>Ctrl</kbd>+<kbd>J</kbd> (<kbd>⌘</kbd>+<kbd>J</kbd> on a Mac). <kbd>Esc</kbd> closes it. It isn't shown while you practice.
- On a computer the panel sits on the right and pushes the page over; drag its left edge to resize it. On a phone it opens full screen.
- Pick who you talk to with the picture and name at the top of the chat (see Agents below). Picking someone else starts a new chat with them; each chat keeps its agent, and History shows each chat's picture.
- When the agent's brain is a model, pick the model under the message box. The choice belongs to the conversation, and new chats start with the last one you picked.
- Attach files with the paperclip, by dropping them on the panel, or by pasting: images (png, jpg, webp, gif), PDFs, text files (markdown, csv, json, code) and Anki packages (`.apkg`, `.colpkg`). Up to 50 MB each.
- Each command the assistant runs shows as a row; click it to see the output.
- History (the clock icon) lists past conversations; the plus starts a new one.

## Safety

- **Confirmation.** Commands that delete or replace things (the ones the CLI marks as needing `--yes`) never run straight away. The panel shows the command and a dry-run preview with **Allow** and **Deny**. Deny tells the assistant it wasn't done.
- **Permissions.** The shield in the message box (or `etude agents permission <level>`) sets how much is asked, for every chat on the collection: **Ask for everything** (`ask`: every command that changes something waits for a yes), **Only dangerous** (`dangerous`, the default: the commands above) or **Allow everything** (`allow`: nothing is asked). An external agent decides for itself what needs a yes and sends those as permission requests; the level sets which of them reach you. Under `dangerous`, Etude answers yes to reads and file edits and shows the rest (commands, deletes, anything it can't name, and edits to `.env`, keys, `.git` or `.ssh`); under `allow` it answers yes to all of them; under `ask` you see every one. The level lives beside the chats (`agent_kv`, `agent-permission`), and the assistant can't change it: `agents permission` is refused for Ask and `etude mcp`.
- **Steer.** Typing while a reply is being written turns Stop into Steer: the words go to the model after the step it's on, with its next tool result, and the reply carries on with them in mind. With a model Etude runs, they're added to the conversation after the running step (and after an answer that was about to end the turn). With an external agent they go through the agent's own `/steer` command, when it lists one in `available_commands_update` (Hermes does); an agent without it can't be steered, and the message is sent when the reply ends instead. The words are saved in the reply where they landed (a `steer` item).
- **Undo.** Before the first change in each reply, Etude snapshots the collection (`VACUUM INTO` into `$ETUDE_HOME/agent-snapshots/`, the last 10 are kept). A reply that changed something has an **Undo these changes** button that puts the collection back as it was before that reply. Changes made after it are undone too. Conversations themselves aren't rewound. Media files copied in by the reply stay on disk.
- **Limits.** At most 25 tool calls per message. **Stop** ends a running reply at the next step.
- **Blocked commands.** The assistant can't run `serve`, `update`, `settings chatgpt login/logout/import`, `db restore`, `market publish` or the `agent` commands, and can't point a command at another database with `--db`. Settings output never contains API keys.
- **Outside the collection.** Attached files, deck text and Market entries can carry instructions, so the assistant treats them as material and is limited before a command runs: `settings set/unset` only for day start, learn-ahead, theme, auto feedback, language and model names (never provider URLs, API key names or `market.*`); no `--out`, backup destinations or exports that write files; file paths only from the chat's own attachments; no `--url` on Market commands. The user's own CLI and Settings page aren't limited.

## Agents: who you talk to

An agent profile is someone to talk to in Ask: a name, a round picture, an optional body for the corner, a personality in your words, and a brain. Minimi is the first and is built in (he can be changed, not deleted). Settings → AI → Agents has one card per agent, Minimi first: its name, Default (or Make default) and a ⋯ menu (Duplicate, Delete), its brain, its personality and, folded, its look. Everything saves as you change it. New agent adds a card. From a terminal: `etude agents`.

- **Picture**: a picture you upload (cropped to a circle in the app), Minimi's faces, or the name's first letter.
- **Body**: a transparent PNG or WebP that sits in the corner where Minimi sits, at his size, with the same drag, resize and hide. Without one, the corner shows the picture in a round button. The corner follows the default profile.
- **Banner**: what a new chat with the agent shows before the first message. With one, the chat opens on that picture alone, in the middle, its edges fading into the page; without one it opens on the agent's picture, a question, what's due today and up to three things to ask. Any image; set it under the card's Look or with `etude agents edit <id> --banner <file>` (`--banner none` removes it). It syncs like the other pictures.
- **Animation**: a body can also move, like Minimi in his Christmas outfit: four clips, `read-loop` (idle), `look-up`, `look-loop` (while you're on it: hover, drag, the chat open, its menu) and `look-down`, each a VP9 WebM with transparency (`-pix_fmt yuva420p`), at most 4 MB, and optionally in two heights, 248 and 533 pixels (`read-loop-248.webm`, `read-loop-533.webm`…), so the app plays the one closest to its size on screen. The body picture shows until the first frame and wherever WebM with alpha can't play (Safari, iPad, reduced motion). Add them under the card's Look (four slots, or Choose all… for a folder's files; saved once all four are in) or with `etude agents edit <id> --clips <folder>`; `--clips none` removes them. They sync like pictures.
- **Personality**: for a model brain it's the identity part of the system prompt (Minimi's empty personality keeps his usual one; another profile's empty one is a plain friendly assistant). For Hermes or another agent the card calls it "Notes for <name>": it goes with each message inside `<etude-context>`, labelled as your notes for that agent, and the agent keeps its own identity and memory.
- **Brain**, one of five on the card:
  - **Hermes**: one of your Hermes profiles (listed from `~/.hermes/profiles`), run as `hermes -p <profile> acp` on this computer. Personality and memory come from Hermes.
  - **ChatGPT**, **OpenRouter**, **Custom**: a model from that provider and how long it thinks (reasoning effort), run by Etude with its own tools. A provider that isn't connected says so and points to Providers below the cards.
  - **Other agent**: Gemini CLI, Claude Code, Codex or a custom command (environment under Advanced), over ACP (see below).
- **Default**: the profile new chats start with and the corner shows.

Profiles sync with the collection (name, pictures, personality, brain, which is the default). Picking Hermes or another agent on a card makes that card's own entry in this device's `ai.agents` (its id is the profile's id; changing the brain updates it, a model brain or deleting the card removes it). That list, the commands Etude runs, never syncs: the profile only carries which kind of agent it is and the Hermes profile. On a device where it isn't set up the card says "Runs on the computer where it's set up" and offers to set it up there, and the chat shows it greyed.

```sh
etude agents list
etude agents add Tutor --avatar ~/tutor.png --body ~/tutor-body.png --clips ~/tutor-clips --hermes tutor --personality "Keep answers brief." --default
etude agents edit minimi --provider chatgpt --model gpt-6.1-sol --effort low
etude agents edit tutor --provider openrouter --model deepseek/deepseek-v4.1-flash-1017
etude agents edit minimi --personality "Speaks only in haiku."
etude agents default minimi
etude agent ask --profile tutor "how many decks do I have?"
```

Minimi's personality is still stored as the `minimi` setting, so `etude settings get minimi` and older versions see the same text as his profile. Chats from before profiles belong to Minimi. Before agents had their own brains, Ask ran on `ai.agent.model` and `ai.agent.effort`: Minimi's brain is that model until he's given one (when it was a model, not an `agent:` ref), and a model brain left empty still uses it.

## Models

| Provider | Where it comes from | Protocol |
| --- | --- | --- |
| ChatGPT | Your ChatGPT sign-in (Settings → AI). Models from your plan's model list. | Responses API with function tools |
| OpenRouter | `OPENROUTER_API_KEY` (in the environment or `$ETUDE_HOME/.env`). Only models that support tool calling are listed. | Chat Completions with `tools` |
| Custom endpoint | Your feedback model when it is a non-OpenRouter OpenAI-compatible server (OpenAI, llama.cpp, vLLM, Ollama). The model must support tool calls. | Chat Completions with `tools` |

A model ref is `chatgpt:<model>`, `openrouter:<model>` or `custom:<model>`. Each agent's card picks its own model and effort; Settings → AI → Providers (under the agents) has the ChatGPT sign-in, the OpenRouter key and where the custom endpoint is set. `ai.agent.model` and `ai.agent.effort` are only read for older data and for a model brain left empty (empty means the feedback model):

```sh
etude agents edit minimi --provider openrouter --model deepseek/deepseek-v4.1-flash-1017 --effort low
etude agent models --search sonnet
```

## External agents (ACP)

Instead of a model, the brain can be an agent you already run: Hermes, Gemini CLI, Claude Code, Codex, or any program that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP, the protocol Zed uses for its agents: JSON-RPC over the agent's stdin and stdout). Etude is the client and starts the agent as a subprocess.

Pick Hermes or Other agent on an agent's card in Settings → AI → Agents. The presets:

| Preset | Command | Needs |
| --- | --- | --- |
| Hermes | `hermes -p <profile> acp` (profile field, default `default`; the name follows the profile, so `tutor` is called Tutor) | Hermes Agent |
| Gemini CLI | `gemini --acp` | Gemini CLI |
| Claude Code | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp` (Zed's adapter; it was `@zed-industries/claude-code-acp`) |
| Codex | `codex-acp` | `npm install -g @agentclientprotocol/codex-acp` |
| Custom command | any command, arguments and environment | |

An external agent is an agent profile's brain; it isn't in the model picker. From the CLI, `--hermes <profile>` makes the entry the way the card does. The list itself is the `ai.agents` setting, and `--external <id>` points a profile at an entry you wrote by hand:

```sh
etude agents add Tutor --hermes tutor
etude settings set 'ai.agents=[{"id":"mine","name":"Mine","command":"my-agent","args":["--acp"]}]'
etude agents add Mine --external mine
etude agent ask --profile tutor "how many decks do I have?"
```

What happens:

- **One process per agent.** It starts on the first message that uses it and stays for later chats. It runs with your environment (minus the engine's API token), in your home folder unless `cwd` is set, in its own process group, and stops with the server or the desktop app.
- **What the agent gets.** `initialize` offers no file system and no terminal of Etude's own (the agent has its own). `session/new` hands it one MCP server, `etude mcp` named `etude_app` (so it isn't confused with an Etude server the agent already has, which may point at another collection), run by the same program and CLI as the app with `ETUDE_DB` set to the collection the app has open, so its changes land where you are looking. Each message starts with a short `<etude-context>` block (the page you're on, the deck or note); images go as image blocks and text files as embedded resources when the agent supports them, other files as links.
- **Streaming.** `agent_message_chunk` becomes the reply, `tool_call` and `tool_call_update` become the panel's steps, `plan` shows as one step. The panel header shows the profile's picture and name; Settings shows the title the agent gives itself in `agentInfo` beside its profile.
- **Permissions.** `session/request_permission` shows the agent's own options (Allow once, Always allow, Reject…) as buttons in the chat, and the chosen `optionId` goes back. Stop sends `session/cancel` and answers a waiting request as cancelled. `etude agent ask` rejects them unless `--yes`.
- **Undo.** The collection is snapshotted before the agent's first step that may write; writes show up as the database changing underneath (another process wrote), and the reply gets the usual Undo button. A change there is checked against the snapshot first, so a reply that only read gets none: opening the collection in `etude mcp` can commit fresh query-planner statistics, which moves the database without changing anything you have.
- **Sessions.** The agent's session id is kept with the chat. Reopening the chat later uses `session/load` when the agent supports it; otherwise it starts a new session and the reply says so in one line.
- **Desktop and local server only.** Agents are programs on your computer. In the web app and the phone apps a card can still show Hermes or another agent (it syncs), but it answers only on the computer where it's set up.
- **Who can set them.** Only you, in Settings or with the CLI. Ask Etude (with any model) and `etude mcp` refuse to set or reset `ai.agents` or the whole `ai` object: text in an attachment could otherwise make Etude run a program. The same goes for agent profiles: `etude agents add/edit/duplicate/remove/default` and the settings `agentProfiles`, `agentProfile` and `minimi` are refused for both, so a prompt injection can't change who you're talking to or what they're told.

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
| POST | `/api/agent/turns/:turn/confirm` | `{ callId, allow, optionId? }` (`optionId`: one of an external agent's options) |
| POST | `/api/agent/turns/:turn/stop` | |
| POST | `/api/agent/turns/:turn/steer` | `{ text }` for the running reply; `{ steered }` is false when the turn is over or its agent can't take words mid-reply |
| GET, PUT | `/api/agent/permission` | `{ permission }`: `ask`, `dangerous` or `allow` |
| POST | `/api/agent/conversations/:id/undo` | `{ messageId? }` |

Stream events: `start` (turn id, conversation, the saved user message), `text` (a delta), `tool_start`, `tool_end`, `confirm` (a command waiting for Allow/Deny), `steer` (words taken mid-reply), `ui`, `changed`, `error`, `done` (the saved reply). Closing the tab doesn't stop a reply; it is saved and shows up when the panel opens again.

## CLI

```sh
etude agent ask "make a deck from these notes" --attach notes.md
etude agent ask -c <id> "now move it under Biology"
etude agent ask --yes "delete the Scratch deck"     # without --yes, confirmations are denied
etude agent list
etude agent show <id>
etude agent undo <id> --yes
etude agent delete <id> --yes
etude agents permission                              # ask, dangerous or allow
etude agents permission ask
```

`agent ask` prints `{ conversation, reply, commands, changed, canUndo, model, ms }` and lists each command on stderr as it runs. The full reference is in [cli.md](cli.md).

## Tabs

The panel holds several chats at once, each in a tab (`Alt+T` opens one, `Alt+W` closes the one in front, and closing the only tab closes the panel, `Alt+1`…`9` picks one). Every tab is its own conversation and its own turn, so one can be working while you talk in another; a tab that's working shows a spinner and one that finished behind another shows a dot. Tabs come back after a reload. Closing a tab leaves its chat in the history. The server already ran one turn per conversation; nothing there is shared between tabs.

## What a reply can show

A reply is still plain text. Marks in it, each on its own line, become things in the chat (`web/src/lib/agent-rich.ts` reads them, `web/src/components/agent-rich.tsx` draws them, `src/core/agent-show.ts` tells the agent about them with every message):

| In the reply | Shows |
| --- | --- |
| `MEDIA:/absolute/path` | A file from this computer: a picture (click to enlarge), a voice player for audio, a video, a PDF, or an `.html` file run as a widget |
| ```` ```widget ```` fence | HTML, CSS and JS in a sandboxed frame with the app's colours and look. `etude.send("…")` or `data-etude-send="…"` sends the user's next message. JSON `{"url"}` or `{"file"}` frames a page instead |
| ```` ```chart ```` fence | JSON `{type: line, bar, area, pie, donut or scatter, title?, x, series: [{name, data}], unit?, stacked?}` |
| ```` ```note ```` fence | A JSON array of note blocks, shown the way a page shows them, read only |
| `::card{id=…}`, `::cards{deck="A::B" n=5}` | Flashcards answered in the chat (the `/embed` route: real reviews) |
| `::sticker{file="…"}` | A picture with no bubble |

Lotus's `::preview{file=…}`, `hermes.send` and `data-hermes-send` work too, so a widget written for Lotus runs as it is.

Local files are served by `GET /api/agent/conversations/:id/shown?path=…`, only for a chat with an agent that runs on this computer, only a path that agent wrote in that chat, and only pictures, audio, video, PDFs and HTML (sent as text). When the reply is saved the files it named are copied into `agent-attachments/<conversation>/shown/`, so the chat still shows them after the original moves. A model's reply (ChatGPT, OpenRouter, a custom server) can never open a local file. A picture or sound an ACP agent sends as data is saved the same way.

`node test/e2e/ask-rich.ts` drives all of this in Chromium with the scripted agent.

## The message box

The text sits on top; under it, in one row: attach, who you're talking to, the model, the reasoning effort, the permissions shield, the context ring and Send. Each pill opens only its own menu. While a reply is being written the last button is Stop, or Steer once something is typed (Enter steers too).

- **External agents (ACP).** The pills are the agent's own `configOptions` from `session/new` and `session/load` (categories `model` and `thought_level`; `mode` is left out, anything else shows in the ring's card). A pick is `session/set_config_option`. Before a chat exists the pills show what the agent offered last time (kept in `agent_kv` as `acp-controls:<agent>`; the first time ever, the agent is started to ask and that session becomes the next new chat's), and picks ride along with the first message (`controls` in the send body). `GET /api/agent/controls?conv=|profile=&warm=1`, `PUT /api/agent/conversations/:id/controls/:control`.
- **Models.** The model pill is the app's own picker; the effort pill sets `effort` for the messages sent from that chat.
- **The ring** fills with the context window: `usage_update` from an agent (used and size), or the last request's tokens from a model (no size, so no ring fill). It's saved with each reply (`usage`). Its card adds when the chat started, the time the replies took, replies and tool calls, who answered, and Rename, Delete and AI settings.
- **Thinking.** `agent_thought_chunk` becomes a `thought` item with how long it took, shown as one "Thought for 8s" line that opens on a click.

The chat history is the clock button beside the tabs.
