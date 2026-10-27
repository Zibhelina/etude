// Builds the static website into site/dist.
//   node site/build.ts            (run `npm run build` first: the card runtime needs web/dist/kit)
//
// The landing page runs real Etude card types with no server: the card frames, runtime and
// vendor files are copied here, and each demo's prepare and grade scripts run in the page with
// the same helpers (`std`, `rng`) the server's sandbox gives them.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

// The text pages: /sync and /support from site/pages/*.html, /terms, /privacy, /refunds and
// /creators from the Markdown in site/legal/, all in one layout with the shared footer. GitHub
// Pages serves sync.html at /sync. The footer replaces the one in index.html and download.html,
// so every page links to Support and the legal pages.
{
  const { Marked } = await import("marked");
  const layout = readFileSync(join(here, "pages/layout.html"), "utf8");
  const footer = readFileSync(join(here, "pages/footer.html"), "utf8").trim();
  const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const page = (slug: string, title: string, description: string, body: string) =>
    layout
      .replaceAll("{{TITLE}}", attr(title))
      .replaceAll("{{DESCRIPTION}}", attr(description))
      .replaceAll("{{SLUG}}", slug)
      .replace("{{NAV_SYNC}}", slug === "sync" ? ' aria-current="page"' : "")
      .replace("{{NAV_SUPPORT}}", slug === "support" ? ' aria-current="page"' : "")
      .replace("{{BODY}}", body.trim())
      .replace("{{FOOTER}}", footer);
  const frontMatter = (src: string) => {
    const m = /^(?:---\n([\s\S]*?)\n---|<!--\n([\s\S]*?)\n-->)\n/.exec(src);
    if (!m) throw new Error("page is missing its front matter");
    const meta = Object.fromEntries((m[1] ?? m[2]).split("\n").map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
    if (!meta.title || !meta.description) throw new Error("front matter needs title and description");
    return { meta, rest: src.slice(m[0].length) };
  };
  for (const slug of ["sync", "support"]) {
    const { meta, rest } = frontMatter(readFileSync(join(here, "pages", `${slug}.html`), "utf8"));
    writeFileSync(join(out, `${slug}.html`), page(slug, meta.title, meta.description, rest));
  }
  const LEGAL = [["terms", "Terms"], ["privacy", "Privacy"], ["refunds", "Refunds"], ["creators", "Creator terms"]] as const;
  const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const md = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        return depth === 2 ? `<h2 id="${slugify(text)}">${text}</h2>\n` : `<h${depth}>${text}</h${depth}>\n`;
      },
      table(t) {
        const head = t.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join("");
        const labels = t.header.map((c) => attr(c.text.replace(/[*_`]/g, "")));
        const rows = t.rows.map((r) => `<tr>${r.map((c, i) => `<td data-label="${labels[i]}">${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`).join("\n");
        return `<div class="table-scroll"><table class="booktabs"><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>\n`;
      },
    },
  });
  const date = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  for (const [slug] of LEGAL) {
    const { meta, rest } = frontMatter(readFileSync(join(here, "legal", `${slug}.md`), "utf8"));
    const html = (md.parse(rest) as string).replaceAll('<a href="http', '<a rel="noopener" href="http');
    const nav = LEGAL.map(([s, label]) => `<a href="${s}"${s === slug ? ' aria-current="page"' : ""}>${label}</a>`).join("");
    const body = `<article class="legal"><div class="wrap">
<p class="opus">Legal <span>${attr(meta.title.toLowerCase())}</span></p>
<nav class="legal-nav" aria-label="Legal pages">${nav}</nav>
<div class="doc">
${html}</div>
<p class="legal-meta">Last updated ${date(meta["last-updated"])}. Questions: <a href="mailto:hello@etude.study">hello@etude.study</a>.</p>
</div></article>`;
    writeFileSync(join(out, `${slug}.html`), page(slug, meta.title, meta.description, body));
  }
  for (const f of ["index.html", "download.html"]) {
    const p = join(out, f);
    const s = readFileSync(p, "utf8");
    const swapped = s.replace(/<footer class="footer">[\s\S]*?<\/footer>/, () => footer);
    if (swapped === s) throw new Error(`${f}: no footer to replace`);
    writeFileSync(p, swapped);
  }
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
  { id: "showcase.typing.english", label: "Typing" },
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
  const fit = `<style>.ch-board svg{max-width:16rem;transition:max-width .5s cubic-bezier(.22,1,.36,1)}.uc-stage{max-width:250px}.gw-svg{max-width:280px}.pl-stage{max-width:260px}.co-swatch{height:3.2rem}.co-sliders{gap:.3rem}.co-slider input{height:2.2rem}.co-hex{font-size:1.7rem}.st-staff svg{max-width:17rem}.kb-oct{max-width:15rem}body[data-mode=result] .ch-board svg{max-width:12rem}@media (min-width:400px){.kb:not(.kb-nowrap){flex-wrap:nowrap;gap:0}.kb:not(.kb-nowrap) .kb-oct{flex-basis:0;max-width:15rem}}</style>`;
  const html = cardFrame(def, "__BASE__")
    .replace('<base href="__BASE__">', `<base href="../">${fontFace}`)
    .replace("</head>", `${fit}\n<script src="assets/demo-driver.js"></script>\n</head>`)
    .replaceAll("__BASE__", "./");
  writeFileSync(join(out, "frames", `${def.id}.html`), html);
  const grader = def.grader as { kind: string; code?: string };
  if (grader.kind !== "script" || !grader.code) throw new Error(`${id}: demos need script-graded types`);
  return {
    id,
    label,
    type: def.id,
    name: def.name,
    // The landing page shows the task, not the lesson: the explanatory note stays in the app.
    fields: Object.fromEntries(Object.entries({ ...fieldDefaults(def), ...item.fields }).filter(([k]) => k !== "note" && k !== "demo" && k !== "demoGrade")),
    prepare: def.prepare ?? null,
    grade: grader.code,
    private: def.fields.filter((f) => f.private).map((f) => f.name),
  };
});
// The repertoire: every card type in the box, live, for the visitor's own hands. Items come from
// the showcase pack (one per type) plus site/variants.json, more items of the same types that the
// repertoire rotates through but the tour in the app doesn't need.
const variants: { id: string; type: string; fields: Record<string, unknown> }[] = JSON.parse(readFileSync(join(here, "variants.json"), "utf8"));
const itemById = (id: string) => pack.items.find((i: { id: string }) => i.id === id) ?? variants.find((i) => i.id === id);
const REPERTOIRE: [string, [string, string, string, string[]][]][] = [
  ["Recall", [
    ["basic", "Flip a card", "The classic: think of the answer, turn the card over, and be honest with yourself.", ["showcase.basic.sky"]],
    ["typed", "Type the answer", "A short answer typed from memory, checked against the accepted spellings.", ["showcase.typed.capital"]],
    ["mcq", "Pick the answer", "Options shuffled every time, so you remember the answer, not its position.", ["showcase.mcq.day"]],
    ["cloze", "Fill the blanks", "A sentence with holes in it. Each blank is checked on its own.", ["showcase.cloze.haiku"]],
    ["match", "Match the pairs", "Wire each item to its partner. The right side comes shuffled.", ["showcase.match.paintings"]],
  ]],
  ["Calculate", [
    ["numeric", "Compute, with units", "New numbers every review. Units are fine, and the answer gets a tolerance.", ["showcase.numeric.train"]],
    ["math", "Write the expression", "Type it however you like: any equivalent form is accepted, and it renders as you type.", ["showcase.math.derivative", "showcase.math.factor", "showcase.math.roots", "showcase.math.exact", "showcase.math.line"]],
    ["estimate", "Estimate it", "Slide to your best guess. Close is full credit, near is partial.", ["showcase.estimate.everest", "showcase.estimate.heartbeats"]],
    ["balance", "Balance the equation", "Step the coefficients until every atom balances. The tally updates as you go.", ["showcase.balance.combustion", "showcase.balance.rust", "showcase.balance.aluminium-acid"]],
    ["unit-circle", "Find the angle", "Put the angle where it belongs, in degrees, radians or both.", ["showcase.unit-circle.mixed", "showcase.unit-circle.radians"]],
    ["plot", "Mark the points", "Tap the points that matter on the grid: roots, vertices, intersections.", ["showcase.plot.parabola", "showcase.plot.lines"]],
  ]],
  ["Arrange", [
    ["order", "Put them in order", "Drag the blocks, or move them with the keyboard. Partial credit for what's already in order.", ["showcase.order.scale"]],
    ["timeline", "Place it in time", "Drag each event to its year. Graded on order and on how many years off.", ["showcase.timeline.computing", "showcase.timeline.physics"]],
    ["graph-walk", "Walk the graph", "Tap the nodes in the order the algorithm would visit them, on a graph made for this review.", ["showcase.graph-walk.bfs", "showcase.graph-walk.dfs"]],
  ]],
  ["Code", [
    ["code", "Write a function", "A real editor. The answer runs against hidden tests in a sandbox.", ["showcase.code.roman"]],
    ["regex", "Write the regex", "The visible tests light up as you type; hidden ones decide the grade.", ["showcase.regex.hex-color", "showcase.regex.iso-date"]],
    ["bug-hunt", "Find the bug", "Point at the line that's wrong. The fix appears afterwards.", ["showcase.bug-hunt.moving-average", "showcase.bug-hunt.closure-retry"]],
    ["bits", "Flip the bits", "Flip switches until the binary makes the number.", ["showcase.bits.unsigned", "showcase.bits.twos-complement"]],
  ]],
  ["Play & listen", [
    ["chess", "Mate in one", "Find the mate on a real board. Tap, or drag the piece.", ["showcase.chess.smothered", "showcase.chess.queen-f2"]],
    ["chord", "Build the chord", "Play it on the keyboard. Any voicing or inversion counts.", ["showcase.chord.triads", "showcase.chord.sevenths"]],
    ["staff", "Read the note", "Read the note off the staff and play it.", ["showcase.staff.treble", "showcase.staff.bass"]],
    ["interval", "Name the interval", "Ear training: listen to two notes and name the distance between them. Turn your sound on.", ["showcase.interval.basic", "showcase.interval.all"]],
    ["color", "Mix the color", "Build the color from its hex code with hue, saturation and lightness.", ["showcase.color.hex"]],
    ["sprint", "Beat the clock", "Thirty seconds of mental arithmetic. It submits itself when the time is up.", ["showcase.sprint.mixed"]],
    ["typing", "Type fast", "A Monkeytype-style typing test. The clock starts on your first key, and the result is your WPM.", ["showcase.typing.english", "showcase.typing.python"]],
  ]],
  ["Draw & write", [
    ["free", "Prove it", "A proof in your own words, with math that renders as you type.", ["showcase.free.induction"]],
    ["draw", "Write it by hand", "Draw or write it with your finger or mouse. A vision model reads the strokes.", ["showcase.draw.kanji-water", "showcase.draw.parabola"]],
  ]],
];
// The new Market decks (site/tools/new-decks.mjs copies their types and a few real items into
// site/decks/). They live in the Market, not in examples/, so they're loaded from there.
type DeckFile = { type: any; items: { id: string; type: string; deck: string; fields: Record<string, unknown> }[]; assets: string[]; deck: { name: string; cards: number; decks: number } };
const deckFiles = new Map<string, DeckFile>(
  readdirSync(join(here, "decks")).filter((f) => f.endsWith(".json")).map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(here, "decks", f), "utf8"))]),
);
REPERTOIRE.find(([g]) => g === "Play & listen")![1].push(["flippy", "Shoot the invaders", "Flippy Bit: flip eight bits until they spell the hex number falling at you. A drill, measured in invaders.", ["flippy.hex"]]);
REPERTOIRE.splice(REPERTOIRE.findIndex(([g]) => g === "Code"), 0, ["Explore", [
  ["country-map", "Find it on the map", "Name the country that's lit up, or find the one that's named. Zoom and pan like a real map.", ["geo.country.can", "geo.country.jpn", "geo.country.ita", "geo.country.egy", "geo.country.per", "geo.country.mng"]],
  ["element", "Read the table", "Tap an element on a blank periodic table, name a lit cell, or give its family and configuration.", ["pt.locate.fe", "pt.identify.ne", "pt.name.au", "pt.family.w", "pt.config.c", "pt.numbers.c"]],
]]);
const deckItem = (id: string) => [...deckFiles.values()].flatMap((d) => d.items).find((i) => i.id === id);
// A type from the examples folder or from site/decks/, with the asset hashes its frame needs.
function loadSiteType(type: string): { def: any; assets?: { type: string; files: { name: string; hash: string }[] } } {
  const d = deckFiles.get(type);
  if (!d) return { def: loadTypeDir(typeDir(type), { assets: false }) };
  const files = d.assets.map((name) => ({ name, hash: createHash("sha256").update(readFileSync(join(here, "src/type-assets", type, name))).digest("hex") }));
  return { def: d.type, assets: { type, files } };
}
// The country map has two faces (name it / find it); the site picks one per item.
const FACE: Record<string, string> = { "geo.country.jpn": "locate", "geo.country.egy": "locate", "geo.country.mng": "locate" };

