import { RATING_NAMES, type Rating } from "../../core/model.ts";
import type { StudyCard as EngineCard } from "../../core/engine.ts";
import { alias, command, group, CliError, type Ctx } from "../registry.ts";
import { answerValue, humanSpan, parseRating, textInput } from "../input.ts";
import { DECK_FLAG, FACE_FLAG, QUERY_FLAG, oneCard, scopeOf, stateName } from "../common.ts";

group({ name: "study", summary: "Studying: the queue, presenting a card, submitting answers, ratings, undo" });

const AHEAD_FLAG = { name: "ahead", type: "boolean" as const, description: "Study ahead: nothing has to be due. Every card in the scope, soonest due first, no daily limits; ratings are real reviews." };
const PLACEMENT_FLAG = { name: "placement", type: "string" as const, description: "Placement on an adaptive deck: only probes that find the learner's level. The value names the session (any text, e.g. today's date): use the same one for every probe and when submitting; a new name starts a fresh placement, and the latest placement is the one that counts.", placeholder: "SESSION" };
const AS_OF_FLAG = { name: "as-of", type: "string" as const, description: "The card's `asOf` from `study next`/`study card` (adaptive decks), so the grade matches the variant shown.", placeholder: "ISO" };
const PRACTICE_FLAG = { name: "practice", type: "boolean" as const, description: "Practice only: the review is logged but the card's schedule doesn't move (like “another variant” in the app)." };
const ANSWER_FLAGS = [
  { name: "answer", type: "string" as const, short: "a", description: "The learner's answer, verbatim (`-` reads stdin). Parsed as JSON when it starts with `[`, `{` or `\"` (`[\"1.2\"]` for numeric parts, `[\"o0\"]` for mcq); anything else is kept as typed. --text forces text.", placeholder: "VALUE" },
  { name: "answer-file", type: "string" as const, description: "Read the answer from a file (`-` for stdin).", placeholder: "PATH" },
  { name: "text", type: "boolean" as const, description: "Treat the answer as plain text even if it looks like JSON." },
];

/** Card for agents: the view plus a plain description of how to answer it. */
function presented(c: EngineCard, ctx: Ctx) {
  const now = Date.now();
  return {
    cardId: c.cardId,
    itemId: c.itemId,
    face: c.face,
    seed: c.seed,
    type: c.type,
    deck: c.deck,
    tags: c.tags,
    state: stateName(c.state),
    title: c.title,
    grader: c.grader,
    generated: c.generated,
    view: c.view,
    answerFormat: answerFormat(c, ctx),
    scheduler: c.scheduler.id,
    ...(c.asOf ? { asOf: c.asOf } : {}),
    ...(c.placement ? { placement: c.placement } : {}),
    ...(c.quickCheck ? { quickCheck: true } : {}),
    ...(c.scheduler.ratings
      ? { intervals: Object.fromEntries(([1, 2, 3, 4] as Rating[]).map((r) => [RATING_NAMES[r], humanSpan(now, new Date(c.intervals[r]).getTime())])) }
      : { next: c.scheduler.next ? humanSpan(now, new Date(c.scheduler.next).getTime()) : null, rating: "none: submit, then `study rate <card> next` (or use `study answer`)" }),
  };
}

/** How to shape `--answer` for a card, derived from its view. */
function answerFormat(c: EngineCard, ctx: Ctx): string {
  const v = c.view as any;
  switch (c.type) {
    case "basic":
      return "self-graded: show the front, let the learner answer, then reveal (submit with any text, or none) and rate 1-4";
    case "typed":
      return "a string";
    case "numeric":
      return `a JSON array with one string per part (${(v.parts ?? []).length} part${(v.parts ?? []).length === 1 ? "" : "s"}), e.g. ["1.2"]; units may be included`;
    case "mcq":
      return `a JSON array of chosen option ids (${(v.options ?? []).map((o: any) => o.id).join(", ")})${v.multiple ? "; several may be right" : "; exactly one"}`;
    case "order":
      return `a JSON array of block ids in the learner's order (${(v.blocks ?? []).map((b: any) => b.id).join(", ")})`;
    case "match":
      return `a JSON object mapping each left id to a right id, e.g. {"${v.left?.[0]?.id ?? "l0"}":"${v.right?.[0]?.id ?? "r0"}"}`;
    case "cloze":
      return `a JSON array with one string per blank (${(v.blanks ?? []).length} blank${(v.blanks ?? []).length === 1 ? "" : "s"}), in order`;
    case "free":
      return "free text (AI-graded)";
    case "draw":
      return 'a drawing: {"image":"data:image/png;base64,..."}; in chat, prefer a written description graded by the learner rating themselves';
  }
  const g = ctx.e.type(c.type).grader.kind;
  return g === "self" ? "self-graded: reveal and rate 1-4" : "see the type's card.js (what etude.getAnswer returns); usually a string or a JSON value";
}

