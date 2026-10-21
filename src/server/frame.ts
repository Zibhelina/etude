// Builds the HTML document a card renders in. The document is served from its own route and
// loaded into an iframe with `sandbox="allow-scripts"` (no same-origin), so a card's code can't
// read the app, its cookies or the API. It talks to the app only through postMessage.
import type { CardTypeDef } from "../core/model.ts";

const esc = (s: string) => s.replace(/<\/(script|style)/gi, "<\\/$1");

export function cardFrame(def: CardTypeDef, base: string): string {
  const js = def.template.js ?? "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${base}">
<link rel="stylesheet" href="${base}runtime/vendor/katex.css">
<link rel="stylesheet" href="${base}runtime/card.css">
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
}, template);
</script>
</body>
</html>`;
}
