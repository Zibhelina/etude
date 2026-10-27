// Reference implementation of Etude Sync's client-side encryption (docs/crypto.md).
// WebCrypto only (works in browsers, workers and Node), plus hash-wasm for Argon2id.
// The server never runs this code and never sees any key it handles.
import { argon2id } from "hash-wasm";

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export const VERSION = 1;
export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;

/** Default Argon2id cost for the Sync password. Stored with each wrap, so it can be raised later without breaking old wraps. */
export const DEFAULT_ARGON2 = { m: 64 * 1024, t: 3, p: 1 } as const; // 64 MiB, 3 passes, 1 lane

export type Argon2Params = { m: number; t: number; p: number };

export interface Wrap {
  v: 1;
  alg: "A256GCM";
  kdf: { name: "argon2id"; m: number; t: number; p: number; salt: string } | { name: "hkdf-sha256"; salt: string };
  nonce: string;
  ct: string;
}

/** The JSON stored at /v1/vault/keys. Opaque to the server. */
export interface VaultKeys {
  v: 1;
  password?: Wrap;
  recovery?: Wrap;
  passkeys?: Record<string, Wrap>;
}

// ── encoding ───────────────────────────────────────────────────
export const toB64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
export const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** WebCrypto's BufferSource wants a plain ArrayBuffer-backed view. */
const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const h = new Uint8Array(await subtle.digest("SHA-256", buf(data)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── primitives ─────────────────────────────────────────────────
async function aesKey(raw: Uint8Array, usages: ("encrypt" | "decrypt")[]) {
  if (raw.length !== KEY_BYTES) throw new Error("keys are 32 bytes");
  return subtle.importKey("raw", buf(raw), { name: "AES-GCM" }, false, usages);
}

async function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Promise<{ nonce: Uint8Array; ct: Uint8Array }> {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(enc.encode(aad)) }, await aesKey(key, ["encrypt"]), buf(plaintext)));
  return { nonce, ct };
}

async function open(key: Uint8Array, nonce: Uint8Array, ct: Uint8Array, aad: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(enc.encode(aad)) }, await aesKey(key, ["decrypt"]), buf(ct)));
  } catch {
    throw new Error("decryption failed: wrong key, or the data was changed");
  }
}

/** HKDF-SHA256 → 32 bytes. */
export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(enc.encode(info)) }, k, KEY_BYTES * 8));
}

export async function argon2Key(password: string, salt: Uint8Array, p: Argon2Params): Promise<Uint8Array> {
  return argon2id({ password: password.normalize("NFKC"), salt, iterations: p.t, memorySize: p.m, parallelism: p.p, hashLength: KEY_BYTES, outputType: "binary" });
}

// ── the vault key ──────────────────────────────────────────────
/** A new vault key: 256 random bits, made once per vault on the first device. */
export const generateVaultKey = () => randomBytes(KEY_BYTES);

const wrapAad = (slot: string) => `etude-vk-wrap:v1:${slot}`;

async function wrapWith(kek: Uint8Array, vk: Uint8Array, slot: string, kdf: Wrap["kdf"]): Promise<Wrap> {
  const { nonce, ct } = await seal(kek, vk, wrapAad(slot));
  return { v: 1, alg: "A256GCM", kdf, nonce: toB64(nonce), ct: toB64(ct) };
}
async function unwrapWith(kek: Uint8Array, w: Wrap, slot: string): Promise<Uint8Array> {
  if (w.v !== 1 || w.alg !== "A256GCM") throw new Error("unsupported wrap version");
  const vk = await open(kek, fromB64(w.nonce), fromB64(w.ct), wrapAad(slot));
  if (vk.length !== KEY_BYTES) throw new Error("bad vault key length");
  return vk;
}

/** Wraps the vault key under the Sync password (Argon2id → AES-256-GCM). */
export async function wrapWithPassword(vk: Uint8Array, password: string, params: Argon2Params = DEFAULT_ARGON2): Promise<Wrap> {
  const salt = randomBytes(16);
  return wrapWith(await argon2Key(password, salt, params), vk, "password", { name: "argon2id", ...params, salt: toB64(salt) });
}
export async function unwrapWithPassword(w: Wrap, password: string): Promise<Uint8Array> {
  if (w.kdf.name !== "argon2id") throw new Error("not a password wrap");
  return unwrapWith(await argon2Key(password, fromB64(w.kdf.salt), w.kdf), w, "password");
}

// ── recovery key ───────────────────────────────────────────────
// 30 random bytes (240 bits) + a 5-byte SHA-256 checksum = 35 bytes = 56 Crockford base32 characters,
// shown as 14 groups of 4: "7K2M-9QX4-…". High entropy, so it's stretched with HKDF, not Argon2.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_ENTROPY = 30;
const RECOVERY_CHECK = 5;

