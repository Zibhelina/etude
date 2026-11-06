// Card sound: `etude.play(url)`, and in Chromium every <audio> a card plays routed through Web Audio.
//
// Chromium (Chrome, Edge, Android's WebView and Electron, so the desktop app) has a bug in media
// element playback across frames. When the frame whose <audio> first opened the audio output is
// removed while another frame's <audio> is playing, that element freezes a moment in (no error, no
// `ended`), and so does every <audio> played in any frame afterwards, until all of them are gone.
// Study removes the previous card's frame after its fly-off, while the next card's sound is
// starting, which is exactly that. Sound played through Web Audio isn't affected: decoded buffers,
// and also an <audio> element routed into an AudioContext with createMediaElementSource (it still
// decodes as media, but its output no longer goes to the shared one). So, in Chromium only:
//
// - `etude.play(url)` decodes the file once and plays it as a buffer, and
// - every <audio> the card plays (`new Audio()`, a template's <audio controls>, `autoplay`) gets
//   `crossorigin="anonymous"` before it loads (Web Audio gets silence from a non-CORS load; every
//   route a card can load media from answers with CORS) and goes through the frame's AudioContext
//   once that is running and the element has its metadata.
//
// Elsewhere both stay plain <audio>: other engines don't have the bug, and on iPhone Web Audio
// follows the silent switch while media elements don't.

const HAVE_METADATA = 1;
const NETWORK_IDLE = 1;
const NETWORK_LOADING = 2;
/** How long `play()` waits for a suspended AudioContext to start before it uses an <audio> instead. */
const RESUME_WAIT_MS = 300;

/** Whether this engine has the cross-frame media bug (any Chromium, including Electron). */
export const affected = (win) => /\b(?:Chrome|Chromium)\/\d/.test(win.navigator?.userAgent ?? "");

