// Rendering and event handling.
// SECURITY: all user text goes through textContent / .value. Never innerHTML.

import * as Board from './board.js';

let board = null;
let root = null;
let onChange = () => {};

// ---- Transient UI state (not part of the board, never saved) ----

let addingColumn = false;
let focusAfterRender = null; // CSS selector to focus after the next render
let editingColumnId = null;
let draggingCardId = null;
let viewCardId = null; // card shown in the read-only view

// The edit form works on a draft checklist; it is only written to the board on Save.
let cardDraft = { cardId: null, checklist: [] };

// Search / filter / sort. Kept in memory only: search terms can contain card text,
// and nothing derived from card content is stored unencrypted.
const DEFAULT_FILTERS = { text: '', priority: '', project: '', due: '', sort: 'manual' };
const filters = { ...DEFAULT_FILTERS };
const NO_PROJECT = ' none'; // sentinel option value; project names are trimmed, so none starts with a space

const PRIORITY_FILTERS = [
  { value: '', label: 'All priorities' },
  ...Board.PRIORITIES.filter((p) => p.value).map((p) => ({ value: p.value, label: p.label })),
  { value: 'none', label: 'No priority' },
];
const DUE_FILTERS = [
  { value: '', label: 'Any due date' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'week', label: 'Due in 7 days' },
  { value: 'none', label: 'No due date' },
];
const SORTS = [
  { value: 'manual', label: 'Sort: Board order' },
  { value: 'due', label: 'Sort: Due date' },
  { value: 'priority', label: 'Sort: Priority' },
  { value: 'updated', label: 'Sort: Recently updated' },
  { value: 'created', label: 'Sort: Newest first' },
  { value: 'name', label: 'Sort: Name A–Z' },
];

// Mouse/trackpad devices get drag and drop. Touch devices get the "Move to…" menu.
// Re-checked live, so toggling device emulation in DevTools takes effect without a reload.
const finePointer = window.matchMedia('(pointer: fine)');
let canDrag = finePointer.matches;

const $ = (id) => document.getElementById(id);

// ---- Public API ----

export function initUI(rootEl, initialBoard, changeCallback) {
  root = rootEl;
  board = initialBoard;
  onChange = changeCallback || (() => {});

  document.body.classList.toggle('can-drag', canDrag);
  finePointer.addEventListener('change', (e) => {
    canDrag = e.matches;
    document.body.classList.toggle('can-drag', canDrag);
    render();
  });

  $('create-card').addEventListener('click', () => {
    const first = Board.visibleColumns(board)[0];
    if (first) openCardDialog({ columnId: first.id });
  });
  $('open-archive').addEventListener('click', openArchive);

  wireToolbar();
  wireViewDialog();
  wireCardDialog();
  wireArchiveDialog();
  wireColumnDialog();
  render();
}

// Call after any board mutation: re-render everything visible and notify the app.
function commit() {
  render();
  if ($('view-dialog').open) renderCardView();
  if ($('archive-dialog').open) renderArchiveList();
  onChange(board);
}

// ---- Tiny DOM helpers ----

// el('button', { className, text, type, value, attrs: {...}, dataset: {...}, on: { click: fn } }, children)
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.type) node.type = props.type;
  if (props.value !== undefined) node.value = props.value;
  for (const [k, v] of Object.entries(props.attrs || {})) node.setAttribute(k, v);
  for (const [k, v] of Object.entries(props.dataset || {})) node.dataset[k] = v;
  for (const [evt, fn] of Object.entries(props.on || {})) node.addEventListener(evt, fn);
  for (const child of children) if (child) node.append(child);
  return node;
}

function setOptions(select, options, selectedValue) {
  select.replaceChildren(...options.map(({ value, label }) => {
    const option = el('option', { text: label, value });
    option.selected = value === selectedValue;
    return option;
  }));
}

// Close a dialog when the backdrop (outside the content) is clicked.
function closeOnBackdrop(dialog) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}

// ---- Search, filter, sort ----

function isFiltering() {
  return Boolean(filters.text.trim() || filters.priority || filters.project || filters.due);
}

// Manual reordering only makes sense when every card is shown in board order.
function isManualOrder() {
  return filters.sort === 'manual' && !isFiltering();
}

