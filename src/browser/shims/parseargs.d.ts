// @pkgjs/parseargs ships no types; it is Node's own parseArgs.
declare module "@pkgjs/parseargs" {
  export const parseArgs: typeof import("node:util").parseArgs;
}
