// Builds the static website into site/dist.
//   node site/build.ts            (run `npm run build` first: the card runtime needs web/dist/kit)
//
// The landing page runs real Etude card types with no server: the card frames, runtime and
// vendor files are copied here, and each demo's prepare and grade scripts run in the page with
// the same helpers (`std`, `rng`) the server's sandbox gives them.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cardFrame } from "../src/server/frame.ts";
import { fieldDefaults, loadTypeDir } from "../src/core/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "dist");
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (!existsSync(join(root, "web/dist/kit/kit.js"))) throw new Error("web/dist/kit is missing: run `npm run build` first");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Pages and assets. {{VERSION}} is filled in from package.json.
cpSync(join(here, "src"), out, { recursive: true });
for (const page of ["index.html", "download.html", "404.html"]) {
  const p = join(out, page);
  if (existsSync(p)) writeFileSync(p, readFileSync(p, "utf8").replaceAll("{{VERSION}}", pkg.version));
}

// The card runtime, exactly as the app serves it.
const rt = join(out, "runtime");
mkdirSync(join(rt, "vendor"), { recursive: true });
for (const f of ["runtime.js", "card.css", "code.css", "mathexpr.js"]) cpSync(join(root, "runtime", f), join(rt, f));
const katexDist = join(dirname(require.resolve("katex/package.json")), "dist");
cpSync(join(katexDist, "katex.mjs"), join(rt, "vendor/katex.js"));
cpSync(join(katexDist, "katex.min.css"), join(rt, "vendor/katex.css"));
cpSync(join(katexDist, "fonts"), join(rt, "vendor/fonts"), { recursive: true });
cpSync(join(dirname(require.resolve("marked/package.json")), "lib/marked.esm.js"), join(rt, "vendor/marked.js"));
cpSync(join(root, "web/dist/kit"), join(rt, "kit"), { recursive: true });
// The real scheduler, for the deadline chart.
mkdirSync(join(out, "vendor"), { recursive: true });
cpSync(join(root, "node_modules/ts-fsrs/dist/index.mjs"), join(out, "vendor/ts-fsrs.js"));

// The sandbox prelude (`std` and the seeded `rng`), taken from the engine so the two can't drift.
const sandbox = readFileSync(join(root, "src/core/sandbox.ts"), "utf8");
const prelude = /const PRELUDE = String\.raw`([\s\S]*?)\n`;/.exec(sandbox)?.[1];
if (!prelude) throw new Error("couldn't find PRELUDE in src/core/sandbox.ts");