/** Sound for one card frame. `win` is the frame's window; `webAudio` defaults to `affected(win)`. */
export function cardAudio(win = globalThis, { webAudio = affected(win) } = {}) {
  let ctx = null;
  let ctxFailed = false;
  const onRunning = new Set();
  const context = () => {
    if (ctx || ctxFailed || !webAudio) return ctx;
    try {
      ctx = new win.AudioContext();
      ctx.addEventListener("statechange", () => {
        if (ctx.state === "running") for (const fn of onRunning) fn();
      });
    } catch {
      ctxFailed = true;
    }
    return ctx;
  };
  /** Resolves with whether the context runs, waiting at most `ms` for it to start. */
  const running = async (c, ms) => {
    if (c.state === "running") return true;
    let timer;
    await Promise.race([Promise.resolve(c.resume()).catch(() => {}), new Promise((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
    return c.state === "running";
  };

  // ---------- etude.play ----------

  const decoded = new Map();
  let stopCurrent = null;

  const decode = (c, href) => {
    if (!decoded.has(href)) {
      const p = win
        .fetch(href)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((b) => c.decodeAudioData(b));
      p.catch(() => decoded.delete(href));
      decoded.set(href, p);
    }
    return decoded.get(href);
  };

  /** Plays `url`, stopping the sound the card played before. Returns `{ stop(), finished }`. */
  function play(url) {
    stopCurrent?.();
    let settle;
    const finished = new Promise((r) => (settle = r));
    let stopped = false;
    let halt = null;
    const done = (ok) => {
      settle?.(ok);
      settle = null;
      if (stopCurrent === stop) stopCurrent = null;
    };
    const stop = () => {
      stopped = true;
      halt?.();
      halt = null;
      done(false);
    };
    stopCurrent = stop;
    let href = null;
    try {
      if (url != null && String(url)) href = new URL(String(url), win.document?.baseURI).href;
    } catch {}
    if (!href) {
      done(false);
      return { stop, finished };
    }

    const element = () => {
      const el = new win.Audio(href);
      const release = () => {
        el.pause();
        el.removeAttribute("src");
        el.load();
      };
      halt = release;
      el.addEventListener("ended", () => {
        if (halt === release) halt = null;
        done(true);
      });
      el.addEventListener("error", () => done(false));
      Promise.resolve(el.play()).catch(() => done(false));
    };

    (async () => {
      const c = context();
      if (!c) return element();
      try {
        if (!(await running(c, RESUME_WAIT_MS))) throw new Error("audio isn't allowed to start yet");
        const buffer = await decode(c, href);
        if (stopped) return;
        const node = c.createBufferSource();
        node.buffer = buffer;
        node.connect(c.destination);
        node.onended = () => done(true);
        halt = () => {
          try {
            node.stop();
          } catch {}
        };
        node.start();
      } catch {
        if (!stopped) element();
      }
    })();
    return { stop, finished };
  }

  // ---------- routing every <audio> through Web Audio ----------

  let installed = false;
  function install() {
    if (installed || !webAudio || !win.HTMLAudioElement || !win.AudioContext) return;
    installed = true;
    const doc = win.document;
    const proto = win.HTMLMediaElement.prototype;
    const nativePlay = proto.play;
    const ours = new WeakSet(); // we added its crossorigin attribute
    const routed = new WeakSet();
    const plain = new WeakSet(); // left as it is: its CORS load failed, or it can't be routed
    const listening = new WeakSet();
    const waiting = new Set(); // played, to route once the context runs and the metadata is in
    const isAudio = (el) => el instanceof win.HTMLAudioElement;

    const cors = (el) => {
      if (!isAudio(el) || plain.has(el) || el.hasAttribute("crossorigin")) return;
      el.setAttribute("crossorigin", "anonymous");
      if (ours.has(el)) return;
      ours.add(el);
      // A host without CORS fails the load: load it again without, as a plain element. The card's
      // own listeners don't see that first error.
      el.addEventListener("error", (e) => {
        if (routed.has(el) || plain.has(el) || el.readyState >= HAVE_METADATA || !el.hasAttribute("crossorigin")) return;
        e.stopImmediatePropagation();
        plain.add(el);
        const wanted = waiting.delete(el);
        el.removeAttribute("crossorigin");
        el.load();
        if (wanted) Promise.resolve(nativePlay.call(el)).catch(() => {});
      });
    };

    const route = (el) => {
      if (!waiting.has(el) || !ctx || ctx.state !== "running") return;
      if (el.readyState < HAVE_METADATA) {
        if (!listening.has(el)) {
          listening.add(el);
          el.addEventListener("loadedmetadata", () => route(el));
        }
        return;
      }
      waiting.delete(el);
      try {
        ctx.createMediaElementSource(el).connect(ctx.destination);
        routed.add(el);
      } catch {
        // Already routed by the card itself (so it's in Web Audio anyway), or Web Audio refused it.
        plain.add(el);
      }
    };
    onRunning.add(() => {
      for (const el of [...waiting]) route(el);
    });

    /** Called for every play of an <audio>. Returns true when it had to load the element again. */
    const played = (el) => {
      if (!isAudio(el) || routed.has(el) || plain.has(el)) return false;
      let reloaded = false;
      if (!el.hasAttribute("crossorigin")) {
        cors(el);
        // A fetch may have started without CORS, and Web Audio would only get silence from it.
        if (el.networkState === NETWORK_IDLE || el.networkState === NETWORK_LOADING) {
          const t = el.currentTime;
          el.load();
          if (t) el.currentTime = t;
          reloaded = true;
        }
      }
      const c = context();
      if (!c) return reloaded;
      waiting.add(el);
      if (c.state === "running") route(el);
      else Promise.resolve(c.resume()).catch(() => {});
      return reloaded;
    };

    proto.play = function play() {
      played(this);
      return nativePlay.call(this);
    };
    // Plays that don't go through play(): native controls and the autoplay attribute.
    doc.addEventListener(
      "play",
      (e) => {
        if (played(e.target)) Promise.resolve(nativePlay.call(e.target)).catch(() => {});
      },
      true,
    );

    // crossorigin has to be set before the element starts loading: when it's made, when it gets a
    // src, and when it lands in the document (this observer runs before Chromium's load task).
    const NativeAudio = win.Audio;
    const Audio = function Audio(src) {
      const el = new NativeAudio();
      cors(el);
      if (src !== undefined) el.src = src;
      return el;
    };
    Audio.prototype = NativeAudio.prototype;
    Object.defineProperty(win, "Audio", { value: Audio, writable: true, configurable: true });
    const srcProp = Object.getOwnPropertyDescriptor(proto, "src");
    if (srcProp?.set) {
      Object.defineProperty(proto, "src", {
        ...srcProp,
        set(v) {
          cors(this);
          srcProp.set.call(this, v);
        },
      });
    }
    const scan = (node) => {
      if (node.nodeType !== 1) return;
      cors(node);
      for (const el of node.querySelectorAll("audio")) cors(el);
    };
    new win.MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") cors(r.target);
        else for (const n of r.addedNodes) scan(n);
      }
    }).observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
    scan(doc.documentElement);
  }

  return { play, install };
}