/** A bare string for a card that wants one entry per part (one-blank cloze, one-part numeric) gets wrapped. */
function shaped(ctx: Ctx, cardId: number, seed: number, answer: unknown): unknown {
  if (typeof answer !== "string") return answer;
  const c = ctx.e.present(cardId, seed) as any;
  const n = c.type === "cloze" ? (c.view?.blanks ?? []).length : c.type === "numeric" ? (c.view?.parts ?? []).length : 0;
  if (n === 1) return [answer];
  if (n > 1) throw new CliError(`this card has ${n} ${c.type === "cloze" ? "blanks" : "parts"}; give a JSON array with one string each, e.g. --answer '${JSON.stringify(Array(n).fill("..."))}'`, "validation");
  return answer;
}

function answerOf(ctx: Ctx, required = true): unknown {
  const raw = textInput(ctx, ctx.flags.answer, ctx.flags["answer-file"]);
  if (raw === undefined) {
    if (required) throw new CliError("--answer is required (use --answer \"\" for a self-graded reveal)");
    return null;
  }
  return ctx.flags.text ? raw : answerValue(raw);
}



command({
  name: "study counts",
  summary: "Today's queue for a scope: new, learning, review, done today, next due.",
  flags: [DECK_FLAG, QUERY_FLAG, AHEAD_FLAG],
  examples: ['etude study counts --deck "Networks"', 'etude study counts --deck "Networks" --ahead'],
  output: "{ new, learning, learningSoon, review, doneToday, nextDue }",
  run: (ctx) => ctx.e.counts(scopeOf(ctx.flags)),
});

command({
  name: "study next",
  summary: "The next card to study in a scope, with its view and how to answer it. Private fields are never included.",
  description:
    "Use `view` to present the card (render its markdown for the learner). Keep `cardId` and `seed`: submit with them so the answer is graded against exactly this variant. On adaptive decks also keep `asOf` and pass it as `--as-of`. Respects daily limits and the preset's ordering; `--exclude` skips the card just answered. With `--ahead`, nothing has to be due: every card in the scope comes up, soonest due first. With `--placement` (adaptive decks), only placement probes come up, and `card` is null once the level is found.",
  flags: [DECK_FLAG, QUERY_FLAG, AHEAD_FLAG, PLACEMENT_FLAG, { name: "exclude", type: "number", description: "Card id to avoid repeating right away." }],
  examples: ['etude study next --deck "Networks"', 'etude study next --query "tag:delay is:due"', 'etude study next --deck "Networks" --ahead', 'etude study next --deck "Course" --placement 2026-10-27'],
  output: "{ card: { cardId, itemId, face, seed, type, deck, tags, state, title, grader, view, answerFormat, intervals, asOf?, placement?: session, quickCheck? } | null, counts }",
  run(ctx) {
    if (ctx.flags.placement && !ctx.flags.deck) throw new CliError("--placement needs --deck");
    const r = ctx.e.next({ ...scopeOf(ctx.flags), placement: ctx.flags.placement || undefined }, { exclude: ctx.flags.exclude });
    return { card: r.card ? presented(r.card, ctx) : null, counts: r.counts };
  },
});

command({
  name: "study card",
  summary: "Present a specific card (any time, due or not). A seed reproduces a variant; a new seed gives a new one.",
  args: [{ name: "ref", description: "Card id, or an item id with a single card.", required: true }],
  flags: [{ name: "seed", type: "number", description: "Variant seed. Random when omitted." }, FACE_FLAG],
  examples: ["etude study card 42 --seed 7"],
  output: "{ cardId, itemId, face, seed, view, answerFormat, ... }",
  run(ctx) {
    return presented(ctx.e.present(oneCard(ctx, ctx.args.ref), ctx.flags.seed), ctx);
  },
});