function searchWords(text) {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

function cardSearchText(card) {
  return [
    card.title,
    card.notes,
    card.project,
    ...card.checklist.map((i) => i.text),
    ...Board.liveComments(card).map((c) => c.text),
  ].join('\n').toLowerCase();
}

function matchesWords(card, words) {
  if (!words.length) return true;
  const haystack = cardSearchText(card);
  return words.every((w) => haystack.includes(w));
}

function matchesFilters(card, isDoneColumn) {
  if (!matchesWords(card, searchWords(filters.text))) return false;

  if (filters.priority) {
    const wanted = filters.priority === 'none' ? '' : filters.priority;
    if (card.priority !== wanted) return false;
  }
  if (filters.project) {
    const wanted = filters.project === NO_PROJECT ? '' : filters.project;
    if (card.project !== wanted) return false;
  }
  if (filters.due === 'none') return !card.dueDate;
  if (filters.due) {
    if (!card.dueDate || isDoneColumn) return false;
    const days = Board.daysUntil(card.dueDate);
    if (filters.due === 'overdue') return days < 0;
    if (filters.due === 'week') return days >= 0 && days <= 7;
  }
  return true;
}

const SORT_COMPARE = {
  due: (a, b) => (a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99'),
  priority: (a, b) => Board.priorityRank(b.priority) - Board.priorityRank(a.priority),
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  created: (a, b) => b.createdAt.localeCompare(a.createdAt),
  name: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
};

function sortCards(cards) {
  const compare = SORT_COMPARE[filters.sort];
  return compare ? [...cards].sort((a, b) => compare(a, b) || a.order - b.order) : cards;
}

function wireToolbar() {
  setOptions($('filter-priority'), PRIORITY_FILTERS, '');
  setOptions($('filter-due'), DUE_FILTERS, '');
  setOptions($('sort-by'), SORTS, 'manual');

  $('search').addEventListener('input', (e) => {
    filters.text = e.target.value;
    render();
  });
  const selects = { 'filter-priority': 'priority', 'filter-project': 'project', 'filter-due': 'due', 'sort-by': 'sort' };
  for (const [id, key] of Object.entries(selects)) {
    $(id).addEventListener('change', (e) => {
      filters[key] = e.target.value;
      render();
    });
  }
  $('clear-filters').addEventListener('click', () => {
    Object.assign(filters, DEFAULT_FILTERS);
    render();
  });
}

// Bring the toolbar controls in line with `filters` (and refresh the project list).
function syncToolbar() {
  if ($('search').value !== filters.text) $('search').value = filters.text;

  const names = Board.projectNames(board);
  if (filters.project && filters.project !== NO_PROJECT && !names.includes(filters.project)) {
    names.push(filters.project); // keep the active choice even if no card uses it any more
  }
  setOptions($('filter-project'), [
    { value: '', label: 'All projects' },
    ...names.map((n) => ({ value: n, label: n })),
    { value: NO_PROJECT, label: 'No project' },
  ], filters.project);

  $('filter-priority').value = filters.priority;
  $('filter-due').value = filters.due;
  $('sort-by').value = filters.sort;

  const selects = { 'filter-priority': 'priority', 'filter-project': 'project', 'filter-due': 'due', 'sort-by': 'sort' };
  for (const [id, key] of Object.entries(selects)) {
    $(id).classList.toggle('active', filters[key] !== DEFAULT_FILTERS[key]);
  }
  $('clear-filters').hidden = !isFiltering() && filters.sort === 'manual';
}

// ---- Board rendering ----

function render() {
  // Full re-render is simple and fast enough for a personal board.
  // Preserve scroll positions so the view doesn't jump.
  const scrollLeft = root.scrollLeft;
  const listScroll = {};
  root.querySelectorAll('.column').forEach((col) => {
    listScroll[col.dataset.columnId] = col.querySelector('.card-list').scrollTop;
  });

  syncToolbar();
  const columns = Board.visibleColumns(board);
  root.replaceChildren(
    ...columns.map((column, i) => renderColumn(column, columns, i === columns.length - 1)),
    renderAddColumn(),
  );
  $('create-card').disabled = columns.length === 0;
  const archived = Board.archivedCards(board).length;
  $('open-archive').textContent = archived ? `Archived (${archived})` : 'Archived';

  root.scrollLeft = scrollLeft;
  root.querySelectorAll('.column').forEach((col) => {
    const top = listScroll[col.dataset.columnId];
    if (top) col.querySelector('.card-list').scrollTop = top;
  });

  if (focusAfterRender) {
    const target = root.querySelector(focusAfterRender);
    if (target) {
      target.focus();
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    focusAfterRender = null;
  }
}

// The rightmost column is treated as "done": its cards are never flagged overdue.
function isDoneColumnId(columnId) {
  const columns = Board.visibleColumns(board);
  return columns.length > 1 && columns[columns.length - 1].id === columnId;
}

function renderColumn(column, columns, isLast) {
  const isDoneColumn = isLast && columns.length > 1;
  const allCards = Board.visibleCards(board, column.id);
  const shown = sortCards(allCards.filter((c) => matchesFilters(c, isDoneColumn)));
  const filtering = isFiltering();
  const manual = isManualOrder();

  const countText = filtering ? `${shown.length}/${allCards.length}` : String(allCards.length);
  const header = el('header', { className: 'column-header' }, [
    el('h2', { className: 'column-title' }, [
      el('button', {
        className: 'column-name',
        type: 'button',
        text: column.name,
        attrs: { title: 'Edit column' },
        on: { click: () => openColumnDialog(column.id) },
      }),
    ]),
    el('span', {
      className: 'column-count',
      text: countText,
      attrs: { 'aria-label': filtering ? `${shown.length} of ${allCards.length} cards shown` : `${allCards.length} cards` },
    }),
  ]);

  const items = shown.map((card, index) => renderCard(card, index, shown.length, columns, isDoneColumn, manual));
  if (filtering && !shown.length) {
    items.push(el('li', { className: 'empty-note', text: 'No matching cards' }));
  }
  const list = el('ol', { className: 'card-list' }, items);

  const addButton = el('button', {
    className: 'add-card-btn',
    type: 'button',
    text: '+ Create',
    on: { click: () => openCardDialog({ columnId: column.id }) },
  });

  const section = el('section', {
    className: 'column',
    dataset: { columnId: column.id },
    attrs: { 'aria-label': column.name },
  }, [header, list, addButton]);

  if (canDrag) wireColumnDrop(section, list, column.id);
  return section;
}

function renderCard(card, index, count, columns, isDoneColumn, manual) {
  const meta = el('span', { className: 'card-meta' }, [
    priorityBadge(card.priority),
    dateBadge(card, isDoneColumn),
    checklistBadge(card.checklist),
    commentBadge(card),
  ]);

  const open = el('button', {
    className: 'card-open',
    type: 'button',
    on: { click: () => openCardView(card.id) },
  }, [
    el('span', { className: 'card-title', text: card.title }),
    card.project ? projectLozenge(card.project) : null,
    meta.childElementCount ? meta : null,
  ]);

  const li = el('li', { className: 'card', dataset: { cardId: card.id } }, [
    open,
    canDrag ? null : renderMoveSelect(card, index, count, columns, manual),
  ]);

  if (canDrag) wireCardDrag(li, card.id);
  return li;
}

// ---- Small badges (shared by the board and the card view) ----

function projectLozenge(name) {
  return el('span', { className: `lozenge ${projectColorClass(name)}`, text: name });
}

// Same project name → same colour, on every device.
function projectColorClass(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return `lozenge-c${hash % 6}`;
}

function priorityBadge(priority) {
  if (!priority) return null;
  const label = Board.priorityLabel(priority);
  return el('span', {
    className: `priority priority-${priority}`,
    text: label,
    attrs: { title: `Priority: ${label}` },
  });
}

function dateBadge(card, isDoneColumn) {
  const { startDate, dueDate } = card;
  if (!startDate && !dueDate) return null;

  let text;
  if (startDate && dueDate) text = `${Board.formatDate(startDate)} – ${Board.formatDate(dueDate)}`;
  else if (dueDate) text = `Due ${Board.formatDate(dueDate)}`;
  else text = `Starts ${Board.formatDate(startDate)}`;

  return dueBadge(text, isDoneColumn ? '' : Board.dueState(dueDate));
}

function dueBadge(text, state) {
  const titles = { overdue: 'Overdue', soon: 'Due soon' };
  return el('span', {
    className: `badge date-badge${state ? ` date-${state}` : ''}`,
    text,
    attrs: state ? { title: titles[state] } : {},
  });
}

function checklistBadge(checklist) {
  if (!checklist.length) return null;
  const done = checklist.filter((i) => i.done).length;
  const complete = done === checklist.length;
  return el('span', {
    className: `badge checklist-badge${complete ? ' checklist-complete' : ''}`,
    text: `☑ ${done}/${checklist.length}`,
    attrs: { title: `${done} of ${checklist.length} tasks done` },
  });
}

function commentBadge(card) {
  const count = Board.liveComments(card).length;
  if (!count) return null;
  return el('span', {
    className: 'badge',
    text: `💬 ${count}`,
    attrs: { title: `${count} comment${count === 1 ? '' : 's'}` },
  });
}

// ---- "Move to…" menu (touch devices) ----

// A native <select> is the most reliable control on phones:
// it opens the OS picker and needs no custom touch handling.
function renderMoveSelect(card, index, count, columns, manual) {
  const select = el('select', {
    className: 'card-move',
    attrs: { 'aria-label': `Move "${card.title}"` },
    on: { change: (e) => handleMoveSelect(card.id, e.target.value) },
  });

  const placeholder = el('option', { text: 'Move to…', value: '' });
  placeholder.disabled = true;
  placeholder.selected = true;
  select.append(placeholder);

  // Up/down only make sense when the column shows every card in board order.
  if (manual) {
    const position = el('optgroup', { attrs: { label: 'Position' } });
    if (index > 0) {
      position.append(el('option', { text: '↑ Up one', value: 'up' }));
      position.append(el('option', { text: '⤒ Top', value: 'top' }));
    }
    if (index < count - 1) {
      position.append(el('option', { text: '↓ Down one', value: 'down' }));
      position.append(el('option', { text: '⤓ Bottom', value: 'bottom' }));
    }
    if (position.children.length) select.append(position);
  }

  const others = columns.filter((c) => c.id !== card.columnId);
  if (others.length) {
    const group = el('optgroup', { attrs: { label: 'Column' } });
    others.forEach((c) => group.append(el('option', { text: `→ ${c.name}`, value: `col:${c.id}` })));
    select.append(group);
  }
  return select;
}

function handleMoveSelect(cardId, value) {
  const card = Board.findCard(board, cardId);
  if (!card) return;
  const index = Board.cardIndex(board, cardId);

  if (value === 'up') Board.moveCard(board, cardId, card.columnId, index - 1);
  else if (value === 'down') Board.moveCard(board, cardId, card.columnId, index + 1);
  else if (value === 'top') Board.moveCard(board, cardId, card.columnId, 0);
  else if (value === 'bottom') Board.moveCard(board, cardId, card.columnId, Infinity);
  else if (value.startsWith('col:')) Board.moveCard(board, cardId, value.slice(4), Infinity);
  else return;
  commit();
}

// ---- Add column ----

function renderAddColumn() {
  const wrapper = el('div', { className: 'add-column' });

  if (!addingColumn) {
    wrapper.append(el('button', {
      className: 'add-column-btn',
      type: 'button',
      text: '+ Add column',
      on: {
        click: () => {
          addingColumn = true;
          focusAfterRender = '.add-column-input';
          render();
        },
      },
    }));
    return wrapper;
  }

  const input = el('input', {
    className: 'add-column-input',
    type: 'text',
    attrs: { placeholder: 'Column name', maxlength: '100', autocomplete: 'off', 'aria-label': 'New column name' },
  });
  const cancel = () => {
    addingColumn = false;
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel();
  });

  wrapper.append(el('form', {
    className: 'inline-form',
    on: {
      submit: (e) => {
        e.preventDefault(); // handled in JS; never submits anywhere
        const name = input.value.trim();
        if (!name) return cancel();
        Board.addColumn(board, name);
        addingColumn = false;
        commit();
      },
    },
  }, [
    input,
    el('div', { className: 'button-row' }, [
      el('button', { className: 'btn btn-primary', type: 'submit', text: 'Add' }),
      el('button', { className: 'btn', type: 'button', text: 'Cancel', on: { click: cancel } }),
    ]),
  ]));
  return wrapper;
}

// ---- Drag and drop (desktop) ----

function wireCardDrag(li, cardId) {
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    draggingCardId = cardId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cardId); // Firefox requires some data
    // Delay the class so the browser's drag image is the normal-looking card.
    requestAnimationFrame(() => li.classList.add('dragging'));
  });
  li.addEventListener('dragend', () => {
    draggingCardId = null;
    li.classList.remove('dragging');
    clearDropFeedback();
  });
}

