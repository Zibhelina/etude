// The web edition's service worker (etude.study/app/). It keeps the app itself on the device, so
// the second visit starts from the cache and the app opens with no connection at all. Your
// collection isn't here: it lives in the browser's private storage (OPFS), next to this cache.
//
//  - Built files (/app/assets/…) have their hash in the name: from the cache, else the network.
//  - The page (/app/, /app/study?deck=…): the network first, so a new version arrives on the next
//    visit; offline, or when the static host answers 404 for one of the app's screens, the cached
//    copy of the app instead.
//  - Everything else (the Market on GitHub, AI providers, Sync) goes straight to the network.
//
// __BASE__ and __BUILD__ are filled in by the build (vite.config.ts).
const BASE = "__BASE__";
const CACHE = "etude-web-__BUILD__";
const SHELL = `${BASE}/`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll([SHELL]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("etude-web-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === "navigate" && (url.pathname === BASE || url.pathname.startsWith(`${BASE}/`))) {
    event.respondWith(page(req));
    return;
  }
  if (url.pathname.startsWith(`${BASE}/assets/`)) {
    event.respondWith(built(req));
    return;
  }
  if (url.pathname.startsWith(`${BASE}/`)) event.respondWith(fresh(req));
});

async function page(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) {
      if (new URL(req.url).pathname === SHELL) await cache.put(SHELL, res.clone());
      return res;
    }
    // One of the app's own screens (/app/study?deck=…): the host has no such file, the app does.
    return (await cache.match(SHELL)) ?? res;
  } catch {
    return (await cache.match(SHELL)) ?? Response.error();
  }
}

async function built(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

async function fresh(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) ?? Response.error();
  }
}