command({
  name: "study submit",
  summary: "Grade an answer and store the attempt, or return the hint when the grader asks for another try. Doesn't schedule: follow a grade with `study rate`.",
  args: [{ name: "ref", description: "Card id (or item id with one card).", required: true }],
  flags: [
    { name: "seed", type: "number", description: "The seed from `study next`/`study card`. Required, so the grade matches what was shown." },
    ...ANSWER_FLAGS,
    PRACTICE_FLAG,
    { name: "feedback", type: "boolean", description: "Also write AI feedback now (when the grade has none)." },
    FACE_FLAG,
    AS_OF_FLAG,
    PLACEMENT_FLAG,
  ],
  writes: true,
  examples: ['etude study submit 42 --seed 7 --answer \'["1.2 ms"]\'', "etude study submit 43 --seed 3 --answer-file answer.md"],
  output: "{ attemptId: number | null, cardId, grade, suggested, key, wantsFeedback, retry: { hint, view } | null, feedback? }; retry means the grader asked for another try: nothing was stored and there is no key; show retry.hint and ask again with the same card and seed",
  async run(ctx) {
    if (ctx.flags.seed === undefined) throw new CliError("--seed is required (from `study next` or `study card`)");
    const cardId = oneCard(ctx, ctx.args.ref);
    const answer = shaped(ctx, cardId, ctx.flags.seed, answerOf(ctx));
    const r = await ctx.e.submit(cardId, ctx.flags.seed, answer, { practice: ctx.flags.practice, asOf: ctx.flags["as-of"], placement: ctx.flags.placement });
    const out: Record<string, unknown> = { attemptId: r.attemptId, cardId, answer, grade: r.grade, suggested: r.grade.suggested ? { rating: r.grade.suggested, name: RATING_NAMES[r.grade.suggested] } : null, key: r.key, wantsFeedback: r.wantsFeedback, retry: r.retry };
    if (ctx.flags.feedback && r.attemptId !== null && !r.grade.feedback) {
      try {
        out.feedback = (await ctx.e.feedback(r.attemptId)).feedback;
      } catch (e) {
        out.feedbackError = (e as Error).message;
      }
    }
    return out;
  },
});

command({
  name: "study feedback",
  summary: "AI feedback for an attempt (written once, then cached).",
  args: [{ name: "attempt", description: "Attempt id from `study submit`.", required: true }],
  writes: true,
  output: "{ feedback, model?, cached? }",
  run: (ctx) => ctx.e.feedback(Number(ctx.args.attempt)),
});

command({
  name: "study rate",
  summary: "Record a rating and reschedule the card. Pass --attempt to link the graded attempt.",
  args: [
    { name: "ref", description: "Card id (or item id with one card).", required: true },
    { name: "rating", description: "1-4 or again, hard, good, easy. On a scheduler without ratings (a drill) use `next`.", required: true },
  ],
  flags: [
    { name: "attempt", type: "number", description: "Attempt id from `study submit`." },
    { name: "duration", type: "number", description: "Milliseconds the learner spent (for stats)." },
    PRACTICE_FLAG,
    FACE_FLAG,
  ],
  writes: true,
  dryRun: true,
  examples: ["etude study rate 42 good --attempt 118", "etude study rate 42 1"],
  output: "{ reviewId, cardId, rating, due, in, state }",
  run(ctx) {
    const cardId = oneCard(ctx, ctx.args.ref);
    const unrated = !ctx.e.cardSchedule(cardId).scheduler.ratings;
    const rating = unrated || /^(next|0)$/i.test(ctx.args.rating) ? 0 : parseRating(ctx.args.rating);
    const practice = ctx.flags.practice ?? (ctx.flags.attempt ? !!ctx.e.db.get("SELECT practice FROM attempts WHERE id = ?", ctx.flags.attempt)?.practice : false);
    const r = ctx.e.rate(cardId, rating, { attemptId: ctx.flags.attempt, durationMs: ctx.flags.duration, practice });
    return { reviewId: r.reviewId, cardId, rating: rating ? RATING_NAMES[rating] : "next", practice, due: r.due, in: humanSpan(Date.now(), new Date(r.due).getTime()), state: stateName(r.state) };
  },
});

