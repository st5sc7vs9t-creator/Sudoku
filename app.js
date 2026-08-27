'use strict';

/* ============================================================
   Offline support (service worker)
   ============================================================ */

/* Registered here, before any game code runs, and deliberately not from inside
   init(): this used to be the last statement of init(), so any earlier failure
   -- a corrupt saved game, an unexpected DOM state -- skipped it silently. The
   game still worked while online, and then the first launch without wifi hit
   the browser's "no internet" page, because nothing had ever been cached. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { scope: './' })
    .catch(() => { /* offline-first: nothing useful to do if it fails */ });
}

/* Confirm the game really is stored on the tablet and say so on the start
   screen, so it is visible when it is safe to close it or switch wifi off.
   On its own load listener, so a failure in init() cannot take it down. */
let ensureCacheAsked = false;

function showOfflineReady() {
  const el = document.getElementById('offline-ready');
  if (el) el.classList.remove('hidden');
}

async function verifyOfflineReady() {
  if (!('caches' in window) || !('serviceWorker' in navigator)) return;
  const needed = ['./index.html', './style.css', './app.js'];
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const hits = await Promise.all(needed.map(u => caches.match(u, { ignoreSearch: true })));
      if (hits.every(Boolean) && navigator.serviceWorker.controller) {
        showOfflineReady();
        return;
      }
      /* Registered, but the files are gone -- evicted under storage pressure,
         or an install that never finished. Ask the worker to stock up again. */
      if (!ensureCacheAsked && navigator.serviceWorker.controller) {
        ensureCacheAsked = true;
        navigator.serviceWorker.controller.postMessage('ensure-cache');
      }
    } catch (e) { return; }
    await new Promise(r => setTimeout(r, 500));
  }
}

window.addEventListener('load', verifyOfflineReady);

/* ============================================================
   Sudoku engine — bitmask backtracking solver + generator
   Supports two variants: classic 9x9 (3x3 boxes) and mini 6x6 (2x3 boxes)
   ============================================================ */

const BOX_DIMS = {
  9: { r: 3, c: 3 },
  6: { r: 2, c: 3 },
};

const VARIANTS = {
  easy:   { size: 9, clues: 42, label: 'Lehká' },
  medium: { size: 9, clues: 32, label: 'Střední' },
  hard:   { size: 9, clues: 26, label: 'Těžká' },
  mini:   { size: 6, clues: 20, label: 'Mini (6×6)' },
};

const DIFFICULTY_LABELS = {
  easy: 'Lehká', medium: 'Střední', hard: 'Těžká', mini: 'Mini (6×6)',
};

const SAVE_KEY = 'sudoku_save_v1';
const STATS_KEY = 'sudoku_stats_v1';

function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

