// Board state shape and mutations.
// Mutations change the board in place and stamp `updatedAt` on every item they touch.
// Deletes are tombstones (deleted: true) so a later merge can't resurrect them.

const DEFAULT_COLUMNS = ['To Do', 'Doing', 'Done'];

export const PRIORITIES = [
  { value: '', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];
const PRIORITY_VALUES = PRIORITIES.map((p) => p.value);

const PRIORITY_RANK = { '': 0, low: 1, medium: 2, high: 3, critical: 4 };

const LIMITS = { title: 200, notes: 10000, project: 60, task: 500, comment: 5000 };

function now() {
  return new Date().toISOString();
}

function touch(item) {
  item.updatedAt = now();
}

function byOrder(a, b) {
  // Tie-break on id so ordering is deterministic across devices.
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Give items consecutive `order` values, touching only the ones that change.
function renumber(items) {
  items.forEach((item, index) => {
    if (item.order !== index) {
      item.order = index;
      touch(item);
    }
  });
}

export function createBoard() {
  const board = { schema: 1, columns: [], cards: [] };
  DEFAULT_COLUMNS.forEach((name) => addColumn(board, name));
  return board;
}

// Fill in any card fields missing from older data (e.g. a board saved before a field existed).
export function normalizeBoard(board) {
  board.cards.forEach((card) => {
    if (typeof card.notes !== 'string') card.notes = '';
    if (!PRIORITY_VALUES.includes(card.priority)) card.priority = '';
    if (typeof card.project !== 'string') card.project = '';
    if (!isDateString(card.startDate)) card.startDate = '';
    if (!isDateString(card.dueDate)) card.dueDate = '';
    if (!Array.isArray(card.checklist)) card.checklist = [];
    if (!Array.isArray(card.comments)) card.comments = [];
    if (typeof card.archived !== 'boolean') card.archived = false;
    if (typeof card.archivedAt !== 'string') card.archivedAt = '';
    if (typeof card.createdAt !== 'string') card.createdAt = card.updatedAt || now();
  });
  return board;
}

// ---- Queries ----

export function visibleColumns(board) {
  return board.columns.filter((c) => !c.deleted).sort(byOrder);
}

// Cards shown on the board: not deleted, not archived.
export function visibleCards(board, columnId) {
  return board.cards.filter((c) => !c.deleted && !c.archived && c.columnId === columnId).sort(byOrder);
}

// Archived cards, most recently archived first.
export function archivedCards(board) {
  return board.cards
    .filter((c) => !c.deleted && c.archived)
    .sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''));
}

export function priorityRank(priority) {
  return PRIORITY_RANK[priority] ?? 0;
}

export function priorityLabel(priority) {
  return PRIORITIES.find((p) => p.value === priority)?.label ?? 'None';
}

export function liveComments(card) {
  return card.comments.filter((c) => !c.deleted);
}

export function findColumn(board, id) {
  return board.columns.find((c) => c.id === id && !c.deleted) || null;
}

export function findCard(board, id) {
  return board.cards.find((c) => c.id === id && !c.deleted) || null;
}

export function cardIndex(board, id) {
  const card = findCard(board, id);
  if (!card) return -1;
  return visibleCards(board, card.columnId).findIndex((c) => c.id === id);
}

export function projectNames(board) {
  const names = new Set();
  board.cards.forEach((c) => {
    if (!c.deleted && c.project) names.add(c.project);
  });
  return [...names].sort((a, b) => a.localeCompare(b));
}

// ---- Dates ("YYYY-MM-DD" strings, as produced by <input type="date">) ----

export function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Day number since epoch, computed in UTC so time zones and DST can't shift it.
function dayNumber(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function todayString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Inclusive length in days (start and due on the same day = 1 day).
// Returns null if either date is missing, or < 1 if due is before start.
export function durationDays(startDate, dueDate) {
  if (!isDateString(startDate) || !isDateString(dueDate)) return null;
  return dayNumber(dueDate) - dayNumber(startDate) + 1;
}

// 'overdue', 'soon' (due within 2 days), or ''.
// Days from today until the date (negative = in the past).
export function daysUntil(dateString) {
  return dayNumber(dateString) - dayNumber(todayString());
}

export function dueState(dueDate) {
  if (!isDateString(dueDate)) return '';
  const daysLeft = daysUntil(dueDate);
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= 2) return 'soon';
  return '';
}

export function formatDate(dateString) {
  if (!isDateString(dateString)) return '';
  const [y, m, d] = dateString.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const options = { month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString(undefined, options);
}

export function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ---- Card field cleaning ----

function cleanChecklist(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => ({
      id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
      text: String(item.text ?? '').trim().slice(0, LIMITS.task),
      done: Boolean(item.done),
    }))
    .filter((item) => item.text);
}

// Keep only known card fields, with sane values.
function cleanCardFields(fields) {
  const out = {};
  if ('title' in fields) out.title = String(fields.title).trim().slice(0, LIMITS.title);
  if ('notes' in fields) out.notes = String(fields.notes).slice(0, LIMITS.notes);
  if ('priority' in fields) out.priority = PRIORITY_VALUES.includes(fields.priority) ? fields.priority : '';
  if ('project' in fields) out.project = String(fields.project).trim().slice(0, LIMITS.project);
  if ('startDate' in fields) out.startDate = isDateString(fields.startDate) ? fields.startDate : '';
  if ('dueDate' in fields) out.dueDate = isDateString(fields.dueDate) ? fields.dueDate : '';
  if ('checklist' in fields) out.checklist = cleanChecklist(fields.checklist);
  return out;
}