// The whole column is a drop target, so empty columns and headers work too.
// When sorted or filtered, a drop just moves the card to the end of the column
// (there is no meaningful "position" in a filtered/sorted view).
function wireColumnDrop(section, list, columnId) {
  section.addEventListener('dragover', (e) => {
    if (!draggingCardId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (isManualOrder()) {
      showDropIndicator(list, dropIndex(list, e.clientY));
    } else {
      section.classList.add('drop-target');
    }
  });
  section.addEventListener('dragleave', (e) => {
    if (!section.contains(e.relatedTarget)) clearDropFeedback();
  });
  section.addEventListener('drop', (e) => {
    if (!draggingCardId) return;
    e.preventDefault();
    const cardId = draggingCardId;
    const manual = isManualOrder();
    const index = manual ? dropIndex(list, e.clientY) : Infinity;
    draggingCardId = null;
    clearDropFeedback();
    const card = Board.findCard(board, cardId);
    if (!card || (!manual && card.columnId === columnId)) return;
    Board.moveCard(board, cardId, columnId, index);
    commit();
  });
}

// Cards in this list other than the one being dragged.
function otherCards(list) {
  return [...list.querySelectorAll('.card')].filter((c) => c.dataset.cardId !== draggingCardId);
}

// Index to insert at, based on which card midpoint the pointer is above.
function dropIndex(list, clientY) {
  const cards = otherCards(list);
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return cards.length;
}

function showDropIndicator(list, index) {
  let indicator = document.querySelector('.drop-indicator');
  if (!indicator) indicator = el('li', { className: 'drop-indicator', attrs: { 'aria-hidden': 'true' } });
  const before = otherCards(list)[index] || null;
  if (indicator.parentNode === list && indicator.nextElementSibling === before) return;
  list.insertBefore(indicator, before);
}

function clearDropFeedback() {
  document.querySelectorAll('.drop-indicator').forEach((n) => n.remove());
  document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
}

// ---- Card view (read-only, opened by clicking a card) ----

function wireViewDialog() {
  const dialog = $('view-dialog');
  closeOnBackdrop(dialog);
  dialog.addEventListener('close', () => {
    viewCardId = null;
  });
  $('view-close').addEventListener('click', () => dialog.close());

  $('view-edit').addEventListener('click', () => {
    const card = Board.findCard(board, viewCardId);
    if (card) openCardDialog({ card }); // opens on top; Save refreshes this view
  });

  $('view-status').addEventListener('change', (e) => {
    if (!viewCardId) return;
    Board.moveCard(board, viewCardId, e.target.value, Infinity);
    commit();
  });

  $('view-archive').addEventListener('click', () => {
    const card = Board.findCard(board, viewCardId);
    if (!card) return;
    if (card.archived) Board.restoreCard(board, card.id);
    else Board.archiveCard(board, card.id);
    commit();
  });

  $('view-delete').addEventListener('click', () => {
    if (!viewCardId) return;
    if (!window.confirm('Delete this card? This cannot be undone.')) return;
    Board.deleteCard(board, viewCardId);
    dialog.close();
    commit();
  });

  $('comment-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('comment-text').value;
    if (!viewCardId || !text.trim()) return;
    Board.addComment(board, viewCardId, text);
    $('comment-text').value = '';
    commit();
  });
  // Ctrl/Cmd + Enter saves the comment; plain Enter makes a new line.
  $('comment-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      $('comment-form').requestSubmit();
    }
  });
}

