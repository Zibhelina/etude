// Updating Etude from its GitHub repo: check for new commits, fast-forward, rebuild, restart.
// Only a git checkout can update itself. Package installs (npm, the Mac app) get the latest
// release's version and a link instead.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
      /** Tracked files with local changes; updating refuses while there are any. */
      dirty: string[];
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
    return resolve(git(root, ["rev-parse", "--show-toplevel"])) === resolve(root);
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
  const blocked = !branch
    ? "Not on a branch (detached HEAD)."
    : !upstream
      ? `Branch ${branch} doesn't track a remote branch.`
      : dirty.length
        ? `${dirty.length} file${dirty.length === 1 ? " has" : "s have"} local changes.`
        : ahead && behind
          ? `This copy has ${ahead} commit${ahead === 1 ? "" : "s"} the repo doesn't, so it can't fast-forward.`
          : undefined;
  const c = lastCheck.get(root);
  return { kind: "git", version, branch, upstream, commit, incoming, behind, ahead, dirty, checked: c?.at ?? null, ...(c?.error ? { checkError: c.error } : {}), ...(blocked ? { blocked } : {}) };
}

/** npm next to the node that runs Etude, run through that same node (no PATH lookup, no shebang). */
function npmArgs(): [string, string[]] {
  const cli = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(cli) ? [process.execPath, [cli]] : ["npm", []];
}

/** Child processes find this node first, so `#!/usr/bin/env node` scripts work under systemd too. */
const toolEnv = () => ({ ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, GIT_TERMINAL_PROMPT: "0" });

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
    if (st.kind !== "git") throw new UpdateError(st.latest ? `This install can't update itself: get ${st.latest} from ${st.url}` : "This install can't update itself (it isn't a git checkout).", 409);
    if (st.checkError) throw new UpdateError(`Couldn't reach the repo: ${st.checkError}`, 502);
    if (st.blocked) throw new UpdateError(st.blocked, 409, { dirty: st.dirty });
    const steps: { step: string; ms: number }[] = [];
    const time = (step: string, f: () => void) => {
      const t = Date.now();
      f();
      steps.push({ step, ms: Date.now() - t });
    };
    const from = git(root, ["rev-parse", "HEAD"]);
    if (!st.behind) return { result: "current", from: from.slice(0, 7), to: from.slice(0, 7), commits: [], steps: [{ step: "fetch", ms: 0 }] };

    time("pull", () => git(root, ["merge", "--ff-only", "--quiet", "@{u}"]));
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
      // Leave the code as it was; the live web build was never touched.
      try {
        git(root, ["reset", "--keep", "--quiet", from]);
      } catch {}
      throw e;
    }
    return { result: "updated", from: from.slice(0, 7), to: to.slice(0, 7), commits: st.incoming, steps };
  } finally {
    busy = false;
  }
}
