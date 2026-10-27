// `node:url` in the browser build. Core modules find the app's own files next to themselves
// (`fileURLToPath(import.meta.url)`, then `../..`); in a bundle every module maps to one place
// under APP_ROOT, which is where fs.ts loads those files.
export const APP_ROOT = "/etude/app";

export function fileURLToPath(u: string | URL): string {
  const s = String(u);
  if (s.startsWith("file://")) return decodeURIComponent(new URL(s).pathname);
  if (/^(https?|blob):/.test(s)) return `${APP_ROOT}/src/core/bundle.js`;
  throw new TypeError(`The URL must be of scheme file: ${s}`);
}
export const pathToFileURL = (p: string) => new URL("file://" + p);
export default { fileURLToPath, pathToFileURL };
