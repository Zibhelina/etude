// Turns a read Anki collection into Etude types, presets, decks, items, cards, reviews and media.
// Everything is computed up front so the engine can apply it in one transaction.
import { createHash } from "node:crypto";
import { type CardRow, type CardTypeDef, type FieldSpec, type PresetConfig } from "../model.ts";
import * as sched from "../scheduler.ts";
import type { AnkiCard, AnkiCollection, AnkiDeckConfig, AnkiNote, AnkiNotetype, AnkiReview } from "./collection.ts";
import { convertAnkiIo, convertIoe, isAnkiIoNotetype, isIoeNotetype, type IoItem } from "./occlusion.ts";

export interface PlannedMedia {
  /** Name as referenced from note HTML. */
  name: string;
  /** Path under the media directory (always `anki/<file>`). */
  target: string;
  load: () => Buffer;
}

export interface PlannedReview {
  ts: string;
  rating: number;
  durationMs: number | null;
  stateBefore: number;
  cardBefore: string;
  dueAfter: string;
}

export interface PlannedCard {
  itemId: string;
  face: string;
  state: number;
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  learningSteps: number;
  lastReview: string | null;
  suspended: boolean;
  buriedUntil: string | null;
  reviews: PlannedReview[];
}

export interface PlannedItem {
  id: string;
  type: string;
  deck: string;
  fields: Record<string, unknown>;
  tags: string[];
  source: string;
}

export interface Skipped {
  what: string;
  name: string;
  reason: string;
}

export interface ImportPlan {
  types: CardTypeDef[];
  presets: { id: string; name: string; config: Partial<PresetConfig> }[];
  decks: { name: string; presetId: string | null; description: string }[];
  items: PlannedItem[];
  cards: PlannedCard[];
  media: PlannedMedia[];
  skipped: Skipped[];
  notes: number;
  cardsRead: number;
  reviewsRead: number;
}

export interface ConvertOptions {
  deckPrefix?: string;
  scheduling: boolean;
  media: Map<string, () => Buffer>;
}

const DAY = 86_400_000;

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "imported";

/** Etude field names are identifiers; Anki's can be anything. */
function fieldIdent(name: string, used: Set<string>): string {
  let base = name
    .normalize("NFKD")
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) base = "Field";
  if (!/^[A-Za-z_]/.test(base)) base = `_${base}`;
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
  used.add(id);
  return id;
}

