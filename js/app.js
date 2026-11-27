// Entry point: screens (setup / unlock / board), the unlocked session, lock and auto-lock,
// the encrypted cache on this device, and syncing the encrypted file with GitHub.
//
// Data flow:
//   edit -> board in memory -> (0.5 s) encrypted copy in IndexedDB, marked "dirty"
//                           -> (1.5 s) encrypted copy PUT to GitHub, then "dirty" cleared
//   unlock -> render the cached copy immediately -> fetch GitHub in the background
//   save conflict (another device saved first) -> fetch, decrypt, merge, re-encrypt, retry (x3)

import * as Board from './board.js';
import * as C from './crypto.js';
import * as Storage from './storage.js';
import * as Sync from './sync.js';
import { mergeBoards } from './merge.js';
import { initUI, showBoard, replaceBoard, clearBoard } from './ui.js';

const MIN_PASSPHRASE_LENGTH = 12;
const LOCAL_SAVE_DELAY_MS = 500;
const REMOTE_SAVE_DELAY_MS = 1500;
const RETRY_DELAY_MS = 60_000;
const MAX_CONFLICT_RETRIES = 3;
const AUTO_LOCK_MS = autoLockMs();
const TOKEN_PATTERN = /^(github_pat_|ghp_)[A-Za-z0-9_]+$/;

// Everything secret lives here, in memory only, while unlocked. Set to null on lock.
// {
//   key, salt, token, config,   crypto + GitHub access
//   board, sha,                 the board and the GitHub version it is based on
//   dirty,                      true = changes not yet saved to GitHub
//   changeCount,                bumps on every edit (detects edits made during a save)
//   pushing, pushAgain, pulling,
//   blocked,                    'auth' | 'repo' | 'invalid' | null: stop auto-sync until fixed
//   pastShas,                   versions we've already moved past (ignore stale GitHub reads)
// }
let session = null;

const $ = (id) => document.getElementById(id);

// ---- Startup ----

function start() {
  initUI($('board'), onBoardChange);
  wireSetup();
  wireUnlock();
  wireBoardChrome();
  wireSettings();
  wireAutoLock();
  wireConnectivity();

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

function newSession(fields) {
  return {
    dirty: false,
    changeCount: 0,
    pushing: false,
    pushAgain: false,
    pulling: false,
    blocked: null,
    pastShas: new Set(),
    ...fields,
  };
}

// Begin an unlocked session and show the board.
function startSession(s) {
  session = s;
  lastActivity = Date.now();
  showScreen('board');
  showBoard(s.board);
  setStatus(s.dirty ? 'saving' : 'saved');
}

// ---- Sync status indicator ----

const STATUS_TEXT = { saved: 'Saved', saving: 'Saving…', offline: 'Offline', error: 'Error' };

// state: 'saved' | 'saving' | 'offline' | 'error'. `message` explains offline/error.
function setStatus(state, message = '', action = null) {
  const pill = $('sync-status');
  pill.dataset.state = state;
  pill.textContent = STATUS_TEXT[state];
  pill.title = message || STATUS_TEXT[state];

  const showBanner = state === 'error' || state === 'offline';
  $('sync-banner').hidden = !showBanner;
  $('sync-banner').dataset.state = state;
  $('sync-banner-text').textContent = showBanner ? message : '';
  $('sync-banner-action').hidden = action !== 'settings';
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
  if (!TOKEN_PATTERN.test(token)) {
    return 'That doesn\'t look like a GitHub token. A fine-grained token starts with "github_pat_".';
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  }
  if (passphrase !== confirm) return 'Passphrases don\'t match.';
  return '';
}

function setupErrorMessage(err) {
  if (err instanceof C.WrongPassphraseError) return 'Wrong passphrase';
  if (err instanceof Sync.SyncError) {
    if (err.kind === 'network') return 'Can\'t reach GitHub. Setup needs a connection; check it and try again.';
    if (err.kind === 'auth') return 'Token rejected or expired. Check the token and try again.';
    if (err.kind === 'conflict') return 'The board was created on another device at the same moment. Try again.';
    return err.message;
  }
  if (err instanceof C.InvalidFileError) return 'The board file on GitHub is not in the expected format.';
  return 'Setup failed. Please try again.';
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

    const button = $('setup-submit');
    setBusy(button, true, 'Connecting to GitHub…', 'Set up');
    try {
      const s = await createSession(values);
      // Only clear the secrets once setup worked, so a typo'd repo name doesn't
      // force retyping everything.
      $('setup-token').value = '';
      $('setup-passphrase').value = '';
      $('setup-confirm').value = '';
      Storage.saveConfig(s.config);
      startSession(s);
      await writeCache(s);
    } catch (err) {
      showError('setup-error', setupErrorMessage(err));
    } finally {
      setBusy(button, false, 'Connecting to GitHub…', 'Set up');
    }
  });
}

