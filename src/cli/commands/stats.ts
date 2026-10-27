import { alias, command, group } from "../registry.ts";
import { DECK_FLAG, QUERY_FLAG, scopeOf, stateName } from "../common.ts";

group({ name: "stats", summary: "Statistics: overview, forecast, recall per tag, adaptive skills", defaultVerb: "overview" });

const SCOPE = [DECK_FLAG, QUERY_FLAG];
const DAYS = { name: "days", type: "number" as const, description: "Activity window in days (heatmap, ratings, verdicts).", default: 30 };

command({
  name: "stats overview",
  summary: "Everything the Stats page shows for a scope: card states, retention, recall, daily activity, forecast, ratings, verdicts, streak, deadline.",
  flags: [...SCOPE, DAYS],
  examples: ['etude stats --deck "Networks"', "etude stats overview --days 90"],
  output: "the engine's stats object (cards, retention, trueRetention, recall, days, forecast, overdue, tags, tagTree, today, ratings, verdicts, streak, window, deadline, schedulers: one row per scheduler with cards, due, pass rate and state groups, practice)",
  run: (ctx) => ctx.e.stats(scopeOf(ctx.flags), ctx.flags.days),
});

command({
  name: "stats forecast",
  summary: "Cards due per day for the next 30 days (overdue counts on today).",
  flags: SCOPE,
  output: "{ overdue, forecast: [{ day, due }], deadline }",
  run(ctx) {
    const s = ctx.e.stats(scopeOf(ctx.flags));
    return { overdue: s.overdue, forecast: s.forecast, deadline: s.deadline };
  },
});

command({
  name: "stats skills",
  summary: "On an adaptive deck: estimated skills, levels, placement and today's adaptive pace.",
  description:
    "Skills come from the card types' faces (and `skill::` tags), measured across the highest deck with an adaptive setting on. `typical` is the predicted chance of getting a middling card right. Everything is computed from the graded history, so nothing here is stored. A deck that isn't adaptive reports `adaptive: false`.",
  args: [{ name: "deck", description: "Deck name.", required: true }],
  examples: ['etude stats skills "Course"'],
  output: "{ deck, adaptive, root?, settings?, skills?: [{ skill, answers, success, ability, typical, level: { index, tag, progress, checkPassed, done, nextOpen } | null, placement: { probes, done, frontier } | null }], pace?: { value, base, success, minutesPerDay, reason } | null }",
  run: (ctx) => ctx.e.learnerSummary(ctx.args.deck),
});

command({
  name: "stats tags",
  summary: "Predicted recall per tag (with parent tags), weakest first.",
  flags: [...SCOPE, { name: "min-cards", type: "number", description: "Skip tags with fewer seen cards.", default: 1 }],
  examples: ['etude stats tags --deck "Networks"'],
  output: "array of { tag, depth, cards, seen, recall }",
  run(ctx) {
    const s = ctx.e.stats(scopeOf(ctx.flags)) as any;
    const rows: any[] = s.tagTree ?? s.tags.map((t: any) => ({ ...t, seen: t.cards }));
    return rows.filter((r) => (r.seen ?? 0) >= ctx.flags["min-cards"]).sort((a, b) => (a.recall ?? 1) - (b.recall ?? 1));
  },
});

command({
  name: "stats weak",
  summary: "Cards most likely forgotten or most often lapsed: candidates for rewording, splitting or suspending.",
  description: "Sorted by lapses, then by recall probability now. Leeches are cards with at least --lapses lapses.",
  flags: [...SCOPE, { name: "lapses", type: "number", description: "Minimum lapses to count as weak.", default: 2 }, { name: "limit", type: "number", description: "Rows.", default: 20 }],
  examples: ['etude stats weak --deck "Networks" --lapses 3'],
  output: "{ total, rows: [card rows as in `card list`] }",
  run(ctx) {
    const q = [ctx.flags.deck ? `deck:"${ctx.flags.deck}"` : "", ctx.flags.query ? `(${ctx.flags.query})` : "", `prop:lapses>=${ctx.flags.lapses}`, "-is:suspended"].filter(Boolean).join(" ");
    const r = ctx.e.search(q, { limit: 1000, order: "lapses" });
    const rows = r.rows.sort((a, b) => b.lapses - a.lapses || (a.retrievability ?? 1) - (b.retrievability ?? 1)).slice(0, ctx.flags.limit);
    return { total: r.total, query: q, rows: rows.map((x) => ({ ...x, stateName: stateName(x.state) })) };
  },
});

alias("stats show", "stats overview");
