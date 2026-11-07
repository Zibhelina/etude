// `node:fs/promises` in the browser build: what the core uses of it.
import { readFile } from "./fs.ts";

export { readFile };
export default { readFile };
