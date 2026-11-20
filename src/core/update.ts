// Updating Etude from its GitHub repo: check for new commits, fast-forward, rebuild, restart.
// Only a git checkout can update itself. Package installs (npm, the Mac app) get the latest
// release's version and a link instead.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ETUDE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export class UpdateError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status = 409, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export interface Commit {
  sha: string;
  subject: string;
  date: string;
}

export type UpdateStatus =
  | {
      kind: "git";
      version: string;
      branch: string | null;
      upstream: string | null;
      commit: string;
      /** New commits on the upstream, newest first (at most 20). */
      incoming: Commit[];
      behind: number;
      ahead: number;
      /** Tracked files with local changes. Updating keeps them: they're set aside, and put back on the new code. */
      dirty: string[];
      /** The local changes that will still be local changes after the update (the rest are already in it). */
      kept: string[];
      /** Untracked files the update would replace with something else; updating refuses while there are any. */
      clash: string[];
      checked: string | null;
      checkError?: string;
      /** Why one click can't update right now, if it can't. */
      blocked?: string;
    }
  | { kind: "package"; version: string; latest: string | null; url: string; checked: string | null; checkError?: string };

export interface UpdateResult {
  result: "updated" | "current";
  from: string;
  to: string;
  commits: Commit[];
  steps: { step: string; ms: number }[];
}

interface Opts {
  root?: string;
  /** Contact the remote (git fetch / GitHub releases). Without it, status uses what's already known. */
  fetch?: boolean;
  /** Fetch even if the last check was under THROTTLE_MS ago. */
  force?: boolean;
}

const lastCheck = new Map<string, { at: string; error?: string; latest?: string | null }>();

/** Automatic checks (opening the app) hit the remote at most this often. */
export const THROTTLE_MS = 10 * 60_000;
const due = (root: string, o: Opts) => !!o.fetch && (o.force || !lastCheck.get(root) || Date.now() - Date.parse(lastCheck.get(root)!.at) > THROTTLE_MS);

const pkgOf = (root: string) => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function git(root: string, args: string[], timeout = 60_000, raw = false): string {
  try {
    const out = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      // Never stop and wait for a password: the repo is public, and a prompt would hang the server.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", LC_ALL: "C" },
    });
    return raw ? out : out.trim();
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new UpdateError("git isn't installed", 424);
    const msg = String(err?.stderr || err?.message || err).trim();
    throw new UpdateError(`git ${args[0]}: ${msg}`, 502);
  }
}

/** True when `root` is the top of its own git checkout (not a folder inside some other repo). */
export function isCheckout(root = ETUDE_ROOT): boolean {
  if (!existsSync(join(root, ".git"))) return false;
  try {
    return realpathSync.native(resolve(git(root, ["rev-parse", "--show-toplevel"]))) === realpathSync.native(resolve(root));
  } catch {
    return false;
  }
}

const parseLog = (out: string): Commit[] =>
  out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, date, ...s] = l.split("\t");
      return { sha, date, subject: s.join("\t") };
    });


function repoSlug(pkg: any): string | null {
  const url: string = pkg?.repository?.url ?? pkg?.repository ?? "";
  return url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] ?? null;
}

const newer = (a: string, b: string) => {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

export async function updateStatus(opts: Opts = {}): Promise<UpdateStatus> {
  const root = opts.root ?? ETUDE_ROOT;
  const pkg = pkgOf(root);
  const version: string = pkg.version;

  if (!isCheckout(root)) {
    const slug = repoSlug(pkg) ?? "Zibhelina/etude";
    const url = `https://github.com/${slug}/releases/latest`;
    if (due(root, opts)) {
      const at = new Date().toISOString();
      try {
        const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        const tag = String(((await res.json()) as any).tag_name ?? "");
        lastCheck.set(root, { at, latest: tag.replace(/^v/, "") || null });
      } catch (e) {
        lastCheck.set(root, { at, error: (e as Error).message, latest: lastCheck.get(root)?.latest ?? null });
      }
    }
    const c = lastCheck.get(root);
    const latest = c?.latest && newer(c.latest, version) ? c.latest : null;
    return { kind: "package", version, latest, url, checked: c?.at ?? null, ...(c?.error ? { checkError: c.error } : {}) };
  }

  let branch: string | null = null;
  try {
    branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || null;
  } catch {
    branch = null;
  }
  let upstream: string | null = null;
  try {
    upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) || null;
  } catch {
    upstream = null;
  }
  if (upstream && due(root, opts)) {
    const at = new Date().toISOString();
    try {
      git(root, ["fetch", "--quiet", upstream.split("/")[0]], 45_000);
      lastCheck.set(root, { at });
    } catch (e) {
      lastCheck.set(root, { at, error: (e as Error).message });
    }
  }
  const commit = git(root, ["rev-parse", "--short", "HEAD"]);
  let behind = 0, ahead = 0, incoming: Commit[] = [];
  if (upstream) {
    const [a, b] = git(root, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]).split(/\s+/).map(Number);
    ahead = a;
    behind = b;
    if (behind) incoming = parseLog(git(root, ["log", "--max-count=20", "--format=%h%x09%cI%x09%s", "HEAD..@{u}"]));
  }
  // Raw: porcelain lines start with a status column that may be a space.
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"], 60_000, true).split("\n").filter(Boolean).map((l) => l.slice(3));
  const plan = upstream && behind ? localPlan(root) : { kept: changedPaths(root), clash: [], same: [] };
  const blocked = !branch
    ? "Not on a branch (detached HEAD)."
    : !upstream
      ? `Branch ${branch} doesn't track a remote branch.`
      : plan.clash.length
        ? `The update would replace ${plan.clash.length === 1 ? "an untracked file" : `${plan.clash.length} untracked files`}: ${plan.clash.slice(0, 3).join(", ")}${plan.clash.length > 3 ? "…" : ""}`
        : ahead && behind
          ? `This copy has ${ahead} commit${ahead === 1 ? "" : "s"} the repo doesn't, so it can't fast-forward.`
          : undefined;
  const c = lastCheck.get(root);
  return { kind: "git", version, branch, upstream, commit, incoming, behind, ahead, dirty, kept: plan.kept, clash: plan.clash, checked: c?.at ?? null, ...(c?.error ? { checkError: c.error } : {}), ...(blocked ? { blocked } : {}) };
}