// ---- Columns ----

export function addColumn(board, name) {
  const column = {
    id: crypto.randomUUID(),
    name: name.trim(),
    order: visibleColumns(board).length,
    updatedAt: now(),
    deleted: false,
  };
  board.columns.push(column);
  return column;
}

export function renameColumn(board, id, name) {
  const column = findColumn(board, id);
  const trimmed = name.trim();
  if (!column || !trimmed || column.name === trimmed) return;
  column.name = trimmed;
  touch(column);
}

export function moveColumn(board, id, toIndex) {
  const column = findColumn(board, id);
  if (!column) return;
  const others = visibleColumns(board).filter((c) => c.id !== id);
  others.splice(clamp(toIndex, 0, others.length), 0, column);
  renumber(others);
}

// Deleting a column also tombstones the cards in it.
export function deleteColumn(board, id) {
  const column = findColumn(board, id);
  if (!column) return;
  visibleCards(board, id).forEach((card) => {
    card.deleted = true;
    touch(card);
  });
  column.deleted = true;
  touch(column);
  renumber(visibleColumns(board));
}

// ---- Cards ----

export function addCard(board, columnId, fields) {
  if (!findColumn(board, columnId)) return null;
  const clean = cleanCardFields(fields);
  if (!clean.title) return null;
  const card = {
    id: crypto.randomUUID(),
    columnId,
    title: clean.title,
    notes: clean.notes ?? '',
    priority: clean.priority ?? '',
    project: clean.project ?? '',
    startDate: clean.startDate ?? '',
    dueDate: clean.dueDate ?? '',
    checklist: clean.checklist ?? [],
    comments: [],
    archived: false,
    archivedAt: '',
    order: visibleCards(board, columnId).length,
    createdAt: now(),
    updatedAt: now(),
    deleted: false,
  };
  board.cards.push(card);
  return card;
}

export function updateCard(board, id, fields) {
  const card = findCard(board, id);
  if (!card) return;
  const clean = cleanCardFields(fields);
  if ('title' in clean && !clean.title) delete clean.title; // never blank a title

  let changed = false;
  for (const [key, value] of Object.entries(clean)) {
    if (JSON.stringify(card[key]) !== JSON.stringify(value)) {
      card[key] = value;
      changed = true;
    }
  }
  if (changed) touch(card);
}

export function deleteCard(board, id) {
  const card = findCard(board, id);
  if (!card) return;
  card.deleted = true;
  touch(card);
  renumber(visibleCards(board, card.columnId));
}

// Move a card to `toIndex` within `toColumnId` (index counted without the card itself).
export function moveCard(board, id, toColumnId, toIndex) {
  const card = findCard(board, id);
  if (!card || !findColumn(board, toColumnId)) return;
  const fromColumnId = card.columnId;

  const target = visibleCards(board, toColumnId).filter((c) => c.id !== id);
  target.splice(clamp(toIndex, 0, target.length), 0, card);

  if (fromColumnId !== toColumnId) {
    card.columnId = toColumnId;
    touch(card);
    renumber(visibleCards(board, fromColumnId));
  }
  renumber(target);
}

// ---- Archive ----

export function archiveCard(board, id) {
  const card = findCard(board, id);
  if (!card || card.archived) return;
  card.archived = true;
  card.archivedAt = now();
  touch(card);
  renumber(visibleCards(board, card.columnId));
}

export function archiveColumnCards(board, columnId) {
  visibleCards(board, columnId).forEach((card) => archiveCard(board, card.id));
}

// Restored cards go to the bottom of their column (or the first column if theirs was deleted).
export function restoreCard(board, id) {
  const card = findCard(board, id);
  if (!card || !card.archived) return;
  const columns = visibleColumns(board);
  if (!columns.length) return;
  if (!findColumn(board, card.columnId)) card.columnId = columns[0].id;
  card.order = visibleCards(board, card.columnId).length;
  card.archived = false;
  card.archivedAt = '';
  touch(card);
}

// ---- Checklist and comments (changed directly from the card view) ----

export function setChecklistItemDone(board, cardId, itemId, done) {
  const card = findCard(board, cardId);
  const item = card?.checklist.find((i) => i.id === itemId);
  if (!item || item.done === done) return;
  item.done = done;
  touch(card);
}

export function addComment(board, cardId, text) {
  const card = findCard(board, cardId);
  const clean = String(text).trim().slice(0, LIMITS.comment);
  if (!card || !clean) return null;
  const comment = { id: crypto.randomUUID(), text: clean, createdAt: now(), deleted: false };
  card.comments.push(comment);
  touch(card);
  return comment;
}

// Comments are tombstoned too, so the merge can't bring them back.
export function deleteComment(board, cardId, commentId) {
  const card = findCard(board, cardId);
  const comment = card?.comments.find((c) => c.id === commentId);
  if (!comment || comment.deleted) return;
  comment.deleted = true;
  touch(card);
}
