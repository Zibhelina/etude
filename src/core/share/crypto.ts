// Sharing's keys (docs/sharing.md): each signed-in device has its own ECDH P-256 identity, made and kept on it; each
// shared space has a random 32-byte key per epoch, wrapped for every member device with its public key (ECIES). Content under a space key uses Sync's own event and
// blob encryption (syncKeys, encryptEvent, encryptBlob). WebCrypto only, so it runs in Node, browsers and workers.
import { decryptEvent, encryptEvent, fromB64, hkdf, randomBytes, toB64, type SyncKeys } from "../sync/crypto.ts";

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;
const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

async function aes(raw: Uint8Array, usage: "encrypt" | "decrypt") {
  return subtle.importKey("raw", buf(raw), { name: "AES-GCM" }, false, [usage]);
}
async function seal(raw: Uint8Array, plaintext: Uint8Array, aad: string) {
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(enc.encode(aad)) }, await aes(raw, "encrypt"), buf(plaintext)));
  return { nonce: toB64(nonce), ct: toB64(ct) };
}
async function open(raw: Uint8Array, nonce: string, ct: string, aad: string) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64(nonce)), additionalData: buf(enc.encode(aad)) }, await aes(raw, "decrypt"), buf(fromB64(ct))));
  } catch {
    throw new Error("decryption failed: wrong key, or the data was changed");
  }
}

// ── identity ───────────────────────────────────────────────────
/** A device's keypair: SPKI public key and PKCS8 private key, both base64. The private key never leaves the device. */
export type Identity = { publicKey: string; privateKey: string };

export async function generateIdentity(): Promise<Identity> {
  const pair = (await subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    publicKey: toB64(new Uint8Array(await subtle.exportKey("spki", pair.publicKey))),
    privateKey: toB64(new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey))),
  };
}

// ── space keys ─────────────────────────────────────────────────
export const newSpaceKey = () => randomBytes(32);
const spaceInfo = (spaceId: string, epoch: number, deviceId: string) => `etude-space-key-v2:${spaceId}:${epoch}:${deviceId}`;

/** A space key for one device: an ephemeral ECDH key with its key, HKDF, AES-256-GCM. The info string binds space, epoch and device. */
export async function wrapSpaceKey(key: Uint8Array, devicePublicKey: string, spaceId: string, epoch: number, deviceId: string): Promise<string> {
  const member = await subtle.importKey("spki", buf(fromB64(devicePublicKey)), ECDH, false, []);
  const eph = (await subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: member }, eph.privateKey, 256));
  const info = spaceInfo(spaceId, epoch, deviceId);
  const kek = await hkdf(shared, new Uint8Array(await subtle.exportKey("raw", eph.publicKey)), info);
  const sealed = await seal(kek, key, info);
  return JSON.stringify({ v: 1, eph: toB64(new Uint8Array(await subtle.exportKey("spki", eph.publicKey))), ...sealed });
}

export async function unwrapSpaceKey(wrapped: string, privateKey: string, spaceId: string, epoch: number, deviceId: string): Promise<Uint8Array> {
  let w: any;
  try {
    w = JSON.parse(wrapped);
  } catch {
    throw new Error("unsupported space key wrap");
  }
  if (w?.v !== 1 || typeof w.eph !== "string") throw new Error("unsupported space key wrap");
  const eph = await subtle.importKey("spki", buf(fromB64(w.eph)), ECDH, true, []);
  const mine = await subtle.importKey("pkcs8", buf(fromB64(privateKey)), ECDH, false, ["deriveBits"]);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: eph }, mine, 256));
  const info = spaceInfo(spaceId, epoch, deviceId);
  const key = await open(await hkdf(shared, new Uint8Array(await subtle.exportKey("raw", eph)), info), w.nonce, w.ct, info);
  if (key.length !== 32) throw new Error("bad space key length");
  return key;
}

// ── meta ───────────────────────────────────────────────────────
/** What the server keeps about a space besides ciphertext: nothing readable. The name and root note id are inside. */
export type SpaceMeta = { name: string; root: string };
export const encryptMeta = (keys: SyncKeys, spaceId: string, meta: SpaceMeta) => encryptEvent(keys, "meta:" + spaceId, meta);
export async function decryptMeta(keys: SyncKeys, spaceId: string, ct: string): Promise<SpaceMeta> {
  const m = await decryptEvent<SpaceMeta>(keys, "meta:" + spaceId, ct);
  if (typeof m?.root !== "string" || typeof m.name !== "string") throw new Error("this space's meta isn't readable");
  return m;
}
