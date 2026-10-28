# Schedulers

A card type decides what a card *is*: how it looks, how you answer and how the answer is graded. A scheduler decides *when the card comes back*. They're separate on purpose, so any card can be studied in any rhythm.

Every deck has one scheduler (set in the deck's Options, in a preset, or with `etude deck set "Deck" scheduler=<id>`). Subdecks inherit it like any other setting.

A card type can name the scheduler its cards need (`"scheduler": "drill"` in its definition; see [Card types](types.md#shape)). Those cards use it whenever no deck layer sets `scheduler`, so a typing test added to any deck is a drill without changing the deck. Once the deck, its preset or a parent sets one, FSRS included, that applies to every card in it. The deck's Options list the types that pick their own scheduler, and `etude deck show` returns them as `typeSchedulers`.

| Scheduler | Asks for a rating | Good for |
| --- | --- | --- |
| `fsrs` (default) | Again / Hard / Good / Easy | Things you want to remember. Each card comes back right before you'd forget it. |
| `drill` | No | Skills you train and measure: typing speed, scales, mental math. The card comes back every practice day, as many times as you set, and every result is kept. |
| `leitner` | Yes | The classic paper boxes: right answers move a card up a box, a miss sends it back to the first. |
| your own | Your choice | Anything you can write as a few lines of JavaScript. |

## A typing drill in one minute

```sh
etude deck set "Typing" scheduler=drill schedulerOptions.perDay=3
```

A typing type that names `drill` as its scheduler doesn't need this: its cards are drills in any deck that doesn't pick a scheduler.

A typing card has nothing to remember, so FSRS makes no sense for it: there is no "forgetting" to predict, and the real result is your WPM. On a drill deck:

- After you finish a test there are no rating buttons. **Next** records the result, **Go again** records it and starts another run right away.
- The card comes back `perDay` times on every practice day (`everyDays` apart). `perDay=0` keeps it always available.
- **Stats** for the deck shows the numbers the grader measured over every session (WPM, accuracy, raw, consistency for the typing type), with your best and how far you've come since the first run. There's no recall ring or forgetting curve, because those are FSRS's predictions.

Which numbers are charted comes from the card type's `metrics` (see below). Without them, every top-level number the grader puts in `details` is charted, plus the score.

## Writing a scheduler

A scheduler is a folder with two files:

```
every-monday/
  scheduler.json
  schedule.js
```

`scheduler.json`:

```json
{
  "id": "every-monday",
  "name": "Every Monday",
  "description": "The card comes back on the next Monday, whatever you answered.",
  "ratings": false,
  "options": [
    { "name": "weeks", "kind": "number", "label": "Every", "suffix": "weeks", "default": 1, "min": 1, "max": 52 }
  ]
}
```

- `ratings`: `true` shows Again / Hard / Good / Easy after an answer; `false` shows **Next** and **Go again**, and the graded result is what's recorded.
- `options`: settings a deck can give the scheduler (`number`, `boolean` or `text`). They appear in the deck's Options under the scheduler, and are passed to the script as `options`. Set them from the CLI with `schedulerOptions.<name>=<value>`.

`schedule.js` is the body of `function (card, attempt, options, ctx)` and returns `{ due, state }`:

```js
// Next Monday at the start of the study day, `weeks` weeks out.
let n = 0, seen = 0;
for (let i = 1; i < ctx.day.length; i++) {
  if (new Date(ctx.day[i]).getDay() === 1 && ++seen === options.weeks) { n = i; break; }
}
return { due: ctx.day[n], state: { runs: (card.state?.runs ?? 0) + 1 } };
```

What the script gets:

| | |
| --- | --- |
| `card.state` | Whatever the script returned as `state` last time (`null` before the first answer). Keep anything you need here: a box number, a streak, a best score. |
| `card.reps`, `card.due`, `card.lastReview`, `card.created` | The card's counters and dates. |
| `attempt.rating` | 1–4 when the scheduler asks for ratings, otherwise `null`. |
| `attempt.score`, `attempt.verdict` | The grader's score (0..1) and verdict, `null` when self-rated. |
| `attempt.details` | Everything the grader returned in `details`: WPM, accuracy, per-part marks… |
| `attempt.ms`, `attempt.at` | Time spent on the card, and when it was answered. |
| `ctx.now` | Now, as an ISO date. |
| `ctx.day[n]` | The start of the study day *n* days from today, in your time zone (`ctx.day[0]` is today; 400 days ahead). |
| `ctx.doneToday` | How many times this card was answered today, before this one. |
| `ctx.history` | Earlier results for this card, oldest first (up to 50): `{ at, rating, score }`. |

`due` is an ISO date (or a timestamp). Returning `ctx.now` keeps the card available right away. A due date in the past works the same way.

The script runs in the same sandbox as graders (no network, files or timers, 500 ms). If it throws, the answer isn't recorded and the card stays where it was, so a broken scheduler never loses a card. Its clock is fixed to `ctx.now`: `Date.now()` and argument-free `new Date()` use that time, and `Math.random()` uses a stream seeded by the review count.

In a synced collection, merges replay the history with stable review-id ordering for tied timestamps and UTC study-day boundaries. FSRS replay disables fuzz. See [Sync](sync.md) for the conflict rules, reset/due controls and unsupported operations.

Install it, then point a deck at it:

```sh
etude scheduler validate ./every-monday
etude scheduler import ./every-monday
etude deck set "Weekly review" scheduler=every-monday schedulerOptions.weeks=2
```

`etude scheduler export drill -o my-drill` gives you a built-in one to start from. A pack can carry its schedulers in a top-level `"schedulers": [...]` array, and `etude pack export` includes the custom ones its decks, presets and types use.

## Charting what a type measures

A card type can say which numbers in its grade are worth tracking, so Stats charts them with the right labels:

```json
"metrics": [
  { "key": "wpm", "label": "WPM", "better": "higher", "digits": 0 },
  { "key": "acc", "label": "Accuracy", "unit": "%", "digits": 0 }
]
```

`key` names a value in the grade's `details` (dots reach nested values; `score` is the grade's score). Every graded attempt counts, practice runs included: a result is a result.

## What Stats shows for a scheduler

Stats shows what a deck's scheduler actually knows:

- **FSRS** decks get the memory model: recall now, the forgetting curve, memory strength, the forecast and weakest tags.
- **Rated scripts** (Leitner, or your own with `ratings: true`) get what's due, the forecast, the pass rate, ratings and practice days. They don't predict recall, so there's no forgetting curve.
- **Drills** (`ratings: false`) get the type's metrics over time and their practice days. A drill is always ready, so it stays out of the forecast and the due count; "All decks" shows it as "N drills ready" instead.

On "All decks", recall, card states, retention and the forecast count FSRS cards only, and a **By scheduler** panel lists every other scheduler with its cards, what's due and its pass rate. The heatmap counts every answer, with a drill's runs listed apart from reviews.

A scheduler can also say what its state means, so Stats can chart it. Leitner keeps `{ box }`, so its `scheduler.json` has:

```json
"stats": { "groupBy": "box", "label": "Box" }
```

and the deck's Stats page shows a "Cards by box" histogram. `groupBy` names a value in the state your script returns (dots reach nested ones, like `rank.level`). Whole numbers get every step between the lowest and highest, empty ones included; anything else becomes one bar per value. Cards whose state has no such value are counted apart.

## Switching a deck's scheduler

Changing the scheduler doesn't lose anything. Every answer stays in the review log, and **Reschedule** (or `etude card reschedule --deck "…"`) replays that history through the new scheduler:

- to a script scheduler: the script runs again, answer by answer;
- back to FSRS: rated answers replay as they were; a drill's unrated answers count as the rating their score suggests (the deck's `autoRate` thresholds).

## What stays FSRS-only

Some features only make sense with FSRS and skip decks on another scheduler: the weights optimizer, exam deadlines, desired retention and learning steps, recall predictions, the forgetting curve, memory strength and true retention. Daily limits and ordering still apply to every scheduler.
