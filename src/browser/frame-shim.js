// Injected into card frames in the serverless build. There is no server for a frame to load media
// or type assets from, so it asks the app (its parent) for the bytes over postMessage: fetch() for
// those URLs is answered that way, and src/href attributes pointing at them become blob URLs.
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
  // A missing file's URL waits in data-etude-<attribute> until the app says files arrived.
  const fix = (el) => {
    if (!el.getAttribute) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v || v.startsWith("blob:") || v.startsWith("data:")) continue;
      const h = ours(v);
      if (!h) continue;
      el.removeAttribute(a);
      // A miss is told as an error, so the card runtime can show that the file is on its way.
      blobFor(h).then((b) => (b ? el.setAttribute(a, b) : (el.setAttribute("data-etude-" + a, v), el.dispatchEvent(new Event("error")))));
    }
  };
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