// Demo cards: real showcase items and their types.
const pack = JSON.parse(readFileSync(join(root, "examples/showcase.pack.json"), "utf8"));
const DEMOS = [
  { id: "showcase.chess.smothered", label: "Chess" },
  { id: "showcase.unit-circle.mixed", label: "Unit circle" },
  { id: "showcase.chord.triads", label: "Piano" },
  { id: "showcase.math.derivative", label: "Math" },
  { id: "showcase.graph-walk.bfs", label: "Graphs" },
  { id: "showcase.timeline.computing", label: "Timeline" },
  { id: "showcase.staff.treble", label: "Sheet music" },
  { id: "showcase.plot.parabola", label: "Plot" },
  { id: "showcase.color.hex", label: "Color" },
];
const typeDir = (id: string) => [join(root, "examples/showcase/types", id), join(root, "types", id)].find((d) => existsSync(join(d, "type.json")))!;
mkdirSync(join(out, "frames"), { recursive: true });
const fontFace = `<style>@font-face{font-family:"Inter";src:url("assets/fonts/inter.woff2") format("woff2");font-weight:100 900;font-display:swap}@font-face{font-family:"JetBrains Mono";src:url("assets/fonts/jetbrains-mono.woff2") format("woff2");font-weight:100 800;font-display:swap}</style>`;
const demos = DEMOS.map(({ id, label }) => {
  const item = pack.items.find((i: { id: string }) => i.id === id);
  if (!item) throw new Error(`no showcase item ${id}`);
  const def = loadTypeDir(typeDir(item.type));
  // Frames sit in /frames/ and resolve everything from the site root through <base>.
  // On the landing page the cards sit in a smaller window than in the app, so big boards shrink.
  const fit = `<style>.ch-board svg{max-width:18rem;transition:max-width .5s cubic-bezier(.22,1,.36,1)}.uc-stage{max-width:280px}.gw-svg{max-width:330px}.pl-stage{max-width:290px}.co-swatch{height:5rem}.kb-oct{max-width:15rem}body[data-mode=result] .ch-board svg{max-width:13rem}@media (min-width:400px){.kb:not(.kb-nowrap){flex-wrap:nowrap;gap:0}.kb:not(.kb-nowrap) .kb-oct{flex-basis:0;max-width:15rem}}</style>`;
  const html = cardFrame(def, "__BASE__")
    .replace('<base href="__BASE__">', `<base href="../">${fontFace}`)
    .replace("</head>", `${fit}\n</head>`)
    .replaceAll("__BASE__", "./");
  writeFileSync(join(out, "frames", `${def.id}.html`), html);
  const grader = def.grader as { kind: string; code?: string };
  if (grader.kind !== "script" || !grader.code) throw new Error(`${id}: demos need script-graded types`);
  return {
    id,
    label,
    type: def.id,
    name: def.name,
    fields: { ...fieldDefaults(def), ...item.fields },
    prepare: def.prepare ?? null,
    grade: grader.code,
    private: def.fields.filter((f) => f.private).map((f) => f.name),
  };
});
// Highlighted source for the "card types are code" section and the generator example, using the
// same highlighter classes (tok-*) as the app, styled by runtime/code.css.
const { highlightCode, classHighlighter } = await import("@lezer/highlight");
const { javascriptLanguage } = await import("@codemirror/lang-javascript");
const { jsonLanguage } = await import("@codemirror/lang-json");
const { htmlLanguage } = await import("@codemirror/lang-html");
const { cssLanguage } = await import("@codemirror/lang-css");
const LANGS = { js: javascriptLanguage, json: jsonLanguage, html: htmlLanguage, css: cssLanguage } as const;
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
function highlight(code: string, lang: keyof typeof LANGS): string {
  let html = "";
  highlightCode(code, LANGS[lang].parser.parse(code), classHighlighter, (text, cls) => {
    html += cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
  }, () => (html += "\n"));
  return html;
}
const showType = join(root, "examples/showcase/types/unit-circle");
const FILES = [
  ["type.json", "json", "The fields an item fills in, which of them stay private, and the grader."],
  ["template.html", "html", "What the card shows. Blocks inside <template data-on=\"result\"> appear after grading."],
  ["style.css", "css", "Styles for this card only, built on the theme's variables."],
  ["prepare.js", "js", "Runs on the server: picks this review's angle and keeps the answer out of the frame."],
  ["card.js", "js", "Runs in the card's sandboxed frame: the draggable circle and the answer it reports."],
  ["grade.js", "js", "Runs on the server: full credit on the angle, half credit one step off."],
] as const;
const files = FILES.map(([name, lang, note]) => {
  const src = readFileSync(join(showType, name), "utf8");
  return { name, note, lines: src.split("\n").length, html: highlight(src.replace(/\n$/, ""), lang) };
});
const derivative = pack.items.find((i: { id: string }) => i.id === "showcase.math.derivative");
const generator = { code: derivative.fields.generator as string, html: highlight(derivative.fields.generator, "js") };

writeFileSync(
  join(out, "data.js"),
  `// Generated by site/build.ts.\nexport const PRELUDE = ${JSON.stringify(prelude)};\nexport const DEMOS = ${JSON.stringify(demos)};\nexport const TYPE_FILES = ${JSON.stringify(files)};\nexport const GENERATOR = ${JSON.stringify(generator)};\n`,
);

console.log(JSON.stringify({ out, version: pkg.version, demos: demos.map((d) => d.type) }));