/** Item ids come from the note guid so re-importing updates instead of duplicating. */
function itemId(guid: string, taken: Set<string>): string {
  let id = `anki-${guid}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 190);
  if (taken.has(id)) id = `${id}-${createHash("sha1").update(guid).digest("hex").slice(0, 6)}`;
  taken.add(id);
  return id;
}

/** Anki stores HTML in note fields; `html` keeps it as-is in the editor and the card. */
const FIELD_KIND = "html" as FieldSpec["kind"];

function mediaUrl(name: string) {
  return `/media/anki/${encodeURIComponent(name)}`;
}

function rewriteMedia(html: string, media: Map<string, () => Buffer>): string {
  if (!media.size) return html;
  const known = (u: string) => media.has(u.trim());
  return html
    .replace(/\[sound:([^\]]+)\]/gi, (m, name: string) => (known(name) ? `<audio controls preload="none" src="${mediaUrl(name)}"></audio>` : m))
    .replace(/\b(src|href)\s*=\s*(["'])([^"']+)\2/gi, (m, attr: string, q: string, url: string) => (known(url) ? `${attr}=${q}${mediaUrl(url)}${q}` : m))
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q: string, url: string) => (known(url) ? `url(${q}${mediaUrl(url)}${q})` : m));
}

// ------------------------------------------------------------------ rendering (runs in prepare)

/**
 * The template engine Anki cards need, emitted into the generated type's `prepare` script.
 * It expands `{{Field}}`, `{{FrontSide}}`, conditionals, cloze markers, `{{type:}}`, `{{hint:}}`,
 * `{{text:}}` and `{{furigana:}}` the way Anki's card templates do.
 */
const RENDERER = String.raw`
var CFG = __ANKI__;
var MAP = CFG.map, TPL = CFG.tpl, TYPE_NAME = CFG.typeName, CLOZE = CFG.cloze;
var EXPECTED = [];

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function plain(s) {
  return String(s == null ? "" : s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
function field(name) {
  var k = MAP[name];
  if (k === undefined) return "";
  var v = fields[k];
  return v == null ? "" : String(v);
}
function isEmpty(name) {
  var raw = field(name);
  // Anki counts a field holding only media as filled.
  if (/<(img|audio|video|object|embed)\b/i.test(raw) || /\[sound:/i.test(raw)) return false;
  return plain(raw) === "";
}

// {{#Field}}…{{/Field}} and {{^Field}}…{{/Field}}, inside out so nesting works.
function conditionals(src) {
  var out = src;
  for (var pass = 0; pass < 30; pass++) {
    var before = out;
    out = out.replace(/\{\{([#^])\s*([^{}]+?)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\2\s*\}\}/g, function (m, sign, name, body) {
      var empty = isEmpty(String(name).trim());
      return (sign === "#" ? !empty : empty) ? body : "";
    });
    if (out === before) break;
  }
  return out;
}

// Reads "{{c2::answer::hint}}" (nested markers allowed) and rebuilds the field for one cloze.
function clozePass(src, num, show) {
  var out = "";
  var i = 0;
  while (i < src.length) {
    var rest = src.slice(i);
    var m = /\{\{c\s*(\d+)\s*::/.exec(rest);
    if (!m) {
      out += rest;
      break;
    }
    var start = i + m.index;
    out += src.slice(i, start);
    var j = start + m[0].length, depth = 1, end = -1, hint = -1;
    while (j < src.length) {
      if (src.substr(j, 2) === "{{") { depth++; j += 2; continue; }
      if (src.substr(j, 2) === "}}") { depth--; if (depth === 0) { end = j; break; } j += 2; continue; }
      if (depth === 1 && hint < 0 && src.substr(j, 2) === "::") { hint = j; j += 2; continue; }
      j++;
    }
    if (end < 0) { out += src.slice(start); break; }
    var inner = src.slice(start + m[0].length, hint >= 0 ? hint : end);
    var hintText = hint >= 0 ? src.slice(hint + 2, end) : "";
    var active = Number(m[1]) === num;
    if (active && !show) out += '<span class="cloze">' + (hintText ? "[" + esc(plain(hintText)) + "]" : "[...]") + "</span>";
    else out += active ? '<span class="cloze">' + clozePass(inner, num, show) + "</span>" : clozePass(inner, num, show);
    i = end + 2;
  }
  return out;
}
function clozeAnswers(src, num) {
  var found = [];
  var i = 0;
  while (i < src.length) {
    var rest = src.slice(i);
    var m = /\{\{c\s*(\d+)\s*::/.exec(rest);
    if (!m) break;
    var start = i + m.index;
    var j = start + m[0].length, depth = 1, end = -1, hint = -1;
    while (j < src.length) {
      if (src.substr(j, 2) === "{{") { depth++; j += 2; continue; }
      if (src.substr(j, 2) === "}}") { depth--; if (depth === 0) { end = j; break; } j += 2; continue; }
      if (depth === 1 && hint < 0 && src.substr(j, 2) === "::") { hint = j; j += 2; continue; }
      j++;
    }
    if (end < 0) break;
    var inner = src.slice(start + m[0].length, hint >= 0 ? hint : end);
    if (Number(m[1]) === num) found.push(plain(clozePass(inner, -1, true)));
    i = end + 2;
  }
  return found;
}

function furigana(text) {
  return plain(text).replace(/([^\s\[\]]+)\[([^\]]+)\]/g, "<ruby>$1<rt>$2</rt></ruby>");
}

function typeInput(expected) {
  if (expected) EXPECTED.push(expected);
  return '<input type="text" class="e-input anki-type" id="typeans" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Type the answer">';
}
function typeAnswer(expected) {
  if (expected) EXPECTED.push(expected);
  return '<div class="anki-typeans" data-expected="' + esc(expected) + '"><span class="anki-typed"></span><span class="anki-typeans-expected">' + esc(expected) + "</span></div>";
}

function renderSide(tpl, side, frontside) {
  var out = side === "q" ? tpl.q : tpl.a;
  if (side === "a") out = out.split("{{FrontSide}}").join(renderSide(tpl, "q", true));
  out = conditionals(out);

  out = out.replace(/\{\{type:cloze:([^{}]+?)\}\}/g, function (m, name) {
    var answers = CLOZE ? clozeAnswers(field(String(name).trim()), ACTIVE) : [plain(field(String(name).trim()))];
    var expected = answers.join(" / ");
    return side === "q" && !frontside ? typeInput(expected) : typeAnswer(expected);
  });
  out = out.replace(/\{\{type:([^{}]+?)\}\}/g, function (m, name) {
    var expected = plain(field(String(name).trim()));
    return side === "q" && !frontside ? typeInput(expected) : typeAnswer(expected);
  });
  out = out.replace(/\{\{cloze:([^{}]+?)\}\}/g, function (m, name) {
    return CLOZE ? clozePass(field(String(name).trim()), ACTIVE, side === "a" || frontside) : field(String(name).trim());
  });
  out = out.replace(/\{\{hint:([^{}]+?)\}\}/g, function (m, name) {
    return '<details class="anki-hint"><summary>' + esc("Hint") + '</summary><div class="anki-hint-body">' + field(String(name).trim()) + "</div></details>";
  });
  out = out.replace(/\{\{text:([^{}]+?)\}\}/g, function (m, name) {
    return esc(plain(field(String(name).trim())));
  });
  out = out.replace(/\{\{furigana:([^{}]+?)\}\}/g, function (m, name) {
    return furigana(field(String(name).trim()));
  });
  out = out.replace(/\{\{kanji:([^{}]+?)\}\}/g, function (m, name) {
    return plain(field(String(name).trim()));
  });

  out = out.replace(/\{\{([^{}]+?)\}\}/g, function (m, raw) {
    var name = String(raw).trim();
    if (name === "FrontSide") return "";
    if (name === "Card") return esc(tpl.n);
    if (name === "Type") return esc(TYPE_NAME);
    if (name === "Subdeck") {
      var d = field("Deck");
      return esc(d ? d.split("::")[d.split("::").length - 1] : "");
    }
    return field(name);
  });
  return out;
}

var ACTIVE = CLOZE ? Number(String(face).replace(/[^0-9]/g, "")) || 0 : 0;
var tpl = TPL[CLOZE ? 0 : Number(String(face).replace(/[^0-9]/g, "")) || 0] || TPL[0];
var q = renderSide(tpl, "q", false);
var a = renderSide(tpl, "a", false);
var accepted = [];
for (var e = 0; e < EXPECTED.length; e++) if (accepted.indexOf(EXPECTED[e]) < 0) accepted.push(EXPECTED[e]);
return { view: { html: q }, key: { answerHtml: a, accepted: accepted } };
`;

/** Card frame body: puts the prepared HTML in place, lights up Anki's `.nightMode`, renders math. */
const CARD_JS = String.raw`
const faceEl = etude.$("#anki-face");
const night = () => {
  try { if (getComputedStyle(document.documentElement).colorScheme === "dark") faceEl.classList.add("nightMode"); else faceEl.classList.remove("nightMode"); } catch (e) {}
};
function renderMath(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue || "";
    if (text.indexOf("\\(") < 0 && text.indexOf("\\[") < 0) continue;
    const re = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
    let last = 0, m, frag = document.createDocumentFragment(), hit = false;
    while ((m = re.exec(text))) {
      hit = true;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement("span");
      span.innerHTML = etude.tex(m[1] != null ? m[1] : m[2], m[2] != null);
      while (span.firstChild) frag.appendChild(span.firstChild);
      last = m.index + m[0].length;
    }
    if (!hit) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (node.parentNode) node.parentNode.replaceChild(frag, node);
  }
}
function fillTyped(answer) {
  const wrap = faceEl.querySelector(".anki-typeans");
  if (!wrap) return;
  const typed = typeof answer === "string" ? answer : answer && typeof answer === "object" ? String(answer.typed || "") : "";
  const slot = wrap.querySelector(".anki-typed");
  if (!slot) return;
  slot.textContent = typed;
  const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");
  if (typed.trim()) slot.classList.add(norm(typed) === norm(wrap.getAttribute("data-expected") || "") ? "is-correct" : "is-wrong");
}
function show(html, answer) {
  faceEl.innerHTML = String(html || "");
  night();
  renderMath(faceEl);
  if (answer !== undefined) fillTyped(answer);
}
night();
show(etude.view.html);
if (HAS_TYPE) {
  etude.getAnswer(() => {
    const input = faceEl.querySelector(".anki-type");
    return { typed: input ? input.value : "" };
  });
  const input = faceEl.querySelector(".anki-type");
  if (input) {
    etude.setReady(false);
    input.addEventListener("input", () => etude.setReady(input.value.trim().length > 0));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); etude.submit(); } });
    input.focus();
  }
}
etude.onResult(({ key, answer }) => show((key || {}).answerHtml, answer));
`;

const BASE_CSS = `.card { width: 100%; }
.anki-type { max-width: 24rem; }
.anki-typeans { display: flex; flex-wrap: wrap; gap: 0.5rem; font-family: var(--font-mono); }
.anki-typeans .anki-typed { min-width: 2rem; }
.anki-typeans .is-correct { color: var(--success); }
.anki-typeans .is-wrong { color: var(--destructive); text-decoration: line-through; }
.anki-typeans-expected { color: var(--foreground); font-weight: 600; }
.anki-hint { margin-top: 0.5rem; }
.anki-hint summary { cursor: pointer; color: var(--muted-foreground); font-size: 0.9em; }
.cloze { font-weight: 600; }
hr#answer { border: 0; border-top: 1px solid var(--border); margin: 1rem 0; }
audio { max-width: 100%; }
img { max-width: 100%; height: auto; }`;

/** Keeps Anki's CSS but lets the theme show through: no white page, no forced black text. */
function ankiCss(css: string): string {
  return css
    .replace(/(^|[\s,}])body(\s*[{,])/g, "$1.card$2")
    .replace(/(\.card\s*\{)([^}]*)\}/g, (_m, head: string, body: string) => `${head}${body.replace(/(^|;)\s*(color|background|background-color)\s*:\s*(black|white|#000|#fff|#000000|#ffffff)\s*(?=;|$)/gi, "$1")}}`)
    .replace(/background(-color)?\s*:\s*(white|#fff|#ffffff)\s*(;|})/gi, (_m, _c, _v, end: string) => `background: transparent${end}`)
    .replace(/;;+/g, ";")
    .replace(/\{\s*;/g, "{")
    .replace(/;\s*\}/g, "}");
}

/** A template fully wrapped in one conditional only makes a card when that field is filled. */
function gateOf(qfmt: string): string | null {
  const m = /^\s*\{\{#([^{}]+?)\}\}[\s\S]*\{\{\s*\/\s*\1\s*\}\}\s*$/.exec(qfmt);
  return m ? m[1].trim() : null;
}

function facesFor(nt: AnkiNotetype, notes: { fields: string[] }[]): { faces: string[]; gates: { face: string; field: string | null }[] } {
  if (nt.cloze) {
    let max = 0;
    for (const n of notes)
      for (const f of n.fields) {
        const re = /\{\{c\s*(\d+)\s*::/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(f))) max = Math.max(max, Number(m[1]));
      }
    const faces = Array.from({ length: Math.max(1, max) }, (_, i) => `c${i + 1}`);
    return { faces, gates: [] };
  }
  return {
    faces: nt.templates.map((_t, i) => `t${i}`),
    gates: nt.templates.map((t, i) => ({ face: `t${i}`, field: gateOf(t.qfmt) })),
  };
}

function buildType(nt: AnkiNotetype, ids: Map<number, string>, used: Set<string>, notes: { fields: string[] }[], media: Map<string, () => Buffer>): { def: CardTypeDef; map: Record<string, string> } {
  const usedFields = new Set<string>();
  const map: Record<string, string> = {};
  const fields: FieldSpec[] = nt.fields.map((f) => {
    const ident = fieldIdent(f.name, usedFields);
    map[f.name] = ident;
    return { name: ident, kind: FIELD_KIND, label: f.name };
  });

  const { faces, gates } = facesFor(nt, notes);
  const templateText = nt.templates.map((t) => t.qfmt + t.afmt).join("\n");
  const usesTags = /\{\{Tags\}\}/.test(templateText);
  const usesDeck = /\{\{Deck\}\}|\{\{Subdeck\}\}/.test(templateText);
  const snapshot: [string, string, string][] = [];
  if (usesTags) snapshot.push(["Tags", "Anki_Tags", "Anki tags (at import)"]);
  if (usesDeck) snapshot.push(["Deck", "Anki_Deck", "Anki deck (at import)"]);
  for (const [placeholder, wanted, label] of snapshot) {
    let ident = wanted;
    while (usedFields.has(ident)) ident += "_";
    usedFields.add(ident);
    map[placeholder] = ident;
    fields.push({ name: ident, kind: "text", label });
  }

  const hasType = /\{\{type:/.test(templateText);
  const data = {
    map,
    tpl: nt.templates.map((t) => ({ n: t.name, q: rewriteMedia(t.qfmt, media), a: rewriteMedia(t.afmt, media) })),
    typeName: nt.name,
    cloze: nt.cloze,
  };

  const prepare = RENDERER.replace("__ANKI__", JSON.stringify(data));

  // Cloze types get one face per cloze number used; standard ones only the templates that can exist.
  let facesWhen: string | undefined;
  if (nt.cloze) {
    const clozeField = nt.templates.map((t) => /\{\{cloze:([^{}]+?)\}\}/.exec(t.qfmt)?.[1]).find(Boolean) ?? nt.fields[0]?.name ?? "";
    const ident = map[clozeField] ?? fields[0]?.name ?? "";
    facesWhen = String.raw`
var s = String(fields[${JSON.stringify(ident)}] == null ? "" : fields[${JSON.stringify(ident)}]);
var out = [], re = /\{\{c\s*(\d+)\s*::/g, m;
while ((m = re.exec(s))) {
  var face = "c" + m[1];
  if (out.indexOf(face) < 0) out.push(face);
}
return out;`;
  } else if (gates.some((g) => g.field && map[g.field])) {
    const conditions = gates.map((g) => (g.field && map[g.field] ? map[g.field] : null));
    facesWhen = String.raw`
var faces = ${JSON.stringify(faces)};
var gates = ${JSON.stringify(conditions)};
var out = [];
for (var i = 0; i < faces.length; i++) {
  var g = gates[i];
  var v = String(fields[g] == null ? "" : fields[g]);
  // As in Anki, a field holding only media (a flag, a map, a sound) counts as filled.
  if (g && !/<(img|audio|video|object|embed)\b/i.test(v) && !/\[sound:/i.test(v) && !v.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim()) continue;
  out.push(faces[i]);
}
return out;`;
  }

  const def: CardTypeDef = {
    id: ids.get(nt.id)!,
    name: `Anki: ${nt.name}`,
    description: `Imported from Anki (${nt.name} notetype).`,
    faces,
    fields,
    prepare,
    template: {
      html: '<div class="card" id="anki-face"></div>',
      css: `${ankiCss(rewriteMedia(nt.css, media))}\n${BASE_CSS}`,
      js: `const HAS_TYPE = ${hasType};\n${CARD_JS}`,
    },
    grader: hasType
      ? {
          kind: "script",
          code: `const typed = typeof answer === "string" ? answer : answer && typeof answer === "object" ? String(answer.typed == null ? "" : answer.typed) : "";
if (!typed.trim()) return { score: null };
const ok = (key.accepted || []).some((a) => std.looseEqual(typed, a));
return { score: ok ? 1 : 0, feedback: ok ? undefined : "Expected: " + String((key.accepted || [])[0] || "") };`,
        }
      : { kind: "self" },
  };
  if (facesWhen) def.facesWhen = facesWhen;
  return { def, map };
}

// ---------------------------------------------------------------------- scheduling

function minutesToSteps(steps: number[]): string[] {
  return steps
    .filter((m) => Number.isFinite(m) && m > 0)
    .map((m) => (m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 && m >= 60 ? `${m / 60}h` : `${Math.round(m)}m`));
}

function presetConfig(cfg: AnkiDeckConfig | undefined): Partial<PresetConfig> {
  if (!cfg) return {};
  const out: Partial<PresetConfig> = {
    learningSteps: minutesToSteps(cfg.learnSteps),
    relearningSteps: minutesToSteps(cfg.relearnSteps),
    newPerDay: cfg.newPerDay,
    reviewsPerDay: cfg.reviewsPerDay,
    maximumInterval: cfg.maximumInterval,
    burySiblings: cfg.buryNew || cfg.buryReviews,
  };
  if (out.learningSteps && !out.learningSteps.length) delete out.learningSteps;
  if (out.relearningSteps && !out.relearningSteps.length) delete out.relearningSteps;
  if (cfg.desiredRetention && cfg.desiredRetention > 0.5 && cfg.desiredRetention < 1) out.desiredRetention = cfg.desiredRetention;
  if (cfg.fsrsWeights.length) out.weights = cfg.fsrsWeights;
  return out;
}

/** Review-card due dates are day numbers counted from the collection's creation day. */
function dayDate(created: number, day: number, dayStartHour: number): Date {
  const d = new Date((created + day * 86_400) * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), dayStartHour, 0, 0, 0);
}

function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

const isDayDue = (c: AnkiCard) => c.queue === 2 || c.queue === 3 || c.type === 2;

function fsrsState(card: AnkiCard): { s: number; d: number; lrt: number } | null {
  if (!card.data) return null;
  try {
    const data = JSON.parse(card.data) as { s?: unknown; d?: unknown; lrt?: unknown };
    if (typeof data.s === "number" && typeof data.d === "number" && typeof data.lrt === "number" && data.lrt > 0) return { s: data.s, d: data.d, lrt: data.lrt };
  } catch {
    // Older or add-on data: fall back to the review log.
  }
  return null;
}

function planCard(
  card: AnkiCard,
  log: { ts: Date; rating: number; durationMs: number | null }[],
  itemId: string,
  face: string,
  created: number,
  cfg: PresetConfig,
  dayStartHour: number,
  scheduling: boolean,
): PlannedCard {
  const reviews: PlannedReview[] = [];
  const empty: CardRow = {
    id: 0,
    item_id: itemId,
    face,
    ...sched.emptyCard(new Date(created * 1000)),
    suspended: 0,
    buried_until: null,
  };

  if (!scheduling) {
    return { itemId, face, state: 0, due: new Date().toISOString(), stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, learningSteps: 0, lastReview: null, suspended: false, buriedUntil: null, reviews };
  }

  let row: CardRow = { ...empty };
  for (const r of log) {
    const next = sched.schedule(row, r.rating as 1 | 2 | 3 | 4, r.ts, cfg).next;
    reviews.push({
      ts: r.ts.toISOString(),
      rating: r.rating,
      durationMs: r.durationMs,
      stateBefore: row.state,
      cardBefore: JSON.stringify(row),
      dueAfter: next.due,
    });
    row = { ...row, ...next };
  }

  const due = isDayDue(card)
    ? dayDate(created, card.originalDeckId ? card.originalDue : card.due, dayStartHour)
    : new Date((card.originalDeckId ? card.originalDue : card.due) * 1000);
  const dueIso = (Number.isNaN(due.getTime()) ? new Date() : due).toISOString();

  const state = card.type === 2 ? 2 : card.type === 3 ? 3 : card.type === 1 ? 1 : 0;
  const fsrs = fsrsState(card);
  const lastReview = fsrs ? new Date(fsrs.lrt * 1000).toISOString() : (row.last_review ?? null);
  const stability = fsrs ? fsrs.s : row.stability;
  const difficulty = fsrs ? fsrs.d : row.difficulty;
  const totalSteps = state === 3 ? cfg.relearningSteps.length : cfg.learningSteps.length;
  const learningSteps = state === 1 || state === 3 ? Math.max(0, totalSteps - Math.max(0, card.left)) : 0;

  const buried = card.queue === -2 || card.queue === -3;
  const tomorrow = addDays(new Date(), 1);
  const buriedUntil = buried ? new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), dayStartHour, 0, 0, 0).toISOString() : null;

  return {
    itemId,
    face,
    state,
    due: dueIso,
    stability,
    difficulty,
    elapsedDays: lastReview ? Math.max(0, Math.floor((Date.now() - new Date(lastReview).getTime()) / DAY)) : row.elapsed_days,
    scheduledDays: card.interval > 0 ? card.interval : row.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    learningSteps,
    lastReview,
    suspended: card.queue === -1,
    buriedUntil,
    reviews,
  };
}

// -------------------------------------------------------------------------- the plan

export function convertCollection(col: AnkiCollection, opts: ConvertOptions): ImportPlan {
  const skipped: Skipped[] = [];
  const decksById = new Map(col.decks.map((d) => [d.id, d]));
  const configsById = new Map(col.configs.map((c) => [c.id, c]));
  const notesById = new Map(col.notes.map((n) => [n.id, n]));
  const notetypesById = new Map(col.notetypes.map((n) => [n.id, n]));

  // Image occlusion notes (Anki's built-in notetype and the Image Occlusion Enhanced add-on) become
  // `occlusion` items. A note that can't be read keeps the generic conversion below.
  const rewrite = (html: string) => rewriteMedia(html, opts.media);
  const occlusion: IoItem[] = [];
  const asOcclusion = new Set<number>();
  for (const nt of col.notetypes) {
    const notes = col.notes.filter((n) => n.notetypeId === nt.id);
    if (!notes.length) continue;
    if (isAnkiIoNotetype(nt, notes)) {
      for (const n of notes) {
        const it = convertAnkiIo(nt, n, rewrite);
        if (it) {
          occlusion.push(it);
          asOcclusion.add(n.id);
        }
      }
    } else if (isIoeNotetype(nt)) {
      const { items, failed } = convertIoe(nt, notes, rewrite, opts.media);
      occlusion.push(...items);
      for (const it of items) for (const x of it.notes) asOcclusion.add(x.note.id);
      if (failed.length) skipped.push({ what: "occlusion", name: nt.name, reason: `${failed.length} note(s) whose mask couldn't be read were imported as plain notes` });
    }
  }

  // Notes and the notetypes they actually use.
  const used = new Set(col.notes.filter((n) => !asOcclusion.has(n.id)).map((n) => n.notetypeId));
  const typesWanted = col.notetypes.filter((nt) => used.has(nt.id));
  const anyNotes = new Set(col.notes.map((n) => n.notetypeId));
  for (const nt of col.notetypes) if (!anyNotes.has(nt.id)) skipped.push({ what: "notetype", name: nt.name, reason: "no notes" });

  const typeIds = new Map<number, string>();
  const takenTypes = new Set<string>();
  for (const nt of typesWanted) {
    let id = `anki-${slug(nt.name)}`;
    for (let i = 2; takenTypes.has(id); i++) id = `anki-${slug(nt.name)}-${i}`;
    takenTypes.add(id);
    typeIds.set(nt.id, id);
  }

  const notesFor = (ntId: number) => col.notes.filter((n) => n.notetypeId === ntId && !asOcclusion.has(n.id)).map((n) => ({ fields: n.fields }));
  const types: CardTypeDef[] = [];
  const mapsByType = new Map<number, Record<string, string>>();
  for (const nt of typesWanted) {
    const { def, map } = buildType(nt, typeIds, takenTypes, notesFor(nt.id), opts.media);
    types.push(def);
    mapsByType.set(nt.id, map);
  }

  // Decks: filtered ones are skipped and their cards fall back to their home deck.
  const deckName = (id: number): string | null => {
    const d = decksById.get(id);
    if (!d) return null;
    return d.filtered ? null : d.name;
  };
  const prefix = (name: string) => (opts.deckPrefix ? `${opts.deckPrefix}::${name}` : name);
  // A card whose home deck can't be resolved (a filtered deck without odid) lands in the first normal deck.
  const fallbackDeck = col.decks.find((d) => !d.filtered && /^default$/i.test(d.name)) ?? col.decks.find((d) => !d.filtered);

  const wantedDecks = new Set<string>();
  for (const card of col.cards) {
    const home = card.originalDeckId && deckName(card.originalDeckId) ? card.originalDeckId : card.deckId;
    const name = deckName(home) ?? fallbackDeck?.name ?? null;
    if (name) wantedDecks.add(prefix(name));
    else skipped.push({ what: "deck", name: decksById.get(home)?.name ?? String(home), reason: "unknown deck" });
  }
  for (const d of col.decks) if (d.filtered) skipped.push({ what: "deck", name: d.name, reason: "filtered deck; its cards go to their home deck" });

  const presetFor = (cfg: AnkiDeckConfig | undefined) => (cfg ? `anki-${slug(cfg.name)}` : null);
  const presets = new Map<string, { id: string; name: string; config: Partial<PresetConfig> }>();
  const decks: { name: string; presetId: string | null; description: string }[] = [];
  const seenDecks = new Set<string>();
  for (const full of [...wantedDecks].sort()) {
    const d = col.decks.find((x) => prefix(x.name) === full)!;
    const cfg = d.configId ? configsById.get(d.configId) : undefined;
    const presetId = presetFor(cfg);
    if (presetId && cfg) presets.set(presetId, { id: presetId, name: cfg.name, config: presetConfig(cfg) });
    // Parents are implicit in Etude; only the leaf carries the preset and description.
    if (!seenDecks.has(full)) {
      seenDecks.add(full);
      decks.push({ name: full, presetId, description: rewriteMedia(d.description, opts.media) });
    }
  }

  // Items, one per note.
  const takenItems = new Set<string>();
  const items: PlannedItem[] = [];
  const cards: PlannedCard[] = [];
  const reviewsByCard = new Map<number, AnkiReview[]>();
  for (const r of col.reviews) {
    const list = reviewsByCard.get(r.cardId) ?? [];
    list.push(r);
    reviewsByCard.set(r.cardId, list);
  }

  const cardsByNote = new Map<number, AnkiCard[]>();
  for (const c of col.cards) {
    const list = cardsByNote.get(c.noteId) ?? [];
    list.push(c);
    cardsByNote.set(c.noteId, list);
  }

  const dayStartHour = 4;
  let skippedReviews = 0;
  const homeDeckOf = (note: AnkiNote) => {
    const noteCards = cardsByNote.get(note.id) ?? [];
    const homeCard = noteCards.find((c) => !c.originalDeckId) ?? noteCards[0];
    const homeDeck = homeCard ? (homeCard.originalDeckId ? homeCard.originalDeckId : homeCard.deckId) : null;
    return homeDeck != null ? (deckName(homeDeck) ?? fallbackDeck?.name ?? null) : (fallbackDeck?.name ?? null);
  };
  const planReviews = (card: AnkiCard, id: string, face: string, deckPath: string) => {
    const cfg = decks.find((d) => d.name === deckPath)?.presetId;
    const config = sched.resolveConfig(cfg ? presets.get(cfg)?.config ?? {} : {});
    const all = (reviewsByCard.get(card.id) ?? []).sort((a, b) => a.id - b.id);
    const log = all
      .filter((r) => r.ease >= 1 && r.ease <= 4 && r.type !== 4)
      .map((r) => ({ ts: new Date(r.id), rating: r.ease, durationMs: r.time || null }));
    skippedReviews += all.length - log.length;
    cards.push(planCard(card, log, id, face, col.created, config, dayStartHour, opts.scheduling));
  };

  for (const it of occlusion) {
    const first = it.notes[0].note;
    const deck = homeDeckOf(first);
    if (!deck) {
      skipped.push({ what: "note", name: first.guid, reason: "no deck" });
      continue;
    }
    const id = itemId(it.id || first.guid, takenItems);
    const deckPath = prefix(deck);
    const tags = [...new Set(it.notes.flatMap((x) => x.note.tags))];
    items.push({ id, type: "occlusion", deck: deckPath, fields: it.fields as Record<string, unknown>, tags, source: "anki" });
    for (const { note, faceOf } of it.notes)
      for (const card of cardsByNote.get(note.id) ?? []) {
        const face = faceOf(card.ord);
        if (face) planReviews(card, id, face, deckPath);
      }
  }

  for (const note of col.notes) {
    if (asOcclusion.has(note.id)) continue;
    const nt = notetypesById.get(note.notetypeId);
    const typeId = typeIds.get(note.notetypeId);
    if (!nt || !typeId) {
      skipped.push({ what: "note", name: note.guid, reason: "unknown notetype" });
      continue;
    }
    const map = mapsByType.get(note.notetypeId)!;
    const noteCards = cardsByNote.get(note.id) ?? [];
    const homeCard = noteCards.find((c) => !c.originalDeckId) ?? noteCards[0];
    const homeDeck = homeCard ? (homeCard.originalDeckId ? homeCard.originalDeckId : homeCard.deckId) : null;
    const deck = homeDeck != null ? (deckName(homeDeck) ?? fallbackDeck?.name ?? null) : (fallbackDeck?.name ?? null);
    if (!deck) {
      skipped.push({ what: "note", name: note.guid, reason: "no deck" });
      continue;
    }
    const id = itemId(note.guid, takenItems);

    const fields: Record<string, unknown> = {};
    for (const [i, f] of nt.fields.entries()) {
      const ident = map[f.name];
      if (ident) fields[ident] = rewriteMedia(note.fields[i] ?? "", opts.media);
    }
    const deckPath = prefix(deck);
    if (map["Tags"]) fields[map["Tags"]] = note.tags.join(" ");
    if (map["Deck"]) fields[map["Deck"]] = deckPath;
    items.push({ id, type: typeId, deck: deckPath, fields, tags: note.tags, source: "anki" });

    const cfg = decks.find((d) => d.name === deckPath)?.presetId;
    const config = sched.resolveConfig(cfg ? presets.get(cfg)?.config ?? {} : {});

    for (const card of noteCards) {
      const face = nt.cloze ? `c${card.ord + 1}` : `t${card.ord}`;
      const all = (reviewsByCard.get(card.id) ?? []).sort((a, b) => a.id - b.id);
      const log = all
        .filter((r) => r.ease >= 1 && r.ease <= 4 && r.type !== 4)
        .map((r) => ({ ts: new Date(r.id), rating: r.ease, durationMs: r.time || null }));
      skippedReviews += all.length - log.length;
      cards.push(planCard(card, log, id, face, col.created, config, dayStartHour, opts.scheduling));
    }
  }
  if (skippedReviews) skipped.push({ what: "review", name: `${skippedReviews}`, reason: "manual or ungraded reviews were not imported" });

  // Media: anything referenced from the imported HTML, copied under anki/.
  const media: PlannedMedia[] = [];
  for (const [name, load] of opts.media) {
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
      skipped.push({ what: "media", name, reason: "unsafe file name" });
      continue;
    }
    media.push({ name, target: `anki/${name}`, load });
  }

  return { types, presets: [...presets.values()], decks, items, cards, media, skipped, notes: col.notes.length, cardsRead: col.cards.length, reviewsRead: col.reviews.length };
}
