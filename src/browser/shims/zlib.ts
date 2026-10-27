import { Buffer } from "buffer";
import { inflateSync } from "fflate";
import { decompress } from "fzstd";

export const inflateRawSync = (b: Uint8Array) => Buffer.from(inflateSync(b));
export const zstdDecompressSync = (b: Uint8Array) => Buffer.from(decompress(b));
export default { inflateRawSync, zstdDecompressSync };