// In the repertoire the card has most of the content width, so only the tallest pieces are capped.
const galleryFit = `<style>.ch-board svg{max-width:21rem}.uc-stage{max-width:300px}.gw-svg{max-width:340px}.pl-stage{max-width:330px}.st-staff svg{max-width:20rem}body[data-mode=result] .ch-board svg{max-width:15rem}</style>`;
// A card focuses its first input when it mounts. Down here that would pull the keyboard (and on a
// phone, the on-screen keyboard) into a card the visitor only scrolled past, so focus waits until
// the page says they picked it.
const holdFocus = `<script>(() => { let ok = false; const f = HTMLElement.prototype.focus; HTMLElement.prototype.focus = function (o) { if (ok) return f.call(this, { ...(o ?? {}), preventScroll: true }); }; addEventListener("message", (e) => { if (e.source === parent && e.data?.etude === 1 && e.data.type === "rep-focus") ok = true; }); })();</script>`;
mkdirSync(join(out, "frames/gallery"), { recursive: true });
const gallery = REPERTOIRE.flatMap(([group, entries]) => entries.map(([type, label, desc, ids]) => {
  const { def, assets } = loadSiteType(type);
  const html = cardFrame(def, "__BASE__", assets)
    .replace('<base href="__BASE__">', `<base href="../../">${fontFace}`)
    .replace("</head>", `${galleryFit}\n<script src="assets/demo-driver.js"></script>\n${holdFocus}\n</head>`)
    .replaceAll("__BASE__", "./");
  writeFileSync(join(out, "frames/gallery", `${def.id}.html`), html);
  const items = ids.map((id) => {
    const item = itemById(id) ?? deckItem(id);
    if (!item) throw new Error(`repertoire: no item ${id}`);
    if (item.type !== type) throw new Error(`repertoire: ${id} is a ${item.type} item, not ${type}`);
    // Watch-mode example answers stay in the app.
    const { demo: _d, demoGrade: _g, ...own } = item.fields as Record<string, unknown>;
    return { id, fields: { ...fieldDefaults(def), ...own }, ...(FACE[id] ? { face: FACE[id] } : {}) };
  });
  const g = def.grader as { kind: string; code?: string };
  const prep = def.prepare ?? "";
  return {
    group,
    label,
    type: def.id,
    name: def.name,
    desc,
    // script, hybrid (a script that may hand the answer to AI), ai or self
    grader: g.kind,
    // A type that hides its verdict (a drill like Flippy Bit) reports its numbers instead.
    quiet: def.showVerdict === false,
    metrics: def.metrics ?? null,
    // Ends itself (game over): no Check button while it runs.
    auto: type === "flippy",
    grade: g.code ?? null,
    prepare: def.prepare ?? null,
    private: def.fields.filter((f: { private?: boolean }) => f.private).map((f: { name: string }) => f.name),
    // What another go gives you: a new variant (a generator, random picks or another item), the
    // same card reshuffled, or the same card again.
    again: items.length > 1 || items.some((i) => typeof i.fields.generator === "string") || /\brng\.(int|float|pick|bool|next)\b/.test(prep) ? "variant" : /\brng\.shuffle\b/.test(prep) ? "shuffle" : "reset",
    items,
  };
}));
const allTypes = [join(root, "types"), join(root, "examples/showcase/types")].flatMap((d) => readdirSync(d).filter((t: string) => existsSync(join(d, t, "type.json"))));
const missing = allTypes.filter((t) => !gallery.some((e) => e.type === t));
// A new type should get a place in REPERTOIRE; until then the build says so instead of failing.
if (missing.length) console.warn(`site: the repertoire is missing types: ${missing.join(", ")}`);

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
// The schedulers that ship with Etude, run in the Tempo section exactly as the engine runs them,
// plus the example a user writes in docs/schedulers.md.
const schedDoc = readFileSync(join(root, "docs/schedulers.md"), "utf8");
const SCHEDULERS = {
  drill: readFileSync(join(root, "schedulers/drill/schedule.js"), "utf8"),
  leitner: readFileSync(join(root, "schedulers/leitner/schedule.js"), "utf8"),
  monday: /```js\n(\/\/ Next Monday[\s\S]*?)```/.exec(schedDoc)?.[1] ?? "",
};
if (!SCHEDULERS.monday) throw new Error("couldn't find the every-monday example in docs/schedulers.md");
const derivative = itemById("showcase.math.derivative")!;
const generator = { code: derivative.fields.generator as string, html: highlight(derivative.fields.generator, "js") };

