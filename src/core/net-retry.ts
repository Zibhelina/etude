// Retrying a request that died with the connection under it. Many transfers at once over one HTTP/2 connection can
// make the proxy refuse streams (NGHTTP2_ENHANCE_YOUR_CALM), and Node's fetch then fails every request still on that
// connection with "fetch failed". Those are worth another try on a fresh connection; an HTTP answer never is here.

const CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN", "ERR_HTTP2_STREAM_ERROR", "ERR_HTTP2_SESSION_ERROR", "ERR_HTTP2_GOAWAY_SESSION", "ERR_HTTP2_STREAM_CANCEL", "ERR_HTTP2_INVALID_SESSION", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "UND_ERR_CONNECT_TIMEOUT"]);
const TEXT = /ENHANCE_YOUR_CALM|REFUSED_STREAM|stream error|socket hang up|other side closed|ECONNRESET|UND_ERR_SOCKET/i;

/** A connection or stream failure, looking through `cause` chains (undici puts the real error there). */
export function isTransient(err: unknown): boolean {
  for (let e = err as any, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e.name === "AbortError" || e.name === "TimeoutError") return false;
    if (typeof e.code === "string" && CODES.has(e.code)) return true;
    if (typeof e.message === "string" && TEXT.test(e.message)) return true;
  }
  return false;
}

/** Retries after this long, times the attempt number, with jitter so parallel transfers don't come back together. */
export const RETRY_BASE_MS = { value: 400 };

/** Runs `fn`, and again up to `retries` times when it throws a transient connection error (not when `signal` stopped it). */
export async function retryTransient<T>(fn: () => Promise<T>, opts: { retries?: number; signal?: AbortSignal | null } = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || opts.signal?.aborted || !isTransient(err)) throw err;
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS.value * (attempt + 1) * (0.75 + Math.random() / 2)));
    }
  }
}