function openCardView(cardId) {
  viewCardId = cardId;
  $('comment-text').value = '';
  renderCardView();
  const dialog = $('view-dialog');
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('.dialog-body').scrollTop = 0;
}

function renderCardView() {
  const dialog = $('view-dialog');
  const card = Board.findCard(board, viewCardId);
  if (!card) {
    if (dialog.open) dialog.close();
    return;
  }
  const readOnly = card.archived; // archived cards are read-only until restored

  $('view-tags').replaceChildren(...[
    card.archived ? el('span', { className: 'badge badge-archived', text: 'Archived' }) : null,
    card.project ? projectLozenge(card.project) : null,
  ].filter(Boolean));
  $('view-title').textContent = card.title;

  const notes = $('view-notes');
  notes.textContent = card.notes || 'No description.';
  notes.classList.toggle('muted', !card.notes);

  renderViewTasks(card, readOnly);
  renderViewComments(card, readOnly);

  const columns = Board.visibleColumns(board).map((c) => ({ value: c.id, label: c.name }));
  setOptions($('view-status'), columns, card.columnId);
  $('view-status').disabled = readOnly;

  renderViewDetails(card);

  $('view-archive').textContent = card.archived ? 'Restore' : 'Archive';
  $('view-edit').hidden = readOnly;
  $('comment-form').hidden = readOnly;
}