// Setup: look for the board on GitHub.
// - Found: reuse its salt, derive the key, decrypt it (this checks the passphrase).
// - Not found: new salt, new empty board, create the file on GitHub.
// Then store the token, encrypted with the derived key.
async function createSession({ owner, repo, token, passphrase }) {
  const config = { owner, repo };
  const remote = await Sync.loadRemote(config, token);

  let salt;
  let key;
  let board;
  let sha;
  if (remote) {
    C.parseEncryptedFile(remote.file);
    salt = C.saltFromFile(remote.file);
    key = await C.deriveKey(passphrase, salt);
    board = Board.normalizeBoard(await C.decryptJSON(key, remote.file)); // throws on wrong passphrase
    sha = remote.sha;
  } else {
    salt = C.newSalt();
    key = await C.deriveKey(passphrase, salt);
    board = Board.createBoard();
    sha = await Sync.saveRemote(config, token, await C.encryptJSON(key, salt, board), null);
  }

  // The token gets its own random IV; the plaintext token is never stored.
  const encryptedToken = await C.encryptString(key, token);
  Storage.saveEncryptedToken({ salt: C.bytesToBase64(salt), ...encryptedToken });

  return newSession({ key, salt, token, config, board, sha });
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
      const { session: s, fromCache } = await openSession(passphrase);
      startSession(s);
      if (fromCache) pullRemote(); // background: pick up changes from other devices
      else writeCache(s);
    } catch (err) {
      let message = 'Could not open the board.';
      if (err instanceof C.WrongPassphraseError) message = 'Wrong passphrase';
      else if (err instanceof Sync.SyncError && err.kind === 'network') {
        message = 'No copy of the board on this device yet, and GitHub can\'t be reached. Connect and try again.';
      } else if (err instanceof Sync.SyncError) message = err.message;
      showError('unlock-error', message);
      $('unlock-passphrase').focus();
    } finally {
      setBusy(button, false, 'Unlocking…', 'Unlock');
    }
  });

  $('unlock-reset').addEventListener('click', resetDevice);
}

// Derive the key and decrypt the token (this is where a wrong passphrase is caught).
// Then open the cached board, or if there's no cache, fetch it from GitHub.
async function openSession(passphrase) {
  const config = Storage.loadConfig();
  const tokenRecord = Storage.loadEncryptedToken();
  const tokenSalt = C.base64ToBytes(tokenRecord.salt);
  const tokenKey = await C.deriveKey(passphrase, tokenSalt);
  const token = await C.decryptString(tokenKey, tokenRecord); // throws WrongPassphraseError

  // The board normally shares the token's salt; derive a second key only if it doesn't.
  const keyFor = async (file) => (file.salt === tokenRecord.salt
    ? { key: tokenKey, salt: tokenSalt }
    : { key: await C.deriveKey(passphrase, C.saltFromFile(file)), salt: C.saltFromFile(file) });

  const cached = await Storage.loadCachedFile();
  if (cached) {
    const { key, salt } = await keyFor(cached.file);
    const board = Board.normalizeBoard(await C.decryptJSON(key, cached.file));
    return {
      session: newSession({ key, salt, token, config, board, sha: cached.sha, dirty: cached.dirty }),
      fromCache: true,
    };
  }

  const remote = await Sync.loadRemote(config, token);
  if (!remote) {
    // The file was removed from GitHub. Start a new board; it will be saved there.
    return {
      session: newSession({ key: tokenKey, salt: tokenSalt, token, config, board: Board.createBoard(), sha: null, dirty: true }),
      fromCache: false,
    };
  }
  const { key, salt } = await keyFor(remote.file);
  const board = Board.normalizeBoard(await C.decryptJSON(key, remote.file));
  return { session: newSession({ key, salt, token, config, board, sha: remote.sha }), fromCache: false };
}

