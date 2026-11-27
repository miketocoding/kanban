// Entry point: screens (setup / unlock / board), the unlocked session, lock and auto-lock,
// and saving the encrypted board to this device.
//
// Milestone 3: no network yet. The board is saved only to this device (encrypted).
// GitHub sync arrives in Milestone 4.

import * as Board from './board.js';
import * as C from './crypto.js';
import * as Storage from './storage.js';
import { initUI, showBoard, clearBoard } from './ui.js';

const MIN_PASSPHRASE_LENGTH = 12;
const SAVE_DELAY_MS = 500;
const AUTO_LOCK_MS = autoLockMs();

// Everything secret lives here, in memory only, while unlocked.
// { key, salt, token, board, sha }. Set to null on lock.
let session = null;

const $ = (id) => document.getElementById(id);

// ---- Startup ----

function start() {
  initUI($('board'), scheduleSave);
  wireSetup();
  wireUnlock();
  wireBoardChrome();
  wireSettings();
  wireAutoLock();

  if (Storage.isSetUp()) showUnlock();
  else showSetup();
}

function showScreen(name) {
  for (const screen of ['setup', 'unlock', 'board']) {
    $(`${screen}-screen`).hidden = screen !== name;
  }
}

function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function setBusy(button, busy, busyText, idleText) {
  button.disabled = busy;
  button.textContent = busy ? busyText : idleText;
}

// Begin an unlocked session and show the board.
function startSession(newSession) {
  session = newSession;
  lastActivity = Date.now();
  showScreen('board');
  showBoard(session.board);
}

// ---- Setup screen ----

function showSetup() {
  const config = Storage.loadConfig();
  $('setup-form').reset();
  if (config) {
    $('setup-owner').value = config.owner;
    $('setup-repo').value = config.repo;
  }
  showError('setup-error', '');
  showScreen('setup');
  $('setup-owner').focus();
}

function validateSetup({ owner, repo, token, passphrase, confirm }) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return 'Enter a valid GitHub owner (user name).';
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return 'Enter a valid repo name.';
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(token)) {
    return 'That doesn\'t look like a GitHub token. A fine-grained token starts with "github_pat_".';
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  }
  if (passphrase !== confirm) return 'Passphrases don\'t match.';
  return '';
}

function wireSetup() {
  const repoLabel = () => `${$('setup-owner').value.trim()}/${$('setup-repo').value.trim()}`;
  $('setup-owner').addEventListener('input', () => { $('setup-username').value = repoLabel(); });
  $('setup-repo').addEventListener('input', () => { $('setup-username').value = repoLabel(); });

  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {
      owner: $('setup-owner').value.trim(),
      repo: $('setup-repo').value.trim(),
      token: $('setup-token').value.trim(),
      passphrase: $('setup-passphrase').value,
      confirm: $('setup-confirm').value,
    };
    const problem = validateSetup(values);
    if (problem) return showError('setup-error', problem);
    showError('setup-error', '');

    // Clear secrets out of the form right away; we have them in `values`.
    $('setup-token').value = '';
    $('setup-passphrase').value = '';
    $('setup-confirm').value = '';

    const button = $('setup-submit');
    setBusy(button, true, 'Setting up…', 'Set up');
    try {
      const newSession = await createSession(values);
      Storage.saveConfig({ owner: values.owner, repo: values.repo });
      startSession(newSession);
      await saveNow();
    } catch (err) {
      showError('setup-error', err instanceof C.WrongPassphraseError
        ? 'Wrong passphrase'
        : 'Setup failed. Please try again.');
    } finally {
      setBusy(button, false, 'Setting up…', 'Set up');
    }
  });
}

// Derive the key, open (or create) the board, and store the token encrypted.
// No network yet: if this device already has an encrypted board, its salt is reused
// and it must decrypt with this passphrase; otherwise a new board and salt are created.
// (Milestone 4 will check GitHub for an existing board first.)
async function createSession({ token, passphrase }) {
  const cached = await Storage.loadCachedFile();
  let salt;
  let key;
  let board;
  let sha = null;

  if (cached) {
    salt = C.saltFromFile(cached.file);
    key = await C.deriveKey(passphrase, salt);
    board = Board.normalizeBoard(await C.decryptJSON(key, cached.file)); // throws on wrong passphrase
    sha = cached.sha;
  } else {
    salt = C.newSalt();
    key = await C.deriveKey(passphrase, salt);
    board = Board.createBoard();
  }

  // The token gets its own random IV; the plaintext token is never stored.
  const encryptedToken = await C.encryptString(key, token);
  Storage.saveEncryptedToken({ salt: C.bytesToBase64(salt), ...encryptedToken });

  return { key, salt, token, board, sha };
}

// ---- Unlock screen ----

function showUnlock() {
  const { owner, repo } = Storage.loadConfig();
  $('unlock-repo').textContent = `Board: ${owner}/${repo}`;
  $('unlock-username').value = `${owner}/${repo}`;
  $('unlock-passphrase').value = '';
  showError('unlock-error', '');
  showScreen('unlock');
  $('unlock-passphrase').focus();
}

