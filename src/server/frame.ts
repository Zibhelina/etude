// Builds the HTML document a card renders in. The document is served from its own route and
// loaded into an iframe with `sandbox="allow-scripts"` (no same-origin), so a card's code can't
// read the app, its cookies or the API. It talks to the app only through postMessage.
import type { CardTypeDef } from "../core/model.ts";

/** What a card needs to find its type's assets: the type id and each asset's content hash. */
export interface FrameAssets {
  type: string;
  files: { name: string; hash: string }[];
}

const esc = (s: string) => s.replace(/<\/(script|style)/gi, "<\\/$1");

/**
 * The frame's Content-Security-Policy: a card's code may load the runtime, KaTeX, its type's assets
 * and collection media from the Etude server, and data:/blob: URLs it makes itself, and nothing
 * else. That keeps a Market card type from sending what the user studies or types to another host.
 */
export function frameCsp(base: string): string {
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    origin = "'none'";
  }
  const self = origin === "null" ? "'none'" : origin;
  return [
    "default-src 'none'",
    `script-src ${self} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `media-src ${self} data: blob:`,
    `font-src ${self} data:`,
    `connect-src ${self} data: blob:`,
    `worker-src ${self} blob:`,
    "frame-src 'none'",
    "form-action 'none'",
    `base-uri ${self}`,
  ].join("; ");
}

export function cardFrame(def: CardTypeDef, base: string, assets?: FrameAssets): string {
  const js = def.template.js ?? "";
  const assetMap = { type: assets?.type ?? def.id, files: Object.fromEntries((assets?.files ?? []).map((f) => [f.name, f.hash])) };
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${frameCsp(base)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${base}">
<link rel="stylesheet" href="${base}runtime/vendor/katex.css">
<link rel="stylesheet" href="${base}runtime/card.css">
<link rel="stylesheet" href="${base}runtime/code.css">
<style id="etude-theme"></style>
<style>${esc(def.template.css ?? "")}</style>
</head>
<body data-mode="answer">
<div id="card"></div>
<script type="module">
import { boot } from "${base}runtime/runtime.js";
const template = ${JSON.stringify(def.template.html).replace(/</g, "\\u003c")};
boot(async (etude) => {
  const std = {
    normalize: (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\\s+/g, " ").trim(),
  };
${esc(js)}
}, template, ${JSON.stringify(assetMap).replace(/</g, "\\u003c")});
</script>
</body>
</html>`;
}
