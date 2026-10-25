// Serves site/dist like GitHub Pages does (with `Access-Control-Allow-Origin: *`, which the
// sandboxed card frames need), under /etude/ so paths match the published site.
//   node site/tools/serve.mjs [port]
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const port = Number(process.argv[2] ?? 4620);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };

createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/") { res.writeHead(302, { Location: "/etude/" }); return res.end(); }
  if (!path.startsWith("/etude/")) path = "/etude/404.html";
  let file = join(dist, normalize(path.slice("/etude/".length)));
  if (file.endsWith("/") || (existsSync(file) && statSync(file).isDirectory())) file = join(file, "index.html");
  const found = file.startsWith(dist) && existsSync(file);
  if (!found) file = join(dist, "404.html");
  res.writeHead(found ? 200 : 404, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/etude/`));
