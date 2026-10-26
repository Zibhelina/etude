import { RATING_NAMES, type Rating } from "../../core/model.ts";
import { command, group, CliError } from "../registry.ts";
import { humanSpan, parseMoment } from "../input.ts";
import { DECK_FLAG, FACE_FLAG, QUERY_FLAG, oneCard, resolveCards, scopeOf, stateName } from "../common.ts";

group({ name: "card", summary: "Cards: per-card scheduling (suspend, bury, reset, due dates, intervals)" });

const refsArg = { name: "refs", description: "Card ids, or item ids (all of an item's cards; narrow with --face). `-` reads them from stdin. Or use --query / --deck.", variadic: true };
const BULK = [DECK_FLAG, QUERY_FLAG, FACE_FLAG];

const brief = (e: any, ids: number[]) =>
  ids.map((id) => {
    const c = e.db.get("SELECT id, item_id, face, state, due, suspended, buried_until FROM cards WHERE id = ?", id);
    return { cardId: c.id, itemId: c.item_id, face: c.face, state: stateName(c.state), due: c.due, suspended: !!c.suspended, buriedUntil: c.buried_until };
  });

const intervalsOut = (iv: Record<Rating, string>, now = Date.now()) =>
  Object.fromEntries(([1, 2, 3, 4] as Rating[]).map((r) => [RATING_NAMES[r], { rating: r, due: iv[r], in: humanSpan(now, new Date(iv[r]).getTime()) }]));

command({
  name: "card show",
  summary: "A card's scheduling: state, due, stability, difficulty, recall probability now, and what each rating would do.",
  args: [{ name: "ref", description: "Card id, or an item id with a single card (or --face).", required: true }],
  flags: [FACE_FLAG],
  examples: ["etude card show 42", "etude card show net.dtrans-1"],
  output: "{ cardId, itemId, face, deck, state, stateName, due, stability, difficulty, reps, lapses, lastReview, suspended, buriedUntil, retrievability, intervals, deadline }",
  run(ctx) {
    const s = ctx.e.cardSchedule(oneCard(ctx, ctx.args.ref));
    return { ...s, stateName: stateName(s.state), intervals: intervalsOut(s.intervals) };
  },
});

command({
  name: "card list",
  summary: "Cards matching a search (one row per card), with scheduling.",
  args: [{ name: "query", description: "Search; words are joined.", variadic: true }],
  flags: [
    DECK_FLAG,
    { name: "order", type: "string", description: "Sort order. relevance: with free text, items whose title is or starts with a word come first; otherwise the order added.", values: ["relevance", "added", "due", "deck", "lapses", "difficulty", "updated"], default: "relevance" },
    { name: "limit", type: "number", description: "Maximum rows.", default: 100 },
    { name: "offset", type: "number", description: "Rows to skip.", default: 0 },
    { name: "ids", type: "boolean", description: "Print only card ids, one per line." },
  ],
  examples: ["etude card list is:due --order due", 'etude card list "prop:lapses>=3" --ids | etude card suspend -'],
  output: "{ total, rows: [{ cardId, itemId, face, type, deck, tags, title, state, stateName, due, reps, lapses, stability, difficulty, suspended, archived, generated, retrievability }] }",
  run(ctx) {
    const q = [ctx.flags.deck ? `deck:"${ctx.flags.deck}"` : "", ctx.args.query.join(" ")].filter(Boolean).join(" ");
    const r = ctx.e.search(q, { limit: ctx.flags.limit, offset: ctx.flags.offset, order: ctx.flags.order });
    if (ctx.flags.ids) return r.rows.map((x) => x.cardId).join("\n");
    return { ...r, rows: r.rows.map((x) => ({ ...x, stateName: stateName(x.state) })) };
  },
});

command({
  name: "card intervals",
  summary: "When the card would next be due for each rating (again, hard, good, easy), right now.",
  args: [{ name: "ref", description: "Card id, or an item id with a single card.", required: true }],
  flags: [FACE_FLAG],
  examples: ["etude card intervals 42"],
  output: "{ cardId, state, intervals: { again: { rating, due, in }, hard, good, easy } }",
  run(ctx) {
    const s = ctx.e.cardSchedule(oneCard(ctx, ctx.args.ref));
    return { cardId: s.cardId, state: stateName(s.state), intervals: intervalsOut(s.intervals) };
  },
});

