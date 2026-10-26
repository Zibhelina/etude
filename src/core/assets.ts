// Type assets: files a card type ships once (meshes, data, images) and its cards fetch at runtime.
// In JSON they travel as `{ "<name>": "<base64>" }`; in a type directory they are files in `assets/`.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { mediaType } from "./media.ts";

export const ASSET_NAME = /^[\w.-]{1,80}$/;
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_TYPE_ASSET_BYTES = 40 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** What `etude type show`, `GET /api/types` and the editor see: never the bytes. */
export interface AssetInfo {
  name: string;
  size: number;
  hash: string;
}

export const hashBytes = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Bytes a base64 string decodes to, without decoding it. */
function decodedSize(b64: string) {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

const mib = (n: number) => `${n / 1024 / 1024} MiB`;

/** Problems with a type's `assets` (empty when fine). `undefined` is fine: it means "keep what's stored". */
export function validateAssets(assets: unknown): string[] {
  if (assets === undefined) return [];
  if (!assets || typeof assets !== "object" || Array.isArray(assets)) return ['assets must be an object of { "name": "base64" }'];
  const errors: string[] = [];
  let total = 0;
  for (const [name, value] of Object.entries(assets)) {
    if (!ASSET_NAME.test(name) || name === "." || name === "..") {
      errors.push(`asset name "${name}" must be 1 to 80 letters, digits, '_', '-' or '.'`);
      continue;
    }
    if (typeof value !== "string" || value.length % 4 !== 0 || !BASE64.test(value)) {
      errors.push(`asset "${name}" must be base64 text`);
      continue;
    }
    const size = decodedSize(value);
    if (size > MAX_ASSET_BYTES) errors.push(`asset "${name}" is ${(size / 1024 / 1024).toFixed(1)} MiB; one asset can be at most ${mib(MAX_ASSET_BYTES)}`);
    total += size;
  }
  if (total > MAX_TYPE_ASSET_BYTES) errors.push(`assets total ${(total / 1024 / 1024).toFixed(1)} MiB; a type's assets can be at most ${mib(MAX_TYPE_ASSET_BYTES)} together`);
  return errors;
}

export function decodeAssets(assets: Record<string, string>): Map<string, Buffer> {
  return new Map(Object.entries(assets).map(([name, b64]) => [name, Buffer.from(b64, "base64")]));
}

/** The files in `<typedir>/assets/` as base64, or undefined when the folder doesn't exist. */
export function readAssetDir(typeDir: string): Record<string, string> | undefined {
  const dir = join(typeDir, "assets");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    out[f] = readFileSync(p).toString("base64");
  }
  return out;
}

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".bin": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".xml": "application/xml",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export function assetMime(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? mediaType(name)?.mime ?? "application/octet-stream";
}
