import { spawn } from "node:child_process";
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
    { name: "allow-host", type: "string", multiple: true, description: "Also answer requests for this hostname without a token (repeatable; $ETUDE_ALLOW_HOSTS, comma-separated). localhost, 127.x and *.ts.net are always allowed; other names are refused to stop DNS rebinding.", placeholder: "NAME" },
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
    let server: ReturnType<typeof serve>;
    const allowHosts = [...(ctx.flags["allow-host"] ?? []), ...(process.env.ETUDE_ALLOW_HOSTS ?? "").split(",")].map((h: string) => h.trim()).filter(Boolean);
    const app = createApp(ctx.e, { token, allowHosts, webDist: ctx.flags.dev ? null : existsSync(dist) ? dist : null, onRestart: () => restart(server, ctx) });
    server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      ctx.note(`etude ${ctx.flags.dev ? "api (dev) " : ""}on http://${host}:${info.port}  db ${ctx.dbPath}`);
    });
    return KEEP_OPEN;
  },
});

/**
 * Comes back on the new code after `etude update`. Under systemd (or another supervisor that sets
 * ETUDE_SUPERVISED), exit with EX_TEMPFAIL and let it restart us; otherwise free the port and run the
 * same command again in the foreground, staying around only to pass on its exit code.
 */
function restart(server: { close(cb?: () => void): unknown; closeAllConnections?(): void }, ctx: { e: { close(): void }; note(m: string): void }) {
  ctx.note("etude updated; restarting");
  const supervised = !!(process.env.INVOCATION_ID || process.env.ETUDE_SUPERVISED);
  let once = false;
  const done = () => {
    // server.close's callback and the 3 s fallback can both fire; restart only once.
    if (once) return;
    once = true;
    try {
      ctx.e.close();
    } catch {}
    if (supervised) process.exit(75);
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit", env: process.env });
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
    child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
  };
  server.closeAllConnections?.();
  server.close(done);
  // Don't wait forever on a connection that won't close.
  setTimeout(done, 3000).unref();
}

command({
  name: "update",
  summary: "Update this copy of Etude from its GitHub repo: fetch, fast-forward, install dependencies, rebuild the web app.",
  description:
    "Only works in a git checkout with no local changes. A running server keeps the old code until it restarts; the Update button in the app restarts it for you. Package installs (npm, the Mac app) get the latest release's version and a link instead.",
  flags: [{ name: "check", type: "boolean", description: "Only check for new commits; change nothing." }],
  noDb: true,
  writes: true,
  examples: ["etude update --check", "etude update"],
  output: "--check: { kind: git|package, version, commit, behind, incoming: [{ sha, date, subject }], blocked? } · otherwise { result: updated|current, from, to, commits, steps }",
  async run(ctx) {
    const { applyUpdate, updateStatus, UpdateError } = await import("../../core/update.ts");
    try {
      if (ctx.flags.check) return await updateStatus({ fetch: true, force: true });
      const out = await applyUpdate();
      if (out.result === "updated") ctx.note("updated; restart `etude serve` to run the new code");
      return out;
    } catch (e) {
      if (e instanceof UpdateError) throw new CliError(e.message, e.status === 409 ? "conflict" : e.status === 502 ? "external" : "internal", e.details);
      throw e;
    }
  },
});

command({
  name: "search",
  summary: "Find cards with the search language (one row per card). Same as `etude card list`.",
  args: [{ name: "query", description: "Search; words are joined.", variadic: true }],
  flags: [
    { name: "order", type: "string", description: "Sort order. relevance: with free text, items whose title is or starts with a word come first; otherwise the order added.", values: ["relevance", "added", "due", "deck", "lapses", "difficulty", "updated"], default: "relevance" },
    { ...LIMIT_FLAG, default: 50 },
    OFFSET_FLAG,
  ],
  examples: ['etude search deck:"Networks" is:due', 'etude search "tag:delay prop:lapses>=2" --order lapses', "etude search front:router"],
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
