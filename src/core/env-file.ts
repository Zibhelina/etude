// API keys in $ETUDE_HOME/.env: one NAME=value per line, readable by the owner only. A key is written
// here and put in the environment, and never read back out.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keyNameProblem } from "./env-names.ts";

export { ENV_KEY_NAME } from "./env-names.ts";

export class EnvKeyError extends Error {}

/** A value as a .env line understands it: bare when it's plain, quoted when it has spaces, `#` or quotes. */
function encode(value: string): string {
  if (/^[A-Za-z0-9_\-.:/+=@,~%]*$/.test(value)) return value;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new EnvKeyError("a key can't contain both kinds of quote");
}

/**
 * Sets (or with an empty value, removes) one variable in `<home>/.env`, keeping every other line, and
 * updates `env` so it takes effect without a restart. The file is written with mode 0600.
 */
export function setEnvKey(home: string, name: string, value: string | null, env: Record<string, string | undefined> = process.env): { name: string; set: boolean; path: string } {
  const problem = keyNameProblem(name);
  if (problem) throw new EnvKeyError(problem);
  if (value != null && typeof value !== "string") throw new EnvKeyError("the key must be text");
  const v = (value ?? "").trim();
  if (/[\r\n\0]/.test(v)) throw new EnvKeyError("a key can't contain line breaks");
  const line = v ? `${name}=${encode(v)}` : null;
  const path = join(home, ".env");
  const same = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter((l) => !same.test(l)) : [];
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (line) lines.push(line);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  if (v) env[name] = v;
  else delete env[name];
  return { name, set: !!v, path };
}
