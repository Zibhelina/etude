import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { bundledPlugin, bundledPlugins, checkPlugin, loadPluginDir, pluginHash, pluginsFor, scaffoldPlugin, type PluginPackage } from "../../core/plugins.ts";
import { command, group, CliError } from "../registry.ts";

group({ name: "plugin", summary: "Plugins: sandboxed extensions for Desktop and Web (install, check, permissions, scaffold)", defaultVerb: "list" });

function readPluginSource(source: string): { pkg: PluginPackage; origin: "local" | "bundled" } {
  const bundled = bundledPlugin(source);
  if (bundled && !existsSync(source)) return { pkg: { manifest: bundled.manifest, files: bundled.files }, origin: "bundled" };
  const p = resolve(source);
  if (!existsSync(p)) throw new CliError(`no plugin folder or file at "${source}"`, "not_found");
  if (statSync(p).isDirectory()) return { pkg: loadPluginDir(p), origin: "local" };
  const raw = JSON.parse(readFileSync(p, "utf8"));
  if (raw?.etudeMarket === 1 && raw?.kind === "plugin" && raw?.content) return { pkg: raw.content as PluginPackage, origin: "local" };
  return { pkg: raw as PluginPackage, origin: "local" };
}

command({
  name: "plugin list",
  summary: "Installed plugins and bundled free plugins ready to install.",
  examples: ["etude plugin list"],
  output: "{ installed: [...], bundled: [...] }",
  run(ctx) {
    return {
      installed: pluginsFor(ctx.e).list(),
      bundled: bundledPlugins().map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        author: p.manifest.author,
        description: p.manifest.description,
        permissions: p.manifest.permissions,
        platforms: p.manifest.platforms,
        hash: p.hash,
      })),
    };
  },
});

command({
  name: "plugin show",
  summary: "Details, granted permissions and hash of one installed plugin.",
  args: [{ name: "id", description: "Plugin id.", required: true }],
  examples: ["etude plugin show pomodoro"],
  output: "installed plugin metadata",
  run(ctx) {
    const p = pluginsFor(ctx.e).get(ctx.args.id);
    if (!p) throw new CliError(`unknown plugin "${ctx.args.id}"`, "not_found");
    return p;
  },
});

command({
  name: "plugin check",
  summary: "Validate a plugin folder or JSON package (manifest, permissions, static safety checks, SHA-256).",
  args: [{ name: "path", description: "Plugin directory, JSON package, or bundled plugin id.", required: true }],
  examples: ["etude plugin check ./examples/plugins/pomodoro"],
  output: "{ ok, id, version, hash, permissions, errors }",
  run(ctx) {
    const { pkg } = readPluginSource(ctx.args.path);
    const errors = checkPlugin(pkg);
    return {
      ok: errors.length === 0,
      id: pkg.manifest?.id ?? null,
      version: pkg.manifest?.version ?? null,
      hash: errors.length === 0 ? pluginHash(pkg) : null,
      permissions: pkg.manifest?.permissions ?? [],
      errors,
    };
  },
});

command({
  name: "plugin new",
  summary: "Create a starter plugin folder with plugin.json, main.js and a floating view.",
  args: [{ name: "id", description: "Lowercase slug id for the plugin.", required: true }],
  flags: [
    { name: "dir", type: "string", description: "Target directory (default: ./<id>).", placeholder: "DIR" },
    { name: "name", type: "string", description: "Display name." },
    { name: "author", type: "string", description: "Author name." },
  ],
  examples: ["etude plugin new my-timer --dir ./my-timer"],
  output: "{ dir, files }",
  run(ctx) {
    return scaffoldPlugin(ctx.args.id, ctx.flags.dir ?? ctx.args.id, { name: ctx.flags.name, author: ctx.flags.author });
  },
});

command({
  name: "plugin install",
  summary: "Install a plugin from a folder, JSON package, or bundled free plugin id (user-only).",
  args: [{ name: "source", description: "Folder path, JSON file, or bundled id (e.g. pomodoro).", required: true }],
  flags: [
    { name: "enable", type: "boolean", description: "Grant declared permissions and enable immediately." },
    { name: "hash", type: "string", description: "Expected SHA-256 hash to verify before installing.", placeholder: "SHA256" },
  ],
  writes: true,
  dryRun: true,
  examples: ["etude plugin install pomodoro --enable", "etude plugin install ./my-plugin --enable"],
  output: "{ plugin, status, pausedForPermissions }",
  run(ctx) {
    const { pkg, origin } = readPluginSource(ctx.args.source);
    if (ctx.dry) {
      const errors = checkPlugin(pkg);
      if (errors.length) throw new CliError(`invalid plugin: ${errors.join("; ")}`, "usage");
      return { dryRun: true, id: pkg.manifest.id, version: pkg.manifest.version, hash: pluginHash(pkg), permissions: pkg.manifest.permissions };
    }
    return pluginsFor(ctx.e).install(pkg, { source: origin, expectedHash: ctx.flags.hash, enable: !!ctx.flags.enable });
  },
});

command({
  name: "plugin enable",
  summary: "Enable an installed plugin (user-only).",
  args: [{ name: "id", description: "Plugin id.", required: true }],
  writes: true,
  examples: ["etude plugin enable pomodoro"],
  run: (ctx) => pluginsFor(ctx.e).setEnabled(ctx.args.id, true),
});

command({
  name: "plugin disable",
  summary: "Disable an installed plugin without deleting its data (user-only).",
  args: [{ name: "id", description: "Plugin id.", required: true }],
  writes: true,
  examples: ["etude plugin disable pomodoro"],
  run: (ctx) => pluginsFor(ctx.e).setEnabled(ctx.args.id, false),
});

command({
  name: "plugin permissions",
  summary: "Grant or revoke permissions for an installed plugin (user-only).",
  args: [{ name: "id", description: "Plugin id.", required: true }],
  flags: [
    { name: "grant", type: "string", multiple: true, description: "Permission to grant." },
    { name: "revoke", type: "string", multiple: true, description: "Permission to revoke." },
  ],
  writes: true,
  examples: ["etude plugin permissions pomodoro --revoke notify"],
  run(ctx) {
    const store = pluginsFor(ctx.e);
    const cur = store.get(ctx.args.id);
    if (!cur) throw new CliError(`unknown plugin "${ctx.args.id}"`, "not_found");
    const next = new Set(cur.granted);
    for (const p of ctx.flags.grant) next.add(p);
    for (const p of ctx.flags.revoke) next.delete(p);
    return store.setPermissions(ctx.args.id, [...next]);
  },
});

command({
  name: "plugin uninstall",
  summary: "Uninstall a plugin and remove its collection storage (user-only).",
  args: [{ name: "id", description: "Plugin id.", required: true }],
  writes: true,
  confirm: true,
  examples: ["etude plugin uninstall pomodoro --yes"],
  run: (ctx) => pluginsFor(ctx.e).uninstall(ctx.args.id),
});
