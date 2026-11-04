// node:util in the browser build: the CLI parses its arguments with parseArgs, and the in-app
// assistant (Ask Etude) runs CLI commands in the worker. @pkgjs/parseargs is Node's own
// implementation, published for other runtimes.
import { parseArgs } from "@pkgjs/parseargs";

export { parseArgs };
export default { parseArgs };
