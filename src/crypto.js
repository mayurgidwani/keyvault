// ── crypto.js ─────────────────────────────────────────────────────────────────
// AES-GCM encryption with a key derived from the user's PIN via PBKDF2.
// Works in any modern browser and inside the Tauri webview (uses Web Crypto).

const enc = new TextEncoder();
const dec = new TextDecoder();

const PBKDF2_ITERATIONS = 250_000; // high cost slows brute-force of the PIN
const SALT_BYTES = 16;
const IV_BYTES = 12;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function newSalt() {
  return bufToB64(randomBytes(SALT_BYTES));
}

// Derive a non-extractable AES-GCM key from the PIN + salt.
export async function deriveKey(pin, saltB64) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: b64ToBuf(saltB64),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Encrypt a JS value -> { iv, data } base64 strings.
export async function encryptJSON(key, value) {
  const iv = randomBytes(IV_BYTES);
  const plaintext = enc.encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );
  return { iv: bufToB64(iv), data: bufToB64(cipher) };
}

// Decrypt { iv, data } -> JS value. Throws if the key (PIN) is wrong.
export async function decryptJSON(key, payload) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBuf(payload.iv) },
    key,
    b64ToBuf(payload.data)
  );
  return JSON.parse(dec.decode(plaintext));
}
