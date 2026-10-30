# εtude

[![Mentioned in Awesome FSRS](https://awesome.re/mentioned-badge.svg)](https://github.com/open-spaced-repetition/awesome-fsrs#etude)

**Flashcards that can be anything a web page can be.**

Etude is a self-hosted spaced-repetition app where every card type is a small program. A card can give you fresh numbers to compute on every review, ask you to drag events onto a timeline, play a chord on a piano, find the checkmate on a real board, write a proof that renders as you type, or draw a diagram that a vision model grades. Open answers are graded by AI, which tells you exactly what you missed. Scheduling is FSRS-6, with exam deadlines that make sure everything gets reviewed before the day. And every action in the app is also a CLI command with JSON output, so an AI agent can build your decks, quiz you in a chat and find your weak spots.

![Decks](docs/screenshots/decks.png)

![A proof by induction graded by AI, with feedback](docs/screenshots/study-feedback.png)

![Browse: search, preview and edit, with a chess card open](docs/screenshots/browse.png)

![Stats: recall now, true retention, streak, and what you'd forget if you stopped today](docs/screenshots/stats.png)

## Why another flashcard app

Classic flashcards test recognition: you see the front, think of the back, flip the card and judge yourself. That works for vocabulary. It works badly for most of what people actually study, where the skill is doing something: computing, deriving, tracing an algorithm, explaining why. Etude keeps what makes spaced repetition work and changes what a card is.

| | Classic flashcard apps | Etude |
|---|---|---|
| What a card is | A front and a back | A program: template, script and grader |
| Who grades it | You | You, a script, AI, or a script that hands hard cases to AI |
| Calculation practice | Same numbers every time, so you end up memorizing the answer | A generator makes a new variant every review |
| Open answers | You compare with the back | An AI verdict plus a few sentences on what was missing |
| Math answers | Shown, never checked | Typed with live rendering, graded by equivalence (`x(x+1)` = `x^2+x`) |
| Exam dates | Intervals ignore them | A deadline pulls every card in before the exam |
| Automation | Add-ons, or editing the database | Every action is a CLI command with JSON output |

## With AI or without it

AI is optional. Etude doesn't need an account, a key or an internet connection, and nothing is sent anywhere until you turn AI on.

**Without AI**, Etude is a flashcard app you fully control. Your collection is one SQLite file on your own machine. Most card types are checked by scripts, not by a model: numbers with a tolerance, math by equivalence, code against tests, chess moves against the engine's list, chords by their notes, or you rate yourself as in any flashcard app. Every card type, theme and scheduling setting is yours to edit.

**With AI**, Etude goes further:

- **Feedback on your answers.** Explanations, proofs and drawings get a verdict and a few sentences on what was missing and how to fix it.
- **Cards made from what you need to study.** Hand an agent your lecture notes, slides or a textbook chapter. It writes the cards as a pack, checks them and imports them.
- **An assistant that manages your collection.** Through the CLI an agent can reorganize decks, reword or split cards you keep failing, set an exam deadline and reschedule around it.
- **Knowing what to review next.** An agent can read your statistics, tell you which topics are slipping and quiz you on them in a chat.

The first one is built into the app: sign in with your ChatGPT plan or add an API key in Settings. The rest work with any agent that can run commands, using the bundled [skill](skill/SKILL.md).

## What a card can be

Every card below is a real card type from the [showcase pack](examples/showcase/), screenshotted after answering it. Each one is a folder of HTML, CSS and JavaScript you can open and change, and each is graded by something that actually checks the work.

<table>
<tr>
<td width="50%" valign="top">
<p><b>Write kanji by hand.</b> Draw the character with a mouse, pen or finger. A vision model reads your strokes against a description of the character and tells you what to fix.</p>
<img src="docs/screenshots/cards/kanji.png" alt="Writing the kanji for water by hand, graded by a vision model with feedback">
</td>
<td width="50%" valign="top">
<p><b>Solve chess puzzles on a real board.</b> Tap or drag the move. The answer is checked against the engine-verified list of mates, so any correct move counts.</p>
<img src="docs/screenshots/cards/chess.png" alt="A mate-in-one chess puzzle solved on the board">
</td>
</tr>
<tr>
<td width="50%" valign="top">
<p><b>Play chords on a piano.</b> A new root and quality every review. Any voicing or inversion counts, because the grader compares pitch classes. Hear your chord and the right one.</p>
<img src="docs/screenshots/cards/chord.png" alt="Building an A major 7th chord on a piano keyboard, with each chord tone checked">
</td>
<td width="50%" valign="top">
<p><b>Read music.</b> A new note on the treble or bass staff every review, ledger lines and accidentals included. Answer on the keyboard or with the letter keys.</p>
<img src="docs/screenshots/cards/staff.png" alt="Middle C on a treble staff with a piano keyboard to answer on">
</td>
</tr>
<tr>
<td width="50%" valign="top">
<p><b>Trace algorithms.</b> Tap the nodes of a generated graph in the order BFS or DFS visits them. The real traversal animates afterwards.</p>
<img src="docs/screenshots/cards/graph.png" alt="Tapping the nodes of a generated graph in breadth-first order">
</td>
<td width="50%" valign="top">
<p><b>Place history on a timeline.</b> Drag events between fixed anchors. Graded by order and by how many years each one is off.</p>
<img src="docs/screenshots/cards/timeline.png" alt="Dragging computing milestones onto a timeline">
</td>
</tr>
</table>

The pack also has ear training (name the interval you hear), regexes with live tests, spotting the buggy line in a listing, binary and two's complement switches, the unit circle, points on a graph, balancing chemical equations, colors from hex codes, Fermi estimates on a log slider and 30-second arithmetic sprints. Import it and try them all:

```sh
etude pack import examples/showcase.pack.json
```

## Decks from the Market

Whole decks are built the same way, and the [Market](https://github.com/Zibhelina/etude-market) installs them in one click. These are some of the first ones:

<table>
<tr>
<td width="33%" valign="top">
<p><b>Countries of the world.</b> All 197 countries in one subdeck per continent, on a real map with zoom and pan. Name the highlighted country, or find the one that's named. Names in English, Portuguese, Spanish and French count, typos too, and a wrong pick tells you if it was a neighbour.</p>
<img src="docs/screenshots/market/countries.png" alt="Brazil highlighted on a map of South America, answered correctly">
</td>
<td width="33%" valign="top">
<p><b>The periodic table.</b> All 118 elements, each asked eight ways: symbol, name, find it on a blank table, name a lit cell, atomic number and position, mass, family and block, electron configuration.</p>
<img src="docs/screenshots/market/periodic-table.png" alt="Finding iron on the periodic table, with its tile and electron configuration">
</td>
<td width="33%" valign="top">
<p><b>Flippy Bit.</b> One card that's a whole arcade game. Invaders fall carrying a hex number and you flip eight bits to shoot them down before they land. It runs on the drill scheduler, so it never runs out and every run is kept.</p>
<img src="docs/screenshots/market/flippy-bit.png" alt="Flippy Bit: hex invaders falling over a city, with eight bits to flip">
</td>
</tr>
</table>

The Market also has a Morse code deck, the Showcase, single card types and 22 themes, including Catppuccin, Gruvbox, Nord, Tokyo Night, Rosé Pine and Dracula.


## What you can do with it

- **Prepare for an exam.** Put the course in a deck, set the exam date as its deadline and study every day. No card is scheduled after the deadline, and cards you already know still get one last look before it. The Stats page forecasts how many reviews are left each day until then.
- **Practise calculations instead of memorizing answers.** A numeric item can carry a generator, so "the transmission delay of an L-byte packet on an R Mbps link" comes back with different numbers every time. The seed is stored with each review, so any variant can be reproduced.
- **Explain things in your own words.** Free-answer cards are graded against a reference answer and a rubric. You get a verdict and two to four sentences on what was missing and how to fix it, in the language of the card.
- **Write math and code the way you would on paper.** Answer fields are live Markdown editors, like Obsidian: `$math$`, code blocks and formatting render as you type, so a derivation can be the answer. Code cards have a real editor with highlighting for about 140 languages, and JavaScript answers run against hidden tests in a sandbox.
- **Draw your answer.** Write kanji or hanzi by hand, sketch a graph, a circuit or a molecule, and a vision model grades it.
- **Learn skills that aren't text.** Music, chess, algorithms and history become cards you play, move, tap and drag, as in the gallery above. If the skill you want isn't there, a card type is a web page, so you can build it.
- **Let an agent make your cards.** Give an agent your notes and the bundled [skill](skill/SKILL.md). It writes a pack, validates it with `etude pack check`, imports it, and later reads `etude stats weak` to see which topics you keep failing.
- **Train a skill you measure.** Put a deck on the `drill` scheduler and a card comes back as often as you want, with no rating buttons. A typing test keeps your WPM and accuracy from every run, and Stats charts them over time.
- **Get quizzed in a chat.** An agent can run a study session without the web app: `etude study next` returns the card and how to answer it, and `etude study answer` grades and schedules it.
- **Study from anywhere on your own server.** Run Etude on your computer and open it from your phone or tablet; the layout is made for phones too. A compact study view at `/embed` fits inside other apps.

## Features

- **Programmable card types.** Twelve built-in types ship as editable files: basic, typed answer, cloze, numeric, multiple choice, match, order, free answer, math, code, drawing and image occlusion. Custom types are written the same way and edited in the app with a live preview.
- **Four kinds of grader.** `self` (you rate), `script` (checked by code, with partial credit), `ai` (a decision model plus feedback) and `hybrid` (a script that hands the cases it can't decide to the AI). Grading instructions cascade from the item's rubric through its tags, decks and type.
- **AI providers you choose.** Sign in with ChatGPT to grade with your Plus or Pro plan, or use an API key. The API defaults use OpenRouter: `liquid/d1-ultra` for the verdict, a fast chat model for feedback and a vision model for drawings. Any OpenAI-compatible endpoint works, including a local llama.cpp or Ollama server. AI stays off until you add a key.
- **FSRS-6 scheduling** with learning steps, fuzz, per-deck daily limits, new and review ordering, sibling burying, a suggested rating from the grade, undo, and replaying history after a settings change. **Optimize** fits the FSRS weights to your own review history, as in Anki.
- **Pluggable schedulers.** Each deck picks FSRS, `drill` (for skills you measure), `leitner` (classic boxes) or a `schedule.js` of your own.
- **Practice ahead** when nothing is due, **bury** or **suspend** a card or its whole note with one key, and **undo** even after you've moved on to the next card.
- **Settings that inherit down the deck tree.** A preset on `Physics` applies to `Physics::Waves` unless that deck overrides it.
- **Exam deadlines** per deck.
- **A deck tree you can rearrange.** Drag a deck anywhere: onto another deck to put it inside, between rows to reorder it, or out to the top level. Each row shows its total cards next to New, Learn and Due.
- **Card types in folders**, and card types can ship their own files (3D models, maps, data) once instead of in every card.
- **Edit for me.** Describe a change to a card and AI proposes the new fields for you to accept. A card type can also hide the verdict after an answer, for cards where Correct means nothing, like a typing test.
- **A search language** for Browse, filtered study sessions and the CLI.
- **Packs.** One JSON file carries decks, presets, tags, card types and items. Import is idempotent and keeps review history.
- **Statistics:** recall now against your target, true retention, streaks, a forgetting curve for what happens if you stop today, memory strength, a 24-hour study clock, the forecast up to a deadline and recall per tag. Each scheduler gets its own numbers.
- **Themes:** six built in (four dark, two light), or your own with CSS variables and extra CSS.
- **A complete CLI** with more than 140 commands, stable JSON output, a machine-readable catalog (`etude commands`) and a dry run on most commands that change data.
- **Updates from GitHub in one click.** When there are new commits an Update Etude button appears at the bottom of the sidebar and updates the app in place (Settings → About shows the version and checks on demand); `etude update` does the same from a terminal.
- **Import from Anki.** `.apkg` and `.colpkg` files bring their notetypes, decks, tags, media and review history across; see [docs/anki.md](docs/anki.md).
- **Ask Etude, an assistant in the app.** The round button in the corner opens a chat that runs Etude's own commands for you: a deck from your notes or a PDF, a reorganized tree, a new theme. Deletes wait for your OK and every change can be undone. See [docs/agent.md](docs/agent.md).
- **A market for themes, decks and card types.** The Market tab installs what other people shared from [etude-market](https://github.com/Zibhelina/etude-market), and Publish shares yours as a pull request; see [docs/market.md](docs/market.md).

## Quick start

**On a Mac**, download the app from the [latest release](https://github.com/Zibhelina/etude/releases/latest) ([Apple Silicon](https://github.com/Zibhelina/etude/releases/latest/download/Etude-mac-apple-silicon.dmg), [Intel](https://github.com/Zibhelina/etude/releases/latest/download/Etude-mac-intel.dmg)) and drag it to Applications. It has Node inside and opens on the showcase.

**Anywhere else**, Etude needs Node 24 or newer. Node runs the TypeScript sources directly, so the server has no compile step.

```sh
git clone https://github.com/Zibhelina/etude.git
cd etude
npm install
npm run build        # builds the web app into web/dist
npm start            # same as: node src/cli/main.ts serve
```

Open http://127.0.0.1:4610. Your collection lives in `~/.etude/etude.db`.

Paste an image, audio or video file into a card field and Etude copies it into its own media folder, normally `~/.etude/media`. Pasted local file paths and `file://` URLs are copied too; the card uses the copy even after the original is moved or deleted. Settings → Data shows the folder, and `etude media add ./picture.png` imports a file from the terminal. When Etude runs on another computer, paste the file itself; local paths refer to the computer running Etude. Back up the media folder along with the database. Settings → Clean up (or `etude media prune`) deletes media files nothing names any more, and cards on faces their type no longer makes.

To see what cards can be, import the showcase: one card for each of the 28 card types. It opens in Watch mode, a tour where each card can show an example answer, graded, so you see how it works without answering anything:

```sh
node src/cli/main.ts pack import examples/showcase.pack.json
```

`npm link` puts the `etude` command on your path, so `etude serve` and `etude pack import file.json` work from anywhere.

### Turn on AI grading

**With your ChatGPT plan.** If you have ChatGPT Plus or Pro, open Settings → AI grading and click **Continue with ChatGPT**. Sign in in the browser and grading uses your plan's included usage, with no API key. You can cap how much Etude may use, or disconnect it, in ChatGPT's settings. Sign in from a browser on the computer that runs Etude (or run `etude settings chatgpt login` there); after that, grading works from any device.

**With an API key.** Paste it in Settings → AI grading → API keys (or on the first-run setup screen). It is saved to `~/.etude/.env`, readable only by you, and used right away. From a terminal, pipe it in so it stays out of your shell history:

```sh
printf %s "$OPENROUTER_KEY" | etude settings key set OPENROUTER_API_KEY
```

Settings → AI grading has presets for OpenRouter, OpenAI and a local server, plus a button that grades a sample answer to test the setup. [SECURITY.md](SECURITY.md) lists exactly what is sent to the provider.

### Use it from your phone

By default the server only listens on your own computer. To reach it from other devices on your network, give it a token:

```sh
etude serve --host 0.0.0.0 --token "$(openssl rand -hex 16)"
```

Open `http://<your-computer>:4610/?token=<token>` on the phone and add it to the home screen. For access away from home, use a private network such as Tailscale, or a reverse proxy with TLS.

## Configuration

| | |
|---|---|
| `~/.etude/.env` | API keys, one per line, e.g. `OPENROUTER_API_KEY=...`. Read at startup, and written by Settings or `etude settings key set`. Keys are never stored in the database or shown in the app. |
| `--db PATH` or `ETUDE_DB` | Collection file. Default `~/.etude/etude.db`. Pasted media, imports and drawings are saved in a `media/` folder next to it. |
| `ETUDE_HOME` | Where `.env` and the default database live. Default `~/.etude`. |
| `--port` or `ETUDE_PORT` | Default 4610. |
| `--host` or `ETUDE_HOST` | Default `127.0.0.1`. Any other address requires a token. |
| `--token` or `ETUDE_TOKEN` | Every `/api` request must then send `Authorization: Bearer <token>` or `?token=<token>`. |

AI providers, the feedback language, when feedback is written automatically, the hour a new study day starts and the learn-ahead limit are set on the Settings page or with `etude settings`.

## Packs

A pack is one JSON file. Every key except `etude` is optional, and decks named by items are created as needed.

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

Import it from the Decks page, Settings → Data, or a terminal:

```sh
etude pack check networks.pack.json            # validate every item, including generated variants
etude pack import networks.pack.json --dry-run # report what would change
etude pack import networks.pack.json
etude pack new starter.pack.json               # one working item of each built-in type, to edit
```

Items are matched by `id`, so importing an edited pack updates the content and keeps the scheduling. [docs/packs.md](docs/packs.md) documents the format, generators and the fields of every built-in type.

## Card types

A card type is a folder: `type.json` (fields and grader), `template.html`, `style.css`, `card.js` (runs in the card's frame), an optional `prepare.js` (turns stored fields into what the card shows and keeps the answer key out of the frame) and an optional `grade.js`. The built-in types in [`types/`](types/) and the showcase types in [`examples/showcase/types/`](examples/showcase/types/) are the best examples.

```sh
etude type export mcq -o mcq/     # a type as editable files
# edit them
etude type import mcq/            # create or update the type
```

The Card types page does the same in the browser, with an editor and a live preview. [docs/types.md](docs/types.md) is the full reference.

## Scheduling

Cards are scheduled with FSRS-6 (via [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)). Settings come in layers: the defaults, then for each deck from the root down, its preset and its own overrides. Retention, learning steps, limits, ordering, FSRS weights and how scores turn into suggested ratings are all set per layer.

FSRS is the default, not the only choice. Each deck picks a scheduler: `drill` for skills you train and measure (a typing test comes back every day and keeps every WPM, with no rating buttons), `leitner` for classic boxes, or your own few lines of JavaScript. Stats charts what a drill measured instead of predicting recall. See [docs/schedulers.md](docs/schedulers.md).

A deck can have an exam `deadline`. No card in it is scheduled after the deadline minus a margin (12 hours by default). A card that would come back later is pulled in, usually to halfway between now and the deadline, so even a well-known card gets one more look. After changing retention, steps or a deadline, `etude card reschedule --deck NAME` replays the review history with the new settings; the deck page offers the same when you save such a change.

## Search

The same language works in Browse, in filtered study sessions and in `etude search`:

```
deck:"Networks"       the deck and everything below it      (deck:net* wildcards)
tag:net::w1           the tag and every tag below it        (tag:exam::* wildcards)
type:numeric  id:net.w1.*  source:ch1
is:new is:learning is:review is:relearning is:due is:suspended is:buried is:archived
is:leftover           cards on faces their type no longer makes (see Settings → Clean up)
prop:lapses>=2  prop:reps=0  prop:stability<3  prop:difficulty>7  prop:due<=1 (days from now)
rated:1  rated:7:1    reviewed in the last N days (optionally with that rating)
word  "a phrase"      text in any field, ignoring case (not markup or media file names)
front:word  front:    text in one field, by name (empty: the field is empty)
-term  a OR b  (grouping)   implicit AND between terms
```

With free text, results come best match first: items whose title is the word, then those whose title starts with it, then the rest. `--order` (or the Browse menu) picks another order.

## CLI for people, scripts and agents

```
etude <group> <verb> [args] [flags]

  deck      the tree, settings inheritance, presets, descriptions and grading instructions
  preset    named settings shared by several decks
  item      the content behind one or more cards
  card      per-card scheduling: suspend, bury, reset, due dates
  media     copy images, audio and video into the collection's media folder
  tag       hierarchical labels, with grading instructions
  type      card types: fields, template, prepare script and grader
  scheduler who decides when a card comes back: FSRS, a drill, Leitner boxes or your own script
  study     the queue, presenting a card, submitting answers, ratings, undo
  stats     overview, forecast, recall per tag, weak cards
  settings  AI providers and models, day start, learn-ahead, ChatGPT sign-in
  theme     app colors and custom CSS
  pack      import, export, check, new
  anki      import an .apkg or .colpkg collection
  market    browse, install and publish themes, decks and card types
  db        backups, integrity, schema version

  serve     run the web app and HTTP API
  update    update this copy from GitHub
  search    find cards with the search language
  commands  every command as JSON: args, flags, defaults, examples, whether it writes
```

Output is JSON on stdout. Errors are `{"error", "code"}` on stderr with a distinct exit code for each kind. Most commands that change data accept `--dry-run`. [docs/cli.md](docs/cli.md) has recipes (build a deck from notes, quiz someone in a chat, set an exam deadline, find and suspend leeches) and the full reference.

Agents that use Etude should read [skill/SKILL.md](skill/SKILL.md). It can be dropped into an agent's skills folder as is.

## Architecture

### The model

Etude keeps three questions apart: **what** you practice (an item), **how** you answer it and get marked (its card type and grader), and **when** it comes back (the deck's scheduler). Each one can be swapped without touching the others, so a map card can run on FSRS and a typing test can run on a daily drill.

```mermaid
flowchart TD
  deck["Deck"] -->|holds| item["Item<br/>fields and tags"]
  item -->|one card per face| card["Card<br/>scheduling state"]
  card -->|you study it| type
  subgraph type ["Card type"]
    direction LR
    prepare["prepare(fields)"] -->|view + key| template["template<br/>sandboxed frame"]
    template -->|your answer| grader["grader"]
  end
  type -->|score 0 to 1| review["Attempt, then review"]
  review -->|rating| scheduler["Scheduler<br/>chosen by the deck"]
  scheduler -->|next due date| card
```

| Concept | What it is |
| --- | --- |
| **Deck** | A node in a tree (`Biology::Cells`). Holds items and settings; subdecks inherit settings from their parents. |
| **Preset** | Named settings shared by several decks: daily limits, retention, how scores become ratings, which scheduler. A deck can override any of them. |
| **Item** | The content: a JSON object of `fields`, plus tags, source and notes. Like a note in Anki. It has no scheduling state of its own. |
| **Card** | What enters the study queue. An item makes one card per **face** of its type (`forward` and `reverse`, or `c1`, `c2`… for a cloze). The card keeps the scheduling state: FSRS stability and difficulty, or a JSON `sched_state` for other schedulers, plus suspended and buried. |
| **Card type** | The pluggable part: a small app that defines the item's **fields**, a **template** (HTML, CSS and JS running in the card's sandboxed frame), an optional **prepare** script (turns fields into `view` and `key`, so the answer never reaches the frame), a **grader**, and optionally **faces**, **assets** (meshes, data, images shipped once with the type), a **demo** answer for Watch, **metrics** to chart and `showVerdict`. The built-in types (`basic`, `typed`, `numeric`, `mcq`, `order`, `match`, `cloze`, `free`, `math`, `code`, `draw`, `occlusion`) use exactly the same format as custom ones. |
| **Grader** | Turns an answer into a score from 0 to 1. `self`: you rate yourself. `script`: a JS function in the sandbox. `ai`: a model decides and another writes feedback, with instructions layered from the item, its tags, the deck and the type. `hybrid`: the script first, the AI when the script defers. The preset's `autoRate` thresholds turn the score into a suggested Again / Hard / Good / Easy. |
| **Attempt** | One graded answer, kept whole: the view shown, the answer and everything the grader returned (a typing test's WPM lives here). |
| **Review** | An attempt once a rating is applied and the scheduler has moved the card. History, Stats and the FSRS optimizer read these. |
| **Scheduler** | Decides when a card comes back. One per deck, inherited by subdecks. `fsrs` (default) predicts when you'd forget. `drill` asks for no rating and brings the card back N times a day, charting the type's metrics. `leitner` is the classic boxes. Your own is a folder with `scheduler.json` and `schedule.js`. |
| **Pack** | One JSON file of types, schedulers, decks and items. Items match by `id`, so re-importing an edited pack updates content and keeps history. |
| **Market** | A Git repository of decks, card types and themes, installable from the app or the CLI. |

Everything above is reachable from the web app, the HTTP API and the `etude` CLI, and Ask Etude (the in-app agent) uses that same CLI as its tools. The full references are [docs/types.md](docs/types.md), [docs/schedulers.md](docs/schedulers.md) and [docs/packs.md](docs/packs.md).

### The code

```
src/core/     the engine, no HTTP: data model and SQLite store (node:sqlite), FSRS scheduler,
              search compiler, QuickJS sandbox for user scripts, AI grading, packs
src/server/   Hono HTTP API, card frame documents, static files for the web app
src/cli/      the etude command
runtime/      runtime.js and card.css, loaded inside every card frame
types/        the built-in card types, one folder each
web/          React, Tailwind and shadcn/ui app (Vite)
examples/     showcase.pack.json (built from examples/showcase/ with `node examples/showcase/build.ts`)
skill/        the agent skill for using Etude
docs/         packs, card types and the CLI reference
test/         node:test suites
```

The web app and the CLI are thin layers over one engine class, so they can't drift apart.

## Security

Card code runs in sandboxed iframes with an opaque origin, user scripts run in QuickJS on the server, and the server only listens on localhost unless you set a token. [SECURITY.md](SECURITY.md) explains the trust model, what AI grading sends and how to report a vulnerability.

## Support

Etude is free and made by one person in his free time. If it helps you study, you can [buy me a coffee on Ko-fi](https://ko-fi.com/jhca) or on [Buy Me a Coffee](https://buymeacoffee.com/jhca).

## Legal

The [Terms](https://etude.study/terms), [Privacy Policy](https://etude.study/privacy), [Refund Policy](https://etude.study/refunds) and [Creator Terms](https://etude.study/creators) cover the optional account, Sync and the paid Market. Their source is in [`site/legal/`](site/legal/). They are drafts that haven't been reviewed by a lawyer yet.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and new card types are very welcome.

## License

Etude is free software under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).
