# Kanban Board — Project Brief

Personal kanban board for one user (M). Runs on a laptop and a phone with the same data. Hosted free on GitHub Pages. All board data is encrypted in the browser before it leaves the device.

Read this whole file before writing code. Build one milestone at a time and stop after each so M can test.

## Architecture

Two GitHub repos, both owned by `miketocoding`.

1. **`kanban`** (public, this repo). The app code. Served by GitHub Pages at `https://miketocoding.github.io/kanban/`. Contains no personal data, no tokens, no secrets.
2. **`kanban-data`** (private). Holds one file, `board.enc.json`, containing only ciphertext. Never cloned or edited by hand. The app reads and writes it through the GitHub REST API.

There is no backend. Everything runs in the browser.

## Tech constraints

- Vanilla JavaScript (ES modules), HTML, CSS. No TypeScript.
- **Zero dependencies.** No npm packages, no CDNs, no frameworks, no build step.
- Must work well on a phone screen (mobile-first layout, touch-friendly). Drag and drop on desktop; on touch devices also provide a "Move to…" control, since touch drag is unreliable.
- Local dev: `python3 -m http.server 8000`, then open `http://localhost:8000`. (Web Crypto and service workers require localhost or HTTPS.)
- Paths must work under the `/kanban/` subpath on GitHub Pages. Use relative paths everywhere.

## File structure

```
index.html
manifest.webmanifest
sw.js
css/styles.css
js/app.js        # entry point, wiring, screens (setup / unlock / board)
js/board.js      # state shape and mutations (add, edit, move, delete)
js/ui.js         # rendering and event handling
js/crypto.js     # key derivation, encrypt, decrypt, base64 helpers
js/storage.js    # IndexedDB / localStorage wrappers
js/sync.js       # GitHub Contents API load/save
js/merge.js      # conflict merge
icons/           # PWA icons
```

## Data model (plaintext, exists only in memory)

```json
{
  "schema": 1,
  "columns": [
    { "id": "uuid", "name": "To Do", "order": 0, "updatedAt": "ISO", "deleted": false }
  ],
  "cards": [
    {
      "id": "uuid",
      "columnId": "uuid",
      "title": "string",
      "notes": "string",
      "priority": "" | "low" | "medium" | "high" | "critical",
      "project": "string",
      "startDate": "YYYY-MM-DD or empty",
      "dueDate": "YYYY-MM-DD or empty",
      "checklist": [ { "id": "uuid", "text": "string", "done": false } ],
      "comments": [ { "id": "uuid", "text": "string", "createdAt": "ISO", "deleted": false } ],
      "archived": false,
      "archivedAt": "ISO or empty",
      "order": 0,
      "createdAt": "ISO",
      "updatedAt": "ISO",
      "deleted": false
    }
  ]
}
```

- IDs from `crypto.randomUUID()`.
- Every mutation sets `updatedAt` to now.
- **Deletes are tombstones**: set `deleted: true` and update `updatedAt`; hide them in the UI. Without tombstones, the merge would bring deleted items back. Tombstones older than 30 days may be purged on save.
- Default columns on a fresh board: To Do, Doing, Done.
- UI labels: `title` = Name, `notes` = Description, `checklist` = Tasks. A card's Status is its column. Duration is computed from the dates, never stored. The rightmost column counts as "done" (no overdue flag).
- `normalizeBoard()` fills missing card fields, so older boards still load.
- Archived cards are hidden from the board, listed under "Archived", read-only until restored. Archive is not delete.
- Clicking a card opens a read-only view (status, task ticks and comments can be changed there); "Edit" opens the form.
- Search/filter/sort state is UI-only and never stored (search terms can contain card text).

## Encrypted file format (`board.enc.json` in the private repo)

```json
{ "version": 1, "salt": "base64", "iv": "base64", "ct": "base64" }
```

- `salt` is 16 random bytes, generated once when the board is first created, then reused.
- `iv` is 12 random bytes, **new on every encryption. Never reuse an IV.**
- `ct` is AES-GCM ciphertext of `JSON.stringify(board)`.

## Crypto spec (`js/crypto.js`)

- Use only the built-in Web Crypto API (`crypto.subtle`). Do not write custom crypto.
- Key derivation: PBKDF2, SHA-256, 600,000 iterations, 16-byte salt, producing an AES-GCM 256-bit key.
- Keys are created with `extractable: false` and kept only in memory. Never stored, never logged.
- Base64 helpers must handle large arrays (encode in chunks; do not spread a large Uint8Array into `String.fromCharCode`).
- A wrong passphrase makes AES-GCM decryption throw. Catch it and show "Wrong passphrase", nothing more specific.

## Secrets and setup flow

The app needs three things from M on each device:
1. Repo owner and name (`miketocoding` / `kanban-data`). Not secret; store in localStorage.
2. GitHub fine-grained personal access token (scoped to `kanban-data` only, Contents read/write).
3. Passphrase. **Never stored anywhere, never sent anywhere.**

