// Node modules the browser build has no use for (spawning programs, HTTP servers, node:sqlite).
// Importing works; using them throws, so a code path that needs one fails loudly.
const fail = (name: string) => () => {
  throw new Error(`${name} isn't available in the browser build`);
};
export const spawn = fail("child_process.spawn");
export const execFileSync = fail("child_process.execFileSync");
export const spawnSync = fail("child_process.spawnSync");
export const createServer = fail("http.createServer");
export class DatabaseSync {
  constructor() {
    throw new Error("node:sqlite isn't available in the browser build");
  }
}
export const backup = fail("node:sqlite backup");
export const STATUS_CODES: Record<number, string> = {};
export class ServerResponse {}
export class IncomingMessage {}
export class Agent {}
export const request = fail("http.request");
export const get = fail("http.get");
export default {};
