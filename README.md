# εtude

Etude is a spaced-repetition app in which every card type is a small program. A type is an HTML template, a stylesheet, a script and a grader, so a card can be a typed answer, a numeric problem with fresh numbers on every review, a drag-to-order list, a drawing, or anything else you can build in a web page. Open answers and drawings are graded by AI: a fast decision model gives the verdict and a language model explains what was missing. Scheduling uses FSRS-6, with presets that cascade through the deck tree and an exam mode that keeps every card inside a deadline. Everything is reachable from a JSON CLI and a plain HTTP API, so the people studying and the agents helping them write cards work with the same collection.

![Decks](docs/screenshots/decks.png)

![A free-answer card after AI grading, with feedback](docs/screenshots/study-feedback.png)

![Browse: search, preview and edit](docs/screenshots/browse.png)

## Features

- **Programmable card types.** Nine built-in types (basic, typed, numeric, multiple choice, order, match, cloze, free answer, drawing) ship as editable files. Custom types are written the same way and edited in the app.
- **Generated items.** An item can carry a generator script, so one item produces endless variants of the same exercise. The seed is stored with each review, so any variant can be reproduced.
- **AI grading.** Free answers go to a decision model (`liquid/d1-ultra` through OpenRouter by default) for a calibrated verdict, then to a chat model for two to four sentences of feedback. Drawings go to a vision model. Any OpenAI-compatible endpoint works, including a local llama.cpp or Ollama server. Grading instructions cascade from the item's rubric through its tags, decks and type.
- **FSRS-6 scheduling** with learning steps, fuzz, per-deck daily limits, new/review ordering, sibling burying, a suggested rating from the grade, undo, and replaying history after a settings change.
- **Exam deadlines.** Set a deadline on a deck and no card is scheduled past it.
- **Search language** for browsing and for filtered study sessions.
- **Packs.** One JSON file carries decks, presets, types and items. Import is idempotent and keeps review history.
- **CLI and HTTP API** that print JSON.
- **Works on phones and tablets**, plus an embeddable study widget at `/embed?deck=...&n=10` for other apps.

## Quick start

Etude needs Node 24 or newer. Node runs the TypeScript sources directly, so there is no compile step for the server.

```sh
npm install
npm run build        # builds the web app into web/dist
npm start            # same as: node src/cli/main.ts serve
```

Open http://127.0.0.1:4610. The collection lives in `~/.etude/etude.db`. To try every card type, import the sampler:

```sh
node src/cli/main.ts import examples/sampler.pack.json
```

The `etude` command (`bin/etude.js`) runs the same CLI. After `npm link` or a global install, `etude serve` and `etude import pack.json` work from anywhere.

## Configuration

| | |
|---|---|
| `~/.etude/.env` | API keys, one per line, e.g. `OPENROUTER_API_KEY=...`. Read at startup; restart after editing. Keys are never stored in the database or shown in the app. |
| `--db PATH` or `ETUDE_DB` | Collection file. Default `~/.etude/etude.db`. Drawings are saved in a `media/` folder next to it. |
| `ETUDE_HOME` | Where `.env` and the default database live. Default `~/.etude`. |
| `--port` or `ETUDE_PORT` | Default 4610. |
| `--host` or `ETUDE_HOST` | Default `127.0.0.1`. Any other address requires a token. |
| `--token` or `ETUDE_TOKEN` | Every `/api` request must then send `Authorization: Bearer <token>` or `?token=<token>`. |

To serve on your local network:

```sh
etude serve --host 0.0.0.0 --token "$(openssl rand -hex 16)"
```

AI providers, feedback language, when feedback is written automatically, the hour a new study day starts and the learn-ahead limit are set on the Settings page, which also has presets for OpenRouter, OpenAI and a local server and a button that grades a sample answer to test your setup.

## Packs

A pack is one JSON file. Every key except `etude` is optional; decks named by items are created as needed.

```json
{
  "etude": "pack/1",
  "name": "Networks",
  "decks": [{ "name": "Networks", "instructions": "Accept answers in ms or s if the conversion is right." }],
  "items": [
    {
      "id": "net.dtrans-1",
      "type": "numeric",
      "deck": "Networks::Delay",
      "fields": { "prompt": "A 1,500-byte packet on a 10 Mbps link. Transmission delay?", "answer": 1.2, "unit": "ms" }
    },
    {
      "id": "net.why-packets",
      "type": "free",
      "deck": "Networks::Switching",
      "fields": {
        "prompt": "Why can packet switching serve more users than circuit switching on the same link?",
        "reference": "Users are idle most of the time, so the link is shared statistically instead of reserving capacity per user.",
        "rubric": "Must mention that users are not all active at once."
      }
    }
  ]
}
```

Import from the Decks page or Settings → Data, or from a terminal:

```sh
etude import networks.pack.json --dry-run   # report what would change
etude import networks.pack.json
node scripts/check-pack.ts networks.pack.json   # validate every item, including generated variants
```

Items are matched by `id`, so importing an edited pack updates the content and keeps scheduling. [docs/packs.md](docs/packs.md) documents the format, generators and the fields of every built-in type.