function renderViewTasks(card, readOnly) {
  $('view-tasks-section').hidden = card.checklist.length === 0;
  const done = card.checklist.filter((i) => i.done).length;
  $('view-progress').max = card.checklist.length || 1;
  $('view-progress').value = done;
  $('view-tasks-count').textContent = card.checklist.length ? `${done} of ${card.checklist.length} done` : '';

  // Remember focus so ticking a box doesn't lose your place after the re-render.
  const focusedId = document.activeElement?.dataset?.itemId;

  $('view-tasks').replaceChildren(...card.checklist.map((item) => {
    const checkbox = el('input', {
      type: 'checkbox',
      dataset: { itemId: item.id },
      attrs: { 'aria-label': `Done: ${item.text}` },
    });
    checkbox.checked = item.done;
    checkbox.disabled = readOnly;
    checkbox.addEventListener('change', () => {
      Board.setChecklistItemDone(board, card.id, item.id, checkbox.checked);
      commit();
    });
    const label = el('label', { className: `checklist-label${item.done ? ' done' : ''}` }, [
      checkbox,
      el('span', { text: item.text }),
    ]);
    return el('li', { className: 'checklist-item' }, [label]);
  }));

  if (focusedId) $('view-tasks').querySelector(`[data-item-id="${CSS.escape(focusedId)}"]`)?.focus();
}

