import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Etude } from "../../core/engine.ts";
import { initSandbox } from "../../core/sandbox.ts";
import {
  MARKET_KINDS,
  buildIndex,
  buildSubmission,
  checkEntry,
  entryJson,
  entryPath,
  fetchEntry,
  fetchIndex,
  forgetInstall,
  ghStatus,
  installEntry,
  installFile,
  installState,
  installedEntries,
  manualPublishUrl,
  marketSettings,
  publishFile,
  summarize,
  type MarketKind,
} from "../../core/market.ts";
import { command, group, CliError, Failed } from "../registry.ts";
import { parseJson, readSource } from "../input.ts";

group({ name: "market", summary: "Market: browse, install and publish shared themes, decks and card types", defaultVerb: "list" });

const KIND_FLAG = { name: "kind", type: "string" as const, description: "theme, deck or type.", values: [...MARKET_KINDS] };
const URL_FLAG = { name: "url", type: "string" as const, description: "Read the market from this URL or folder instead of the configured one (`settings set market.url=…`).", placeholder: "URL" };

command({
  name: "market list",
  summary: "Entries in the market, newest first, with whether each is installed here.",
  flags: [
    KIND_FLAG,
    { name: "query", type: "string", alias: ["q"], description: "Only entries whose name, description, author or tags contain these words.", placeholder: "WORDS" },
    { name: "refresh", type: "boolean", description: "Skip the one-minute cache of the index." },
    URL_FLAG,
  ],
  examples: ["etude market list", "etude market list --kind theme", 'etude market list -q "japanese"'],
  output: "array of { id, kind, name, description, author, tags, version, updated, bytes, installed: installed|update|null }",
  async run(ctx) {
    const url = ctx.flags.url ?? marketSettings(ctx.e).url;
    const index = await fetchIndex(url, { refresh: ctx.flags.refresh });
    const words = String(ctx.flags.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const installed = installedEntries(ctx.e);
    return index.entries
      .filter((x) => !ctx.flags.kind || x.kind === ctx.flags.kind)
      .filter((x) => words.every((w) => [x.name, x.description, x.author, ...x.tags].join(" ").toLowerCase().includes(w)))
      .map(({ summary: _s, path: _p, ...x }) => ({ ...x, installed: installState(ctx.e, x, installed) }));
  },
});

command({
  name: "market show",
  summary: "One entry: its details from the index and what it contains.",
  args: [{ name: "id", description: "Entry id.", required: true }],
  flags: [KIND_FLAG, URL_FLAG, { name: "content", type: "boolean", description: "Download the entry and print the whole file." }],
  examples: ["etude market show dusk-rose", "etude market show morse-code --content"],
  output: "{ id, kind, name, …, summary, installed } or the entry file with --content",
  async run(ctx) {
    const url = ctx.flags.url ?? marketSettings(ctx.e).url;
    const index = await fetchIndex(url);
    const hit = index.entries.filter((x) => x.id === ctx.args.id && (!ctx.flags.kind || x.kind === ctx.flags.kind));
    if (!hit.length) throw new CliError(`the market has no entry "${ctx.args.id}"`, "not_found");
    if (hit.length > 1) throw new CliError(`"${ctx.args.id}" names more than one entry; pass --kind`, "usage");
    if (ctx.flags.content) return fetchEntry(url, hit[0]);
    return { ...hit[0], installed: installState(ctx.e, hit[0]) };
  },
});

command({
  name: "market install",
  summary: "Add an entry to your collection. Installing again updates it; decks keep your scheduling.",
  description:
    "A theme becomes a custom theme (it gets a new id if yours already uses the published one). A deck or card type is imported as a pack: items match by id, so reinstalling updates content and keeps review history. With --file, installs a local entry file instead of one from the market.",
  args: [{ name: "id", description: "Entry id (omit with --file).", required: false }],
  flags: [KIND_FLAG, URL_FLAG, { name: "file", type: "string", description: "Install this entry file (`-` for stdin).", placeholder: "FILE" }, { name: "use", type: "boolean", description: "Themes: also select it." }],
  writes: true,
  dryRun: "self",
  examples: ["etude market install dusk-rose --use", "etude market install morse-code --dry-run", "etude market install --file my-deck.json"],
  output: "{ entry, result: created|updated|unchanged, ids, dryRun, report }",
  async run(ctx) {
    let out;
    if (ctx.flags.file) out = installFile(ctx.e, parseJson(readSource(ctx, ctx.flags.file), ctx.flags.file), { dryRun: ctx.dry });
    else if (ctx.args.id) out = await installEntry(ctx.e, ctx.args.id, { url: ctx.flags.url, kind: ctx.flags.kind as MarketKind | undefined, dryRun: ctx.dry });
    else throw new CliError("give an entry id or --file", "usage");
    if (ctx.flags.use && out.entry.kind === "theme" && !ctx.dry) ctx.e.selectTheme(out.ids[0]);
    return out;
  },
});

command({
  name: "market installed",
  summary: "What you installed from the market, with what each put in your collection.",
  output: "array of { id, kind, name, version, updated, at, ids }",
  run: (ctx) => Object.entries(installedEntries(ctx.e)).map(([id, r]) => ({ id, ...r })),
});

command({
  name: "market forget",
  summary: "Stop tracking an installed entry. What it added stays in your collection; delete that with `theme delete`, `deck delete` or `type delete`.",
  args: [{ name: "id", description: "Entry id.", required: true }],
  writes: true,
  output: "{ forgot: id }",
  run(ctx) {
    if (!forgetInstall(ctx.e, ctx.args.id)) throw new CliError(`"${ctx.args.id}" isn't installed`, "not_found");
    return { forgot: ctx.args.id };
  },
});

const PUBLISH_FLAGS = [
  { name: "kind", type: "string" as const, description: "theme, deck or type.", values: [...MARKET_KINDS] },
  { name: "id", type: "string" as const, description: "Entry id in the market (default: from the name).", placeholder: "SLUG" },
  { name: "name", type: "string" as const, description: "Name shown in the market (default: the theme's, deck's or type's).", placeholder: "TEXT" },
  { name: "description", type: "string" as const, description: "A few lines on what it is and who it's for.", placeholder: "TEXT" },
  { name: "author", type: "string" as const, description: "How you want to be credited. Default: your GitHub login.", placeholder: "NAME" },
  { name: "tag", type: "string" as const, multiple: true, description: "A tag (repeatable).", placeholder: "TAG" },
  { name: "version", type: "string" as const, description: "Version label; bump it when you publish an update.", placeholder: "TEXT" },
  { name: "examples", type: "number" as const, description: "Card types: how many of your items of the type go along as examples.", default: 3 },
];

command({
  name: "market publish",
  summary: "Share a theme, deck or card type: opens a pull request on the market repository with your GitHub account.",
  description:
    "Needs the GitHub CLI signed in (`gh auth login`). Etude forks the market repository if you can't push to it, adds the entry file on a new branch and opens a pull request; it shows up for everyone once it's merged. Decks are shared without your review history. With -o the entry file is written and nothing is sent. --dry-run builds and checks the file and prints where it would go.",
  args: [{ name: "ref", description: "Theme id, deck name, or type id in your collection.", required: true }],
  flags: [...PUBLISH_FLAGS, { name: "out", type: "string", short: "o", description: "Write the entry file here instead of publishing.", placeholder: "FILE" }, { name: "force", type: "boolean", description: "Overwrite an existing --out file." }],
  writes: true,
  dryRun: "self",
  examples: ["etude market publish my-theme --kind theme --tag dark", 'etude market publish "Japanese::Kana" --kind deck --description "All 92 kana, both ways"', "etude market publish morse --kind type -o morse.json"],
  output: "{ url, number, branch, repo, fork, path, updated } or { written } with --out, or { dryRun, path, bytes, entry, manualUrl }",
  run(ctx) {
    if (!ctx.flags.kind) throw new CliError("say what you're publishing with --kind theme|deck|type", "usage");
    const repo = marketSettings(ctx.e).repo;
    let author = ctx.flags.author;
    const offline = ctx.dry || ctx.flags.out;
    const gh = offline ? null : ghStatus();
    if (!author && gh?.ok) author = gh.login;
    const file = buildSubmission(ctx.e, {
      kind: ctx.flags.kind,
      ref: ctx.args.ref,
      id: ctx.flags.id,
      name: ctx.flags.name,
      description: ctx.flags.description,
      author,
      tags: ctx.flags.tag,
      version: ctx.flags.version,
      examples: ctx.flags.examples,
    });
    if (ctx.flags.out) {
      const path = resolve(ctx.flags.out);
      if (existsSync(path) && !ctx.flags.force) throw new CliError(`${path} exists (use --force)`, "conflict");
      writeFileSync(path, entryJson(file));
      return { written: path, id: file.id, kind: file.kind, bytes: Buffer.byteLength(entryJson(file)) };
    }
    if (ctx.dry) return { dryRun: true, repo, path: entryPath(file.kind, file.id), bytes: Buffer.byteLength(entryJson(file)), entry: { ...file, content: undefined }, summary: summarize(file), manualUrl: manualPublishUrl(repo, file) };
    if (!gh?.ok) throw new CliError(`${gh?.reason ?? "gh isn't available"}. Write the file with -o and add it on GitHub: ${manualPublishUrl(repo, file)}`, "external");
    return publishFile(file, { repo });
  },
});

command({
  name: "market check",
  summary: "Validate market entry files without a database. Exits 4 on problems.",
  args: [{ name: "files", description: "Entry files.", required: true, variadic: true }],
  noDb: true,
  examples: ["etude market check entries/themes/*.json"],
  output: "{ ok, files: [{ file, ok, errors }] }",
  run(ctx) {
    const files = ctx.args.files.map((f: string) => {
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(f, "utf8"));
      } catch (e) {
        return { file: f, ok: false, errors: [`not valid JSON: ${(e as Error).message}`] };
      }
      const errors = checkEntry(data);
      return { file: f, ok: !errors.length, errors };
    });
    const out = { ok: files.every((f: any) => f.ok), files };
    return out.ok ? out : new Failed(out, new CliError("market entries have problems", "validation"));
  },
});

command({
  name: "market index",
  summary: "For the market repository: check every file under entries/ (each deck and type is dry-run imported) and write index.json.",
  args: [{ name: "dir", description: "The market repository checkout.", required: true }],
  flags: [
    { name: "repo", type: "string", description: "owner/name recorded in the index.", placeholder: "OWNER/NAME" },
    { name: "check", type: "boolean", description: "Only check; don't write index.json." },
  ],
  noDb: true,
  writes: true,
  examples: ["etude market index .", "etude market index . --check"],
  output: "{ ok, entries, problems: [{ path, errors }], written? }",
  async run(ctx) {
    await initSandbox();
    const { index, problems } = await buildIndex(ctx.args.dir, { repo: ctx.flags.repo, dryRunInto: () => Etude.open(":memory:") });
    const out: Record<string, unknown> = { ok: !problems.length, entries: index.entries.length, problems };
    if (problems.length) return new Failed(out, new CliError(`${problems.length} entr${problems.length === 1 ? "y has" : "ies have"} problems`, "validation"));
    if (!ctx.flags.check) {
      const path = resolve(ctx.args.dir, "index.json");
      writeFileSync(path, JSON.stringify(index, null, 1) + "\n");
      out.written = path;
    }
    return out;
  },
});
