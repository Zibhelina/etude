// On a phone the app shows a card's one text field at the bottom of the screen (runtime/dock.js), on jsdom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { dockableField, installDock, pictureOf, promptOf, wrapperOf } from "../runtime/dock.js";

const tick = () => new Promise((r) => setTimeout(r, 5));
// jsdom lays nothing out: a field counts as showing unless it, or a box around it, has display: none.
const visible = (el: any) => {
  for (let e = el; e; e = e.parentElement) if (e.ownerDocument.defaultView.getComputedStyle(e).display === "none") return false;
  return true;
};
const card = (html: string) => {
  const dom = new JSDOM(`<!doctype html><head></head><body><div id="card">${html}</div></body>`);
  return dom.window.document.getElementById("card")!;
};

test("dock: a card with one single-line field hands it over", () => {
  const root = card(`<div class="prose">Name it</div><div class="ex-field"><input id="answer" placeholder="Type your answer"></div>`);
  assert.equal(dockableField(root, visible)?.id, "answer");
  // The box that held only the field hides with it; the card itself never does.
  assert.equal(wrapperOf(root.querySelector("#answer"), root).className, "ex-field");
});

test("dock: several ways to type, a long-answer box or a tap card keep their own fields", () => {
  assert.equal(dockableField(card(`<input><input>`), visible), null);
  assert.equal(dockableField(card(`<textarea></textarea>`), visible), null);
  assert.equal(dockableField(card(`<input><div contenteditable="true"></div>`), visible), null);
  assert.equal(dockableField(card(`<input type="password">`), visible), null);
  assert.equal(dockableField(card(`<button>A</button><button>B</button>`), visible), null);
  // Checkboxes, hidden, disabled and read-only fields aren't ways to type.
  assert.equal(dockableField(card(`<input id="a"><input type="checkbox"><input disabled><input readonly><input hidden><div hidden><input></div><input style="display:none">`), visible)?.id, "a");
});

test("dock: a blank in a sentence stays in its sentence", () => {
  // A cloze with one blank (types/cloze), a gap in a German sentence, words beside a field right in the card.
  assert.equal(dockableField(card(`<div class="prose cloze"><p>The capital of France is <span class="blank"><input><span class="fix"></span></span>.</p></div>`), visible), null);
  assert.equal(dockableField(card(`<p><span>Er</span> <input> <span>nach Hause.</span></p>`), visible), null);
  assert.equal(dockableField(card(`Er <input> nach Hause.`), visible), null);
  // A field below its question, right in the card or in a box of its own, is taken over.
  assert.ok(dockableField(card(`<h2>Capital of France?</h2><input>`), visible));
  assert.ok(dockableField(card(`<div class="q">Capital of France?</div><div><span><input></span></div>`), visible));
  // Also in a box the card draws everything into (German vocabulary): the words above are other lines.
  assert.ok(dockableField(card(`<div class="dv"><div class="e-label">What does it mean?</div><div class="dv-word">ab</div><button>Show it in a sentence</button><div hidden>Ab morgen.</div><input placeholder="Meaning"></div>`), visible));
  // A label around it, or a unit beside it in a row, stays with the field.
  assert.equal(dockableField(card(`<div><label>Answer: <input></label></div>`), visible), null);
  assert.equal(dockableField(card(`<label class="part"><span style="display: flex"><input><span>m/s</span></span></label>`), visible), null);
  assert.ok(dockableField(card(`<label class="part"><span style="display: flex"><input></span></label>`), visible));
});

test("dock: a field kept out of sight to catch keys (a typing test, a game) is the card's own", () => {
  assert.equal(dockableField(card(`<div class="tt-box"><div class="tt-text">asdf jkl;</div><input class="tt-input" style="position: absolute; opacity: 0"><div>click here or start typing</div></div>`), visible), null);
  assert.equal(dockableField(card(`<input style="visibility: hidden">`), visible), null);
});

test("dock: the card's field hides, takes what the app's field holds and shows again for the result", async () => {
  const root = card(`<div class="ex-field"><input id="answer" placeholder="Name the glowing structure" autocapitalize="off" spellcheck="false" value="fe"></div>`);
  const win = root.ownerDocument.defaultView!;
  const api = { root, mode: "answer" };
  const sent: [string, any][] = [];
  const dock = installDock(api, (type, data) => sent.push([type, data]), visible);
  dock.check();
  assert.equal(dock.docked, true);
  assert.deepEqual(sent, [["dock", { field: { placeholder: "Name the glowing structure", value: "fe", type: "text", inputMode: "", autocapitalize: "off", autocomplete: "", spellcheck: false, maxLength: null, label: "", kicker: "", kickerColor: "", question: "", picture: false, id: 1 } }]]);
  const box = root.querySelector(".ex-field")!;
  assert.ok(box.hasAttribute("data-etude-docked"));
  assert.equal(win.getComputedStyle(box).display, "none");
  // The card's CSS can tell (to put away keys that only type into its field).
  assert.ok(win.document.documentElement.hasAttribute("data-etude-dock"));

  // What the app's field holds goes into the card's, as typing would (the card enables Check on `input`).
  const input = root.querySelector("input")!;
  let typed = "";
  input.addEventListener("input", () => (typed = input.value));
  dock.setValue("Femur");
  assert.equal(typed, "Femur");

  // Nothing changes while the card keeps the same field.
  root.append(win.document.createElement("span"));
  await tick();
  assert.equal(sent.length, 1);

  // Graded: the card shows its own field again, with what was written, marked right or wrong.
  api.mode = "result";
  dock.stop();
  assert.equal(box.hasAttribute("data-etude-docked"), false);
  assert.equal(win.document.documentElement.hasAttribute("data-etude-dock"), false);
  assert.equal(dock.docked, false);
  assert.equal(input.value, "Femur");
});

