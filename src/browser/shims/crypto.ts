// `node:crypto` in the browser build: hashes from @noble/hashes, randomness from Web Crypto.
import { Buffer } from "buffer";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { sha1 } from "@noble/hashes/legacy.js";

const ALGOS: Record<string, (b: Uint8Array) => Uint8Array> = { sha1, sha256, sha512 };

const toBase64Url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (s: string) => {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
};

class Hash {
  private readonly fn: (b: Uint8Array) => Uint8Array;
  private chunks: Uint8Array[] = [];
  constructor(algo: string) {
    const fn = ALGOS[algo.toLowerCase()];
    if (!fn) throw new Error(`Digest method not supported: ${algo}`);
    this.fn = fn;
  }
  update(data: string | Uint8Array, enc?: BufferEncoding) {
    if (typeof data === "string") {
      this.chunks.push(enc === "base64url" ? fromBase64Url(data) : Buffer.from(data, enc ?? "utf8"));
    } else {
      this.chunks.push(data);
    }
    return this;
  }
  digest(enc?: BufferEncoding): any {
    const all = Buffer.concat(this.chunks);
    const out = Buffer.from(this.fn(all));
    if (!enc) return out;
    if (enc === "base64url") return toBase64Url(out);
    return out.toString(enc);
  }
}

export const createHash = (algo: string) => new Hash(algo);
export const randomUUID = () => globalThis.crypto.randomUUID();
export const randomBytes = (n: number) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));
const unsupported = (what: string) => () => {
  throw new Error(`${what} isn't available in the browser build`);
};
export const createPublicKey = unsupported("createPublicKey");
export const verify = unsupported("crypto.verify");
export default { createHash, randomUUID, randomBytes, createPublicKey, verify };
