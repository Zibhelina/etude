#!/usr/bin/env node
// etude: serve the app, or operate on the collection from a terminal (and from agents).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Etude, EtudeError } from "../core/engine.ts";

const HELP = `etude: spaced-repetition practice with programmable card types

Usage: etude <command> [options]

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

Global: --db PATH (or ETUDE_DB). Default ~/.etude/etude.db. Secrets are read from
the environment and from ~/.etude/.env (e.g. OPENROUTER_API_KEY=...).
Output is JSON unless noted, so agents can read it directly.
`;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main(argv: string[]) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      token: { type: "string" },
      deck: { type: "string" },
      q: { type: "string" },
      out: { type: "string", short: "o" },
      limit: { type: "string" },
      "dry-run": { type: "boolean" },
      dev: { type: "boolean" },
      web: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || o.help) {
    process.stdout.write(HELP);
    return;
  }
  const home = process.env.ETUDE_HOME ?? join(homedir(), ".etude");
  const envFile = join(home, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const dbPath = resolve(o.db ?? process.env.ETUDE_DB ?? join(home, "etude.db"));
  const etude = await Etude.open(dbPath);
  const out = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  const scope = { deck: o.deck, query: o.q };

  switch (cmd) {
    case "serve": {
      const { serve } = await import("@hono/node-server");
      const { createApp } = await import("../server/app.ts");
      const port = Number(o.port ?? process.env.ETUDE_PORT ?? 4610);
      const host = o.host ?? process.env.ETUDE_HOST ?? "127.0.0.1";
      const token = o.token ?? process.env.ETUDE_TOKEN;
      if (host !== "127.0.0.1" && host !== "localhost" && !token) throw new EtudeError("refusing to listen beyond localhost without --token");
      const dist = o.web ? resolve(o.web) : join(ROOT, "web", "dist");
      const app = createApp(etude, { token, webDist: o.dev ? null : existsSync(dist) ? dist : null });
      serve({ fetch: app.fetch, port, hostname: host }, (info) => {
        console.error(`etude ${o.dev ? "api (dev) " : ""}on http://${host}:${info.port}  db ${dbPath}`);
      });
      return "serving";
    }
    case "import": {
      if (!args.length) throw new EtudeError("give one or more pack files");
      const reports = args.map((f) => ({ file: f, ...etude.importPack(JSON.parse(readFileSync(f, "utf8")), { dryRun: o["dry-run"] }) }));
      out(o["dry-run"] ? { dryRun: true, reports } : reports);
      break;
    }
    case "export": {
      const pack = etude.exportPack(scope);
      if (o.out) {
        writeFileSync(o.out, JSON.stringify(pack, null, 1) + "\n");
        out({ written: o.out, items: pack.items.length });
      } else out(pack);
      break;
    }
    case "decks":
      out(etude.deckTree().map((d) => ({ deck: d.name, cards: d.cards, new: d.new, learning: d.learning, review: d.review, deadline: d.deadline })));
      break;
    case "search":
      out(etude.search(args.join(" "), { limit: Number(o.limit ?? 50) }));
      break;
    case "show":
      out(etude.item(args[0] ?? ""));
      break;
    case "next":
      out(etude.next(scope));
      break;
    case "stats":
      out(etude.stats(scope));
      break;
    case "reschedule":
      out(etude.reschedule(scope));
      break;
    case "types":
      out(etude.listTypes());
      break;
    case "type-export": {
      const def = etude.type(args[0] ?? "");
      const dir = o.out ?? def.id;
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true });
      const { template, prepare, grader, updated, builtin, ...meta } = def as any;
      const g = { ...grader };
      if (g.code) {
        writeFileSync(join(dir, "grade.js"), g.code);
        delete g.code;
      }
      writeFileSync(join(dir, "type.json"), JSON.stringify({ ...meta, grader: g }, null, 2) + "\n");
      writeFileSync(join(dir, "template.html"), template.html ?? "");
      if (template.css) writeFileSync(join(dir, "style.css"), template.css);
      if (template.js) writeFileSync(join(dir, "card.js"), template.js);
      if (prepare) writeFileSync(join(dir, "prepare.js"), prepare);
      out({ written: dir });
      break;
    }
    case "type-import": {
      const { loadTypeDir } = await import("../core/types.ts");
      const p = args[0] ?? "";
      const def = p.endsWith(".json") ? JSON.parse(readFileSync(p, "utf8")) : loadTypeDir(p);
      out(etude.saveType(def));
      break;
    }
    default:
      throw new EtudeError(`unknown command "${cmd}"\n\n${HELP}`);
  }
  etude.close();
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(JSON.stringify({ error: e?.message ?? String(e) }) + "\n");
  process.exit(1);
});
