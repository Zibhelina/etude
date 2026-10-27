// Where the app's own requests (/api, /frame) go. Normally the Etude server; in the serverless
// build (src/browser) the core runs in a worker in this tab and answers them instead.
type Transport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const local = (): Transport | undefined => (globalThis as { __etudeTransport?: Transport }).__etudeTransport;

/** `fetch` for Etude's own URLs. */
export const etudeFetch: Transport = (input, init) => (local() ?? fetch)(input, init);

/** True when there is no server: the core runs in this tab. */
export const isLocal = () => !!local();
