// `etude activity`: the Activity setting (Settings → Privacy → Activity) and what it recorded. Turning it on, how long
// it's kept and deleting it are the person's own: agent-guard.ts refuses them to Ask and `etude mcp`.
import { agentFor } from "../../core/agent.ts";
import { activityFor, KEEP_CHOICES } from "../../core/activity.ts";
import { command, group } from "../registry.ts";

group({ name: "activity", summary: "Your own activity in the app (time and typing per page, file, chat and screen), for Stats. Off unless you turn it on", defaultVerb: "status" });

const ABOUT =
  "Activity is off unless you turn it on. While on, the app's window counts how long you're active in each page, file, PDF, canvas, board, web page, Ask chat and screen (it stops after 2 minutes without input, or when the window is in the background), and how many characters you type, paste and delete there, and how many words you start. It keeps only those counts, per hour and per note id or screen; never the text, the keys or what you pasted. It stays in this collection on this device: Sync doesn't carry it, shared folders and the Sync server never see it, and it isn't part of Etude's telemetry. Backups of the collection include it.";

const statusOut = "{ on, keepDays, rows, since }";

command({
  name: "activity status",
  summary: "Whether Activity is on, how long it's kept, and how much is recorded.",
  description: ABOUT,
  output: statusOut,
  run: (ctx) => activityFor(ctx.e).status(),
});

command({
  name: "activity on",
  summary: "Start recording your activity on this device.",
  description: ABOUT,
  writes: true,
  output: statusOut,
  run(ctx) {
    activityFor(ctx.e).setPrefs({ on: true });
    return activityFor(ctx.e).status();
  },
});

command({
  name: "activity off",
  summary: "Stop recording. What was recorded stays unless --delete.",
  flags: [{ name: "delete", type: "boolean", description: "Also delete everything recorded." }],
  writes: true,
  output: statusOut,
  run(ctx) {
    activityFor(ctx.e).setPrefs({ on: false, deleteAll: !!ctx.flags.delete });
    return activityFor(ctx.e).status();
  },
});

command({
  name: "activity keep",
  summary: "How many days of activity to keep: 30, 90, 365, or forever.",
  args: [{ name: "days", description: "30, 90, 365, or forever.", required: true }],
  examples: ["etude activity keep 90", "etude activity keep forever"],
  writes: true,
  output: statusOut,
  run(ctx) {
    const raw = String(ctx.args.days).trim().toLowerCase();
    const days = raw === "forever" ? 0 : Number(raw);
    activityFor(ctx.e).setPrefs({ keepDays: KEEP_CHOICES.includes(days) ? days : Number.NaN });
    return activityFor(ctx.e).status();
  },
});

command({
  name: "activity show",
  summary: "What Stats shows: time and typing per day, per kind and hour, and the pages, files and chats you spent the most time in.",
  flags: [
    { name: "days", type: "number", description: "Days to cover, today included (1 to 366).", default: 30 },
    { name: "top", type: "number", description: "How many pages, files and chats to list.", default: 25 },
  ],
  examples: ["etude activity show --days 7"],
  output:
    "{ on, keepDays, today, days: [{ day, ms, typed, words, pasted }], totals: { ms, typed, pasted, deleted, words }, kinds: [{ kind, ms, typed, words }], screens: [{ screen, ms }], hours: [{ hour, ms, typed }], top: [{ kind, ref, title, path?, missing?, ms, typed, words, pasted, last }] }",
  run(ctx) {
    let chats: Map<string, string> | null = null;
    const chatTitle = (id: string) => {
      chats ??= new Map(agentFor(ctx.e).listConversations().map((c) => [c.id, c.title ?? ""]));
      return chats.has(id) ? chats.get(id)! : null;
    };
    return activityFor(ctx.e).summary(ctx.flags.days, { chatTitle, top: Math.max(1, Math.min(200, Math.round(ctx.flags.top))) });
  },
});

command({
  name: "activity clear",
  summary: "Delete everything Activity recorded. Recording goes on if it's on.",
  confirm: true,
  writes: true,
  output: "{ deleted }",
  run: (ctx) => activityFor(ctx.e).clear(),
});
