// Device storage.
//
// What is stored on this device, and nothing else:
//   localStorage  kanban.config  { owner, repo }        not secret
//   localStorage  kanban.token   { salt, iv, ct }       the GitHub token, ENCRYPTED
//   IndexedDB     kanban/cache   { file, sha }          the board file, ENCRYPTED
//
// SECURITY: never store the passphrase, the key, the plaintext token, or the plaintext board.

const CONFIG_KEY = 'kanban.config';
const TOKEN_KEY = 'kanban.token';

const DB_NAME = 'kanban';
const DB_VERSION = 1;
const STORE = 'cache';
const BOARD_KEY = 'board';

// ---- localStorage ----

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // unreadable or corrupted: treat as missing
  }
}

export function loadConfig() {
  const config = readJSON(CONFIG_KEY);
  return config && typeof config.owner === 'string' && typeof config.repo === 'string' ? config : null;
}

export function saveConfig({ owner, repo }) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ owner, repo }));
}

export function loadEncryptedToken() {
  const record = readJSON(TOKEN_KEY);
  const valid = record && ['salt', 'iv', 'ct'].every((k) => typeof record[k] === 'string' && record[k]);
  return valid ? record : null;
}

export function saveEncryptedToken({ salt, iv, ct }) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ salt, iv, ct }));
}

// Set up = this device has both the repo settings and an encrypted token.
export function isSetUp() {
  return Boolean(loadConfig() && loadEncryptedToken());
}

// ---- IndexedDB (encrypted board cache) ----

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener('upgradeneeded', () => request.result.createObjectStore(STORE));
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });
}

// Runs one request in a transaction and resolves when the transaction has committed.
async function withStore(mode, makeRequest) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = makeRequest(tx.objectStore(STORE));
      tx.addEventListener('complete', () => resolve(request.result));
      tx.addEventListener('error', () => reject(tx.error));
      tx.addEventListener('abort', () => reject(tx.error));
    });
  } finally {
    db.close();
  }
}

// Returns { file, sha } or null. `file` is the encrypted { version, salt, iv, ct }.
export async function loadCachedFile() {
  const value = await withStore('readonly', (store) => store.get(BOARD_KEY));
  return value && value.file ? { file: value.file, sha: value.sha ?? null } : null;
}

export async function saveCachedFile({ file, sha }) {
  await withStore('readwrite', (store) => store.put({ file, sha: sha ?? null }, BOARD_KEY));
}

export async function clearCachedFile() {
  await withStore('readwrite', (store) => store.delete(BOARD_KEY));
}

// "Reset device": forget everything this device stored. Never touches GitHub.
export async function clearDevice() {
  localStorage.removeItem(CONFIG_KEY);
  localStorage.removeItem(TOKEN_KEY);
  await clearCachedFile();
}