function bitsToDigits(mask, size) {
  const arr = [];
  for (let d = 1; d <= size; d++) {
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

function boxOf(r, c, size) {
  const dims = BOX_DIMS[size];
  const boxesPerRow = size / dims.c;
  return Math.floor(r / dims.r) * boxesPerRow + Math.floor(c / dims.c);
}

function makeMasks(board, size) {
  const rowMask = new Array(size).fill(0);
  const colMask = new Array(size).fill(0);
  const boxMask = new Array(size).fill(0);
  const total = size * size;
  for (let i = 0; i < total; i++) {
    const v = board[i];
    if (v === 0) continue;
    const r = (i / size) | 0, c = i % size, b = boxOf(r, c, size);
    const bit = 1 << (v - 1);
    rowMask[r] |= bit; colMask[c] |= bit; boxMask[b] |= bit;
  }
  return { rowMask, colMask, boxMask };
}

function solveRandomFull(board, size) {
  const fullMask = (1 << size) - 1;
  const { rowMask, colMask, boxMask } = makeMasks(board, size);
  const total = size * size;

  function backtrack() {
    let bestIdx = -1, bestCount = size + 1, bestCand = 0;
    for (let i = 0; i < total; i++) {
      if (board[i] !== 0) continue;
      const r = (i / size) | 0, c = i % size, b = boxOf(r, c, size);
      const cand = (~(rowMask[r] | colMask[c] | boxMask[b])) & fullMask;
      const cnt = popcount(cand);
      if (cnt === 0) return false;
      if (cnt < bestCount) {
        bestCount = cnt; bestIdx = i; bestCand = cand;
        if (cnt === 1) break;
      }
    }
    if (bestIdx === -1) return true;
    const r = (bestIdx / size) | 0, c = bestIdx % size, b = boxOf(r, c, size);
    const digits = shuffle(bitsToDigits(bestCand, size));
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

function countSolutions(board, size, limit) {
  const fullMask = (1 << size) - 1;
  const { rowMask, colMask, boxMask } = makeMasks(board, size);
  const total = size * size;
  let count = 0;

  function backtrack() {
    if (count >= limit) return;
    let bestIdx = -1, bestCount = size + 1, bestCand = 0;
    for (let i = 0; i < total; i++) {
      if (board[i] !== 0) continue;
      const r = (i / size) | 0, c = i % size, b = boxOf(r, c, size);
      const cand = (~(rowMask[r] | colMask[c] | boxMask[b])) & fullMask;
      const cnt = popcount(cand);
      if (cnt === 0) return;
      if (cnt < bestCount) {
        bestCount = cnt; bestIdx = i; bestCand = cand;
        if (cnt === 1) break;
      }
    }
    if (bestIdx === -1) { count++; return; }
    const r = (bestIdx / size) | 0, c = bestIdx % size, b = boxOf(r, c, size);
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

function generatePuzzle(difficultyKey) {
  const variant = VARIANTS[difficultyKey];
  const size = variant.size;
  const total = size * size;

  const solution = new Array(total).fill(0);
  solveRandomFull(solution, size);

  const puzzle = solution.slice();
  const positions = shuffle([...Array(total).keys()]);
  const targetClues = variant.clues;
  let clueCount = total;

  for (const pos of positions) {
    if (clueCount <= targetClues) break;
    const backup = puzzle[pos];
    if (backup === 0) continue;
    puzzle[pos] = 0;
    const testBoard = puzzle.slice();
    const solutions = countSolutions(testBoard, size, 2);
    if (solutions === 1) {
      clueCount--;
    } else {
      puzzle[pos] = backup;
    }
  }

  return { puzzle, solution, size };
}

/* ============================================================
   Peer precomputation (cached per grid size)
   ============================================================ */

const PEERS_CACHE = {};

function getPeers(size) {
  if (PEERS_CACHE[size]) return PEERS_CACHE[size];
  const dims = BOX_DIMS[size];
  const boxesPerRow = size / dims.c;
  const total = size * size;
  const peers = [];
  for (let i = 0; i < total; i++) {
    const r = (i / size) | 0, c = i % size, b = boxOf(r, c, size);
    const set = new Set();
    for (let k = 0; k < size; k++) {
      set.add(r * size + k);
      set.add(k * size + c);
    }
    const boxRow = Math.floor(b / boxesPerRow), boxCol = b % boxesPerRow;
    const br = boxRow * dims.r, bc = boxCol * dims.c;
    for (let dr = 0; dr < dims.r; dr++) {
      for (let dc = 0; dc < dims.c; dc++) {
        set.add((br + dr) * size + (bc + dc));
      }
    }
    set.delete(i);
    peers.push(set);
  }
  PEERS_CACHE[size] = peers;
  return peers;
}

/* ============================================================
   Game state
   ============================================================ */

let state = null;

function newGameState(difficultyKey) {
  const { puzzle, solution, size } = generatePuzzle(difficultyKey);
  const dims = BOX_DIMS[size];
  return {
    difficulty: difficultyKey,
    size,
    boxRows: dims.r,
    boxCols: dims.c,
    peers: getPeers(size),
    board: puzzle.slice(),
    solution,
    given: puzzle.map(v => v !== 0),
    hintCells: new Array(size * size).fill(false),
    selected: null,
    history: [],
    mistakes: 0,
    hints: 0,
    accumulatedMs: 0,
    sessionStartTs: Date.now(),
    solved: false,
  };
}

function stateFromPuzzle(difficultyKey, given, solution) {
  const variant = VARIANTS[difficultyKey] || VARIANTS.easy;
  const size = variant.size;
  const dims = BOX_DIMS[size];
  const board = solution.map((v, i) => (given[i] ? v : 0));
  return {
    difficulty: difficultyKey,
    size,
    boxRows: dims.r,
    boxCols: dims.c,
    peers: getPeers(size),
    board,
    solution: solution.slice(),
    given: given.slice(),
    hintCells: new Array(size * size).fill(false),
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
  const variant = VARIANTS[saved.difficulty] || VARIANTS.easy;
  const size = variant.size;
  const dims = BOX_DIMS[size];
  state = {
    difficulty: saved.difficulty,
    size,
    boxRows: dims.r,
    boxCols: dims.c,
    peers: getPeers(size),
    board: saved.board.slice(),
    solution: saved.solution.slice(),
    given: saved.given.slice(),
    hintCells: saved.hintCells ? saved.hintCells.slice() : new Array(size * size).fill(false),
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

function starsForResult(mistakes, hints) {
  return Math.max(0, 3 - mistakes - hints);
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
    stars: starsForResult(state.mistakes, state.hints),
    given: state.given,
    solution: state.solution,
  });
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) { /* ignore */ }
}

function starsHtml(n, small) {
  let html = '';
  for (let i = 0; i < 3; i++) {
    html += `<span class="star ${small ? 'star-small' : ''} ${i < n ? 'star-filled' : 'star-empty'}">★</span>`;
  }
  return html;
}

function startRepeatGame(ts) {
  const stats = loadStats();
  const entry = stats.find(g => g.ts === ts);
  if (!entry || !entry.given || !entry.solution) return;
  document.getElementById('win-overlay').classList.add('hidden');
  showScreen('game');
  state = stateFromPuzzle(entry.difficulty, entry.given, entry.solution);
  buildBoardDom();
  buildNumpadDom();
  renderBoard();
  persistSave();
}

function formatDateTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function renderStats() {
  const stats = loadStats();
  const el = document.getElementById('stats-content');
  el.innerHTML = '';

  const total = stats.length;
  const byDifficulty = { easy: 0, medium: 0, hard: 0, mini: 0 };
  let totalMistakes = 0;
  let cleanGames = 0;
  let totalSeconds = 0;
  let totalHints = 0;
  for (const g of stats) {
    if (byDifficulty[g.difficulty] !== undefined) byDifficulty[g.difficulty]++;
    totalMistakes += g.mistakes;
    if (g.mistakes === 0) cleanGames++;
    totalSeconds += g.seconds || 0;
    totalHints += g.hints || 0;
  }
  const avgMistakes = total > 0 ? (totalMistakes / total).toFixed(1) : '0';
  const avgSeconds = total > 0 ? Math.round(totalSeconds / total) : 0;
  const avgHints = total > 0 ? (totalHints / total).toFixed(1) : '0';

  function addRow(label, value) {
    const row = document.createElement('div');
    row.className = 'stats-row';
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    const valueSpan = document.createElement('span');
    valueSpan.className = 'stats-big';
    valueSpan.textContent = String(value);
    row.appendChild(labelSpan);
    row.appendChild(valueSpan);
    el.appendChild(row);
  }

  addRow('Celkem odehraných her', total);
  addRow('— Lehká', byDifficulty.easy);
  addRow('— Střední', byDifficulty.medium);
  addRow('— Těžká', byDifficulty.hard);
  addRow('— Mini (6×6)', byDifficulty.mini);
  addRow('Průměrný počet chyb na hru', avgMistakes);
  addRow('Průměrný počet nápověd na hru', avgHints);
  addRow('Průměrná délka hry', total > 0 ? formatDuration(avgSeconds) : '—');
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
      const mText = g.mistakes === 0 ? 'bez chyby' : `${g.mistakes}× chyba`;
      const hText = g.hints ? `, ${g.hints}× nápověda` : '';
      const timeText = formatDuration(g.seconds || 0);
      const label = DIFFICULTY_LABELS[g.difficulty] || String(g.difficulty);
      const stars = typeof g.stars === 'number' ? g.stars : starsForResult(g.mistakes || 0, g.hints || 0);
      const canRepeat = g.given && g.solution;

      const item = document.createElement('div');
      item.className = 'history-item';

      const top = document.createElement('div');
      top.className = 'history-item-top';
      const main = document.createElement('span');
      main.className = 'history-main';
      main.textContent = `${formatDateTime(g.ts)} — ${label} — ${timeText}`;
      const starsSpan = document.createElement('span');
      starsSpan.className = 'history-stars';
      starsSpan.innerHTML = starsHtml(stars, true);
      top.appendChild(main);
      top.appendChild(starsSpan);

      const bottom = document.createElement('div');
      bottom.className = 'history-item-bottom';
      const detail = document.createElement('span');
      detail.className = 'history-detail';
      detail.textContent = `${mText}${hText}`;
      bottom.appendChild(detail);
      if (canRepeat) {
        const repeatBtn = document.createElement('button');
        repeatBtn.className = 'btn btn-repeat';
        repeatBtn.dataset.ts = String(g.ts);
        repeatBtn.textContent = 'Zopakovat';
        bottom.appendChild(repeatBtn);
      }

      item.appendChild(top);
      item.appendChild(bottom);
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
  board.style.gridTemplateColumns = `repeat(${state.size}, 1fr)`;
  board.style.gridTemplateRows = `repeat(${state.size}, 1fr)`;
  cellEls = [];
  const total = state.size * state.size;
  for (let i = 0; i < total; i++) {
    const r = (i / state.size) | 0, c = i % state.size;
    const cell = document.createElement('div');
    cell.className = 'cell';
    if ((c + 1) % state.boxCols === 0 && c !== state.size - 1) cell.classList.add('border-right-thick');
    if ((r + 1) % state.boxRows === 0 && r !== state.size - 1) cell.classList.add('border-bottom-thick');
    cell.dataset.index = String(i);
    cell.addEventListener('click', () => onCellClick(i));
    board.appendChild(cell);
    cellEls.push(cell);
  }
}

function buildNumpadDom() {
  const numpad = document.getElementById('numpad');
  numpad.innerHTML = '';
  for (let d = 1; d <= state.size; d++) {
    const btn = document.createElement('button');
    btn.className = 'btn num-btn';
    btn.dataset.num = String(d);
    btn.textContent = String(d);
    numpad.appendChild(btn);
  }
}

function recomputeErrors() {
  const errors = new Set();
  const total = state.board.length;
  for (let i = 0; i < total; i++) {
    const v = state.board[i];
    if (v === 0) continue;
    for (const p of state.peers[i]) {
      if (state.board[p] === v) { errors.add(i); break; }
    }
  }
  return errors;
}

function renderBoard() {
  const errors = recomputeErrors();
  const selected = state.selected;
  const selectedValue = selected !== null ? state.board[selected] : 0;
  const total = state.board.length;

  for (let i = 0; i < total; i++) {
    const cell = cellEls[i];
    const v = state.board[i];
    cell.textContent = v === 0 ? '' : String(v);

    cell.classList.toggle('cell-given', state.given[i]);
    cell.classList.toggle('cell-hint', state.hintCells[i]);
    cell.classList.toggle('cell-error', errors.has(i));
    cell.classList.toggle('cell-peer', selected !== null && state.peers[selected].has(i));
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

  const conflict = [...state.peers[i]].some(p => state.board[p] === d);

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
  if (move.wasHint) {
    // Only clear the visual hint highlight — the hint was already seen, so it
    // must keep counting against the star rating even after undoing the digit.
    state.hintCells[move.index] = false;
  }
  state.selected = move.index;
  renderBoard();
  persistSave();
}

function hint() {
  if (!state || state.solved) return;
  const total = state.board.length;
  const candidates = [];
  for (let i = 0; i < total; i++) {
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
  const elapsedSeconds = Math.round(state.accumulatedMs / 1000);
  const stars = starsForResult(state.mistakes, state.hints);
  clearSave();
  renderBoard();
  document.getElementById('win-time').textContent = `Čas hry: ${formatDuration(elapsedSeconds)}`;
  document.getElementById('win-stars').innerHTML = starsHtml(stars, false);
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
    buildNumpadDom();
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
  buildNumpadDom();
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

  document.getElementById('stats-content').addEventListener('click', e => {
    const btn = e.target.closest('.btn-repeat');
    if (btn) startRepeatGame(Number(btn.dataset.ts));
  });

  document.getElementById('btn-back-menu').addEventListener('click', goToMenu);
  document.getElementById('btn-new-game').addEventListener('click', () => {
    startNewGame(state ? state.difficulty : 'easy');
  });

  document.getElementById('numpad').addEventListener('click', e => {
    const btn = e.target.closest('.num-btn');
    if (btn) enterDigit(parseInt(btn.dataset.num, 10));
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
}

document.addEventListener('DOMContentLoaded', init);
