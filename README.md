# Kanban

A personal kanban board that runs in the browser on a laptop and a phone, sharing the same data. It is hosted free on GitHub Pages, and **all board data is encrypted in the browser before it leaves the device**.

Live app: https://miketocoding.github.io/kanban/

## How it works

- **No backend.** Everything runs in the browser. GitHub Pages only serves the code in this repo.
- **Two repos.** `kanban` (this one, public) holds the app code and no personal data. A separate **private** repo holds a single file, `board.enc.json`, which contains only ciphertext.
- **Encryption.** Your passphrase is turned into a key with PBKDF2 (SHA-256, 600,000 rounds, random 16-byte salt). The board is encrypted with AES-GCM (256-bit) and a fresh random 12-byte IV on every save. Only the browser's built-in Web Crypto API is used.
- **What is stored where:**

  | Where | What | Encrypted? |
  |---|---|---|
  | Private GitHub repo | `board.enc.json`: `{ version, salt, iv, ct }` | Yes |
  | Browser IndexedDB | The same encrypted file, its GitHub `sha`, and an "unsynced changes" flag | Yes |
  | Browser localStorage | Repo owner and name | No (not secret) |
  | Browser localStorage | GitHub token | Yes |
  | Memory only, while unlocked | Key, token, decrypted board | — |
  | Nowhere | Your passphrase | — |

- **Zero dependencies.** Vanilla JavaScript (ES modules), HTML and CSS. No npm, no CDNs, no framework, no build step.

## Run locally

```
python3 -m http.server 8000
```

Open http://localhost:8000. Web Crypto requires `localhost` or HTTPS.

While testing local changes, keep DevTools open with **Network → Disable cache** ticked, otherwise Chrome may serve a mix of old and new files.

## Project structure

```
index.html          screens and dialogs; strict Content-Security-Policy
css/styles.css      light, Jira-inspired, mobile-first styles
js/app.js           entry point: setup / unlock / lock, auto-lock, saving and sync flow
js/board.js         board data model and mutations (tombstone deletes)
js/ui.js            rendering and event handling (text only via textContent)
js/crypto.js        key derivation, encrypt / decrypt, base64 helpers
js/storage.js       localStorage and IndexedDB wrappers
js/sync.js          GitHub Contents API load / save
js/merge.js         pure conflict-merge function
CLAUDE.md           the full project brief and spec
```

## Milestones

### ✅ 1. Board UI (local only)
- Columns and cards: add, edit, delete, reorder, move between columns.
- Drag and drop on desktop; a "Move to…" menu (⋮) on touch devices.
- Mobile-first layout with swipeable columns.
- **Added on request:**
  - Card fields: Name, Description, Status (= column), Priority, Project, Start date, Due date, a computed Duration, and Tasks (checklist).
  - Clicking a card opens a read-only view. **Edit** opens the form; status, task ticks and comments can be changed straight from the view.
  - Comments on cards.
  - Search (names, descriptions, projects, tasks, comments), filters (priority, project, due date) and sort.
  - Archive: archive single cards or a whole column, browse and restore archived cards.
  - Light, Jira-inspired visual style.

### ✅ 2. Crypto
- `crypto.js`: PBKDF2 key derivation, AES-GCM encrypt / decrypt, chunked base64 helpers.
- Keys are non-extractable and kept in memory only.
- A wrong passphrase shows exactly "Wrong passphrase".
- An 18-check test page proved round-trips, wrong-passphrase failure, fresh IVs, tamper detection and large boards. It was removed in Milestone 3, as planned.

### ✅ 3. Setup, unlock, lock
- **Setup screen** (first run on a device): owner, repo, token and passphrase. The passphrase must be at least 12 characters and typed twice.
- **Unlock screen** on every later visit: passphrase only.
- The GitHub token is stored only in encrypted form.
- The board is cached in IndexedDB as encrypted data only.
- **Lock** button, plus auto-lock after 15 minutes of inactivity. Locking wipes the board from the page and drops the key, token and board from memory.
- **Settings:** replace the GitHub token, or reset this device (with confirmation; never touches GitHub).

### ✅ 4. GitHub sync
- Setup creates `board.enc.json` in the private repo, or opens the existing one and checks the passphrase against it.
- Saves are debounced to 1.5 seconds after the last edit, and also happen when the app is hidden.
- Every request carries the three required GitHub headers. The commit message is always exactly `update`.
- Unlock shows the cached board instantly, then checks GitHub in the background. Changes from other devices appear when you return to the app.
- Sync status: **Saved / Saving… / Offline / Error**, with an explanatory banner.
- **Offline:** changes are kept on the device and uploaded when the connection returns. Unsynced changes survive a lock or a closed tab.
- **Rejected token:** shows "Token rejected or expired. Update it in settings." with a shortcut to settings.

### ✅ 5. Conflict merge
- `merge.js` is a pure function: union of columns and cards by id, and the newer `updatedAt` wins (deletions included).
- Comments added on two devices are all kept.
- Exact ties are resolved the same way on every device. A card added to a column that was deleted on the other device moves to the first column.
- On a save conflict, the app fetches the latest version, decrypts, merges, re-encrypts with a new IV and retries, up to 3 times with a short pause between attempts.
- Deletions older than 30 days are purged when saving.
- Tested with two browsers editing at once.

### ⬜ 6. PWA (next)
- `manifest.webmanifest` with name, icons (192 and 512), standalone display, and `start_url` / `scope` of `./`.
- `sw.js` caches the app shell so the app loads offline. It must never cache requests to `api.github.com`.
- A versioned cache, with old caches deleted on activate, so updates reach the phone right away instead of waiting for GitHub Pages' 10-minute cache.
- Add to the phone's home screen.

### ⬜ 7. Backup
- Export the encrypted board file as a download.
- Import a backup file, with confirmation before overwriting.

## Open items and notes

- **Adjustable auto-lock time** (for example 5, 15, 30 or 60 minutes): proposed, not decided. It would change the brief.
- **"Move to…" arrow sizes:** the phone's native picker draws ← and → at different sizes. Deferred.
- **Merge granularity:** apart from comments, a card is merged as one unit. If the same card is changed on two devices, the later change wins for all its other fields, including task ticks.
- **iPhone Safari** deletes a website's stored data after 7 days without a visit. The board is safe on GitHub, but that device then needs setup again. Home-screen apps (Milestone 6) are exempt.
- **GitHub token** expires Nov 26, 2027. Replace it in Settings on each device before then.
- **The app is open to anyone,** but only with their own private repo and token. Nobody can reach your data without both your token and your passphrase.

## Security rules (summary)

- User text is rendered only with `textContent`. No `innerHTML`, inline scripts, inline handlers or `eval`.
- A strict CSP allows scripts and styles from this site only, and network requests only to `api.github.com`.
- No analytics, fonts or other third-party resources.
- The passphrase, token, keys and decrypted board are never logged, stored in plain text, or put in commit messages.

See [CLAUDE.md](CLAUDE.md) for the full specification.
