// Serves dist-browser/ as a static site (unknown paths fall back to index.html, like a static host
// configured for a single-page app).   node src/browser/tools/serve.mjs [port]
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(fileURLToPath(new URL("../../../dist-browser", import.meta.url)));
const port = Number(process.argv[2] ?? 4790);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".apkg": "application/octet-stream" };

createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
  let file = resolve(dist, path);
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) file = join(dist, "index.html");
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => console.log(`dist-browser on http://127.0.0.1:${port}/`));