function renderViewComments(card, readOnly) {
  const comments = Board.liveComments(card).slice().reverse(); // newest first
  const items = comments.map((comment) => el('li', { className: 'comment' }, [
    el('div', { className: 'comment-head' }, [
      el('span', { className: 'comment-time', text: Board.formatDateTime(comment.createdAt) }),
      readOnly ? null : el('button', {
        className: 'link-btn',
        type: 'button',
        text: 'Delete',
        attrs: { 'aria-label': 'Delete comment' },
        on: {
          click: () => {
            if (!window.confirm('Delete this comment?')) return;
            Board.deleteComment(board, card.id, comment.id);
            commit();
          },
        },
      }),
    ]),
    el('p', { className: 'comment-text', text: comment.text }),
  ]));
  if (!items.length) items.push(el('li', { className: 'muted', text: 'No comments yet.' }));
  $('view-comments').replaceChildren(...items);
}

function renderViewDetails(card) {
  const none = () => el('span', { className: 'muted', text: 'None' });
  const duration = Board.durationDays(card.startDate, card.dueDate);
  const dueState = isDoneColumnId(card.columnId) || card.archived ? '' : Board.dueState(card.dueDate);

  const rows = [
    ['Priority', priorityBadge(card.priority) || none()],
    ['Project', card.project ? projectLozenge(card.project) : none()],
    ['Start date', card.startDate ? el('span', { text: Board.formatDate(card.startDate) }) : none()],
    ['Due date', card.dueDate ? dueBadge(Board.formatDate(card.dueDate), dueState) : none()],
    ['Duration', duration && duration > 0 ? el('span', { text: `${duration} day${duration === 1 ? '' : 's'}` }) : none()],
    ['Created', el('span', { text: Board.formatDateTime(card.createdAt) })],
    ['Updated', el('span', { text: Board.formatDateTime(card.updatedAt) })],
  ];
  if (card.archived) rows.push(['Archived', el('span', { text: Board.formatDateTime(card.archivedAt) })]);

  $('view-details').replaceChildren(...rows.flatMap(([label, value]) => [
    el('dt', { text: label }),
    el('dd', {}, [value]),
  ]));
}

// ---- Create / edit form ----

function wireCardDialog() {
  const dialog = $('card-dialog');
  closeOnBackdrop(dialog);
  $('card-close').addEventListener('click', () => dialog.close());
  $('card-cancel').addEventListener('click', () => dialog.close());

  $('card-start').addEventListener('input', updateDuration);
  $('card-due').addEventListener('input', updateDuration);

  $('checklist-add').addEventListener('click', addChecklistItem);
  $('checklist-new').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // add the task instead of submitting the form
      addChecklistItem();
    }
  });

  $('card-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveCardDialog();
  });
}