function wireUnlock() {
  $('unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const passphrase = $('unlock-passphrase').value;
    if (!passphrase) return showError('unlock-error', 'Enter your passphrase.');
    $('unlock-passphrase').value = ''; // don't leave it in the page
    showError('unlock-error', '');

    const button = $('unlock-submit');
    setBusy(button, true, 'Unlocking…', 'Unlock');
    try {
      startSession(await openSession(passphrase));
    } catch (err) {
      showError('unlock-error', err instanceof C.WrongPassphraseError
        ? 'Wrong passphrase'
        : 'Could not open the board on this device.');
      $('unlock-passphrase').focus();
    } finally {
      setBusy(button, false, 'Unlocking…', 'Unlock');
    }
  });

  $('unlock-reset').addEventListener('click', resetDevice);
}

// Derive the key, decrypt the token (this is where a wrong passphrase is caught),
// then decrypt the cached board.
async function openSession(passphrase) {
  const tokenRecord = Storage.loadEncryptedToken();
  const salt = C.base64ToBytes(tokenRecord.salt);
  const key = await C.deriveKey(passphrase, salt);
  const token = await C.decryptString(key, tokenRecord); // throws WrongPassphraseError

  const cached = await Storage.loadCachedFile();
  if (!cached) {
    // No board on this device yet (Milestone 4 will fetch it from GitHub here).
    return { key, salt, token, board: Board.createBoard(), sha: null };
  }
  const board = Board.normalizeBoard(await C.decryptJSON(key, cached.file));
  return { key, salt, token, board, sha: cached.sha };
}

// ---- Saving the encrypted board to this device ----

let saveTimer = null;
let saveChain = Promise.resolve(); // saves run one at a time, in order

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
}

// Encrypt the current board (with a fresh IV) and store it. Returns when written.
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!session) return saveChain;

  const { key, salt, board, sha } = session;
  saveChain = saveChain
    .then(async () => {
      const file = await C.encryptJSON(key, salt, board);
      await Storage.saveCachedFile({ file, sha });
    })
    .catch(() => {
      // Never log the error object: keep anything board-related out of the console.
      console.error('Saving the board to this device failed.');
    });
  return saveChain;
}

// ---- Lock ----

function lock() {
  if (!session) return;
  const pending = saveNow(); // finish writing the latest changes (encrypted)
  // Drop every reference to the key, token and board, then clear the page.
  // (JavaScript can't overwrite memory directly; with no references left,
  // the browser frees it.)
  session = null;
  clearBoard();
  showUnlock();
  return pending;
}

let lastActivity = Date.now();

// 15 minutes. On localhost only, ?autolock=<seconds> shortens it for testing.
function autoLockMs() {
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const seconds = isLocal ? Number(new URLSearchParams(location.search).get('autolock')) : 0;
  return seconds > 0 ? seconds * 1000 : 15 * 60 * 1000;
}

function checkIdle() {
  if (session && Date.now() - lastActivity >= AUTO_LOCK_MS) lock();
}

function wireAutoLock() {
  const markActive = () => { lastActivity = Date.now(); };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    document.addEventListener(type, markActive, { capture: true, passive: true });
  }
  // Compare timestamps instead of relying on one long timer: phones pause timers
  // in the background, so we also check the moment the app becomes visible again.
  setInterval(checkIdle, Math.min(30_000, AUTO_LOCK_MS / 3));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
    else checkIdle();
  });
  window.addEventListener('pagehide', () => saveNow());
}

// ---- Header buttons ----

function wireBoardChrome() {
  $('lock-button').addEventListener('click', lock);
  $('open-settings').addEventListener('click', openSettings);
}

// ---- Settings ----

function openSettings() {
  if (!session) return;
  const { owner, repo } = Storage.loadConfig();
  $('settings-repo').textContent = `${owner}/${repo}`;
  $('settings-token').value = '';
  $('token-message').textContent = '';
  $('settings-dialog').showModal();
}

function wireSettings() {
  const dialog = $('settings-dialog');
  $('settings-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  // Replace the token: encrypted with the current key and a new IV, like at setup.
  $('token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!session) return;
    const token = $('settings-token').value.trim();
    const message = $('token-message');
    message.classList.remove('field-error');
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(token)) {
      message.textContent = 'That doesn\'t look like a GitHub token.';
      message.classList.add('field-error');
      return;
    }
    $('settings-token').value = '';
    const encrypted = await C.encryptString(session.key, token);
    Storage.saveEncryptedToken({ salt: C.bytesToBase64(session.salt), ...encrypted });
    session.token = token;
    message.textContent = 'Token saved (encrypted).';
  });

  $('settings-reset').addEventListener('click', resetDevice);
}

// ---- Reset device ----

async function resetDevice() {
  const ok = window.confirm(
    'Reset this device?\n\n'
    + 'This removes the repo settings, the encrypted token, and the encrypted board cache '
    + 'from this device. Your GitHub data is not touched.\n\n'
    + 'Until GitHub sync is set up, the board on this device will be lost.',
  );
  if (!ok) return;

  clearTimeout(saveTimer);
  session = null;
  clearBoard();
  await saveChain; // let any in-progress write finish before deleting
  await Storage.clearDevice();
  showSetup();
}

start();
