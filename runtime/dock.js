// On a phone the app can take over a card's text field: the card's own box hides and the app shows one at
// the bottom of the screen, above the keyboard, and hands back what is typed in it (web/src/pages/study.tsx).
// Only a card whose one way to type is a single-line field is taken over. Anything else (several blanks, a
// box for a long answer, a code editor) keeps its own fields, and so does a card that answers by tapping.

/** Input types the app's field can stand in for. */
const DOCKABLE = ["text", "search", "tel", "url", "email", "number"];
/** Input types a person types into: one of these anywhere else in the card keeps the card's own field. */
const TYPED = [...DOCKABLE, "password"];
const ENTRY = "input, textarea, [contenteditable]";
const MARK = "data-etude-docked";
// While the learner types, the card shows only its picture, filling the room the app gives it.
const STAGE = "data-etude-stage";
const PICTURE = "data-etude-picture";
const ASIDE = "data-etude-aside";
const STYLE = `[${MARK}], [${ASIDE}] { display: none !important; }
[${STAGE}] { height: var(--etude-stage-height) !important; min-height: 0 !important; max-height: none !important; aspect-ratio: auto !important; margin-block: 0 !important; box-sizing: border-box !important; }
[${STAGE}]:is(img, svg, canvas, video), [${PICTURE}] { width: 100% !important; max-width: none !important; max-height: none !important; object-fit: contain; }
[${PICTURE}] { height: 100% !important; }`;
/** Not words of the question: controls, what's hidden from screen readers, status lines, KaTeX's drawn copy. */
const UNSAID = "template, script, style, noscript, button, select, textarea, input, [hidden], [aria-hidden='true'], [role='status'], [role='alert'], .katex-html";
/** The smallest picture that's worth showing on its own, in CSS pixels each way. */
const MIN_PICTURE = 80;

const shown = (el) => el.getClientRects().length > 0;
const layered = (el) => /^(absolute|fixed)$/.test(el.ownerDocument.defaultView.getComputedStyle(el).position);

const typedInto = (el) => {
  if (el instanceof el.ownerDocument.defaultView.HTMLInputElement) return TYPED.includes(el.type);
  if (el.hasAttribute("contenteditable")) return el.getAttribute("contenteditable") !== "false";
  return true;
};

const styleOf = (el) => el.ownerDocument.defaultView.getComputedStyle(el);
const inline = (el) => styleOf(el).display.startsWith("inline");

/** Words in `n` a learner reads, not counting controls (a button's label) or what's hidden. */
const words = (n) => {
  if (n.nodeType === 3) return !!n.textContent.trim();
  if (n.nodeType !== 1 || n.matches(UNSAID) || styleOf(n).display === "none") return false;
  return [...n.childNodes].some(words);
};
const rectsOf = (n) => {
  if (n.nodeType === 1) return [...n.getClientRects()];
  const range = n.ownerDocument.createRange();
  range.selectNodeContents(n);
  return [...range.getClientRects()];
};

/**
 * A field with words on its line: a blank in a sentence (a cloze, a gap to fill), or a label or a unit beside
 * it. Taken out of its words, the sentence would lose its gap, the unit its number. Words on other lines
 * around it (the question above, a hint below) and buttons beside it don't count.
 */
export function inSentence(el, root) {
  // The inline boxes around the field (a cloze's blank, a <label>): words in them are on its line.
  let w = el;
  while (w.parentElement && w.parentElement !== root && inline(w.parentElement)) w = w.parentElement;
  if (w !== el && words(w)) return true;
  // Then what's beside it. Laid out, that's what shares its line, however the text wraps (a field as wide as
  // the card has a line of its own). Otherwise, what comes before and after it until a block starts a line;
  // in a row (flex), everything is beside it.
  const line = w.getBoundingClientRect();
  const laidOut = line.height > 0;
  const box = w.parentElement;
  const row = !!box && /flex/.test(styleOf(box).display) && !styleOf(box).flexDirection.startsWith("column");
  for (const step of ["previousSibling", "nextSibling"]) {
    for (let n = w[step]; n; n = n[step]) {
      if (n.nodeType === 1 && (n.matches(UNSAID) || styleOf(n).display === "none")) continue;
      if (n.nodeType !== 1 && n.nodeType !== 3) continue;
      if (laidOut) {
        if (words(n) && rectsOf(n).some((r) => r.height > 0 && r.top < line.bottom - 1 && r.bottom > line.top + 1)) return true;
        continue;
      }
      if (n.nodeType === 1 && !row && !inline(n)) break;
      if (words(n)) return true;
    }
  }
  return false;
}

/** A field the card keeps out of sight to catch keys for something of its own (a typing test, a game). */
const keyCatcher = (el) => {
  const s = styleOf(el);
  return Number(s.opacity) === 0 || s.visibility === "hidden";
};