test("dock: a field the card builds later is handed over, and given back when a second one appears", async () => {
  const root = card(`<div class="work"></div>`);
  const sent: [string, any][] = [];
  const dock = installDock({ root, mode: "answer" }, (type, data) => sent.push([type, data]), visible);
  dock.check();
  assert.equal(sent.length, 0);
  root.querySelector(".work")!.innerHTML = `<input placeholder="Capital">`;
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].field.placeholder, "Capital");
  root.insertAdjacentHTML("beforeend", `<input placeholder="Second blank">`);
  await tick();
  assert.deepEqual(sent[1], ["dock", { field: null }]);
  assert.equal(root.querySelector("[data-etude-docked]"), null);
  dock.stop();
});

// jsdom lays nothing out: a picture gets its size from the test.
const sized = (el: any, width: number, height: number) => {
  el.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 });
  return el;
};
// An anatomy card (Market "Human anatomy"): the region in capitals over the question, the model with what's
// laid over it, the field under it.
const anatomy = () => {
  const root = card(`
    <div class="a3-head"><div class="a3-eyebrow" style="text-transform: uppercase; color: rgb(240, 122, 176)">Pelvis</div><div class="prose a3-prompt"><p>Name the <em>glowing</em> structure.</p></div></div>
    <div class="a3-stage"><canvas></canvas><svg class="a3-lines" aria-hidden="true"></svg><div class="a3-hint" style="position: absolute">Drag to rotate</div><div class="a3-tools" style="position: absolute"><button>+</button></div><div class="a3-loading" role="status">Loading model…</div></div>
    <div class="a3-work"><input class="a3-in" placeholder="Name the glowing structure"></div>`);
  sized(root.querySelector("canvas"), 340, 340);
  return root;
};

test("dock: the question comes as plain text, a line in capitals over it as its kicker", () => {
  const root = anatomy();
  const field = root.querySelector("input")!;
  const pic = pictureOf(root, field, visible);
  // The whole stage goes with the model: the pins, the hint and the buttons sit over it.
  assert.equal(pic?.box.className, "a3-stage");
  assert.deepEqual(promptOf(root, [wrapperOf(field, root), pic!.box], visible), { kicker: "Pelvis", kickerColor: "rgb(240, 122, 176)", question: "Name the glowing structure." });
  // No kicker without a line in capitals; KaTeX said as written; buttons and hidden bits aren't the question.
  const math = card(`<div class="prose"><p>Solve <span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">x^2 = 9</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x2=9</span></span> for x.</p></div><button>Hint</button><p hidden>secret</p><input>`);
  assert.deepEqual(promptOf(math, [], visible), { kicker: "", kickerColor: "", question: "Solve x^2 = 9 for x." });
  // What comes after the field (how to move a map) isn't the question; one line in capitals alone is the question.
  const map = card(`<div class="cm-head"><div class="c3-eyebrow" style="text-transform: uppercase">Which country is this?</div></div><div class="cm-stage"><svg></svg></div><input class="cm-input"><p class="cm-hint">Drag to move · pinch to zoom</p>`);
  assert.deepEqual(promptOf(map, [map.querySelector(".cm-stage")], visible, map.querySelector("input")), { kicker: "", kickerColor: "", question: "Which country is this?" });
});

test("dock: a picture is the biggest image the card shows on its own, not one in a sentence or a button", () => {
  const typed = card(`<div class="prose"><p>Which bone is this?</p><p><img></p></div><div class="ex-field"><input></div>`);
  sized(typed.querySelector("img"), 300, 200);
  assert.equal(pictureOf(typed, typed.querySelector("input"), visible)?.box.localName, "p");
  const inSentence = card(`<p>What is <img> called?</p><input>`);
  sized(inSentence.querySelector("img"), 300, 200);
  assert.equal(pictureOf(inSentence, inSentence.querySelector("input"), visible), null);
  const small = card(`<p>Flag</p><img><button><img></button><input>`);
  sized(small.querySelector("img"), 40, 30);
  sized(small.querySelector("button img"), 300, 300);
  assert.equal(pictureOf(small, small.querySelector("input"), visible), null);
});

test("dock: while typing the card shows only its picture, as tall as the app says, and then all of itself again", async () => {
  const root = anatomy();
  const doc = root.ownerDocument;
  const sent: [string, any][] = [];
  const dock = installDock({ root, mode: "answer" }, (type, data) => sent.push([type, data]), visible);
  dock.check();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].field.picture, true);
  assert.equal(sent[0][1].field.question, "Name the glowing structure.");

  dock.stage(500);
  assert.ok(root.querySelector(".a3-head")!.hasAttribute("data-etude-aside"));
  assert.ok(root.querySelector(".a3-stage")!.hasAttribute("data-etude-stage"));
  assert.ok(root.querySelector("canvas")!.hasAttribute("data-etude-picture"));
  assert.equal(doc.documentElement.style.getPropertyValue("--etude-stage-height"), "500px");
  assert.equal(visible(root.querySelector(".a3-prompt")), false);
  // What moves over the model while it's staged tells the app nothing.
  root.querySelector(".a3-hint")!.textContent = "Pinch to zoom";
  await tick();
  assert.equal(sent.length, 1);

  dock.stage(null);
  assert.equal(root.querySelector("[data-etude-aside], [data-etude-stage], [data-etude-picture]"), null);
  assert.equal(doc.documentElement.style.getPropertyValue("--etude-stage-height"), "");
  // A new question for the same field comes with the same id, so the app keeps what's typed.
  root.querySelector(".a3-prompt p")!.textContent = "Name the other structure.";
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1][1].field.question, "Name the other structure.");
  assert.equal(sent[1][1].field.id, sent[0][1].field.id);
  dock.stop();
});
