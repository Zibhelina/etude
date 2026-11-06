// etude.play and the <audio> rerouting in runtime/audio.js, on jsdom with a fake Web Audio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { affected, cardAudio } from "../runtime/audio.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Elements already given to createMediaElementSource, by any context (Chromium allows one). */
const connected = new WeakSet<object>();

class FakeSource {
  buffer: unknown = null;
  to: unknown = null;
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  connect(dest: unknown) {
    this.to = dest;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
    queueMicrotask(() => this.onended?.());
  }
}

class FakeContext extends EventTarget {
  state: string;
  destination = { destination: true };
  sources: FakeSource[] = [];
  routed: { el: unknown; to: unknown }[] = [];
  decodes = 0;
  opts: { state: string; resumes: boolean; decodeFails?: boolean };
  constructor(opts: { state: string; resumes: boolean; decodeFails?: boolean }) {
    super();
    this.opts = opts;
    this.state = opts.state;
  }
  resume() {
    if (this.state === "running") return Promise.resolve();
    if (!this.opts.resumes) return new Promise<void>(() => {});
    this.start();
    return Promise.resolve();
  }
  /** What a user gesture would do. */
  start() {
    this.state = "running";
    this.dispatchEvent(new Event("statechange"));
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  decodeAudioData(b: ArrayBuffer) {
    this.decodes++;
    return this.opts.decodeFails ? Promise.reject(new Error("can't decode")) : Promise.resolve({ decoded: b });
  }
  createMediaElementSource(el: object) {
    if (connected.has(el)) throw new Error("InvalidStateError: already connected");
    connected.add(el);
    const entry = { el, to: null as unknown };
    this.routed.push(entry);
    return { connect: (d: unknown) => (entry.to = d) };
  }
}

interface Options {
  webAudio?: boolean;
  state?: "running" | "suspended";
  resumes?: boolean;
  status?: number;
  decodeFails?: boolean;
  fetchGate?: Promise<void>;
}

/** A card frame: jsdom with media methods that record calls, a fake AudioContext and fetch. */
function frame(o: Options = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="card"></div></body>`, { url: "http://127.0.0.1:3000/frame/abc" });
  const win = dom.window as any;
  const plays: any[] = [];
  const loads: any[] = [];
  const srcSetWithCors: (string | null)[] = [];
  const proto = win.HTMLMediaElement.prototype;
  proto.play = function () {
    plays.push(this);
    return Promise.resolve();
  };
  proto.pause = function () {};
  proto.load = function () {
    loads.push(this);
  };
  // Records whether crossorigin was there when src was set (the load would start from here).
  const src = Object.getOwnPropertyDescriptor(proto, "src")!;
  Object.defineProperty(proto, "src", {
    ...src,
    set(v: string) {
      srcSetWithCors.push(this.getAttribute("crossorigin"));
      src.set!.call(this, v);
    },
  });
  const contexts: FakeContext[] = [];
  win.AudioContext = class extends FakeContext {
    constructor() {
      super({ state: o.state ?? "running", resumes: o.resumes ?? true, decodeFails: o.decodeFails });
      contexts.push(this);
    }
  };
  const fetches: string[] = [];
  win.fetch = async (url: string) => {
    fetches.push(url);
    await o.fetchGate;
    const status = o.status ?? 200;
    return { ok: status === 200, status, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const audio = cardAudio(win, { webAudio: o.webAudio ?? true });
  return { win, doc: win.document as any, audio, plays, loads, contexts, fetches, srcSetWithCors };
}

/** What Chromium does once an element has loaded its metadata. */
function loadMetadata(win: any, el: any) {
  Object.defineProperty(el, "readyState", { value: 1, configurable: true });
  el.dispatchEvent(new win.Event("loadedmetadata"));
}

test("the Web Audio path is for Chromium engines, Electron included", () => {
  const ua = (userAgent: string) => affected({ navigator: { userAgent } });
  assert.equal(ua("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) etude/3.0.1 Chrome/146.0.7680.65 Electron/45.1.0 Safari/537.36"), true);
  assert.equal(ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0"), true);
  assert.equal(ua("Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/155.0.0.0 Mobile Safari/537.36"), true);
  assert.equal(ua("Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0"), false);
  assert.equal(ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"), false);
  assert.equal(ua("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1"), false);
  assert.equal(affected({}), false);
});

test("etude.play decodes a file once, plays it as a buffer and stops the previous sound", async () => {
  const f = frame();
  const first = f.audio.play("media/files/a.mp3");
  await tick();
  const second = f.audio.play("media/files/a.mp3");
  await tick();
  assert.deepEqual(f.fetches, ["http://127.0.0.1:3000/frame/media/files/a.mp3"]);
  const [ctx] = f.contexts;
  assert.equal(f.contexts.length, 1);
  assert.equal(ctx.decodes, 1);
  assert.equal(ctx.sources.length, 2);
  assert.ok(ctx.sources.every((s) => s.started && s.to === ctx.destination && s.buffer));
  assert.equal(ctx.sources[0].stopped, true, "the new play stopped the first sound");
  assert.equal(await first.finished, false);
  ctx.sources[1].onended!();
  assert.equal(await second.finished, true);
  assert.equal(f.plays.length, 0, "no <audio> involved");
});

test("stop() before the file is decoded keeps the sound from starting, and so does a newer play", async () => {
  let open!: () => void;
  const f = frame({ fetchGate: new Promise<void>((r) => (open = r)) });
  const a = f.audio.play("a.mp3");
  await tick();
  a.stop();
  const b = f.audio.play("b.mp3");
  await tick();
  const c = f.audio.play("c.mp3");
  open();
  await tick();
  await tick();
  const ctx = f.contexts[0];
  assert.equal(await a.finished, false);
  assert.equal(await b.finished, false);
  assert.equal(ctx.sources.length, 1, "only the last play starts");
  assert.ok(ctx.sources[0].started);
  c.stop();
  assert.equal(ctx.sources[0].stopped, true);
  assert.equal(await c.finished, false);
});

test("a context that doesn't start within about 300 ms plays the file with <audio> instead", async () => {
  const f = frame({ state: "suspended", resumes: false });
  const t0 = Date.now();
  const h = f.audio.play("a.mp3");
  while (!f.plays.length && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
  const waited = Date.now() - t0;
  assert.ok(waited >= 280 && waited < 1000, `fell back after ${waited} ms`);
  assert.equal(f.fetches.length, 0);
  const [el] = f.plays;
  assert.ok(el instanceof f.win.HTMLAudioElement);
  assert.equal(el.src, "http://127.0.0.1:3000/frame/a.mp3");
  el.dispatchEvent(new f.win.Event("ended"));
  assert.equal(await h.finished, true);
});

test("a file that fails to load or decode plays with <audio>, and the next play tries Web Audio again", async () => {
  for (const o of [{ status: 404 }, { decodeFails: true }]) {
    const f = frame(o);
    f.audio.play("a.mp3");
    await tick();
    await tick();
    assert.equal(f.plays.length, 1, JSON.stringify(o));
    assert.equal(f.plays[0].src, "http://127.0.0.1:3000/frame/a.mp3");
    f.audio.play("a.mp3");
    await tick();
    await tick();
    assert.equal(f.fetches.length, 2, "the failure wasn't cached");
  }
});

test("an empty or unusable URL finishes at once without throwing", async () => {
  const f = frame();
  assert.equal(await f.audio.play("").finished, false);
  assert.equal(await f.audio.play(null).finished, false);
  assert.equal(await f.audio.play("http://[bad").finished, false);
  assert.equal(f.fetches.length + f.plays.length, 0);
});

test("outside Chromium, play() uses <audio> and install() leaves the frame alone", async () => {
  const f = frame({ webAudio: false });
  const NativeAudio = f.win.Audio;
  const nativePlay = f.win.HTMLMediaElement.prototype.play;
  f.audio.install();
  assert.equal(f.win.Audio, NativeAudio);
  assert.equal(f.win.HTMLMediaElement.prototype.play, nativePlay);
  f.audio.play("a.mp3");
  await tick();
  assert.equal(f.contexts.length, 0);
  assert.equal(f.plays.length, 1);
  assert.equal(f.plays[0].getAttribute("crossorigin"), null);
});

test("new Audio() gets crossorigin before its src and plays through the frame's AudioContext", async () => {
  const f = frame();
  f.audio.install();
  const el = new f.win.Audio("media/files/a.mp3");
  assert.ok(el instanceof f.win.Audio && el instanceof f.win.HTMLAudioElement);
  assert.equal(el.getAttribute("crossorigin"), "anonymous");
  assert.deepEqual(f.srcSetWithCors, ["anonymous"], "crossorigin was set before src");
  await el.play();
  assert.deepEqual(f.plays, [el], "play() isn't delayed");
  const ctx = f.contexts[0];
  assert.equal(ctx.routed.length, 0, "routed only once the metadata is in (a CORS failure comes first)");
  loadMetadata(f.win, el);
  assert.equal(ctx.routed.length, 1);
  assert.equal(ctx.routed[0].el, el);
  assert.equal(ctx.routed[0].to, ctx.destination);
  el.dispatchEvent(new f.win.Event("play"));
  await el.play();
  assert.equal(ctx.routed.length, 1, "routed once");
  assert.equal(f.loads.length, 0);

  // An element made with createElement gets it from the src setter.
  const el2 = f.doc.createElement("audio");
  el2.src = "media/files/b.mp3";
  assert.equal(f.srcSetWithCors.at(-1), "anonymous");
});

test("an <audio controls> put in the card (an Anki [sound:]) is marked on insertion and routed when its controls play it", async () => {
  const f = frame();
  f.audio.install();
  const card = f.doc.getElementById("card");
  card.innerHTML = `<p>dog</p><audio controls preload="none" src="/media/anki/dog.mp3"></audio>`;
  await tick();
  const el = card.querySelector("audio");
  assert.equal(el.getAttribute("crossorigin"), "anonymous", "set by the observer, before the load task");
  loadMetadata(f.win, el);
  // Native controls don't call play(): the element just fires "play".
  el.dispatchEvent(new f.win.Event("play"));
  assert.equal(f.contexts[0].routed.length, 1);
  assert.equal(f.loads.length, 0);
  assert.equal(f.plays.length, 0, "nothing played again");

  // A src changed with setAttribute on an element in the document.
  const el2 = f.doc.createElement("audio");
  card.append(el2);
  await tick();
  el2.removeAttribute("crossorigin");
  el2.setAttribute("src", "/media/x.mp3");
  await tick();
  assert.equal(el2.getAttribute("crossorigin"), "anonymous");
});

test("an element that may have started loading without CORS is loaded again before it plays", async () => {
  const f = frame();
  f.audio.install();
  const el = f.doc.createElement("audio");
  el.setAttribute("src", "/media/a.mp3"); // detached, so neither the setter nor the observer saw it
  Object.defineProperty(el, "networkState", { value: 1, configurable: true });
  await el.play();
  assert.equal(el.getAttribute("crossorigin"), "anonymous");
  assert.deepEqual(f.loads, [el]);
  assert.deepEqual(f.plays, [el]);
  // The same through native controls: loaded again, then played again.
  const el2 = f.doc.createElement("audio");
  el2.setAttribute("src", "/media/b.mp3");
  f.doc.body.append(el2); // played before the observer runs
  Object.defineProperty(el2, "networkState", { value: 2, configurable: true });
  el2.dispatchEvent(new f.win.Event("play"));
  await tick();
  assert.deepEqual(f.loads, [el, el2]);
  assert.deepEqual(f.plays, [el, el2]);
});

test("while the context waits for a gesture the element plays plainly, and moves to Web Audio once it runs", async () => {
  const f = frame({ state: "suspended", resumes: false });
  f.audio.install();
  const el = new f.win.Audio("a.mp3");
  el.play();
  assert.deepEqual(f.plays, [el], "played at once");
  loadMetadata(f.win, el);
  const ctx = f.contexts[0];
  assert.equal(ctx.routed.length, 0);
  ctx.start();
  assert.equal(ctx.routed.length, 1);
});

test("a host without CORS: the element loads again without crossorigin and plays plainly, and the card sees no error", async () => {
  const f = frame();
  f.audio.install();
  const el = new f.win.Audio("https://elsewhere.example/a.mp3");
  let cardErrors = 0;
  el.addEventListener("error", () => cardErrors++);
  el.play();
  el.dispatchEvent(new f.win.Event("error"));
  assert.equal(el.getAttribute("crossorigin"), null);
  assert.deepEqual(f.loads, [el]);
  assert.equal(f.plays.length, 2, "played again after the reload");
  assert.equal(cardErrors, 0);
  loadMetadata(f.win, el);
  el.play();
  assert.equal(f.contexts[0].routed.length, 0, "never routed: Web Audio would get silence");
  // A real error after that reaches the card.
  el.dispatchEvent(new f.win.Event("error"));
  assert.equal(cardErrors, 1);
});

test("an element the card routes through its own AudioContext, an explicit crossorigin and <video> are left alone", async () => {
  const f = frame();
  f.audio.install();
  const own = new f.win.AudioContext();
  const el = new f.win.Audio("a.mp3");
  own.createMediaElementSource(el);
  loadMetadata(f.win, el);
  await el.play();
  assert.equal(f.plays.length, 1);
  assert.equal(f.contexts[1].routed.length, 0);

  const cred = f.doc.createElement("audio");
  cred.crossOrigin = "use-credentials";
  cred.src = "b.mp3";
  assert.equal(cred.getAttribute("crossorigin"), "use-credentials");

  const video = f.doc.createElement("video");
  video.src = "c.mp4";
  loadMetadata(f.win, video);
  await video.play();
  assert.equal(video.getAttribute("crossorigin"), null);
  assert.equal(f.contexts[1].routed.length, 0);
});