/** The card's one single-line text field, or null when it has none, or more than one way to type. */
export function dockableField(root, visible = shown) {
  let found = null;
  for (const el of root.querySelectorAll(ENTRY)) {
    if (!typedInto(el) || el.disabled || el.readOnly || el.closest("[hidden], [inert]")) continue;
    // The field already taken over is hidden by us, not gone.
    if (!el.closest(`[${MARK}]`) && !visible(el)) continue;
    if (found) return null;
    found = el;
  }
  const Input = root.ownerDocument.defaultView.HTMLInputElement;
  if (!(found instanceof Input) || !DOCKABLE.includes(found.type) || keyCatcher(found)) return null;
  // Once taken over it's hidden, with no line left to measure: it stays taken over while it's the only one.
  return found.closest(`[${MARK}]`) || !inSentence(found, root) ? found : null;
}

/** What hides with the field: the field, or the boxes around it that hold nothing else. */
export function wrapperOf(el, root) {
  let w = el;
  for (let p = w.parentElement; p && p !== root; p = p.parentElement) {
    const alone = p.children.length === 1 && [...p.childNodes].every((n) => n === w || n.nodeType === 8 || (n.nodeType === 3 && !n.textContent.trim()));
    if (!alone) break;
    w = p;
  }
  return w;
}

/** Whether `box` has words in its flow outside `inner`; words laid over a picture (a hint, a pin) don't count. */
function wordsBeside(box, inner, visible) {
  for (const n of box.childNodes) {
    if (n === inner) continue;
    if (n.nodeType === 3 && n.textContent.trim()) return true;
    if (n.nodeType !== 1 || n.matches(UNSAID) || layered(n) || !visible(n)) continue;
    if (wordsBeside(n, inner, visible)) return true;
  }
  return false;
}

/**
 * The card's picture: its biggest image, drawing, canvas or video, and the box that holds it with what's laid
 * over it (the pins and buttons on a 3D model) but no words of the card. Null when the card has none, or
 * when the picture sits in a sentence.
 */
