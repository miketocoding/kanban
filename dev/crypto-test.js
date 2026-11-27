// Dev-only checks for js/crypto.js. Fake passphrases and sample data only.
// Results are shown on the page; nothing secret is logged.

import * as C from '../js/crypto.js';
import * as Board from '../js/board.js';

const PASS_A = 'correct horse battery staple (test only)';
const PASS_B = 'a different test passphrase';

const $ = (id) => document.getElementById(id);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectReject(promise, ErrorClass, message) {
  try {
    await promise;
  } catch (err) {
    assert(err instanceof ErrorClass, `${message}: threw ${err.name}, expected ${ErrorClass.name}`);
    return err;
  }
  throw new Error(`${message}: did not throw`);
}

function sampleBoard(extraCards = 0) {
  const board = Board.createBoard();
  const [todo, doing] = Board.visibleColumns(board);
  Board.addCard(board, todo.id, {
    title: 'Sample: unicode ✓ émoji 🎉 日本語',
    notes: 'Line one\nLine two',
    checklist: [{ text: 'task', done: true }],
  });
  Board.addCard(board, doing.id, { title: 'Sample: <script>not code</script>' });
  for (let i = 0; i < extraCards; i++) {
    Board.addCard(board, todo.id, { title: `Bulk card ${i}`, notes: 'x'.repeat(1000) });
  }
  return board;
}