for (const [verb, summary, act] of [
  ["suspend", "Suspend cards: they never come up until unsuspended.", (e: any, ids: number[]) => e.setSuspended(ids, true)],
  ["unsuspend", "Unsuspend cards.", (e: any, ids: number[]) => e.setSuspended(ids, false)],
  ["unbury", "Unbury cards so they can come up today.", (e: any, ids: number[]) => e.setBuried(ids, null)],
  ["reset", "Forget cards: back to new, as if never studied. Review history is kept (and `card reschedule` would rebuild from it).", (e: any, ids: number[]) => e.resetCards(ids)],
] as const) {
  command({
    name: `card ${verb}`,
    summary,
    args: [refsArg],
    flags: BULK,
    writes: true,
    dryRun: true,
    examples: [`etude card ${verb} 42 43`, `etude card ${verb} --query "deck:Physics prop:lapses>=4"`],
    output: "{ count, cards: [{ cardId, itemId, face, state, due, suspended, buriedUntil }] }",
    run(ctx) {
      const ids = resolveCards(ctx, ctx.args.refs);
      act(ctx.e, ids);
      return { count: ids.length, cards: brief(ctx.e, ids) };
    },
  });
}

const MOMENT_FLAGS = [
  { name: "date", type: "string" as const, description: "A date (2026-10-22 means the start of that study day) or ISO date-time; also `today`, `tomorrow`.", placeholder: "DATE" },
  { name: "in", type: "string" as const, description: "A duration from now: 30m, 12h, 3d, 2w.", placeholder: "DURATION" },
  { name: "now", type: "boolean" as const, description: "Right now." },
];

command({
  name: "card bury",
  summary: "Hide cards until the next study day, or until a date.",
  args: [refsArg],
  flags: [...BULK, ...MOMENT_FLAGS.slice(0, 2), { name: "note", type: "boolean", description: "Bury every card of the selected cards' items." }],
  writes: true,
  dryRun: true,
  examples: ["etude card bury 42", "etude card bury 42 --note", "etude card bury --query tag:hard --in 3d"],
  output: "{ count, until, cards }",
  run(ctx) {
    const selected = resolveCards(ctx, ctx.args.refs);
    const ids = ctx.flags.note ? ctx.e.noteCards(selected) : selected;
    const e = ctx.e;
    const until = ctx.flags.date || ctx.flags.in ? parseMoment({ date: ctx.flags.date, in: ctx.flags.in }, e.settings().dayStartHour) : new Date(e.dayStart().getTime() + 86400_000);
    e.setBuried(ids, until);
    return { count: ids.length, until: until.toISOString(), cards: brief(e, ids) };
  },
});

command({
  name: "card due",
  summary: "Set when cards are next due, without recording a review.",
  description:
    "Review and learning cards keep their stability and difficulty; only the date moves, so the next review is scored as if it happened at the new time. New cards stay new and won't be introduced before the date. `--now` makes cards due immediately. A deck deadline is not applied here: you set the date explicitly.",
  args: [refsArg],
  flags: [...BULK, ...MOMENT_FLAGS],
  writes: true,
  dryRun: true,
  examples: ["etude card due 42 --date 2026-10-22", 'etude card due --query "deck:\\"Networks\\" is:due" --in 1d', "etude card due 42 --now"],
  output: "{ count, due, cards }",
  run(ctx) {
    const e = ctx.e;
    const ids = resolveCards(ctx, ctx.args.refs);
    const due = parseMoment(ctx.flags, e.settings().dayStartHour);
    e.setDue(ids, due);
    return { count: ids.length, due: due.toISOString(), cards: brief(e, ids) };
  },
});

command({
  name: "card reschedule",
  summary: "Rebuild cards' scheduling from their review history with the current settings (after changing retention, steps, weights or a deadline).",
  flags: [DECK_FLAG, QUERY_FLAG],
  writes: true,
  dryRun: true,
  examples: ['etude card reschedule --deck "Networks"'],
  output: "{ rescheduled: number }",
  run(ctx) {
    return ctx.e.reschedule(scopeOf(ctx.flags));
  },
});

command({
  name: "reschedule",
  summary: "Old spelling of `etude card reschedule`.",
  flags: [DECK_FLAG, QUERY_FLAG],
  writes: true,
  dryRun: true,
  legacy: true,
  aliasOf: "card reschedule",
  run(ctx) {
    if (!ctx.flags.deck && !ctx.flags.query) ctx.note("rescheduling every card");
    return ctx.e.reschedule(scopeOf(ctx.flags));
  },
});
void CliError;
