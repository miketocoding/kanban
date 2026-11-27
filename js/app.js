// Entry point.
// Milestone 1: the board lives in memory only and resets on reload.
// Setup / unlock screens, crypto, and sync arrive in later milestones.

import * as Board from './board.js';
import { initUI } from './ui.js';

// "YYYY-MM-DD" for today + n days (sample data only).
function daysFromToday(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const task = (text, done = false) => ({ text, done });

// Fake test data only (per the brief, no real data until sync is tested).
function createSampleBoard() {
  const board = Board.createBoard();
  const [todo, doing, done] = Board.visibleColumns(board);

  Board.addCard(board, todo.id, {
    title: 'Sample: plan the garden layout',
    notes: 'Measure the beds first.',
    project: 'Home',
    priority: 'medium',
    startDate: daysFromToday(3),
    dueDate: daysFromToday(10),
    checklist: [task('Measure beds'), task('Pick plants'), task('Buy soil')],
  });
  Board.addCard(board, todo.id, {
    title: 'Sample: renew passport',
    project: 'Admin',
    priority: 'high',
    dueDate: daysFromToday(1),
  });
  Board.addCard(board, todo.id, {
    title: 'Sample: a card with a long name to check that wrapping works nicely on a narrow phone screen',
  });
  const report = Board.addCard(board, doing.id, {
    title: 'Sample: write the quarterly report',
    notes: 'Chapter 4 next.\nTake notes on the good bits.',
    project: 'Work',
    priority: 'critical',
    startDate: daysFromToday(-7),
    dueDate: daysFromToday(-1),
    checklist: [task('Gather numbers', true), task('Draft', true), task('Review')],
  });
  Board.addComment(board, report.id, 'Sample comment: numbers are in the shared folder.');
  Board.addCard(board, doing.id, {
    title: 'Sample: learn Web Crypto',
    project: 'Learning',
    priority: 'low',
    startDate: daysFromToday(-2),
  });
  Board.addCard(board, done.id, {
    title: 'Sample: <b>not bold</b> (shows text is escaped)',
    project: 'Work',
    dueDate: daysFromToday(-3),
    checklist: [task('One', true), task('Two', true)],
  });
  const old = Board.addCard(board, done.id, {
    title: 'Sample: an old finished card',
    project: 'Home',
  });
  Board.archiveCard(board, old.id);
  return board;
}

const board = Board.normalizeBoard(createSampleBoard());

initUI(document.getElementById('board'), board, () => {
  // Later milestones: schedule an encrypted save here.
});
