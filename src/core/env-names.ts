// Which variable names can hold an API key: in $ETUDE_HOME/.env (env-file.ts) and in the serverless
// builds' copy of it (src/browser/worker-core.ts). No imports, so the browser worker can use it too.

export const ENV_KEY_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Only credential-shaped names can be written: never PATH, NODE_*, ETUDE_* or anything else the process reads as configuration. */
const KEY_SHAPED = /_(API_KEY|KEY|TOKEN)$/;
const RESERVED = /^(ETUDE_|NODE_|NPM_|PATH$|HOME$|LD_|DYLD_)/;

/** Why `name` can't be an API key's variable, or null when it can. */
export function keyNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || !ENV_KEY_NAME.test(name)) return `"${name}" isn't a variable name: use capital letters, digits and _ (at most 64)`;
  if (!KEY_SHAPED.test(name) || RESERVED.test(name)) return `"${name}" isn't an API key name: it has to end in _API_KEY, _KEY or _TOKEN`;
  return null;
}