function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const i = CROCKFORD.indexOf(ch);
    if (i < 0) throw new Error(`"${ch}" isn't a recovery-key character`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function generateRecoveryKey(): Promise<string> {
  const entropy = randomBytes(RECOVERY_ENTROPY);
  const check = new Uint8Array(await subtle.digest("SHA-256", buf(entropy))).slice(0, RECOVERY_CHECK);
  return base32(concat(entropy, check)).match(/.{4}/g)!.join("-");
}

/** Parses a typed recovery key (case, dashes and O/0, I/L/1 confusion forgiven) and checks its checksum. */
export async function parseRecoveryKey(s: string): Promise<Uint8Array> {
  const bytes = unbase32(s);
  if (bytes.length !== RECOVERY_ENTROPY + RECOVERY_CHECK) throw new Error("a recovery key has 56 characters");
  const entropy = bytes.slice(0, RECOVERY_ENTROPY);
  const check = new Uint8Array(await subtle.digest("SHA-256", buf(entropy))).slice(0, RECOVERY_CHECK);
  if (check.some((b, i) => b !== bytes[RECOVERY_ENTROPY + i])) throw new Error("this recovery key has a typo (checksum doesn't match)");
  return entropy;
}

export async function wrapWithRecovery(vk: Uint8Array, recoveryKey: string): Promise<Wrap> {
  const salt = randomBytes(16);
  return wrapWith(await hkdf(await parseRecoveryKey(recoveryKey), salt, "etude-recovery-wrap-v1"), vk, "recovery", { name: "hkdf-sha256", salt: toB64(salt) });
}
export async function unwrapWithRecovery(w: Wrap, recoveryKey: string): Promise<Uint8Array> {
  if (w.kdf.name !== "hkdf-sha256") throw new Error("not a recovery wrap");
  return unwrapWith(await hkdf(await parseRecoveryKey(recoveryKey), fromB64(w.kdf.salt), "etude-recovery-wrap-v1"), w, "recovery");
}

// ── passkey PRF ────────────────────────────────────────────────
/** The fixed PRF input every Etude client sends (`extensions.prf.eval.first`), so the same passkey always yields the same secret. */
export const PRF_SALT = enc.encode("etude-vault-prf-v1");

/** Wraps the vault key with a passkey's PRF output (`getClientExtensionResults().prf.results.first`). */
export async function wrapWithPrf(vk: Uint8Array, prfOutput: Uint8Array, credentialId: string): Promise<Wrap> {
  const salt = randomBytes(16);
  return wrapWith(await hkdf(prfOutput, salt, `etude-prf-wrap-v1:${credentialId}`), vk, `passkey:${credentialId}`, { name: "hkdf-sha256", salt: toB64(salt) });
}
export async function unwrapWithPrf(w: Wrap, prfOutput: Uint8Array, credentialId: string): Promise<Uint8Array> {
  if (w.kdf.name !== "hkdf-sha256") throw new Error("not a PRF wrap");
  return unwrapWith(await hkdf(prfOutput, fromB64(w.kdf.salt), `etude-prf-wrap-v1:${credentialId}`), w, `passkey:${credentialId}`);
}

// ── events and blobs ───────────────────────────────────────────
// Subkeys come from the vault key with HKDF, so the vault key itself never encrypts data.
// Ciphertext layout: [1 byte version][12 bytes nonce][AES-256-GCM ciphertext + 16-byte tag].
const subkey = (vk: Uint8Array, purpose: "events" | "blobs") => hkdf(vk, enc.encode("etude-sync"), `etude-${purpose}-v1`);
const eventAad = (id: string) => `etude-event:v1:${id}`;
const BLOB_AAD = "etude-blob:v1";

function pack(nonce: Uint8Array, ct: Uint8Array) {
  return concat(Uint8Array.of(VERSION), nonce, ct);
}
function unpack(b: Uint8Array) {
  if (b.length < 1 + NONCE_BYTES + 16 || b[0] !== VERSION) throw new Error("not an Etude Sync ciphertext (or an unknown version)");
  return { nonce: b.slice(1, 1 + NONCE_BYTES), ct: b.slice(1 + NONCE_BYTES) };
}

/** Encrypts one sync event. The id goes in the AAD, so the server can't move a ciphertext under another id. */
export async function encryptEvent(vk: Uint8Array, id: string, event: unknown): Promise<string> {
  const { nonce, ct } = await seal(await subkey(vk, "events"), enc.encode(JSON.stringify(event)), eventAad(id));
  return toB64(pack(nonce, ct));
}
export async function decryptEvent<T = unknown>(vk: Uint8Array, id: string, ciphertextB64: string): Promise<T> {
  const { nonce, ct } = unpack(fromB64(ciphertextB64));
  return JSON.parse(new TextDecoder().decode(await open(await subkey(vk, "events"), nonce, ct, eventAad(id))));
}

/** Encrypts a media file or type asset; upload it under the SHA-256 of what this returns. */
export async function encryptBlob(vk: Uint8Array, data: Uint8Array): Promise<{ hash: string; ciphertext: Uint8Array }> {
  const { nonce, ct } = await seal(await subkey(vk, "blobs"), data, BLOB_AAD);
  const ciphertext = pack(nonce, ct);
  return { hash: await sha256Hex(ciphertext), ciphertext };
}
export async function decryptBlob(vk: Uint8Array, ciphertext: Uint8Array, expectedHash?: string): Promise<Uint8Array> {
  if (expectedHash && (await sha256Hex(ciphertext)) !== expectedHash) throw new Error("blob hash mismatch");
  const { nonce, ct } = unpack(ciphertext);
  return open(await subkey(vk, "blobs"), nonce, ct, BLOB_AAD);
}

// ── whole flows ────────────────────────────────────────────────
/** First device: makes the vault key, the recovery key and the wraps to upload. Show `recoveryKey` once. */
export async function createVault(password: string, params: Argon2Params = DEFAULT_ARGON2): Promise<{ vk: Uint8Array; recoveryKey: string; keys: VaultKeys }> {
  const vk = generateVaultKey();
  const recoveryKey = await generateRecoveryKey();
  return { vk, recoveryKey, keys: { v: 1, password: await wrapWithPassword(vk, password, params), recovery: await wrapWithRecovery(vk, recoveryKey), passkeys: {} } };
}

/** Changing the Sync password re-wraps the same vault key; nothing else is re-encrypted. */
export async function changePassword(keys: VaultKeys, vk: Uint8Array, newPassword: string, params: Argon2Params = DEFAULT_ARGON2): Promise<VaultKeys> {
  return { ...keys, password: await wrapWithPassword(vk, newPassword, params) };
}
