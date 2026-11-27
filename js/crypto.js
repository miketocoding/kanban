// Encryption for the board and the GitHub token.
//
// Uses only the browser's built-in Web Crypto API (crypto.subtle). No custom crypto.
//
// How it fits together:
//   passphrase + salt --PBKDF2 (600,000 rounds)--> AES-GCM key (kept in memory only)
//   key + fresh random IV + plaintext --AES-GCM--> ciphertext
//
// - The SALT is random, created once per board, and stored next to the ciphertext.
//   It isn't secret. It makes each board's key unique, so precomputed password-guess
//   tables are useless.
// - The 600,000 rounds make each passphrase guess slow (~0.5 s), which barely affects
//   you but makes brute-forcing very expensive.
// - The IV ("initialisation vector") is 12 random bytes, NEW FOR EVERY ENCRYPTION.
//   Reusing an IV with the same key breaks AES-GCM's security, so it is never reused.
// - AES-GCM also detects tampering: if the ciphertext, IV, or key is wrong, decryption
//   throws instead of returning garbage. That's how a wrong passphrase is detected.
//
// SECURITY: never log passphrases, keys, tokens, or decrypted data.

export const FORMAT_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Thrown for any failed decryption. The message is deliberately vague: a wrong
// passphrase and tampered data look identical, and we don't reveal which.
export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase');
    this.name = 'WrongPassphraseError';
  }
}

// Thrown when an encrypted file isn't in the expected shape (not a passphrase problem).
export class InvalidFileError extends Error {
  constructor(reason) {
    super(`Invalid encrypted file: ${reason}`);
    this.name = 'InvalidFileError';
  }
}

// ---- Random bytes ----

// Cryptographically secure randomness (never Math.random for this).
export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function newSalt() {
  return randomBytes(SALT_BYTES);
}

// ---- Base64 ----

// Converts in chunks: spreading a multi-MB array into String.fromCharCode
// would exceed the engine's argument limit and crash.
const CHUNK = 0x8000;

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Whitespace is stripped first: GitHub returns base64 with line breaks.
export function base64ToBytes(base64) {
  const binary = atob(String(base64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- Key derivation ----

// Turns the passphrase into an AES-GCM key. The key is non-extractable: the browser
// will use it to encrypt/decrypt but refuses to ever hand back its raw bytes.
export async function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('Passphrase is required');
  }
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES) {
    throw new Error(`Salt must be ${SALT_BYTES} bytes`);
  }
  // NFC normalisation: the same visible text (e.g. "é") can be typed as different
  // byte sequences on different keyboards. Normalising keeps phone and laptop in agreement.
  const passphraseBytes = encoder.encode(passphrase.normalize('NFC'));

  const baseKey = await crypto.subtle.importKey('raw', passphraseBytes, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // extractable: false
    ['encrypt', 'decrypt'],
  );
}

// ---- Encrypt / decrypt a string ----

// Returns { iv, ct } as base64. Used directly for the GitHub token.
export async function encryptString(key, plaintext) {
  const iv = randomBytes(IV_BYTES); // fresh every time; never reused
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ciphertext)) };
}

export async function decryptString(key, { iv, ct }) {
  let ivBytes;
  let ctBytes;
  try {
    ivBytes = base64ToBytes(iv);
    ctBytes = base64ToBytes(ct);
  } catch {
    throw new InvalidFileError('not valid base64');
  }
  if (ivBytes.length !== IV_BYTES) throw new InvalidFileError('wrong IV length');

  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ctBytes);
    return decoder.decode(plaintext);
  } catch {
    // AES-GCM's integrity check failed: wrong key, or the data was altered.
    throw new WrongPassphraseError();
  }
}

// ---- The board file: { version, salt, iv, ct } ----

// Encrypts any JSON value into the file format stored in the private repo.
export async function encryptJSON(key, salt, value) {
  const { iv, ct } = await encryptString(key, JSON.stringify(value));
  return { version: FORMAT_VERSION, salt: bytesToBase64(salt), iv, ct };
}

export async function decryptJSON(key, file) {
  const checked = parseEncryptedFile(file);
  const text = await decryptString(key, checked);
  return JSON.parse(text);
}

// Checks the file's shape before we try to use it. Returns it unchanged if valid.
export function parseEncryptedFile(file) {
  if (!file || typeof file !== 'object') throw new InvalidFileError('not an object');
  if (file.version !== FORMAT_VERSION) throw new InvalidFileError(`unsupported version ${file.version}`);
  for (const field of ['salt', 'iv', 'ct']) {
    if (typeof file[field] !== 'string' || !file[field]) throw new InvalidFileError(`missing ${field}`);
  }
  if (saltFromFile(file).length !== SALT_BYTES) throw new InvalidFileError('wrong salt length');
  return file;
}

// The salt stored in a file, as bytes (needed to re-derive the key on another device).
export function saltFromFile(file) {
  try {
    return base64ToBytes(file.salt);
  } catch {
    throw new InvalidFileError('salt is not valid base64');
  }
}