// Pass { card } to edit, or { columnId } to create a new card in that column.
function openCardDialog({ card = null, columnId = null }) {
  const isEdit = Boolean(card);
  cardDraft = {
    cardId: isEdit ? card.id : null,
    checklist: isEdit ? card.checklist.map((item) => ({ ...item })) : [],
  };

  $('card-dialog-title').textContent = isEdit ? 'Edit card' : 'Create card';
  $('card-submit').textContent = isEdit ? 'Save' : 'Create';

  $('card-title').value = isEdit ? card.title : '';
  $('card-notes').value = isEdit ? card.notes : '';
  $('card-project').value = isEdit ? card.project : '';
  $('card-start').value = isEdit ? card.startDate : '';
  $('card-due').value = isEdit ? card.dueDate : '';
  $('checklist-new').value = '';

  const columns = Board.visibleColumns(board).map((c) => ({ value: c.id, label: c.name }));
  setOptions($('card-status'), columns, isEdit ? card.columnId : columnId);
  setOptions($('card-priority'), Board.PRIORITIES, isEdit ? card.priority : '');
  $('project-list').replaceChildren(...Board.projectNames(board).map((name) => el('option', { value: name })));

  renderChecklist();
  updateDuration();

  const dialog = $('card-dialog');
  dialog.showModal();
  dialog.querySelector('.dialog-body').scrollTop = 0;
  $('card-title').focus();
}

function saveCardDialog() {
  const title = $('card-title').value.trim();
  if (!title) {
    $('card-title').reportValidity();
    return;
  }
  const fields = {
    title,
    notes: $('card-notes').value,
    priority: $('card-priority').value,
    project: $('card-project').value,
    startDate: $('card-start').value,
    dueDate: $('card-due').value,
    checklist: cardDraft.checklist,
  };
  const duration = Board.durationDays(fields.startDate, fields.dueDate);
  if (duration !== null && duration < 1) {
    $('card-due').focus();
    return; // the error message is already showing
  }

  const statusId = $('card-status').value;
  if (cardDraft.cardId) {
    Board.updateCard(board, cardDraft.cardId, fields);
    const card = Board.findCard(board, cardDraft.cardId);
    if (card && card.columnId !== statusId) Board.moveCard(board, card.id, statusId, Infinity);
  } else {
    Board.addCard(board, statusId, fields);
  }
  $('card-dialog').close();
  commit();
}

function updateDuration() {
  const days = Board.durationDays($('card-start').value, $('card-due').value);
  const invalid = days !== null && days < 1;
  $('card-duration').textContent = days === null || invalid ? '—' : `${days} day${days === 1 ? '' : 's'}`;
  $('card-date-error').hidden = !invalid;
}

function renderChecklist() {
  const items = cardDraft.checklist.map((item) => {
    const checkbox = el('input', { type: 'checkbox', attrs: { 'aria-label': 'Done' } });
    checkbox.checked = item.done;

    const text = el('input', {
      className: 'checklist-text',
      type: 'text',
      value: item.text,
      attrs: { maxlength: '500', 'aria-label': 'Task', autocomplete: 'off' },
    });
    text.classList.toggle('done', item.done);

    checkbox.addEventListener('change', () => {
      item.done = checkbox.checked;
      text.classList.toggle('done', item.done);
      updateChecklistProgress();
    });
    text.addEventListener('input', () => {
      item.text = text.value;
      updateChecklistProgress();
    });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('checklist-new').focus();
      }
    });

    const remove = el('button', {
      className: 'icon-btn',
      type: 'button',
      text: '×',
      attrs: { 'aria-label': 'Remove task' },
      on: {
        click: () => {
          cardDraft.checklist = cardDraft.checklist.filter((i) => i !== item);
          renderChecklist();
        },
      },
    });

    return el('li', { className: 'checklist-item' }, [checkbox, text, remove]);
  });
  $('checklist-items').replaceChildren(...items);
  updateChecklistProgress();
}

function updateChecklistProgress() {
  const items = cardDraft.checklist.filter((i) => i.text.trim());
  const done = items.filter((i) => i.done).length;
  const progress = $('checklist-progress');
  progress.hidden = items.length === 0;
  progress.max = items.length || 1;
  progress.value = done;
  $('checklist-count').textContent = items.length ? `${done} of ${items.length} done` : '';
}