const lines = (out: string) => out.split("\n").filter(Boolean);

/** Tracked paths whose working copy differs from HEAD (staged or not). */
const changedPaths = (root: string) => lines(git(root, ["diff", "--name-only", "--no-renames", "HEAD"]));

/** Blob ids of `paths` in a commit; a path it doesn't have is missing from the map. */
function blobsAt(root: string, rev: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!paths.length) return out;
  for (const l of lines(git(root, ["ls-tree", "-r", rev, "--", ...paths]))) {
    const m = l.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/** What the working copy holds for `paths` (null: the file isn't there). */
function blobsHere(root: string, paths: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>(paths.map((p) => [p, null]));
  const present = paths.filter((p) => existsSync(join(root, p)));
  if (present.length) git(root, ["hash-object", "--", ...present]).split("\n").forEach((h, i) => out.set(present[i], h.trim()));
  return out;
}

/**
 * How the local changes meet the update: tracked changes the update already has (`same`) or doesn't (`kept`), and
 * untracked files it would add: the same file (`same`, set aside while it updates) or a different one (`clash`).
 */
function localPlan(root: string): { kept: string[]; clash: string[]; same: string[] } {
  const tracked = changedPaths(root);
  const added = lines(git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=A", "HEAD", "@{u}"]));
  const untracked = added.length ? lines(git(root, ["ls-files", "--others", "--exclude-standard", "--", ...added])) : [];
  const up = blobsAt(root, "@{u}", [...tracked, ...untracked]);
  const here = blobsHere(root, [...tracked, ...untracked]);
  const isSame = (p: string) => (up.get(p) ?? null) === here.get(p);
  return {
    kept: tracked.filter((p) => !isSame(p)),
    clash: untracked.filter((p) => !isSame(p)),
    same: [...tracked.filter(isSame), ...untracked.filter(isSame)],
  };
}

/** Takes the update's stash out of the stash list once its changes are back where they were. */
function dropStash(root: string, sha: string) {
  if (!sha) return;
  const i = lines(git(root, ["stash", "list", "--format=%H"])).indexOf(sha);
  if (i >= 0) git(root, ["stash", "drop", "--quiet", `stash@{${i}}`]);
}

/** npm next to the node that runs Etude, run through that same node (no PATH lookup, no shebang). */
function npmArgs(): [string, string[]] {
  const cli = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(cli) ? [process.execPath, [cli]] : ["npm", []];
}

/**
 * Child processes find this node first, so `#!/usr/bin/env node` scripts work under systemd too.
 * In the desktop app this "node" is Electron, which runs scripts only in its Node mode.
 */
const toolEnv = () => ({
  ...process.env,
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
  GIT_TERMINAL_PROMPT: "0",
  ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
});

function run(step: string, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = toolEnv(), timeout = 10 * 60_000) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    const log = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-25).join("\n");
    throw new UpdateError(`${step} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`, 500, { step, log });
  }
}

/** Builds the web app beside the live one and swaps it in only when the build worked. */
function buildWeb(root: string) {
  const web = join(root, "web");
  const next = join(web, ".dist-next"), prev = join(web, ".dist-prev"), dist = join(web, "dist");
  const vite = join(root, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(vite)) throw new UpdateError("vite isn't installed (node_modules/vite is missing)", 500, { step: "build" });
  rmSync(next, { recursive: true, force: true });
  run("build", process.execPath, [vite, "build", "--config", join(web, "vite.config.ts"), "--outDir", next, "--emptyOutDir"], root);
  run("build", process.execPath, [vite, "build", "--config", join(web, "vite.kit.config.ts")], root, { ...toolEnv(), ETUDE_KIT_OUT: join(next, "kit") });
  rmSync(prev, { recursive: true, force: true });
  if (existsSync(dist)) renameSync(dist, prev);
  renameSync(next, dist);
  rmSync(prev, { recursive: true, force: true });
}