export function pictureOf(root, field, visible = shown) {
  let best = null;
  let most = 0;
  for (const el of root.querySelectorAll("img, svg, canvas, video")) {
    if (el.parentElement?.closest("svg") || el.closest(`button, a, label, [${MARK}]`) || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < MIN_PICTURE || r.height < MIN_PICTURE || r.width * r.height <= most) continue;
    best = el;
    most = r.width * r.height;
  }
  if (!best) return null;
  let box = best;
  for (let p = box.parentElement; p && p !== root && !p.contains(field) && !wordsBeside(p, box, visible); p = p.parentElement) box = p;
  if (box.parentElement && [...box.parentElement.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return null;
  return { el: best, box };
}

/**
 * The card's question as plain text, read as the learner sees it up to `until` (the field: what comes after
 * it, like "drag to move the map", isn't the question), leaving out `skip` (the picture). A first line set in
 * capitals (the region over an anatomy question, say) is its kicker, with the colour the card gives it.
 */
export function promptOf(root, skip = [], visible = shown, until = null) {
  const View = root.ownerDocument.defaultView;
  const blocks = [];
  let words = "";
  let owner = null;
  let done = false;
  const flush = () => {
    const text = words.replace(/\s+/g, " ").trim();
    if (text) {
      const style = owner ? View.getComputedStyle(owner) : null;
      blocks.push({ text, upper: style?.textTransform === "uppercase", color: style?.color ?? "" });
    }
    words = "";
    owner = null;
  };
  const walk = (node, block) => {
    for (const n of node.childNodes) {
      if (done) return;
      if (n === until) {
        done = true;
        return;
      }
      if (n.nodeType === 3) {
        if (n.textContent.trim()) owner ??= block;
        words += n.textContent;
        continue;
      }
      if (n.nodeType !== 1 || skip.includes(n) || n.matches(UNSAID) || layered(n) || !visible(n)) continue;
      // KaTeX keeps the formula's source beside what it draws: say it as written.
      if (n.classList.contains("katex")) {
        words += ` ${n.querySelector("annotation")?.textContent ?? ""} `;
        continue;
      }
      if (n.localName === "br") {
        words += " ";
        continue;
      }
      if (inline(n)) {
        walk(n, block);
        continue;
      }
      flush();
      walk(n, n);
      flush();
    }
  };
  walk(root, root);
  flush();
  const kicker = blocks.length > 1 && blocks[0].upper ? blocks.shift() : null;
  return {
    kicker: kicker?.text.slice(0, 80) ?? "",
    kickerColor: kicker?.color ?? "",
    question: blocks.map((b) => b.text).join(" ").slice(0, 400),
  };
}

/** What the app's field copies from the card's, so it behaves the same (keyboard, hint, length). */
export function describe(el) {
  const label = el.getAttribute("aria-label") || [...(el.labels ?? [])].map((l) => l.textContent.trim()).filter(Boolean).join(" ");
  return {
    placeholder: el.placeholder || "",
    value: el.value || "",
    type: el.type || "text",
    inputMode: el.getAttribute("inputmode") || "",
    autocapitalize: el.getAttribute("autocapitalize") || "",
    autocomplete: el.getAttribute("autocomplete") || "",
    spellcheck: el.getAttribute("spellcheck") !== "false",
    maxLength: el.maxLength > 0 ? el.maxLength : null,
    label,
  };
}

/**
 * Hands the card's field to the app while the card waits for an answer. `send("dock", { field })` says which
 * (null when the card's own field shows again), with the card's question and whether it has a picture, sent
 * again when they change (`id` stays the same for the same field); `setValue` types what the app's field
 * holds into the card's, firing `input` so the card reacts as if typed (enabling Check, say); `stage(height)`
 * shows only the card's picture, the card that tall in all, while the app shows the question and the field
 * around it (`stage(null)` shows the whole card again). Watches the card, since many build their field after
 * loading something.
 */
export function installDock(api, send, visible = shown) {
  const root = api.root;
  const doc = root.ownerDocument;
  if (!doc.getElementById("etude-dock-style")) {
    const style = doc.createElement("style");
    style.id = "etude-dock-style";
    style.textContent = STYLE;
    doc.head.append(style);
  }
  let field = null;
  let hidden = null;
  let id = 0;
  let told = "";
  let picture = null;
  let staged = null;
  let timer = null;
  // Whether something changed outside the picture since the question was last read (a 3D model's pins move
  // with every frame; reading the question again each time would be wasted).
  let stale = true;

  const unstage = () => {
    if (!staged) return;
    for (const el of root.querySelectorAll(`[${ASIDE}]`)) el.removeAttribute(ASIDE);
    staged.box.removeAttribute(STAGE);
    staged.el.removeAttribute(PICTURE);
    doc.documentElement.style.removeProperty("--etude-stage-height");
    staged = null;
  };
  const release = () => {
    if (!field) return false;
    unstage();
    delete doc.documentElement.dataset.etudeDock;
    hidden.removeAttribute(MARK);
    field = hidden = picture = null;
    told = "";
    return true;
  };
  const tell = () => {
    picture = pictureOf(root, field, visible);
    const about = { ...promptOf(root, [picture?.box].filter(Boolean), visible, hidden), picture: !!picture };
    const key = JSON.stringify(about);
    if (key === told) return;
    told = key;
    send("dock", { field: { ...describe(field), ...about, id } });
  };
  const check = () => {
    timer = null;
    if (api.mode !== "answer") return stop();
    // Staged, the rest of the card is put aside on purpose: it's read again once the whole card shows.
    if (staged) return;
    const el = dockableField(root, visible);
    if (el === field) {
      if (el && stale) (stale = false), tell();
      return;
    }
    const was = release();
    if (el) {
      field = el;
      hidden = wrapperOf(el, root);
      hidden.setAttribute(MARK, "");
      // For the card's CSS: what only serves its own field (a row of keys for ä, ö, ü) can step aside too.
      doc.documentElement.dataset.etudeDock = "";
      id++;
      stale = false;
      tell();
    } else if (was) send("dock", { field: null });
  };
  const View = doc.defaultView;
  const observer = new View.MutationObserver((records) => {
    if (records.some((r) => !picture?.box.contains(r.target))) stale = true;
    timer ??= View.setTimeout(check, 0);
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "inert", "disabled", "readonly", "type", "contenteditable", "class", "style"] });
  // An image that loads changes nothing in the card but its size: it may be the picture now.
  const sized = View.ResizeObserver ? new View.ResizeObserver(() => {
    stale = true;
    timer ??= View.setTimeout(check, 0);
  }) : null;
  sized?.observe(root);
  function stop() {
    observer.disconnect();
    sized?.disconnect();
    if (timer !== null) View.clearTimeout(timer);
    timer = null;
    // The card shows its own field again for the result (what you wrote, marked right or wrong).
    release();
  }
  return {
    check,
    stop,
    get docked() {
      return field !== null;
    },
    setValue(value) {
      if (!field) return;
      field.value = String(value ?? "");
      field.dispatchEvent(new View.Event("input", { bubbles: true }));
    },
    stage(height) {
      if (!field || !(height > 0)) {
        const was = !!staged;
        unstage();
        if (was) timer ??= View.setTimeout(check, 0);
        return;
      }
      if (!staged) {
        const pic = pictureOf(root, field, visible);
        if (!pic) return;
        for (let el = pic.box; el !== root; el = el.parentElement) {
          for (const sib of el.parentElement.children) if (sib !== el) sib.setAttribute(ASIDE, "");
        }
        pic.box.setAttribute(STAGE, "");
        if (pic.el !== pic.box) pic.el.setAttribute(PICTURE, "");
        staged = picture = pic;
      }
      // The picture takes what's left once the card's own padding (around it, now alone) is counted.
      const rest = doc.body.getBoundingClientRect().height - staged.box.getBoundingClientRect().height;
      doc.documentElement.style.setProperty("--etude-stage-height", `${Math.max(MIN_PICTURE, Math.floor(height - rest))}px`);
    },
  };
}
