// Anki packages (.apkg, .colpkg): a zip holding the collection database and numbered media files.
// New packages (Anki 2.1.50+) compress both with zstd and list media in a protobuf; legacy ones use
// plain SQLite and a JSON media map.
import { inflateRawSync, zstdDecompressSync } from "node:zlib";

export class AnkiFormatError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** Lists a zip's central directory. Zip64 archives (over 4 GB) aren't supported. */
export function readZip(buf: Buffer): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new AnkiFormatError("not a zip file (an .apkg or .colpkg is a zip)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new AnkiFormatError("corrupt zip directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.set(name, { name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function zipData(buf: Buffer, e: ZipEntry): Buffer {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new AnkiFormatError(`corrupt zip entry ${e.name}`);
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const raw = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return inflateRawSync(raw);
  throw new AnkiFormatError(`zip entry ${e.name} uses unsupported compression ${e.method}`);
}

// ---------------------------------------------------------------- protobuf

export type ProtoValue = number | bigint | Buffer;

/** Decodes one protobuf message into field number → values (varints as numbers, fixed32 as floats). */
export function readProto(buf: Buffer | Uint8Array | null | undefined): Map<number, ProtoValue[]> {
  const out = new Map<number, ProtoValue[]>();
  if (!buf) return out;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let p = 0;
  const varint = (): bigint => {
    let v = 0n, shift = 0n;
    for (;;) {
      if (p >= b.length) throw new AnkiFormatError("truncated protobuf");
      const byte = b[p++];
      v |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return v;
      shift += 7n;
    }
  };
  while (p < b.length) {
    const tag = Number(varint());
    const field = tag >> 3, wire = tag & 7;
    let v: ProtoValue;
    if (wire === 0) {
      const big = varint();
      v = big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
    } else if (wire === 1) {
      v = b.readDoubleLE(p);
      p += 8;
    } else if (wire === 2) {
      const len = Number(varint());
      v = b.subarray(p, p + len);
      p += len;
    } else if (wire === 5) {
      v = b.readFloatLE(p);
      p += 4;
    } else throw new AnkiFormatError(`unsupported protobuf wire type ${wire}`);
    const list = out.get(field) ?? [];
    list.push(v);
    out.set(field, list);
  }
  return out;
}

export const protoStr = (m: Map<number, ProtoValue[]>, f: number) => {
  const v = m.get(f)?.[0];
  return Buffer.isBuffer(v) ? v.toString("utf8") : "";
};
export const protoNum = (m: Map<number, ProtoValue[]>, f: number): number | undefined => {
  const v = m.get(f)?.at(-1);
  return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined;
};
export const protoMsg = (m: Map<number, ProtoValue[]>, f: number) => {
  const v = m.get(f)?.[0];
  return Buffer.isBuffer(v) ? readProto(v) : undefined;
};
/** Repeated floats, packed (one length-delimited blob of fixed32) or not. */
export const protoFloats = (m: Map<number, ProtoValue[]>, f: number): number[] =>
  (m.get(f) ?? []).flatMap((v) => (Buffer.isBuffer(v) ? Array.from({ length: v.length / 4 }, (_, i) => v.readFloatLE(i * 4)) : [Number(v)]));

// ---------------------------------------------------------------- packages

export interface AnkiPackage {
  /** "new" = zstd + protobuf schema (collection.anki21b); "legacy" = collection.anki21 / .anki2. */
  format: "new" | "legacy";
  /** The SQLite collection file, decompressed. */
  collection: Buffer;
  /** Media by original filename; data loads on demand. */
  media: Map<string, () => Buffer>;
}

const ZSTD_MAGIC = 0xfd2fb528;
const unzstd = (b: Buffer) => (b.length >= 4 && b.readUInt32LE(0) === ZSTD_MAGIC ? zstdDecompressSync(b) : b);

export function openPackage(buf: Buffer): AnkiPackage {
  const zip = readZip(buf);
  const entry = (n: string) => zip.get(n);
  let format: AnkiPackage["format"];
  let collection: Buffer;
  if (entry("collection.anki21b")) {
    format = "new";
    collection = unzstd(zipData(buf, entry("collection.anki21b")!));
  } else if (entry("collection.anki21") || entry("collection.anki2")) {
    format = "legacy";
    collection = zipData(buf, (entry("collection.anki21") ?? entry("collection.anki2"))!);
  } else throw new AnkiFormatError("no Anki collection in this file (expected collection.anki21b, .anki21 or .anki2)");
  if (collection.subarray(0, 15).toString("latin1") !== "SQLite format 3") throw new AnkiFormatError("the collection inside the package is not a SQLite database");

  const media = new Map<string, () => Buffer>();
  const mediaEntry = entry("media");
  if (mediaEntry) {
    const raw = unzstd(zipData(buf, mediaEntry));
    const load = (zipName: string) => () => {
      const e = entry(zipName);
      if (!e) throw new AnkiFormatError(`media file ${zipName} is missing from the package`);
      return unzstd(zipData(buf, e));
    };
    if (raw.length && raw.toString("utf8").trimStart().startsWith("{")) {
      const map = JSON.parse(raw.toString("utf8")) as Record<string, string>;
      for (const [k, name] of Object.entries(map)) if (entry(k)) media.set(name, load(k));
    } else {
      // MediaEntries { repeated MediaEntry entries = 1 { name = 1; size = 2; sha1 = 3 } }; the i-th is zip entry "i".
      (readProto(raw).get(1) ?? []).forEach((v, i) => {
        if (!Buffer.isBuffer(v)) return;
        const name = protoStr(readProto(v), 1);
        if (name && entry(String(i))) media.set(name, load(String(i)));
      });
    }
  }
  return { format, collection, media };
}