let busy = false;

/** Fast-forwards to the upstream, installs dependencies if the lockfile moved, rebuilds the web app. */
export async function applyUpdate(opts: Omit<Opts, "fetch"> = {}): Promise<UpdateResult> {
  const root = opts.root ?? ETUDE_ROOT;
  if (busy) throw new UpdateError("an update is already running");
  busy = true;
  try {
    const st = await updateStatus({ root, fetch: true, force: true });
    // Run by the desktop app's program (its etude command), this is the app's copy.
    if (st.kind !== "git" && process.versions.electron) throw new UpdateError("This etude came with the Etude desktop app, which updates itself.", 409);
    if (st.kind !== "git") throw new UpdateError(st.latest ? `This install can't update itself: get ${st.latest} from ${st.url}` : "This install can't update itself (it isn't a git checkout).", 409);
    if (st.checkError) throw new UpdateError(`Couldn't reach the repo: ${st.checkError}`, 502);
    if (st.blocked) throw new UpdateError(st.blocked, 409, { dirty: st.dirty, clash: st.clash });
    const steps: { step: string; ms: number }[] = [];
    const time = (step: string, f: () => void) => {
      const t = Date.now();
      f();
      steps.push({ step, ms: Date.now() - t });
    };
    const from = git(root, ["rev-parse", "HEAD"]);
    if (!st.behind) return { result: "current", from: from.slice(0, 7), to: from.slice(0, 7), commits: [], steps: [{ step: "fetch", ms: 0 }] };

    // Local changes go aside (a stash, kept until the end) and come back on the new code; untracked files the update
    // brings exactly as they are wait in .git until it's done. Anything that goes wrong puts it all back as it was.
    const tracked = new Set(changedPaths(root));
    const untrackedSame = localPlan(root).same.filter((p) => !tracked.has(p));
    // In .git (a worktree's .git is a file pointing at its own folder), out of the way of the working copy.
    const aside = join(git(root, ["rev-parse", "--absolute-git-dir"]), "etude-update", String(Date.now()));
    const moved: string[] = [];
    let stash = "";
    const putBack = () => {
      git(root, ["reset", "--hard", "--quiet", from]);
      if (stash) git(root, ["stash", "apply", "--quiet", stash]);
      for (const p of moved) {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        renameSync(join(aside, p), join(root, p));
      }
      rmSync(aside, { recursive: true, force: true });
      dropStash(root, stash);
    };
    time("pull", () => {
      try {
        for (const p of untrackedSame) {
          mkdirSync(dirname(join(aside, p)), { recursive: true });
          renameSync(join(root, p), join(aside, p));
          moved.push(p);
        }
        stash = git(root, ["stash", "create", `etude update from ${from.slice(0, 7)}`]);
        if (stash) {
          // Recorded in the stash list too, so it survives whatever happens next.
          git(root, ["stash", "store", "--quiet", "-m", `etude update from ${from.slice(0, 7)}`, stash]);
          git(root, ["reset", "--hard", "--quiet"]);
        }
        git(root, ["merge", "--ff-only", "--quiet", "@{u}"]);
      } catch (e) {
        putBack();
        throw e;
      }
      if (stash) {
        try {
          git(root, ["stash", "apply", "--quiet", stash]);
        } catch {
          const clashing = lines(git(root, ["diff", "--name-only", "--diff-filter=U"]));
          putBack();
          throw new UpdateError(`Your local changes clash with the update${clashing.length ? ` in ${clashing.slice(0, 3).join(", ")}${clashing.length > 3 ? "…" : ""}` : ""}. Nothing changed.`, 409, { clash: clashing });
        }
      }
    });
    const to = git(root, ["rev-parse", "HEAD"]);
    const changed = git(root, ["diff", "--name-only", from, to]).split("\n").filter(Boolean);
    try {
      const hasDeps = Object.keys({ ...pkgOf(root).dependencies, ...pkgOf(root).devDependencies }).length > 0;
      if (hasDeps && (changed.some((f) => f === "package.json" || f === "package-lock.json") || !existsSync(join(root, "node_modules")))) {
        const [cmd, pre] = npmArgs();
        time("install", () => run("install", cmd, [...pre, "install", "--no-audit", "--no-fund", "--loglevel=error"], root));
      }
      if (existsSync(join(root, "web", "vite.config.ts"))) time("build", () => buildWeb(root));
    } catch (e) {
      // Leave the code as it was, local changes included; the live web build was never touched.
      try {
        putBack();
      } catch {}
      throw e;
    }
    rmSync(aside, { recursive: true, force: true });
    dropStash(root, stash);
    return { result: "updated", from: from.slice(0, 7), to: to.slice(0, 7), commits: st.incoming, steps };
  } finally {
    busy = false;
  }
}