function addChecklistItem() {
  const input = $('checklist-new');
  const text = input.value.trim();
  if (!text) return;
  cardDraft.checklist.push({ id: crypto.randomUUID(), text, done: false });
  input.value = '';
  renderChecklist();
  input.focus();
}

// ---- Archived cards ----

function wireArchiveDialog() {
  const dialog = $('archive-dialog');
  closeOnBackdrop(dialog);
  $('archive-close').addEventListener('click', () => dialog.close());
  $('archive-search').addEventListener('input', renderArchiveList);
}

function openArchive() {
  $('archive-search').value = '';
  renderArchiveList();
  $('archive-dialog').showModal();
}

function renderArchiveList() {
  const words = searchWords($('archive-search').value);
  const all = Board.archivedCards(board);
  const cards = all.filter((c) => matchesWords(c, words));

  $('archive-list').replaceChildren(...cards.map((card) => {
    const column = Board.findColumn(board, card.columnId);
    const meta = [
      column ? `From ${column.name}` : 'Column deleted',
      card.project,
      `Archived ${Board.formatDateTime(card.archivedAt)}`,
    ].filter(Boolean).join(' · ');

    return el('li', { className: 'archive-item' }, [
      el('button', {
        className: 'archive-open',
        type: 'button',
        on: { click: () => openCardView(card.id) },
      }, [
        el('span', { className: 'archive-title', text: card.title }),
        el('span', { className: 'muted small', text: meta }),
      ]),
      el('button', {
        className: 'btn',
        type: 'button',
        text: 'Restore',
        on: {
          click: () => {
            Board.restoreCard(board, card.id);
            commit();
          },
        },
      }),
    ]);
  }));

  const empty = $('archive-empty');
  empty.hidden = cards.length > 0;
  empty.textContent = all.length ? 'No matching archived cards.' : 'No archived cards.';
}

// ---- Column dialog ----

function wireColumnDialog() {
  const dialog = $('column-dialog');
  const name = $('column-name');

  closeOnBackdrop(dialog);
  dialog.addEventListener('close', () => {
    editingColumnId = null;
  });
  $('column-close').addEventListener('click', () => dialog.close());
  $('column-cancel').addEventListener('click', () => dialog.close());

  $('column-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!editingColumnId || !name.value.trim()) return;
    Board.renameColumn(board, editingColumnId, name.value);
    dialog.close();
    commit();
  });

  const shift = (delta) => {
    if (!editingColumnId) return;
    const index = Board.visibleColumns(board).findIndex((c) => c.id === editingColumnId);
    Board.moveColumn(board, editingColumnId, index + delta);
    commit();
    updateColumnButtons();
  };
  $('column-left').addEventListener('click', () => shift(-1));
  $('column-right').addEventListener('click', () => shift(1));

  $('column-archive').addEventListener('click', () => {
    if (!editingColumnId) return;
    const count = Board.visibleCards(board, editingColumnId).length;
    if (!count) return;
    if (!window.confirm(`Archive all ${count} card${count === 1 ? '' : 's'} in this column?`)) return;
    Board.archiveColumnCards(board, editingColumnId);
    dialog.close();
    commit();
  });

  $('column-delete').addEventListener('click', () => {
    if (!editingColumnId) return;
    const count = Board.visibleCards(board, editingColumnId).length;
    const message = count
      ? `Delete this column and its ${count} card${count === 1 ? '' : 's'}?`
      : 'Delete this column?';
    if (!window.confirm(message)) return;
    Board.deleteColumn(board, editingColumnId);
    dialog.close();
    commit();
  });
}

function updateColumnButtons() {
  const columns = Board.visibleColumns(board);
  const index = columns.findIndex((c) => c.id === editingColumnId);
  $('column-left').disabled = index <= 0;
  $('column-right').disabled = index >= columns.length - 1;
  const count = Board.visibleCards(board, editingColumnId).length;
  $('column-archive').disabled = count === 0;
  $('column-archive').textContent = count ? `Archive all ${count} card${count === 1 ? '' : 's'}` : 'No cards to archive';
}

function openColumnDialog(columnId) {
  const column = Board.findColumn(board, columnId);
  if (!column) return;
  editingColumnId = columnId;
  $('column-name').value = column.name;
  updateColumnButtons();
  $('column-dialog').showModal();
}
