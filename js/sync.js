// GitHub Contents API: load and save the encrypted board file in the private data repo.
//
// Only ciphertext ever goes over the network. The commit message is always exactly
// "update", and the filename is fixed, so nothing about the board leaks in metadata.
//
// SECURITY: never log the token, request headers, or response bodies.

import { base64ToBytes, bytesToBase64 } from './crypto.js';

const API = 'https://api.github.com';
export const FILE_PATH = 'board.enc.json';
const COMMIT_MESSAGE = 'update';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const AUTH_MESSAGE = 'Token rejected or expired. Update it in settings.';

// kind: 'network' | 'auth' | 'repo' | 'conflict' | 'ratelimit' | 'server' | 'invalid'
export class SyncError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
  }
}

function repoUrl({ owner, repo }) {
  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function fileUrl(config) {
  return `${repoUrl(config)}/contents/${FILE_PATH}`;
}

async function call(method, url, token, body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store', // always ask GitHub, never the browser cache
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    // fetch only throws when the request couldn't be made at all (offline, DNS, etc.).
    throw new SyncError('network', 'Offline, will sync');
  }
}

function errorFor(response) {
  const { status } = response;
  if (status === 401) return new SyncError('auth', AUTH_MESSAGE);
  if (status === 403 || status === 429) {
    if (status === 429 || response.headers.get('x-ratelimit-remaining') === '0') {
      return new SyncError('ratelimit', 'GitHub rate limit reached. Will retry shortly.');
    }
    return new SyncError('auth', AUTH_MESSAGE);
  }
  // GitHub answers 404 (not 403) for private repos the token can't see.
  if (status === 404) return new SyncError('repo', 'Repo not found, or the token can\'t access it.');
  if (status >= 500) return new SyncError('server', `GitHub is having trouble (${status}). Will retry.`);
  return new SyncError('server', `GitHub request failed (${status}).`);
}

// Confirms the repo exists and the token can see it.
async function checkRepo(config, token) {
  const response = await call('GET', repoUrl(config), token);
  if (!response.ok) throw errorFor(response);
}

// The API's base64 content -> the { version, salt, iv, ct } object.
function parseContent(base64) {
  try {
    return JSON.parse(decoder.decode(base64ToBytes(base64))); // base64ToBytes strips line breaks
  } catch {
    throw new SyncError('invalid', 'The board file on GitHub is not readable.');
  }
}

// Files over 1 MB come back from the Contents API without content; fetch the blob instead.
async function loadBlob(config, token, sha) {
  const response = await call('GET', `${repoUrl(config)}/git/blobs/${encodeURIComponent(sha)}`, token);
  if (!response.ok) throw errorFor(response);
  const data = await response.json();
  return data.content;
}

// Returns { file, sha }, or null if the repo exists but has no board file yet.
export async function loadRemote(config, token) {
  const response = await call('GET', fileUrl(config), token);
  if (response.status === 404) {
    await checkRepo(config, token); // throws if it's the repo (not the file) that's missing
    return null;
  }
  if (!response.ok) throw errorFor(response);

  const data = await response.json();
  let content = data.content;
  if (!content && data.size > 0) content = await loadBlob(config, token, data.sha);
  return { file: parseContent(content), sha: data.sha };
}

// Creates (sha = null) or updates the file. Returns the new sha.
// A stale sha means someone else saved first: SyncError('conflict').
export async function saveRemote(config, token, file, sha) {
  const body = {
    message: COMMIT_MESSAGE,
    content: bytesToBase64(encoder.encode(JSON.stringify(file))),
  };
  if (sha) body.sha = sha;

  const response = await call('PUT', fileUrl(config), token, body);
  if (response.ok) {
    const data = await response.json();
    return data.content.sha;
  }
  if (response.status === 409) throw new SyncError('conflict', 'The board changed on another device.');
  if (response.status === 422) {
    const text = await response.text();
    if (/sha/i.test(text)) throw new SyncError('conflict', 'The board changed on another device.');
    throw new SyncError('server', 'GitHub rejected the save (422).');
  }
  throw errorFor(response);
}