**Setup screen** (first run on a device). M enters owner, repo, token, and passphrase.
- If `board.enc.json` does not exist (404), create a new board with a new salt.
- If it exists, use its salt, derive the key, and decrypt to confirm the passphrase is right.
- Encrypt the token with the derived key (its own random IV) and store `{ salt, iv, ct }` for the token in localStorage. **The plaintext token is never stored.**

**Unlock screen** (every later visit). M enters only the passphrase. Derive key, decrypt token, load board.

**Lock.** A "Lock" button, plus auto-lock after 15 minutes of inactivity. Locking wipes the key, token, and board from memory and returns to the unlock screen.

**Reset device.** A settings option that clears this device's stored config and encrypted token (with confirmation). It does not touch the remote file.

## Local cache

Keep the latest encrypted file (same format as remote, never plaintext) plus its GitHub `sha` in IndexedDB. On unlock, render from the cache immediately, then fetch remote in the background. This also lets the board open offline.

## Sync spec (`js/sync.js`)

GitHub Contents API, `https://api.github.com/repos/{owner}/{repo}/contents/board.enc.json`.

Headers on every request:
```
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

- **Load**: GET. Response `content` is base64 with line breaks; strip whitespace before decoding. Keep the returned `sha`. 404 means no file yet.
- **Save**: PUT with `{ message: "update", content: <base64 of the JSON file>, sha }` (omit `sha` only when creating). Store the new `sha` from the response.
- **Commit messages are always exactly `update`.** Never put card titles or any board content in commit messages, filenames, or anything else unencrypted.
- Debounce saves to 1.5 seconds after the last edit. Also save on `visibilitychange` to hidden.
- **Conflict** (409, or 422 mentioning sha): GET the latest, decrypt, merge (below), re-encrypt with a new IV, PUT again with the new sha. Retry up to 3 times, then show an error.
- 401/403: show "Token rejected or expired. Update it in settings." Allow entering a new token (encrypted the same way).
- Network failure: keep the change locally, show an "Offline, will sync" indicator, retry when `online` fires.
- Show a small sync status: Saved / Saving… / Offline / Error.

## Merge spec (`js/merge.js`)

Merge `local` and `remote` boards item by item:
- Union of all columns and all cards by `id`.
- When an id exists on both sides, keep the one with the newer `updatedAt` (tombstones included).
- Exception: when both sides have the same card, merge its `comments` by `id` union (a comment deleted on either side stays deleted), so comments added on two devices both survive. Other card fields follow the newer `updatedAt`.
- Pure function with no side effects, so it is easy to test.

## Security rules (non-negotiable)

- Render all user text with `textContent` or `createTextNode`. **Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `eval` with user data.**
- No inline `<script>` and no inline event handlers (`onclick=`). All JS lives in files under `js/`.
- Add this CSP as the first element in `<head>`:
  ```html
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.github.com; object-src 'none'; base-uri 'none'; form-action 'none'">
  ```
- No analytics, fonts, or anything else loaded from third parties.
- Never `console.log` the token, the passphrase, keys, or decrypted board contents.
- **Never write a real token into any file in this repo.** M pastes the token into the running app only. Add a `.gitignore` covering `.env`, `*.local`, and `.DS_Store`.
- Passphrase input uses `type="password"` with `autocomplete="current-password"` so password managers work.

## PWA

- `manifest.webmanifest` with name, short name, icons (192 and 512), `display: standalone`, `start_url: "./"`, `scope: "./"`.
- `sw.js` caches the app shell (HTML, CSS, JS, icons) so the app loads offline. **It must never cache requests to `api.github.com`.**
- Use a versioned cache name and delete old caches on activate, so updates actually reach the phone.

## Milestones

Stop after each one and tell M how to test it.

1. **Board UI, local only.** Columns and cards; add, edit, delete, reorder, move between columns (drag on desktop, "Move to…" on mobile). Keep state in memory only for now. Mobile-first styling. CSP and security rules apply from the start.
2. **Crypto.** `crypto.js` with derive/encrypt/decrypt and base64 helpers. A temporary dev-only test page or console check proving round-trip encryption works and a wrong passphrase fails.
3. **Setup, unlock, lock.** Setup and unlock screens, encrypted token storage, auto-lock, encrypted IndexedDB cache. Still no network.
4. **GitHub sync.** Load and save to `kanban-data`, sha handling, debounce, status indicator, error handling.
5. **Conflict merge.** `merge.js` plus conflict-retry flow. Test by editing on two browsers at once.
6. **PWA.** Manifest, icons, service worker, add-to-home-screen on the phone.
7. **Backup.** Export the encrypted file as a download, and import one (with confirmation before overwriting).

**Use fake test data until milestone 4 is finished and tested.**

## Working style

- M is a JavaScript developer who is new to crypto and this kind of architecture. When adding something security-related, explain briefly in plain language what it does and why.
- Keep code readable over clever. Small functions, clear names, short comments where the reason isn't obvious.
- Do not add features outside this brief without asking.
- Do not run `git push` or change GitHub settings. M does those himself.
