// The Command Code plan, as a subprocess provider. It answers one chat request by running
// headless Command Code (`cmd -p`) and reading back its `finalText`. It never sees Etude's
// CLI commands; it just answers the question handed to it in the prompt. This file owns all
// of the `cmd` wire I/O so it's testable without launching a real binary.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { AiError, type ChatProvider } from "./ai.ts";

/** For tests: replaces the binary. */
export let commandCodeBinary = "cmd";
/** For tests: replaces the spawn. */
export const _spawn = spawn;

export interface CommandCodeRun {
  text: string;
  model: string;
  ms: number;
}

/** The `cmd` binary: an absolute path in `ETUDE_CMDCODE_BIN`, or plain `cmd` on PATH. */
export function commandCodeBinaryPath(): string {
  const env = process.env.ETUDE_CMDCODE_BIN?.trim();
  return env ?? commandCodeBinary;
}

/** True when the `cmd` binary can be found; its GO login answers the rest. */
export function commandCodePresent(): boolean {
  try {
    const win = process.platform === "win32";
    const paths = (process.env.PATH || "").split(win ? ";" : ":").filter(Boolean);
    const bin = commandCodeBinaryPath();
    if (bin.includes("/") || bin.includes("\\")) return existsSync(bin);
    return paths.some((d) => existsSync(`${d}/${bin}`) || (win && existsSync(`${d}/${bin}.exe`)));
  } catch {
    return false;
  }
}

/** Display name for the Command Code model group: the model's id, or "default model". */
export function cmdcodeModelName(fb: ChatProvider | null | undefined): string {
  return fb?.kind === "commandcode" && fb.model?.trim() ? fb.model.trim() : "default model";
}

export const DEFAULT_CMDCODE_TIMEOUT_MS = 300_000;
export const LIST_MODELS_TIMEOUT_MS = 15_000;

export interface CommandCodeModel {
  id: string;
  name: string;
  default: boolean;
}

const MODEL_ID = /^[a-zA-Z0-9][\w.-]*(?:\/[\w.:-]+)?$/;

/** Parse `cmd --list-models` output: "group" lines and "id  description" lines. Skips noise. */
export function parseModelList(out: string): CommandCodeModel[] {
  const models: CommandCodeModel[] = [];
  const seen = new Set<string>();
  let inFooter = false;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("Available models")) { inFooter = false; continue; }
    if (line.startsWith("Pass the full id") || line.startsWith("Docs:") || line.startsWith("Decision models")) { inFooter = true; continue; }
    if (!inFooter && /^(Open Source|Stealth|Anthropic|OpenAI|Google|Sakana|Meta|xAI)$/.test(line)) continue;
    if (inFooter) continue;
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, id, desc] = m;
    if (id.startsWith("/") || id.includes("://") || id.startsWith("cmd") || !MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: desc.trim(), default: /\(default\)/.test(desc) });
  }
  return models;
}

/** The models the GO plan can use, straight from `cmd --list-models`. */
export async function listCommandCodeModels(opts: { timeoutMs?: number } = {}): Promise<CommandCodeModel[]> {
  const bin = commandCodeBinaryPath();
  const { stdout, stderr, code, timedOut, spawnError } = await execFilePromise(bin, ["--list-models"], undefined, opts.timeoutMs ?? LIST_MODELS_TIMEOUT_MS);
  if (spawnError) throw new AiError(`${bin}: ${spawnError.message}`);
  if (timedOut) throw new AiError(`cmd timed out after ${opts.timeoutMs ?? LIST_MODELS_TIMEOUT_MS} ms`);
  if (code !== 0) throw new AiError((stderr || `cmd exited with ${code}`).trim().slice(0, 300));
  return parseModelList(stdout);
}

/**
 * One subprocess call. The full conversation is rendered as text and passed as the query
 * argument; `cmd -p --output-format json` prints one final result line whose `finalText`
 * is what the user would type. Reads only: never passes `--yolo` (blocks writes/shell).
 */
export async function commandCodeTurn(
  provider: Extract<ChatProvider, { kind: "commandcode" }>,
  system: string,
  messages: { role: string; content: string }[],
  signal?: AbortSignal,
): Promise<CommandCodeRun> {
  const t0 = Date.now();
  const query = buildQuery(system, messages);
  const bin = commandCodeBinaryPath();
  const args = ["-p", query, "--output-format", "json"];
  if (provider.model?.trim()) args.push("--model", provider.model.trim());
  const timeoutMs = provider.timeoutMs ?? DEFAULT_CMDCODE_TIMEOUT_MS;

  const { stdout, stderr, code, timedOut, spawnError } = await execFilePromise(bin, args, signal, timeoutMs);

  if (spawnError) throw new AiError(`${bin}: ${spawnError.message}`);
  if (timedOut || signal?.aborted) throw new AiError(signal?.aborted ? "stopped" : `cmd timed out after ${timeoutMs} ms`);
  if (code !== 0) throw new AiError((stderr || `cmd exited with ${code}`).trim().slice(0, 300));

  const finalText = parseFinalText(stdout);
  if (finalText == null) throw new AiError("cmd returned no answer");
  if (!finalText.trim()) throw new AiError("language model returned no text");
  const display = provider.model?.trim() ? `cmd:${provider.model.trim()}` : "cmd (default model)";
  return { text: finalText.trim(), model: display, ms: Date.now() - t0 };
}

/** Render the conversation as a single prompt: instructions, then labelled turns. */
export function buildQuery(system: string, messages: { role: string; content: string }[]): string {
  const turns = messages
    .map((m) => {
      const who = m.role === "system" ? "System" : m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
      return `${who}: ${m.content}`;
    })
    .join("\n\n");
  return `${system}\n\n${turns}`;
}

/** The last result line of an NDJSON stream wins; `finalText` is the assistant's reply. */
export function parseFinalText(out: string): string | null {
  const lines = out.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]);
      if (j && typeof j.finalText === "string") return j.finalText;
    } catch {}
  }
  return null;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  spawnError?: Error;
}

function execFilePromise(bin: string, args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => child.kill("SIGTERM");
    const done = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const child = _spawn(bin, args, { shell: false, env: process.env });
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => done({ stdout: out, stderr: err, code: 0, timedOut, spawnError: e }));
    child.on("close", (code) => done({ stdout: out, stderr: err, code: code ?? 1, timedOut }));
  });
}