// ---- Saving ----

let localTimer = null;
let remoteTimer = null;
let retryTimer = null;
let cacheChain = Promise.resolve(); // cache writes run one at a time, in order
let activePush = Promise.resolve();

// Called by the UI after every edit.
function onBoardChange() {
  if (!session) return;
  session.dirty = true;
  session.changeCount++;
  if (!session.blocked) setStatus('saving');

  clearTimeout(localTimer);
  localTimer = setTimeout(() => writeCache(session), LOCAL_SAVE_DELAY_MS);
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(() => pushRemote(), REMOTE_SAVE_DELAY_MS);
}

// Encrypt the board (fresh IV) and store it on this device, with its sha and dirty flag.
function writeCache(s) {
  if (!s) return cacheChain;
  clearTimeout(localTimer);
  cacheChain = cacheChain
    .then(async () => {
      const file = await C.encryptJSON(s.key, s.salt, s.board);
      await Storage.saveCachedFile({ file, sha: s.sha, dirty: s.dirty });
    })
    .catch(() => {
      // Never log the error object: keep anything board-related out of the console.
      console.error('Saving the board to this device failed.');
    });
  return cacheChain;
}

// Encrypt the board and PUT it to GitHub, based on the sha we last saw.
// `s` defaults to the current session; lock() passes the old session to finish a save.
function pushRemote(s = session) {
  clearTimeout(remoteTimer);
  if (!s || !s.dirty || s.blocked) return activePush;
  if (s.pushing) {
    s.pushAgain = true; // another edit arrived mid-save; save again afterwards
    return activePush;
  }
  s.pushing = true;
  if (s === session) setStatus('saving');

  activePush = (async () => {
    let failed = false;
    try {
      // First attempt, plus up to MAX_CONFLICT_RETRIES merge-and-retry rounds.
      for (let attempt = 0; ; attempt++) {
        const startCount = s.changeCount;
        Board.purgeTombstones(s.board);
        const file = await C.encryptJSON(s.key, s.salt, s.board); // new IV every attempt
        try {
          const newSha = await Sync.saveRemote(s.config, s.token, file, s.sha);
          moveToSha(s, newSha);
          if (s.changeCount === startCount) s.dirty = false; // nothing new since we started
          await writeCache(s);
          break;
        } catch (err) {
          const isConflict = err instanceof Sync.SyncError && err.kind === 'conflict';
          if (!isConflict) throw err;
          if (attempt >= MAX_CONFLICT_RETRIES) {
            throw new Sync.SyncError('server', 'Couldn\'t save: the board kept changing on another device. Will retry.');
          }
          // Another device saved first: get its version, merge ours in, try again.
          // Short, growing pause: right after a save, GitHub can briefly serve the old version.
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          await mergeRemoteInto(s);
        }
      }
    } catch (err) {
      failed = true;
      handleSyncError(s, err);
    } finally {
      s.pushing = false;
    }
    if (s !== session) return; // locked meanwhile; cache already holds the result
    if (!failed && s.pushAgain) {
      s.pushAgain = false;
      pushRemote(s);
    } else if (!failed && !s.dirty) {
      setStatus('saved');
    }
  })();
  return activePush;
}