function sameBytes(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function kb(n) {
  return `${(n / 1024).toFixed(0)} KB`;
}

// ---- Tests (run in order; later tests reuse the key from the first) ----

const shared = {};

const tests = [
  ['Base64 round-trip (small, including empty)', async () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array([0, 1, 254, 255]), C.randomBytes(1000)]) {
      assert(sameBytes(C.base64ToBytes(C.bytesToBase64(bytes)), bytes), `mismatch at length ${bytes.length}`);
    }
  }],

  ['Base64 round-trip of 5 MB (chunked, no crash)', async () => {
    const big = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 65536) big.set(C.randomBytes(65536), i);
    const b64 = C.bytesToBase64(big);
    assert(sameBytes(C.base64ToBytes(b64), big), 'mismatch');
    return `${kb(b64.length)} of base64`;
  }],

  ['Base64 decode ignores line breaks (as GitHub returns it)', async () => {
    const bytes = C.randomBytes(300);
    const wrapped = C.bytesToBase64(bytes).replace(/(.{60})/g, '$1\n');
    assert(wrapped.includes('\n'), 'test setup: no line breaks added');
    assert(sameBytes(C.base64ToBytes(wrapped), bytes), 'mismatch');
  }],

  ['Derive key (PBKDF2, 600,000 rounds)', async () => {
    shared.salt = C.newSalt();
    assert(shared.salt.length === 16, 'salt is not 16 bytes');
    const start = performance.now();
    shared.key = await C.deriveKey(PASS_A, shared.salt);
    const ms = performance.now() - start;
    assert(shared.key.algorithm.name === 'AES-GCM' && shared.key.algorithm.length === 256, 'not AES-GCM 256');
    return `took ${ms.toFixed(0)} ms (slow on purpose)`;
  }],

  ['Key is non-extractable (browser refuses to export it)', async () => {
    assert(shared.key.extractable === false, 'key.extractable is true');
    await expectReject(crypto.subtle.exportKey('raw', shared.key), DOMException, 'exportKey');
  }],

  ['Encrypt → decrypt a board gives the same board back', async () => {
    const board = sampleBoard();
    const file = await C.encryptJSON(shared.key, shared.salt, board);
    shared.file = file;
    const back = await C.decryptJSON(shared.key, file);
    assert(JSON.stringify(back) === JSON.stringify(board), 'decrypted board differs');
  }],

  ['File format is { version: 1, salt (16 B), iv (12 B), ct }', async () => {
    const f = shared.file;
    assert(JSON.stringify(Object.keys(f).sort()) === '["ct","iv","salt","version"]', `keys: ${Object.keys(f)}`);
    assert(f.version === 1, 'version');
    assert(C.base64ToBytes(f.salt).length === 16, 'salt length');
    assert(C.base64ToBytes(f.iv).length === 12, 'iv length');
    assert(!f.ct.includes('Sample'), 'ciphertext contains plaintext!');
  }],

  ['Encrypting the same board twice gives a new IV and different ciphertext', async () => {
    const board = sampleBoard();
    const a = await C.encryptJSON(shared.key, shared.salt, board);
    const b = await C.encryptJSON(shared.key, shared.salt, board);
    assert(a.iv !== b.iv, 'IV was reused!');
    assert(a.ct !== b.ct, 'ciphertext identical');
    assert(a.salt === b.salt, 'salt should stay the same');
  }],

  ['Wrong passphrase fails with exactly "Wrong passphrase"', async () => {
    const wrongKey = await C.deriveKey(PASS_B, shared.salt);
    const err = await expectReject(C.decryptJSON(wrongKey, shared.file), C.WrongPassphraseError, 'decrypt');
    assert(err.message === 'Wrong passphrase', `message was "${err.message}"`);
  }],

  ['Another device: same passphrase + the file\'s salt decrypts it', async () => {
    const salt = C.saltFromFile(shared.file); // what a second device would do
    const key = await C.deriveKey(PASS_A, salt);
    const board = await C.decryptJSON(key, shared.file);
    assert(Array.isArray(board.cards) && board.cards.length === 2, 'unexpected board');
  }],

  ['Same passphrase with a different salt cannot decrypt', async () => {
    const key = await C.deriveKey(PASS_A, C.newSalt());
    await expectReject(C.decryptJSON(key, shared.file), C.WrongPassphraseError, 'decrypt');
  }],

  ['Tampered ciphertext is rejected', async () => {
    const bytes = C.base64ToBytes(shared.file.ct);
    bytes[10] ^= 0x01; // flip one bit
    const tampered = { ...shared.file, ct: C.bytesToBase64(bytes) };
    await expectReject(C.decryptJSON(shared.key, tampered), C.WrongPassphraseError, 'decrypt');
  }],

  ['Tampered IV is rejected', async () => {
    const bytes = C.base64ToBytes(shared.file.iv);
    bytes[0] ^= 0x01;
    const tampered = { ...shared.file, iv: C.bytesToBase64(bytes) };
    await expectReject(C.decryptJSON(shared.key, tampered), C.WrongPassphraseError, 'decrypt');
  }],

  ['Malformed files are reported as invalid (not as wrong passphrase)', async () => {
    const bad = [
      null,
      { ...shared.file, version: 2 },
      { ...shared.file, ct: '' },
      { ...shared.file, salt: C.bytesToBase64(C.randomBytes(8)) },
      { ...shared.file, iv: C.bytesToBase64(C.randomBytes(8)) },
    ];
    for (const file of bad) {
      await expectReject(C.decryptJSON(shared.key, file), C.InvalidFileError, JSON.stringify(file)?.slice(0, 40));
    }
  }],

  ['Token-style string encryption (own IV each time)', async () => {
    const fakeToken = 'github_pat_FAKE_TEST_VALUE_0000000000';
    const a = await C.encryptString(shared.key, fakeToken);
    const b = await C.encryptString(shared.key, fakeToken);
    assert(a.iv !== b.iv, 'IV reused');
    assert(await C.decryptString(shared.key, a) === fakeToken, 'round-trip failed');
  }],

  ['Unicode passphrase typed two ways (é vs e + accent) gives the same key', async () => {
    const composed = 'caf\u00e9 test'; // é as one character
    const decomposed = 'cafe\u0301 test'; // e + combining accent
    assert(composed !== decomposed, 'test setup: strings should differ');
    const salt = C.newSalt();
    const keyA = await C.deriveKey(composed, salt);
    const keyB = await C.deriveKey(decomposed, salt);
    const enc = await C.encryptString(keyA, 'hello');
    assert(await C.decryptString(keyB, enc) === 'hello', 'keys differ');
  }],

  ['Empty passphrase is refused', async () => {
    await expectReject(C.deriveKey('', shared.salt), Error, 'deriveKey');
  }],

  ['Large board (~3 MB) round-trips', async () => {
    const board = sampleBoard(3000);
    const start = performance.now();
    const file = await C.encryptJSON(shared.key, shared.salt, board);
    const back = await C.decryptJSON(shared.key, file);
    const ms = performance.now() - start;
    assert(back.cards.length === board.cards.length, 'card count differs');
    assert(JSON.stringify(back) === JSON.stringify(board), 'content differs');
    return `${kb(JSON.stringify(file).length)} file, encrypt + decrypt ${ms.toFixed(0)} ms`;
  }],
];

// ---- Runner ----

async function run() {
  $('rerun').disabled = true;
  $('results').replaceChildren();
  $('summary').dataset.status = 'running';
  $('summary').textContent = 'Running…';
  let passed = 0;

  for (const [name, fn] of tests) {
    const status = document.createElement('span');
    status.className = 'status status-run';
    status.textContent = '…';
    const detail = document.createElement('span');
    detail.className = 'detail';
    const li = document.createElement('li');
    li.append(status, document.createTextNode(name), detail);
    $('results').append(li);

    try {
      const info = await fn();
      status.className = 'status status-pass';
      status.textContent = 'PASS';
      if (info) detail.textContent = info;
      passed++;
    } catch (err) {
      status.className = 'status status-fail';
      status.textContent = 'FAIL';
      detail.textContent = err.message;
    }
  }

  const allPassed = passed === tests.length;
  $('summary').dataset.status = allPassed ? 'pass' : 'fail';
  $('summary').textContent = `${passed} / ${tests.length} passed`;
  $('rerun').disabled = false;
}

$('rerun').addEventListener('click', run);
run();