writeFileSync(
  join(out, "data.js"),
  `// Generated by site/build.ts.\nexport const PRELUDE = ${JSON.stringify(prelude)};\nexport const DEMOS = ${JSON.stringify(demos)};\nexport const TYPE_FILES = ${JSON.stringify(files)};\nexport const GENERATOR = ${JSON.stringify(generator)};\nexport const GALLERY = ${JSON.stringify(gallery)};\nexport const SCHEDULERS = ${JSON.stringify(SCHEDULERS)};\n`,
);

// The hero's tab strip is in the HTML from the start, so the window isn't empty before the script runs.
{
  const p = join(out, "index.html");
  const tabs = demos.map((d, i) => `<button class="stage-tab" role="tab" type="button" aria-selected="${i === 0}" data-i="${i}">${escapeHtml(d.label)}</button>`).join("");
  writeFileSync(p, readFileSync(p, "utf8").replace("{{STAGE_TABS}}", tabs));
}

// The live Stats panels: the app's own React components with the demo snapshots, into dist/live/.
execFileSync(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "build", "--config", join(here, "stats-embed/vite.config.ts")], { cwd: root, stdio: "inherit" });

console.log(JSON.stringify({ out, version: pkg.version, demos: demos.map((d) => d.type), gallery: gallery.length }));
