// Where the app's own requests (/api, /frame) go. Normally the Etude server; in the serverless
// build (src/browser) the core runs in a worker in this tab and answers them instead.
type Transport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const local = (): Transport | undefined => (globalThis as { __etudeTransport?: Transport }).__etudeTransport;

// A server started with --token (the desktop app's engine, or one reached from a phone) needs it on
// every API call. Opening the app once with ?token=… stores it for this browser, and the address loses
// it, so it doesn't stay in history or reach anything the page loads.
const TOKEN = (() => {
  let fromUrl: string | null = null;
  try {
    const params = new URLSearchParams(location.search);
    fromUrl = params.get("token");
    if (!fromUrl) return localStorage.getItem("etude.token");
    localStorage.setItem("etude.token", fromUrl);
    params.delete("token");
    const q = params.toString();
    history.replaceState(history.state, "", location.pathname + (q ? `?${q}` : "") + location.hash);
  } catch {}
  return fromUrl;
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
