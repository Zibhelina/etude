// Turns a card frame from the server's shape (stylesheets and the runtime loaded from /runtime)
// into one self-contained document: a sandboxed srcdoc frame has nowhere to load them from.
import runtime from "./gen/frame-runtime.js?raw";
import css from "./gen/frame.css?raw";
import shim from "./frame-shim.js?raw";

/**
 * The frame inherits the app page's policy (src/browser/csp-boot.js), which runs only scripts with
 * the page's nonce. The worker doesn't know it, so its scripts carry this placeholder, and
 * card-frame.tsx swaps in the nonce right before the frame is shown.
 */
export const FRAME_NONCE = 'nonce="%ETUDE_NONCE%"';

const script = (js: string) => `<script ${FRAME_NONCE}>${js.replace(/<\/script/gi, "<\\/script")}</script>`;

export function localFrame(html: string): string {
  const base = /<base href="([^"]*)">/.exec(html)?.[1] ?? "";
  // Function replacements throughout: the minified runtime contains "$'" and "$&", which a
  // string replacement would expand.
  let out = html.replace(/<link rel="stylesheet" href="[^"]*runtime\/[^"]*">\n?/g, () => "");
  out = out.replace("</head>", () => `<style>${css}</style>\n</head>`);
  out = out.replace(`import { boot } from "${base}runtime/runtime.js";`, () => "const { boot } = globalThis.EtudeRuntime;");
  out = out.replace('<script type="module">', () => `${script(shim)}\n${script(runtime)}\n<script type="module" ${FRAME_NONCE}>`);
  return out;
}