## Card types

A card type is a folder: `type.json` (fields and grader), `template.html`, `style.css`, `card.js` (runs in the card's frame), an optional `prepare.js` (turns stored fields into what the card shows, and keeps the answer key out of the frame) and an optional `grade.js`. Graders are `self`, `script`, `ai` or `hybrid` (a script that can hand hard cases to the AI). The built-in types live in [`types/`](types/) and are the best examples. Export one with `etude type-export mcq -o mcq/`, change it, and bring it back with `etude type-import mcq/`. See [docs/types.md](docs/types.md).

## Scheduling

Cards are scheduled with FSRS-6 (via [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)). Settings come in layers: the defaults, then for each deck from the root down, its preset and its own overrides. A preset on `CMPT 371` therefore applies to `CMPT 371::Week 1` unless that subdeck overrides it. Retention, learning steps, limits, ordering, FSRS weights and how scores turn into suggested ratings are all set per layer.

A deck can have an exam `deadline`. No card in it is scheduled after the deadline minus a margin (12 hours by default). A card that would come back later is pulled in, usually to halfway between now and the deadline, so even a well-known card gets one more look. After changing retention, steps or a deadline, `etude reschedule --deck NAME` replays the review history with the new settings; the deck page offers the same thing when you save such a change.

## Search

The same language works in Browse, in filtered study sessions and in `etude search`:

```
deck:"CMPT 371"       the deck and everything below it      (deck:cmpt* wildcards)
tag:cmpt371::w1       the tag and every tag below it        (tag:exam::* wildcards)
type:numeric  id:cmpt371.w1.*  source:KR
is:new is:learning is:review is:relearning is:due is:suspended is:buried is:archived
prop:lapses>=2  prop:reps=0  prop:stability<3  prop:difficulty>7  prop:due<=1 (days from now)
rated:1  rated:7:1    reviewed in the last N days (optionally with that rating)
word  "a phrase"      text anywhere in the item's fields
-term  a OR b  (grouping)   implicit AND between terms
```

## CLI for scripts and agents

```
etude <command> [options]

  serve [--port 4610] [--host 127.0.0.1] [--token T]   run the app and API (--web DIR serves another build)
  import <pack.json>... [--dry-run]                    add or update items from packs (idempotent)
  export [--deck D] [--q QUERY] [-o file.json]          write a pack
  decks                                                deck tree with due counts
  search <query> [--limit N]                           find cards (same language as the app)
  show <item-id>                                       an item with its cards and history
  next [--deck D] [--q QUERY]                          the card that would be shown next
  stats [--deck D] [--q QUERY]                         collection statistics
  reschedule [--deck D] [--q QUERY]                    replay review history with current settings
  types                                                list card types
  type-export <id> [-o dir]                            a type as editable files
  type-import <dir|type.json>                          create or update a type

Global: --db PATH (or ETUDE_DB). Default ~/.etude/etude.db.
```

Output is JSON, and errors are printed to stderr as `{"error": "..."}` with exit code 1. An agent can write a pack, check it with `--dry-run`, import it, and read `stats` or `search 'rated:1:1'` to see what the learner is getting wrong. Everything the web app does also goes through the HTTP API in [`src/server/app.ts`](src/server/app.ts).

## Architecture

```
src/core/     the engine, no HTTP: data model and SQLite store (node:sqlite), FSRS scheduler,
              search compiler, QuickJS sandbox for user scripts, AI grading, packs
src/server/   Hono HTTP API, card frame documents, static files for the web app
src/cli/      the etude command
runtime/      runtime.js and card.css, loaded inside every card frame
types/        the built-in card types, one folder each
web/          React, Tailwind and shadcn/ui app (Vite)
examples/     sampler.pack.json with every card type
scripts/      check-pack.ts
test/         node:test suites
```

## Security model

- **Cards run in sandboxed frames.** Each card is its own document loaded into an `<iframe sandbox="allow-scripts">` with no same-origin permission, so it has an opaque origin. Card code can't read the app, its storage or the API, and it talks to the app only through `postMessage`. Private fields (answers, reference solutions) stay on the server until the answer is submitted.
- **User scripts run in QuickJS.** Generators, `prepare` and `grade` scripts execute on the server in a QuickJS WebAssembly sandbox with no host access, a memory cap and a time limit. Only JSON goes in and out.
- **The server is local by default.** It binds to `127.0.0.1` and refuses any other address unless a token is set.
- **Cross-site writes are refused.** Every API request that changes something must be `application/json`, and requests whose `Origin` is a different site get a 403, so another web page can't drive your local server.
- **Keys stay in the environment.** Provider keys are read from the environment or `~/.etude/.env`. The app only reports whether each variable is set.

## Development

```sh
npm run dev          # API on :4610, restarts on changes (no web build needed)
npm run dev:web      # Vite on http://localhost:4611, proxies /api, /frame, /runtime and /media to the API
npm test             # node --test "test/**/*.test.ts"
npm run typecheck    # server and web
```

Set `ETUDE_PORT` for both commands to run the dev API on another port.

## License

[MIT](LICENSE)
