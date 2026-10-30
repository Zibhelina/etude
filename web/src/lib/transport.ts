// Where the app's own requests (/api, /frame) go. Normally the Etude server; in the serverless
// build (src/browser) the core runs in a worker in this tab and answers them instead.
type Transport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const local = (): Transport | undefined => (globalThis as { __etudeTransport?: Transport }).__etudeTransport;

// A server started with --token (the desktop app's engine, or one reached from a phone) needs it on
// every API call. Opening the app once with ?token=… stores it for this browser.
const TOKEN = (() => {
  try {
    const fromUrl = new URLSearchParams(location.search).get("token");
    if (fromUrl) localStorage.setItem("etude.token", fromUrl);
    return fromUrl ?? localStorage.getItem("etude.token");
  } catch {
    return null;
  }
})();

export const apiToken = () => TOKEN;

const isApi = (input: RequestInfo | URL) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  return u.origin === location.origin && u.pathname.startsWith("/api/");
};

/** `fetch` for Etude's own URLs, with the server's token on API calls. */
export const etudeFetch: Transport = (input, init) => {
  const l = local();
  if (l) return l(input, init);
  if (!TOKEN || !isApi(input)) return fetch(input, init);
  const headers = new Headers(init?.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${TOKEN}`);
  return fetch(input, { ...init, headers });
};

/** True when there is no server: the core runs in this tab. */
export const isLocal = () => !!local();