command({
  name: "study answer",
  summary: "Submit and rate in one step: grades the answer, then applies the suggested rating (or the one you give).",
  description:
    "`--rate auto` (default) uses the grader's suggestion. When there is none (self-graded cards or a grading error), ask the learner and run `study rate`; the attempt is still stored. When the grader asks for another try, nothing is stored or rated, even with an explicit --rate: show retry.hint and ask again with the same card and seed.",
  args: [{ name: "ref", description: "Card id (or item id with one card).", required: true }],
  flags: [
    { name: "seed", type: "number", description: "The seed the card was shown with." },
    ...ANSWER_FLAGS,
    { name: "rate", type: "string", description: "auto, 1-4, or again/hard/good/easy.", default: "auto" },
    PRACTICE_FLAG,
    { name: "duration", type: "number", description: "Milliseconds spent." },
    FACE_FLAG,
    AS_OF_FLAG,
    PLACEMENT_FLAG,
  ],
  writes: true,
  examples: ['etude study answer 42 --seed 7 --answer \'["1.2"]\'', 'etude study answer 50 --seed 1 --answer "" --rate good'],
  output: "{ attemptId: number | null, grade, key, retry: { hint, view } | null, rated: { reviewId, rating, due, in } | null, needsRating? }",
  async run(ctx) {
    if (ctx.flags.seed === undefined) throw new CliError("--seed is required");
    const cardId = oneCard(ctx, ctx.args.ref);
    const answer = shaped(ctx, cardId, ctx.flags.seed, answerOf(ctx, false));
    const r = await ctx.e.submit(cardId, ctx.flags.seed, answer, { practice: ctx.flags.practice, asOf: ctx.flags["as-of"], placement: ctx.flags.placement });
    const base = { attemptId: r.attemptId, cardId, answer, grade: r.grade, key: r.key, retry: r.retry };
    if (r.retry) return { ...base, rated: null, needsRating: false };
    if (!ctx.e.cardSchedule(cardId).scheduler.ratings) {
      // A drill records the result itself; there's nothing to choose.
      const rv = ctx.e.rate(cardId, 0, { attemptId: r.attemptId, durationMs: ctx.flags.duration, practice: ctx.flags.practice });
      return { ...base, rated: { reviewId: rv.reviewId, rating: "next", due: rv.due, in: humanSpan(Date.now(), new Date(rv.due).getTime()), state: stateName(rv.state) } };
    }
    const rating: Rating | null = ctx.flags.rate === "auto" ? r.grade.suggested : parseRating(ctx.flags.rate);
    if (!rating) return { ...base, rated: null, needsRating: true, hint: `no suggested rating (${r.grade.grader.error ? "grading failed" : r.grade.grader.kind + " grader"}); ask the learner, then: etude study rate ${cardId} <1-4> --attempt ${r.attemptId}` };
    const rv = ctx.e.rate(cardId, rating, { attemptId: r.attemptId, durationMs: ctx.flags.duration, practice: ctx.flags.practice });
    return { ...base, rated: { reviewId: rv.reviewId, rating: RATING_NAMES[rating], due: rv.due, in: humanSpan(Date.now(), new Date(rv.due).getTime()), state: stateName(rv.state) } };
  },
});

command({
  name: "study undo",
  summary: "Undo the most recent review (any card): the card returns exactly to its previous state, and the graded answer is discarded.",
  writes: true,
  dryRun: true,
  output: "{ undone: { cardId, itemId } | null }",
  run: (ctx) => ({ undone: ctx.e.undo() }),
});

command({
  name: "study watch",
  summary: "Watch mode: the cards of a scope in order, one per item, each with an example answer and its grade. Records nothing.",
  description:
    "What the app's Watch button shows, for decks in watch mode (a tour) or any scope. Each card carries `demo.answer` (the item's own `fields.demo`, or what its type's `demo.js` makes) and `demo.grade`: a recorded grade when the item ships one, otherwise the script grader's verdict on that answer. AI-graded cards without a recorded grade come back ungraded instead of calling a model.",
  flags: [DECK_FLAG, QUERY_FLAG, { name: "limit", type: "number", description: "At most this many cards." }],
  examples: ['etude study watch --deck "Etude Showcase"', 'etude study watch --query "type:chess"'],
  output: "{ cards: [{ cardId, itemId, type, deck, title, seed, view, demo: { answer, grade } }] }",
  async run(ctx) {
    const list = ctx.e.watchList(scopeOf(ctx.flags)).slice(0, ctx.flags.limit ?? Infinity);
    const cards = [];
    for (const w of list) {
      const { card, demo } = ctx.e.watchCard(w.cardId);
      const grade = demo.grade ?? (await ctx.e.watchGrade(w.cardId, card.seed, demo.answer)).grade;
      cards.push({ ...w, seed: card.seed, view: card.view, demo: { answer: demo.answer, grade } });
    }
    return { cards };
  },
});

alias("next", "study next", { summary: "Old spelling of `etude study next`." });
