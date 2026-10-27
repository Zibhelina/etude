// `node:crypto` in the browser build: hashes from @noble/hashes, randomness from Web Crypto.
import { Buffer } from "buffer";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { sha1 } from "@noble/hashes/legacy.js";

const ALGOS: Record<string, (b: Uint8Array) => Uint8Array> = { sha1, sha256, sha512 };

class Hash {
  private readonly fn: (b: Uint8Array) => Uint8Array;
  private chunks: Uint8Array[] = [];
  constructor(algo: string) {
    const fn = ALGOS[algo.toLowerCase()];
    if (!fn) throw new Error(`Digest method not supported: ${algo}`);
    this.fn = fn;
  }
  update(data: string | Uint8Array, enc?: BufferEncoding) {
    this.chunks.push(typeof data === "string" ? Buffer.from(data, enc ?? "utf8") : data);
    return this;
  }
  digest(enc?: BufferEncoding): any {
    const all = Buffer.concat(this.chunks);
    const out = Buffer.from(this.fn(all));
    return enc ? out.toString(enc) : out;
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