// Record that we've moved to a new GitHub version (and remember the old one as stale).
function moveToSha(s, sha) {
  if (s.sha && s.sha !== sha) s.pastShas.add(s.sha);
  s.pastShas.delete(sha);
  s.sha = sha;
}

// Decrypt a file fetched from GitHub with this session's key.
async function decryptRemote(s, remote) {
  if (remote.file.salt !== C.bytesToBase64(s.salt)) {
    throw new Sync.SyncError('invalid', 'The board on GitHub was set up with a different passphrase. Reset this device and set it up again.');
  }
  try {
    return Board.normalizeBoard(await C.decryptJSON(s.key, remote.file));
  } catch (err) {
    if (err instanceof C.WrongPassphraseError) {
      throw new Sync.SyncError('invalid', 'The board on GitHub can\'t be opened with this passphrase.');
    }
    throw err;
  }
}

// Merge GitHub's version into ours and adopt its sha, so the next save builds on it.
// The merge runs synchronously right after decrypting, against the board as it is
// at that moment, so edits made while we were fetching are included, never lost.
function adoptMerged(s, remoteBoard, sha) {
  const merged = mergeBoards(s.board, remoteBoard);
  s.board = merged;
  moveToSha(s, sha);
  if (s === session) replaceBoard(merged);
  // Did our side contribute anything GitHub doesn't have? (merge(x, x) = x's canonical form)
  return JSON.stringify(merged) !== JSON.stringify(mergeBoards(remoteBoard, remoteBoard));
}

// Used after a save conflict: fetch the latest, decrypt, merge ours in.
async function mergeRemoteInto(s) {
  const remote = await Sync.loadRemote(s.config, s.token);
  if (!remote) {
    s.sha = null; // file was deleted on GitHub: the retry recreates it
    return;
  }
  const remoteBoard = await decryptRemote(s, remote);
  adoptMerged(s, remoteBoard, remote.sha);
  writeCache(s); // still dirty: the merged board is saved on the next attempt
}

// Fetch GitHub's copy and merge in changes from other devices.
async function pullRemote() {
  const s = session;
  if (!s || s.pulling || s.pushing || s.blocked) return;
  if (s.dirty) {
    pushRemote(s); // our changes go first; a conflict there triggers the merge
    return;
  }
  s.pulling = true;
  try {
    const remote = await Sync.loadRemote(s.config, s.token);
    if (s !== session) return;
    if (!remote) {
      // File deleted on GitHub: put ours back.
      s.sha = null;
      s.dirty = true;
      pushRemote(s);
      return;
    }
    // Same version, or an older one GitHub's API served late: nothing to do.
    if (remote.sha === s.sha || s.pastShas.has(remote.sha)) {
      if (!s.dirty) setStatus('saved');
      return;
    }
    const remoteBoard = await decryptRemote(s, remote);
    if (s !== session) return;
    const weHaveMore = adoptMerged(s, remoteBoard, remote.sha);
    if (weHaveMore || s.dirty) {
      // Edits made during the fetch (or anything GitHub lacks) still need saving.
      s.dirty = true;
      writeCache(s);
      pushRemote(s);
    } else {
      writeCache(s);
      setStatus('saved');
    }
  } catch (err) {
    handleSyncError(s, err);
  } finally {
    s.pulling = false;
  }
}

function handleSyncError(s, err) {
  const kind = err instanceof Sync.SyncError ? err.kind : 'server';
  if (['auth', 'repo', 'invalid'].includes(kind)) s.blocked = kind;
  if (s !== session) return;

  if (kind === 'network') {
    setStatus('offline', 'Offline, will sync when you\'re back online. Your changes are saved on this device.');
    scheduleRetry();
  } else if (kind === 'auth') {
    setStatus('error', Sync.AUTH_MESSAGE, 'settings');
  } else if (kind === 'repo') {
    setStatus('error', `${err.message} Check it in settings.`, 'settings');
  } else if (kind === 'invalid') {
    setStatus('error', err.message);
  } else {
    if (!(err instanceof Sync.SyncError)) {
      // An unexpected bug, not a GitHub/network problem. Log its type and message for
      // debugging; these describe code, never board contents, tokens or keys.
      console.error(`Sync failed unexpectedly: ${err?.name}: ${err?.message}`);
    }
    setStatus('error', err instanceof Sync.SyncError ? err.message : 'Sync failed. Will retry in a minute.');
    scheduleRetry();
  }
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => pullRemote(), RETRY_DELAY_MS);
}

