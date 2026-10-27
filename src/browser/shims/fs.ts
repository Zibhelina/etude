// `node:fs` in the browser build. Loads the app's bundled files (card types, schedulers, the card
// runtime) into memory first: core modules read some of them while they are being imported.
import { preload } from "./vfs.ts";
import { APP_ROOT } from "./url.ts";

const bundled = import.meta.glob(["../../../types/**/*", "../../../schedulers/**/*", "../../../runtime/**/*", "../../../package.json"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
for (const [path, text] of Object.entries(bundled)) preload(APP_ROOT + path.replace(/^(\.\.\/)+/, "/"), text);

export * from "./vfs.ts";
export { default } from "./vfs.ts";
