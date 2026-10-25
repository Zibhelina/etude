import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { command, catalog, CliError, KEEP_OPEN, COMMANDS } from "../registry.ts";
import { LIMIT_FLAG, OFFSET_FLAG } from "../common.ts";
import { VERSION } from "../version.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

command({
  name: "serve",
  summary: "Run the web app and HTTP API.",
  description: "The CLI doesn't need the server: every command opens the database directly, and SQLite's WAL mode lets both run at once.",
  flags: [
    { name: "port", type: "number", description: "Port. Default $ETUDE_PORT or 4610." },
    { name: "host", type: "string", description: "Interface. Default $ETUDE_HOST or 127.0.0.1. Anything beyond localhost needs --token." },
    { name: "token", type: "string", description: "Require this bearer token on the API. Default $ETUDE_TOKEN." },
    { name: "web", type: "string", description: "Serve another web build directory.", placeholder: "DIR" },
    { name: "dev", type: "boolean", description: "API only (Vite serves the web app)." },
  ],
  examples: ["etude serve", "etude serve --host 0.0.0.0 --token $(openssl rand -hex 16)"],
  async run(ctx) {
    const { serve } = await import("@hono/node-server");
    const { createApp } = await import("../../server/app.ts");
    const port = ctx.flags.port ?? Number(process.env.ETUDE_PORT ?? 4610);
    const host = ctx.flags.host ?? process.env.ETUDE_HOST ?? "127.0.0.1";
    const token = ctx.flags.token ?? process.env.ETUDE_TOKEN;
    if (host !== "127.0.0.1" && host !== "localhost" && !token) throw new CliError("refusing to listen beyond localhost without --token");
    const dist = ctx.flags.web ? resolve(ctx.flags.web) : join(ROOT, "web", "dist");
    const app = createApp(ctx.e, { token, webDist: ctx.flags.dev ? null : existsSync(dist) ? dist : null });
    serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      ctx.note(`etude ${ctx.flags.dev ? "api (dev) " : ""}on http://${host}:${info.port}  db ${ctx.dbPath}`);
    });
    return KEEP_OPEN;
  },
});

command({
  name: "search",
  summary: "Find cards with the search language (one row per card). Same as `etude card list`.",
  args: [{ name: "query", description: "Search; words are joined.", variadic: true }],
  flags: [
    { name: "order", type: "string", description: "Sort order.", values: ["added", "due", "deck", "lapses", "difficulty", "updated"], default: "added" },
    { ...LIMIT_FLAG, default: 50 },
    OFFSET_FLAG,
  ],
  examples: ['etude search deck:"Networks" is:due', 'etude search "tag:delay prop:lapses>=2" --order lapses'],
  output: "{ total, rows: [...] }",
  run: (ctx) => ctx.e.search(ctx.args.query.join(" "), { limit: ctx.flags.limit, offset: ctx.flags.offset, order: ctx.flags.order }),
});

command({
  name: "commands",
  summary: "The catalog of every command: args, flags with types and defaults, examples, whether it writes. JSON for agents.",
  args: [{ name: "filter", description: "Only commands whose name starts with this (e.g. `card`)." }],
  flags: [{ name: "names", type: "boolean", description: "Only the command names, one per line." }],
  noDb: true,
  examples: ["etude commands", "etude commands study", "etude commands --names"],
  output: "{ etude: \"cli/1\", version, usage, globalFlags, exitCodes, groups, commands: [{ name, summary, args, flags, examples, writes, dryRun, confirm }] }",
  run(ctx) {
    const c = catalog(VERSION);
    const f = ctx.args.filter;
    const cmds = f ? c.commands.filter((x) => x.name === f || x.name.startsWith(f + " ")) : c.commands;
    if (f && !cmds.length) throw new CliError(`no commands match "${f}"`, "not_found");
    if (ctx.flags.names) return cmds.filter((x) => !x.legacy).map((x) => x.name).join("\n");
    return { ...c, commands: cmds };
  },
});

command({
  name: "version",
  summary: "Print the Etude version.",
  noDb: true,
  run: () => ({ version: VERSION, node: process.version, commands: COMMANDS.filter((c) => !c.legacy).length }),
});

command({
  name: "decks",
  summary: "Old spelling of `etude deck list` (compact rows).",
  legacy: true,
  aliasOf: "deck list",
  run: (ctx) => ctx.e.deckTree().map((d) => ({ deck: d.name, cards: d.cards, new: d.new, learning: d.learning, review: d.review, deadline: d.deadline })),
});
