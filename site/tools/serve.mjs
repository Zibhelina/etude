// Serves site/dist like GitHub Pages does (with `Access-Control-Allow-Origin: *`, which the
// sandboxed card frames need), at the root like etude.study (/etude/… still works, as before the domain).
//   node site/tools/serve.mjs [port]
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const port = Number(process.argv[2] ?? 4620);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".txt": "text/plain", ".wasm": "application/wasm", ".apkg": "application/octet-stream", ".webmanifest": "application/manifest+json" };

createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.startsWith("/etude/")) path = path.slice("/etude".length);
  let file = join(dist, normalize(path.slice(1)));
  // GitHub Pages sends /app to /app/.
  if (!path.endsWith("/") && existsSync(file) && statSync(file).isDirectory()) { res.writeHead(301, { Location: path + "/" }); return res.end(); }
  if (file.endsWith("/") || (existsSync(file) && statSync(file).isDirectory())) file = join(file, "index.html");
  // GitHub Pages serves /sync from sync.html.
  if (!existsSync(file) && !extname(file) && existsSync(file + ".html")) file += ".html";
  const found = file.startsWith(dist) && existsSync(file);
  if (!found) file = join(dist, "404.html");
  res.writeHead(found ? 200 : 404, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
