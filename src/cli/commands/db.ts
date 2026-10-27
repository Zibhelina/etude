import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup } from "node:sqlite";
import { command, group, CliError, Failed } from "../registry.ts";

group({ name: "db", summary: "The database file: path, backups, integrity, schema version" });

const stamp = () => new Date().toISOString().replace(/[:]/g, "").replace(/\..+$/, "").replace("T", "-");

command({
  name: "db path",
  summary: "Which database and media directory the CLI uses, and how it was chosen.",
  noDb: true,
  output: "{ db, exists, bytes, mediaDir, source: flag|ETUDE_DB|ETUDE_HOME|default, home }",
  run(ctx) {
    const source = ctx.flags.db ? "flag" : ctx.env.ETUDE_DB ? "ETUDE_DB" : ctx.env.ETUDE_HOME ? "ETUDE_HOME" : "default";
    const exists = existsSync(ctx.dbPath);
    return { db: ctx.dbPath, exists, bytes: exists ? statSync(ctx.dbPath).size : 0, mediaDir: join(dirname(ctx.dbPath), "media"), source, home: ctx.home };
  },
});

command({
  name: "db backup",
  summary: "Copy the database consistently (SQLite online backup; safe while the server runs).",
  description: "Default destination: <db dir>/backups/etude-<timestamp>.db. Files under media/ are not copied; back up the media folder too to keep pasted media, imports and drawings.",
  args: [{ name: "dest", description: "Destination file or directory." }],
  flags: [{ name: "force", type: "boolean", description: "Overwrite an existing file." }],
  writes: true,
  examples: ["etude db backup", "etude db backup ~/backups/etude-before-cleanup.db"],
  output: "{ backup, bytes, pages }",
  async run(ctx) {
    let dest = ctx.args.dest ? resolve(ctx.args.dest) : join(dirname(ctx.dbPath), "backups", `etude-${stamp()}.db`);
    if (existsSync(dest) && statSync(dest).isDirectory()) dest = join(dest, `etude-${stamp()}.db`);
    if (existsSync(dest) && !ctx.flags.force) throw new CliError(`${dest} exists (use --force)`, "conflict");
    mkdirSync(dirname(dest), { recursive: true });
    const sql = ctx.e.db.sql;
    let pages: number;
    if (sql.serialize) {
      // WebAssembly driver: the database lives in memory, so write its image out.
      const bytes: Uint8Array = sql.serialize();
      writeFileSync(dest, bytes);
      pages = Math.round(bytes.length / Number(ctx.e.db.get("PRAGMA page_size")?.page_size ?? 4096));
    } else pages = await backup(sql as any, dest);
    return { backup: dest, bytes: statSync(dest).size, pages };
  },
});

command({
  name: "db check",
  summary: "Run SQLite's integrity and foreign-key checks. Exits 4 when something is wrong.",
  output: "{ ok, integrity: [...], foreignKeys: [...], counts }",
  run(ctx) {
    const db = ctx.e.db;
    const integrity = db.all("PRAGMA integrity_check").map((r) => Object.values(r)[0]);
    const fk = db.all("PRAGMA foreign_key_check");
    const counts = Object.fromEntries(["decks", "presets", "types", "items", "cards", "reviews", "attempts"].map((t) => [t, db.get(`SELECT COUNT(*) AS n FROM ${t}`)!.n]));
    const orphans = db.get("SELECT COUNT(*) AS n FROM items i LEFT JOIN types t ON t.id = i.type WHERE t.id IS NULL")!.n;
    const ok = integrity.length === 1 && integrity[0] === "ok" && !fk.length && !orphans;
    const out = { ok, integrity, foreignKeys: fk, itemsWithUnknownType: orphans, counts };
    return ok ? out : new Failed(out, new CliError("database check failed", "validation"));
  },
});

command({
  name: "db info",
  summary: "Schema version, SQLite version, journal mode, sizes and row counts.",
  output: "{ path, schemaVersion, sqlite, journalMode, bytes, counts }",
  run(ctx) {
    const db = ctx.e.db;
    const counts = Object.fromEntries(["decks", "presets", "types", "items", "cards", "reviews", "attempts"].map((t) => [t, db.get(`SELECT COUNT(*) AS n FROM ${t}`)!.n]));
    return {
      path: ctx.dbPath,
      schemaVersion: Number(db.get("SELECT value FROM meta WHERE key = 'schema_version'")?.value ?? 0),
      sqlite: db.get("SELECT sqlite_version() AS v")!.v,
      journalMode: db.get("PRAGMA journal_mode")!.journal_mode,
      bytes: statSync(ctx.dbPath).size,
      counts,
    };
  },
});

command({
  name: "db restore",
  summary: "Replace the database with a backup. The current file is backed up first. Stop the server before restoring.",
  args: [{ name: "backup", description: "Backup file.", required: true }],
  writes: true,
  confirm: true,
  noDb: true,
  examples: ["etude db restore ~/.etude/backups/etude-20261020-190000.db --yes"],
  output: "{ restored, previous }",
  async run(ctx) {
    const src = resolve(ctx.args.backup);
    if (!existsSync(src)) throw new CliError(`no such file: ${src}`, "not_found");
    let previous: string | null = null;
    if (existsSync(ctx.dbPath)) {
      const { DatabaseSync } = await import("node:sqlite");
      const cur = new DatabaseSync(ctx.dbPath);
      previous = join(dirname(ctx.dbPath), "backups", `etude-before-restore-${stamp()}.db`);
      mkdirSync(dirname(previous), { recursive: true });
      await backup(cur, previous);
      cur.close();
    }
    const { DatabaseSync } = await import("node:sqlite");
    const from = new DatabaseSync(src, { readOnly: true });
    await backup(from, ctx.dbPath);
    from.close();
    return { restored: ctx.dbPath, from: src, previous };
  },
});