function wireConnectivity() {
  window.addEventListener('online', () => pullRemote());
}

// ---- Lock ----

function lock() {
  const s = session;
  if (!s) return;
  clearTimeout(localTimer);
  clearTimeout(remoteTimer);
  clearTimeout(retryTimer);
  // Drop every reference to the key, token and board, then clear the page.
  // (JavaScript can't overwrite memory directly; with no references left, the browser frees it.)
  session = null;
  clearBoard();
  showUnlock();
  // Finish saving in the background: encrypted to this device, and to GitHub if there
  // are unsaved changes. If that fails, the "dirty" cache is pushed at the next unlock.
  writeCache(s);
  pushRemote(s);
}

let lastActivity = Date.now();

// 4 hours of inactivity. On localhost only, ?autolock=<seconds> shortens it for testing.
function autoLockMs() {
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const seconds = isLocal ? Number(new URLSearchParams(location.search).get('autolock')) : 0;
  return seconds > 0 ? seconds * 1000 : 4 * 60 * 60 * 1000;
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
    if (document.visibilityState === 'hidden') {
      writeCache(session);
      pushRemote();
    } else {
      checkIdle();
      pullRemote(); // coming back to the app: pick up changes from other devices
    }
  });
  window.addEventListener('pagehide', () => {
    writeCache(session);
    pushRemote();
  });
}

// ---- Header buttons ----

function wireBoardChrome() {
  $('lock-button').addEventListener('click', lock);
  $('open-settings').addEventListener('click', openSettings);
  $('sync-banner-action').addEventListener('click', openSettings);
}

// ---- Settings ----

function openSettings() {
  if (!session) return;
  const { owner, repo } = session.config;
  $('settings-repo').textContent = `${owner}/${repo}`;
  $('settings-token').value = '';
  $('token-message').textContent = '';
  $('token-message').classList.remove('field-error');
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
    const s = session;
    if (!s) return;
    const token = $('settings-token').value.trim();
    const message = $('token-message');
    message.classList.remove('field-error');
    if (!TOKEN_PATTERN.test(token)) {
      message.textContent = 'That doesn\'t look like a GitHub token.';
      message.classList.add('field-error');
      return;
    }
    $('settings-token').value = '';
    const encrypted = await C.encryptString(s.key, token);
    Storage.saveEncryptedToken({ salt: C.bytesToBase64(s.salt), ...encrypted });
    s.token = token;
    message.textContent = 'Token saved (encrypted).';

    // Try syncing again with the new token.
    if (s.blocked === 'auth' || s.blocked === 'repo') s.blocked = null;
    if (s.dirty) pushRemote(s);
    else pullRemote();
  });

  $('settings-reset').addEventListener('click', resetDevice);
}

// ---- Reset device ----

async function resetDevice() {
  const ok = window.confirm(
    'Reset this device?\n\n'
    + 'This removes the repo settings, the encrypted token, and the encrypted board cache '
    + 'from this device. Your board on GitHub is not touched.\n\n'
    + 'Any changes not yet saved to GitHub will be lost.',
  );
  if (!ok) return;

  clearTimeout(localTimer);
  clearTimeout(remoteTimer);
  clearTimeout(retryTimer);
  session = null;
  clearBoard();
  // Let in-progress saves finish before deleting, so nothing is written back afterwards.
  await activePush;
  await cacheChain;
  await Storage.clearDevice();
  showSetup();
}

start();
