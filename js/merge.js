// Conflict merge: combine two versions of the board (e.g. laptop and phone) item by item.
//
// Rules:
// - Union of all columns and all cards, matched by id.
// - Same id on both sides: keep the one with the newer `updatedAt` (tombstones included,
//   so a delete only wins if it happened after the other side's edit).
// - A card's comments are the exception: they're combined by id, so comments added on
//   both devices all survive. A comment deleted on either side stays deleted.
// - Exact ties (same `updatedAt`, different content) are broken the same way on every
//   device, so both sides always arrive at the identical result.
// - A live card whose column was deleted on the other device is moved to the first
//   column instead of disappearing.
//
// Pure function: never modifies its inputs, no side effects, easy to test.

export function mergeBoards(local, remote) {
  const columns = mergeById(local.columns, remote.columns, pickNewer);
  const cards = mergeById(local.cards, remote.cards, mergeCard);
  return {
    schema: Math.max(local.schema || 1, remote.schema || 1),
    columns,
    cards: rehomeOrphanCards(cards, columns),
  };
}

// Union of two arrays of { id, ... } items; `combine(a, b)` decides when both have an id.
// Output is sorted by id so both devices produce the same array order.
function mergeById(listA = [], listB = [], combine) {
  const byId = new Map();
  for (const item of listA) byId.set(item.id, item);
  for (const item of listB) {
    const existing = byId.get(item.id);
    byId.set(item.id, existing ? combine(existing, item) : item);
  }
  return [...byId.values()]
    .sort((a, b) => compareStrings(a.id, b.id))
    .map((item) => structuredClone(item)); // never share objects with the inputs
}

// Newer updatedAt wins. On an exact tie: a tombstone wins, then a fixed content order.
function pickNewer(a, b) {
  const ta = Date.parse(a.updatedAt) || 0;
  const tb = Date.parse(b.updatedAt) || 0;
  if (ta !== tb) return ta > tb ? a : b;
  if (Boolean(a.deleted) !== Boolean(b.deleted)) return a.deleted ? a : b;
  return compareStrings(JSON.stringify(a), JSON.stringify(b)) >= 0 ? a : b;
}

function mergeCard(a, b) {
  const winner = pickNewer(a, b);
  return { ...winner, comments: mergeComments(a.comments, b.comments) };
}

function mergeComments(listA = [], listB = []) {
  const byId = new Map();
  for (const comment of [...listA, ...listB]) {
    const existing = byId.get(comment.id);
    byId.set(comment.id, existing
      ? { ...existing, deleted: Boolean(existing.deleted || comment.deleted) }
      : comment);
  }
  return [...byId.values()].sort((a, b) => compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id));
}

// Live, on-board cards pointing at a deleted/missing column move to the first live column.
function rehomeOrphanCards(cards, columns) {
  const live = columns
    .filter((c) => !c.deleted)
    .sort((a, b) => a.order - b.order || compareStrings(a.id, b.id));
  if (!live.length) return cards;
  const liveIds = new Set(live.map((c) => c.id));
  return cards.map((card) => (
    !card.deleted && !card.archived && !liveIds.has(card.columnId)
      ? { ...card, columnId: live[0].id }
      : card
  ));
}

// Plain code-unit comparison: identical on every device and locale (unlike localeCompare).
function compareStrings(a = '', b = '') {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
