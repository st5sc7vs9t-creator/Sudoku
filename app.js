'use strict';

/* ============================================================
   Sudoku engine — bitmask backtracking solver + generator
   ============================================================ */

const DIFFICULTY_CLUES = { easy: 42, medium: 32, hard: 26 };
const DIFFICULTY_LABELS = { easy: 'Lehká', medium: 'Střední', hard: 'Těžká' };

const SAVE_KEY = 'sudoku_save_v1';
const STATS_KEY = 'sudoku_stats_v1';

function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

function bitsToDigits(mask) {
  const arr = [];
  for (let d = 1; d <= 9; d++) {
    if (mask & (1 << (d - 1))) arr.push(d);
  }
  return arr;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function boxOf(r, c) {
  return Math.floor(r / 3) * 3 + Math.floor(c / 3);
}

function makeMasks(board) {
  const rowMask = new Array(9).fill(0);
  const colMask = new Array(9).fill(0);
  const boxMask = new Array(9).fill(0);
  for (let i = 0; i < 81; i++) {
    const v = board[i];
    if (v === 0) continue;
    const r = (i / 9) | 0, c = i % 9, b = boxOf(r, c);
    const bit = 1 << (v - 1);
    rowMask[r] |= bit; colMask[c] |= bit; boxMask[b] |= bit;
  }
  return { rowMask, colMask, boxMask };
}

function solveRandomFull(board) {
  const { rowMask, colMask, boxMask } = makeMasks(board);

  function backtrack() {
    let bestIdx = -1, bestCount = 10, bestCand = 0;
    for (let i = 0; i < 81; i++) {
      if (board[i] !== 0) continue;
      const r = (i / 9) | 0, c = i % 9, b = boxOf(r, c);
      const cand = (~(rowMask[r] | colMask[c] | boxMask[b])) & 0x1FF;
      const cnt = popcount(cand);
      if (cnt === 0) return false;
      if (cnt < bestCount) {
        bestCount = cnt; bestIdx = i; bestCand = cand;
        if (cnt === 1) break;
      }
    }
    if (bestIdx === -1) return true;
    const r = (bestIdx / 9) | 0, c = bestIdx % 9, b = boxOf(r, c);
    const digits = shuffle(bitsToDigits(bestCand));
    for (const d of digits) {
      const bit = 1 << (d - 1);
      board[bestIdx] = d;
      rowMask[r] |= bit; colMask[c] |= bit; boxMask[b] |= bit;
      if (backtrack()) return true;
      rowMask[r] ^= bit; colMask[c] ^= bit; boxMask[b] ^= bit;
      board[bestIdx] = 0;
    }
    return false;
  }

  return backtrack();
}

function countSolutions(board, limit) {
  const { rowMask, colMask, boxMask } = makeMasks(board);
  let count = 0;

  function backtrack() {
    if (count >= limit) return;
    let bestIdx = -1, bestCount = 10, bestCand = 0;
    for (let i = 0; i < 81; i++) {
      if (board[i] !== 0) continue;
      const r = (i / 9) | 0, c = i % 9, b = boxOf(r, c);
      const cand = (~(rowMask[r] | colMask[c] | boxMask[b])) & 0x1FF;
      const cnt = popcount(cand);
      if (cnt === 0) return;
      if (cnt < bestCount) {
        bestCount = cnt; bestIdx = i; bestCand = cand;
        if (cnt === 1) break;
      }
    }
    if (bestIdx === -1) { count++; return; }
    const r = (bestIdx / 9) | 0, c = bestIdx % 9, b = boxOf(r, c);
    let cand = bestCand;
    while (cand !== 0) {
      const bit = cand & (-cand);
      cand ^= bit;
      const d = 31 - Math.clz32(bit);
      board[bestIdx] = d + 1;
      rowMask[r] |= bit; colMask[c] |= bit; boxMask[b] |= bit;
      backtrack();
      rowMask[r] ^= bit; colMask[c] ^= bit; boxMask[b] ^= bit;
      board[bestIdx] = 0;
      if (count >= limit) return;
    }
  }

  backtrack();
  return count;
}

function generatePuzzle(difficulty) {
  const solution = new Array(81).fill(0);
  solveRandomFull(solution);

  const puzzle = solution.slice();
  const positions = shuffle([...Array(81).keys()]);
  const targetClues = DIFFICULTY_CLUES[difficulty] || 32;
  let clueCount = 81;

  for (const pos of positions) {
    if (clueCount <= targetClues) break;
    const backup = puzzle[pos];
    if (backup === 0) continue;
    puzzle[pos] = 0;
    const testBoard = puzzle.slice();
    const solutions = countSolutions(testBoard, 2);
    if (solutions === 1) {
      clueCount--;
    } else {
      puzzle[pos] = backup;
    }
  }

  return { puzzle, solution };
}

/* ============================================================
   Peer precomputation
   ============================================================ */

const PEERS = [];
for (let i = 0; i < 81; i++) {
  const r = (i / 9) | 0, c = i % 9, b = boxOf(r, c);
  const set = new Set();
  for (let k = 0; k < 9; k++) {
    set.add(r * 9 + k);
    set.add(k * 9 + c);
  }
  const br = Math.floor(b / 3) * 3, bc = (b % 3) * 3;
  for (let dr = 0; dr < 3; dr++) {
    for (let dc = 0; dc < 3; dc++) {
      set.add((br + dr) * 9 + (bc + dc));
    }
  }
  set.delete(i);
  PEERS.push(set);
}

/* ============================================================
   Game state
   ============================================================ */

let state = null;

function newGameState(difficulty) {
  const { puzzle, solution } = generatePuzzle(difficulty);
  return {
    difficulty,
    board: puzzle.slice(),
    solution,
    given: puzzle.map(v => v !== 0),
    hintCells: new Array(81).fill(false),
    selected: null,
    history: [],
    mistakes: 0,
    hints: 0,
    accumulatedMs: 0,
    sessionStartTs: Date.now(),
    solved: false,
  };
}

function flushTime() {
  const now = Date.now();
  state.accumulatedMs += now - state.sessionStartTs;
  state.sessionStartTs = now;
}

function persistSave() {
  if (!state || state.solved) return;
  flushTime();
  const data = {
    difficulty: state.difficulty,
    board: state.board,
    solution: state.solution,
    given: state.given,
    hintCells: state.hintCells,
    history: state.history,
    mistakes: state.mistakes,
    hints: state.hints,
    accumulatedMs: state.accumulatedMs,
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { /* ignore quota errors */ }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function restoreGameState(saved) {
  state = {
    difficulty: saved.difficulty,
    board: saved.board.slice(),
    solution: saved.solution.slice(),
    given: saved.given.slice(),
    hintCells: saved.hintCells ? saved.hintCells.slice() : new Array(81).fill(false),
    selected: null,
    history: saved.history || [],
    mistakes: saved.mistakes || 0,
    hints: saved.hints || 0,
    accumulatedMs: saved.accumulatedMs || 0,
    sessionStartTs: Date.now(),
    solved: false,
  };
}

/* ============================================================
   Stats
   ============================================================ */

function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function recordCompletedGame() {
  flushTime();
  const stats = loadStats();
  stats.push({
    ts: Date.now(),
    difficulty: state.difficulty,
    mistakes: state.mistakes,
    hints: state.hints,
    seconds: Math.round(state.accumulatedMs / 1000),
  });
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) { /* ignore */ }
}

function formatDateTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderStats() {
  const stats = loadStats();
  const el = document.getElementById('stats-content');
  el.innerHTML = '';

  const total = stats.length;
  const byDifficulty = { easy: 0, medium: 0, hard: 0 };
  let totalMistakes = 0;
  let cleanGames = 0;
  for (const g of stats) {
    if (byDifficulty[g.difficulty] !== undefined) byDifficulty[g.difficulty]++;
    totalMistakes += g.mistakes;
    if (g.mistakes === 0) cleanGames++;
  }
  const avgMistakes = total > 0 ? (totalMistakes / total).toFixed(1) : '0';

  function addRow(label, value) {
    const row = document.createElement('div');
    row.className = 'stats-row';
    row.innerHTML = `<span>${label}</span><span class="stats-big">${value}</span>`;
    el.appendChild(row);
  }

  addRow('Celkem odehraných her', total);
  addRow('— Lehká', byDifficulty.easy);
  addRow('— Střední', byDifficulty.medium);
  addRow('— Těžká', byDifficulty.hard);
  addRow('Průměrný počet chyb na hru', avgMistakes);
  addRow('Čisté hry (bez chyby)', cleanGames);

  const title = document.createElement('div');
  title.className = 'stats-section-title';
  title.textContent = 'Posledních her';
  el.appendChild(title);

  const list = document.createElement('div');
  list.className = 'history-list';
  const last10 = stats.slice(-10).reverse();
  if (last10.length === 0) {
    const p = document.createElement('div');
    p.textContent = 'Zatím žádné dokončené hry.';
    list.appendChild(p);
  } else {
    for (const g of last10) {
      const item = document.createElement('div');
      item.className = 'history-item';
      const mClass = g.mistakes === 0 ? 'mistakes-good' : 'mistakes-bad';
      const mText = g.mistakes === 0 ? 'bez chyby' : `${g.mistakes}× chyba`;
      item.innerHTML = `<span>${formatDateTime(g.ts)} — ${DIFFICULTY_LABELS[g.difficulty] || g.difficulty}</span><span class="${mClass}">${mText}</span>`;
      list.appendChild(item);
    }
  }
  el.appendChild(list);
}

/* ============================================================
   Rendering
   ============================================================ */

let cellEls = [];

function buildBoardDom() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  cellEls = [];
  for (let i = 0; i < 81; i++) {
    const r = (i / 9) | 0, c = i % 9;
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (c === 2 || c === 5) cell.classList.add('border-right-thick');
    if (r === 2 || r === 5) cell.classList.add('border-bottom-thick');
    cell.dataset.index = String(i);
    cell.addEventListener('click', () => onCellClick(i));
    board.appendChild(cell);
    cellEls.push(cell);
  }
}

function recomputeErrors() {
  const errors = new Set();
  for (let i = 0; i < 81; i++) {
    const v = state.board[i];
    if (v === 0) continue;
    for (const p of PEERS[i]) {
      if (state.board[p] === v) { errors.add(i); break; }
    }
  }
  return errors;
}

function renderBoard() {
  const errors = recomputeErrors();
  const selected = state.selected;
  const selectedValue = selected !== null ? state.board[selected] : 0;

  for (let i = 0; i < 81; i++) {
    const cell = cellEls[i];
    const v = state.board[i];
    cell.textContent = v === 0 ? '' : String(v);

    cell.classList.toggle('cell-given', state.given[i]);
    cell.classList.toggle('cell-hint', state.hintCells[i]);
    cell.classList.toggle('cell-error', errors.has(i));
    cell.classList.toggle('cell-peer', selected !== null && PEERS[selected].has(i));
    cell.classList.toggle('cell-samevalue', selectedValue !== 0 && v === selectedValue && i !== selected);
    cell.classList.toggle('cell-selected', i === selected);
  }

  document.getElementById('board').classList.toggle('board-solved', state.solved);
}

/* ============================================================
   Game actions
   ============================================================ */

function onCellClick(i) {
  if (state.solved) return;
  state.selected = i;
  renderBoard();
}

function enterDigit(d) {
  if (!state || state.solved) return;
  const i = state.selected;
  if (i === null || state.given[i]) return;
  const prev = state.board[i];
  if (prev === d) return;

  const conflict = [...PEERS[i]].some(p => state.board[p] === d);

  state.board[i] = d;
  state.hintCells[i] = false;
  state.history.push({ index: i, prev, wasHint: false });
  if (conflict) state.mistakes++;

  renderBoard();
  persistSave();
  checkWin();
}

function eraseCell() {
  if (!state || state.solved) return;
  const i = state.selected;
  if (i === null || state.given[i]) return;
  const prev = state.board[i];
  if (prev === 0) return;
  state.board[i] = 0;
  state.hintCells[i] = false;
  state.history.push({ index: i, prev, wasHint: false });
  renderBoard();
  persistSave();
}

function undo() {
  if (!state || state.solved) return;
  const move = state.history.pop();
  if (!move) return;
  state.board[move.index] = move.prev;
  state.selected = move.index;
  renderBoard();
  persistSave();
}

function hint() {
  if (!state || state.solved) return;
  const candidates = [];
  for (let i = 0; i < 81; i++) {
    if (!state.given[i] && state.board[i] !== state.solution[i]) candidates.push(i);
  }
  if (candidates.length === 0) return;
  const i = candidates[Math.floor(Math.random() * candidates.length)];
  const prev = state.board[i];
  state.board[i] = state.solution[i];
  state.hintCells[i] = true;
  state.history.push({ index: i, prev, wasHint: true });
  state.hints++;
  state.selected = i;
  renderBoard();
  persistSave();
  checkWin();
}

function checkWin() {
  if (state.board.includes(0)) return;
  const errors = recomputeErrors();
  if (errors.size > 0) return;

  state.solved = true;
  state.selected = null;
  recordCompletedGame();
  clearSave();
  renderBoard();
  document.getElementById('win-overlay').classList.remove('hidden');
}

/* ============================================================
   Screen / flow control
   ============================================================ */

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

function startNewGame(difficulty) {
  document.getElementById('win-overlay').classList.add('hidden');
  showScreen('game');
  document.getElementById('loading-overlay').classList.remove('hidden');
  setTimeout(() => {
    state = newGameState(difficulty);
    buildBoardDom();
    renderBoard();
    persistSave();
    document.getElementById('loading-overlay').classList.add('hidden');
  }, 30);
}

function continueSavedGame() {
  const saved = loadSave();
  if (!saved) return;
  restoreGameState(saved);
  showScreen('game');
  buildBoardDom();
  renderBoard();
}

function goToMenu() {
  if (state && !state.solved) persistSave();
  const saved = loadSave();
  const btn = document.getElementById('btn-continue');
  btn.classList.toggle('hidden', !saved);
  showScreen('start');
}

/* ============================================================
   Wiring
   ============================================================ */

function init() {
  document.querySelectorAll('.btn-difficulty').forEach(btn => {
    btn.addEventListener('click', () => startNewGame(btn.dataset.difficulty));
  });

  document.getElementById('btn-continue').addEventListener('click', continueSavedGame);
  document.getElementById('btn-stats').addEventListener('click', () => { renderStats(); showScreen('stats'); });
  document.getElementById('btn-stats-back').addEventListener('click', () => {
    showScreen(state ? 'game' : 'start');
    if (!state) goToMenu();
  });

  document.getElementById('btn-back-menu').addEventListener('click', goToMenu);
  document.getElementById('btn-new-game').addEventListener('click', () => {
    startNewGame(state ? state.difficulty : 'easy');
  });

  document.querySelectorAll('.num-btn').forEach(btn => {
    btn.addEventListener('click', () => enterDigit(parseInt(btn.dataset.num, 10)));
  });
  document.getElementById('btn-erase').addEventListener('click', eraseCell);
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-hint').addEventListener('click', hint);

  document.getElementById('btn-next-game').addEventListener('click', () => {
    startNewGame(state.difficulty);
  });
  document.getElementById('btn-win-menu').addEventListener('click', () => {
    document.getElementById('win-overlay').classList.add('hidden');
    goToMenu();
  });

  window.addEventListener('beforeunload', () => { if (state && !state.solved) persistSave(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state && !state.solved) persistSave();
    else if (!document.hidden && state && !state.solved) state.sessionStartTs = Date.now();
  });

  const saved = loadSave();
  document.getElementById('btn-continue').classList.toggle('hidden', !saved);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline-first, ignore */ });
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
