// Injected into card frames in the serverless build. There is no server for a frame to load media
// or type assets from, so it asks the app (its parent) for the bytes over postMessage: fetch() for
// those URLs is answered that way, src/href/poster pointing at them become blob URLs (in the document
// or not, so new Image() and new Audio(url) work too), and a FontFace with such a url() is made from
// the bytes.
(() => {
  const BASE = document.baseURI;
  const PREFIXES = [BASE + "media/", BASE + "type-assets/"];
  let n = 0;
  const waits = new Map();
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (m && m.etude === 1 && m.type === "media") return retry();
    if (!m || m.etude !== 1 || m.type !== "bytes" || !waits.has(m.req)) return;
    const w = waits.get(m.req);
    waits.delete(m.req);
    m.error ? w.reject(new Error(m.error)) : w.resolve(m);
  });
  const get = (url) =>
    new Promise((resolve, reject) => {
      const req = ++n;
      waits.set(req, { resolve, reject });
      parent.postMessage({ etude: 1, type: "get", req, url }, "*");
    });
  const ours = (u) => {
    try {
      const h = new URL(u, BASE).href;
      return PREFIXES.some((p) => h.startsWith(p)) ? h : null;
    } catch {
      return null;
    }
  };
  // The editor kit (code and markdown editors, highlighting) for the card runtime, one file built
  // with the app (dist-browser/kit/kit.js), imported from a blob URL.
  let kit = null;
  globalThis.__etudeKit = () =>
    (kit ??= get(BASE + "runtime/kit/kit.js")
      .then((m) => {
        if (m.status !== 200) throw new Error("The editor kit isn't available (" + m.status + ")");
        return import(URL.createObjectURL(new Blob([m.body], { type: "text/javascript" })));
      })
      .catch((e) => {
        kit = null;
        throw e;
      }));
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const h = ours(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (!h) return realFetch(input, init);
    const m = await get(h);
    return new Response(m.body, { status: m.status, headers: { "content-type": m.contentType || "application/octet-stream" } });
  };
  const ATTRS = ["src", "href", "poster"];
  const blobs = new Map();
  // A miss isn't kept: the file may still be on its way from another device.
  const blobFor = (h) => {
    if (!blobs.has(h)) {
      const p = get(h).then((m) => (m.status === 200 ? URL.createObjectURL(new Blob([m.body], { type: m.contentType })) : null), () => null);
      p.then((b) => b || blobs.delete(h));
      blobs.set(h, p);
    }
    return blobs.get(h);
  };
  const setAttr = Element.prototype.setAttribute;
  // The URL an element waits for, per attribute: one set after it replaces it.
  const waiting = new WeakMap();
  // Points the attribute at the file's blob URL once its bytes are here. A missing file's URL waits in
  // data-etude-<attribute> until the app says files arrived, and the miss is told as an error, so the card
  // runtime can show that the file is on its way.
  const route = (el, a, v, h) => {
    el.removeAttribute(a);
    const w = waiting.get(el) ?? {};
    waiting.set(el, w);
    w[a] = v;
    blobFor(h).then((b) => {
      if (w[a] !== v) return;
      delete w[a];
      if (b) setAttr.call(el, a, b);
      else {
        setAttr.call(el, "data-etude-" + a, v);
        el.dispatchEvent(new Event("error"));
      }
    });
  };
  const fix = (el) => {
    if (!el.getAttribute) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      const h = v ? ours(v) : null;
      if (h) route(el, a, v, h);
    }
  };
  // Elements that load outside the document (new Image(), new Audio(url), a video made in code) never
  // reach the observer below, so setting one of these URLs goes the same way, as a property or attribute.
  Element.prototype.setAttribute = function setAttribute(name, value) {
    const a = String(name).toLowerCase();
    if (ATTRS.includes(a)) {
      const h = ours(String(value));
      if (h) return route(this, a, String(value), h);
      delete waiting.get(this)?.[a];
    }
    return setAttr.call(this, name, value);
  };
  for (const [C, a] of [["HTMLImageElement", "src"], ["HTMLMediaElement", "src"], ["HTMLSourceElement", "src"], ["HTMLVideoElement", "poster"]]) {
    const d = globalThis[C] && Object.getOwnPropertyDescriptor(globalThis[C].prototype, a);
    // These reflect their attribute: setting the property sets the attribute to the same string.
    if (d?.set)
      Object.defineProperty(globalThis[C].prototype, a, {
        ...d,
        set(v) {
          this.setAttribute(a, v);
        },
      });
  }
  const NativeAudio = globalThis.Audio;
  if (NativeAudio) {
    const Audio = function Audio(src) {
      const el = new NativeAudio();
      if (src !== undefined) el.src = src;
      return el;
    };
    Audio.prototype = NativeAudio.prototype;
    Object.defineProperty(globalThis, "Audio", { value: Audio, writable: true, configurable: true });
  }
  // A font face whose source is one of these URLs is made from the file's bytes. The face the card holds
  // stands in for it: load() resolves with the real face, and adding the stand-in to a font set adds the
  // real face once it has loaded.
  const NativeFace = globalThis.FontFace;
  // The set's prototype from document.fonts: not every engine exposes FontFaceSet as a global.
  const FaceSet = document.fonts && Object.getPrototypeOf(document.fonts);
  if (NativeFace && FaceSet?.add) {
    const real = new WeakMap();
    const fontUrl = (s) => {
      const m = /^\s*url\(\s*(["']?)(.*?)\1\s*\)/.exec(s);
      return m ? ours(m[2]) : null;
    };
    class FontFace extends NativeFace {
      constructor(family, source, descriptors) {
        const h = typeof source === "string" ? fontUrl(source) : null;
        // The stand-in's own source is never loaded: load() and FontFaceSet.add below go to the real face.
        super(family, h ? 'local("Etude asset")' : source, descriptors);
        if (!h) return;
        const p = get(h).then((m) => {
          if (m.status !== 200) throw new DOMException(`couldn't load ${h} (${m.status})`, "NetworkError");
          return new NativeFace(family, m.body, descriptors).load();
        });
        p.catch(() => {});
        real.set(this, p);
      }
      load() {
        return real.get(this) ?? super.load();
      }
    }
    Object.defineProperty(globalThis, "FontFace", { value: FontFace, writable: true, configurable: true });
    const add = FaceSet.add;
    FaceSet.add = function (face) {
      const p = real.get(face);
      if (!p) return add.call(this, face);
      p.then((f) => add.call(this, f), () => {});
      return this;
    };
  }
  const retry = () => {
    for (const a of ATTRS)
      document.querySelectorAll(`[data-etude-${a}]`).forEach((el) => {
        const v = el.getAttribute("data-etude-" + a);
        el.removeAttribute("data-etude-" + a);
        el.setAttribute(a, v);
      });
  };
  const scan = (root) => {
    fix(root);
    root.querySelectorAll?.("[src],[href],[poster]").forEach(fix);
  };
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === "attributes") fix(m.target);
      for (const nd of m.addedNodes) if (nd.nodeType === 1) scan(nd);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href", "poster"] });
})();
