// Wiring: DOM, pointer gestures, the clock, storage, and the `window.kuromasu` surface the
// verification harness drives. No rule about the board lives here — every judgement comes from
// js/engine/kuromasu.js through js/ui/game.js.

import { Palette, Cell, applyThemeVars, setReduceMotion, prefersReducedMotion, systemPrefersReducedMotion } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import { TIERS, tierFor, makePuzzle, generate, randomSolution, pruneClues, mix } from './engine/generate.js';
import * as Engine from './engine/kuromasu.js';
import { countSolutions } from './engine/count.js';
import { BoardView } from './render/board.js';
import { createAnim, resetAnim, spawnRipple, spawnBurst, advance, busy, snapshot } from './render/anim.js';
import { Game, name, OPEN, BLACK, WHITE, NO_CLUE } from './ui/game.js';

const VERSION = '1.0.0';

const $ = (sel) => document.querySelector(sel);
const el = {
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  time: $('#stat-time'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  filled: $('#stat-filled'),
  remaining: $('#stat-remaining'),
  satisfied: $('#stat-satisfied'),
  conflicts: $('#stat-conflicts'),
  score: $('#stat-score'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  stateLine: $('#state-line'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
  modeBlack: $('#btn-mode-black'),
  modeWhite: $('#btn-mode-white'),
  erase: $('#btn-erase'),
  pause: $('#btn-pause'),
  restart: $('#btn-restart'),
  fullscreen: $('#btn-fullscreen'),
  pauseVeil: $('#pause-veil'),
  helpVeil: $('#help-veil'),
};

const view = new BoardView(el.canvas);
let game = null;
let pulse = null;
let stroke = null;
let erasing = false;
let startedAt = 0;
let baseElapsed = 0;
let ticker = 0;
// 暂停与动画是同一件事的两半：暂停要把时钟真的停下，动画要有一条不吃刷新率的虚拟时间轴。
let paused = false;
let helpOpen = false;
let anim = createAnim();
let raf = 0;
let lastFrame = 0;
let kickAt = 0;
let kicker = 0;

// rAF 的时间戳与 performance.now 同一条时钟，与 Date.now 不是：混用会让首帧的 dt 是
// 一个几百秒的巨数。取不到 performance 的宿主（老 Electron）才退回 Date.now。
const frameStamp = () => (typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
  ? performance.now()
  : Date.now());

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const running = () => !!startedAt;
// 此刻这一局在程序里到底是哪一段：菜单 / 在解 / 停下 / 解开。探针与断言都只读这一个数。
const phase = () => (!game ? 'menu' : game.status === 'won' ? 'won' : paused ? 'paused' : 'playing');

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function availBox() {
  const narrow = window.innerWidth <= 900;
  const w = narrow ? window.innerWidth - 60 : el.viewGame.clientWidth - 340;
  return { w: Math.max(240, w), h: Math.max(240, window.innerHeight - 250) };
}

function draw() {
  if (!game) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  view.draw(game, {
    pulse,
    anim,
    preview: stroke && stroke.items.length ? { cells: stroke.items.map((i) => i.cell), value: stroke.value } : null,
  });
}

// 每帧只消费一个 dt：把它累到 anim.clock 上，其余一切（半径/位移/透明度）都是 clock 的闭函数，
// 所以 30/60/120Hz 在同一虚拟时刻画出来的必须是一模一样的像素。dt 上限 50ms：从后台标签页回来
// 那一整个空闲期的 dt 会把所有粒子瞬移到生命之外。
function pumpFrames(now) {
  raf = 0;
  // 首帧不吃 0 也不吃"上一个手势的间隔"：从 kick 的那一刻算起。否则动画的起点被量化到帧边界，
  // 30Hz 与 120Hz 的同一笔会差整整一个帧长（实测 33ms vs 8ms）——那是真依赖，不是尺子的毛病。
  const from = lastFrame || kickAt;
  const dt = Math.max(0, Math.min(0.05, (now - from) / 1000));
  lastFrame = now;
  advance(anim, dt);
  draw();
  if (busy(anim)) raf = requestAnimationFrame(pumpFrames);
  else lastFrame = 0;
}

function kick() {
  if (anim.reduced) return;
  if (!raf) {
    lastFrame = 0;
    kickAt = frameStamp();
    raf = requestAnimationFrame(pumpFrames);
  }
  // 后台标签页允许整片不发帧。1400ms 比最长寿的粒子还长，所以这条只在"一帧都没来"时才生效——
  // 真在动的动画此时早就自己空了，busy(anim) 为假，这一句没有副作用。
  clearTimeout(kicker);
  kicker = setTimeout(() => {
    if (!busy(anim)) return;
    resetAnim(anim);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastFrame = 0;
    draw();
  }, 1400);
}

// 涟漪只跟真实手势与胜利：验证台是走 kuromasu.stroke() 提交笔的，那条路上不留任何瞬态，
// 于是 tools/scenarios.js 里"连画两遍像素必须相同"的断言不会被动画打掉。
function fxAt(cell, { burst = false, color = null } = {}) {
  if (anim.reduced || cell == null) return;
  if (burst) spawnBurst(anim, cell, { count: 16, seed: (game ? game.moves : 0) + 1, speed: 210 });
  spawnRipple(anim, cell, { color, sprite: burst });
  kick();
}

// One place writes the readouts, so a stat can never be updated by half the file. Every number on
// the panel is the engine's answer via Game.state(): 已定/没定 from diagnose(), 看对 from the
// satisfied set restricted to the cells that carry a number, 冲突 from the violated set.
function syncStats() {
  if (!game) return;
  const st = game.state();
  el.name.textContent = `${st.name} · ${game.w}×${game.h}`;
  el.tier.textContent = tierFor(st.tier).name;
  el.tier.dataset.tier = st.tier;
  el.time.textContent = fmtMs(clock());
  el.moves.textContent = st.moves;
  el.hints.textContent = st.hints;
  el.hintCount.textContent = st.hints;
  el.filled.textContent = `${st.filled}/${st.total}`;
  el.remaining.textContent = st.remaining;
  el.satisfied.textContent = `${st.satisfied}/${st.clues}`;
  el.conflicts.textContent = st.conflicts;
  el.score.textContent = st.score.toFixed(1);
  el.filled.closest('.stat').classList.toggle('good', st.status === 'won');
  el.conflicts.closest('.stat').classList.toggle('bad', st.conflicts > 0);
  el.satisfied.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.conflicts > 0);
  el.stateLine.textContent = st.stuck
    ? '这些墨和数字已经矛盾了：不管剩下的格怎么填，都不可能让所有数字对上。撤销一步再想。'
    : st.badClues
      ? `${st.badClues} 个数字对不上：它已经看见的白格多了，或者四条视线全打开也凑不够。`
      : st.conflicts
        ? '黑格贴在一起，或者白格被劈成了几截——涂黑的地方断了一条通路。'
        : '';
  el.stateLine.classList.toggle('good', !el.stateLine.textContent.length && st.status === 'won');
}

function syncAll() {
  syncStats();
  draw();
}

function flushResume() {
  if (!game || game.status === 'won') return;
  Store.saveResume(game.puzzle, game.st.cell, clock(), { moves: game.moves, hints: game.hints });
}

function startClock() {
  paused = false;   // 新一局从"没暂停"开始；setPaused(false) 走的就是这条路
  startedAt = Date.now();
  clearInterval(ticker);
  ticker = setInterval(() => {
    el.time.textContent = fmtMs(clock());
    if (pulse) draw();
  }, 1000);
}

function stopClock() {
  baseElapsed = clock();
  startedAt = 0;
  clearInterval(ticker);
  ticker = 0;
}

function syncPause() {
  el.pause.setAttribute('aria-pressed', String(paused));
  el.pause.textContent = paused ? '继续' : '暂停';
  el.pauseVeil.hidden = !paused;
  el.canvas.dataset.paused = paused ? 'yes' : 'no';
}

// 暂停是真的停下：走的是同一套 baseElapsed 累加，所以读数不再前走；笔、提示、撤销、重开一律拒绝。
// 盖一层半透明黑而时钟照走的"暂停"不算暂停。
function setPaused(on) {
  if (!game || game.status === 'won') return paused;
  const next = !!on;
  if (next === paused) return paused;
  paused = next;
  if (paused) stopClock();
  else startClock();
  syncPause();
  syncStats();
  flushResume();
  el.hintRule.textContent = paused ? '已暂停' : '提示理由';
  el.hintLine.textContent = paused
    ? '计时真的停了，笔也按不下去。按 继续 或 P 接着推这一局。'
    : '按 提示 会说出当前能推的一格，以及它依据哪条规则。';
  return paused;
}

function togglePause() { return setPaused(!paused); }

// 重开 = 同一个种子、同一个盘面，墨与代价全清；换一局 = 重新发牌。两件事分给两个键。
function restart() {
  if (!game) return null;
  game = new Game(game.puzzle);
  paused = false;
  helpOpen = false;
  pulse = null;
  stroke = null;
  baseElapsed = 0;
  resetAnim(anim);
  el.winVeil.hidden = true;
  el.helpVeil.hidden = true;
  setMode(BLACK);
  syncPause();
  startClock();
  syncAll();
  flushResume();
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '同一张牌重新开始：墨擦干净了，步数与提示也归零，盘面一个数字都没变。';
  return game;
}

const fullscreenOn = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

function syncFullscreen() {
  const on = fullscreenOn();
  el.fullscreen.setAttribute('aria-pressed', String(on));
  el.fullscreen.textContent = on ? '退出全屏' : '全屏';
  return on;
}

function toggleFullscreen() {
  const root = document.documentElement;
  try {
    if (fullscreenOn()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) Promise.resolve(exit.call(document)).catch(() => {});
    } else {
      const req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (!req) return false;
      Promise.resolve(req.call(root, { navigationUI: 'hide' })).catch(() => {});
    }
  } catch {
    /* 非手势调用会被策略挡下：挡下就还是不全屏，盘面不许因此断掉 */
  }
  return true;
}

function syncHelp() { el.helpVeil.hidden = !helpOpen; }

function toggleHelp(on) {
  helpOpen = on === undefined ? !helpOpen : !!on;
  syncHelp();
  return helpOpen;
}

// Two ink brushes and one eraser. The brush is a property of the *pointer*, the mode is a property
// of the ink, so the eraser never has to invent a fourth cell state to borrow the same gesture.
function paintBrush() {
  el.canvas.dataset.mode = game ? (game.mode === BLACK ? 'black' : 'white') : 'black';
  el.canvas.dataset.brush = erasing ? 'erase' : 'ink';
  el.modeBlack.setAttribute('aria-pressed', String(!erasing && game && game.mode === BLACK));
  el.modeWhite.setAttribute('aria-pressed', String(!erasing && game && game.mode === WHITE));
  el.erase.setAttribute('aria-pressed', String(erasing));
}

function setMode(mode) {
  if (!game) return game;
  if (mode === OPEN) return setErase(true);
  if (mode !== BLACK && mode !== WHITE) return game.mode;
  erasing = false;
  game.mode = mode;
  paintBrush();
  draw();
  return mode;
}

function setErase(on) {
  erasing = !!on;
  paintBrush();
  draw();
  return erasing;
}

function showHint(info) {
  if (!info) return;
  if (info.stalled) {
    el.hintRule.textContent = '推不动了';
    el.hintLine.textContent = info.text;
    return;
  }
  if (info.conflict) {
    el.hintRule.textContent = '这里和数字矛盾';
    el.hintLine.textContent = info.conflict;
    pulse = { cell: info.cell, color: 'rgba(255,92,122,0.9)' };
    setTimeout(() => {
      if (pulse && pulse.cell === info.cell) pulse = null;
      draw();
    }, 1600);
    Sound.conflict();
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}`;
  el.hintLine.textContent = info.why;
  pulse = { cell: info.cell, node: info.node };
  const mine = pulse;
  setTimeout(() => {
    if (pulse === mine) pulse = null;
    draw();
  }, 1600);
  Sound.hint();
}

function onWin() {
  stopClock();
  const ms = clock();
  const better = Store.recordBest(game.puzzle.tier, {
    ms,
    hints: game.hints,
    moves: game.moves,
    size: `${game.w}×${game.h}`,
  });
  Store.recordSolve(ms, game.hints);
  Store.clearResume();
  el.winMeta.textContent = `${tierFor(game.puzzle.tier).name} · ${game.w}×${game.h} · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次`;
  el.winRecord.textContent = better ? '新纪录：这一局比存档里的更不求人。' : '未破纪录：同档先比提示次数。';
  el.winVeil.hidden = false;
  setPaused(false);
  fxAt((((game.h / 2) | 0) * game.w + ((game.w / 2) | 0)), { burst: true });
  Sound.win();
  renderRecords();
}

function afterStep(soundKey) {
  syncAll();
  if (game.status === 'won') onWin();
  else {
    flushResume();
    if (soundKey) Sound[soundKey]();
    if (game.stuck || game.diag.violated.size) Sound.conflict();
  }
}

// `quiet` is for a gesture that did land but stepped over one cell: the player gets the reason, and
// does not get an error beep for a drag that worked.
function refusalLine({ quiet = false } = {}) {
  const r = game && game.refusal;
  if (!r) return false;
  el.hintRule.textContent = '这一笔没有落';
  el.hintLine.textContent = r.why;
  if (!quiet && r.cell != null) {
    pulse = { cell: r.cell, color: 'rgba(255,92,122,0.9)' };
    setTimeout(() => {
      if (pulse && pulse.cell === r.cell) pulse = null;
      draw();
    }, 1200);
  }
  if (!quiet) Sound.conflict();
  return true;
}

function useHint() {
  if (!game || game.status === 'won' || paused) return null;
  const before = game.hints;
  const info = game.hint();
  if (!info) return null;
  // An unproductive hint is not a purchase: nothing was written, nothing is charged.
  if (info.stalled || info.conflict) {
    showHint(info);
    return info;
  }
  showHint(info);
  if (game.hints !== before) afterStep('place');
  return info;
}

function undo() {
  if (!game || paused) return null;
  const step = game.undo();
  if (!step) return null;
  pulse = null;
  Sound.undo();
  syncAll();
  flushResume();
  return step;
}

function begin({ tier = 'trainee', seed = null, resume = null } = {}) {
  const origin = seed || `k${Math.floor(Math.random() * 1e9)}`;
  const puzzle = makePuzzle(origin, tier);
  if (!puzzle) return null;
  game = new Game(puzzle);
  pulse = null;
  stroke = null;
  paused = false;
  helpOpen = false;
  resetAnim(anim);
  el.winVeil.hidden = true;
  el.helpVeil.hidden = true;
  baseElapsed = 0;
  if (resume) {
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
    baseElapsed = resume.elapsedMs || 0;
    game.cursor = 0;
    game.load(resume.board);
  }
  setMode(BLACK);
  show('game');
  startClock();
  syncPause();
  syncFullscreen();
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一格，以及它依据哪条规则。';
  syncAll();
  flushResume();
  renderResumeCard();
  return game;
}

// 重开：**同一道题**从头再来 —— 落笔、撤销栈、步数、提示次数、提示游标、计时、结算遮罩
// 全部归零，但不换题。跟「换一局」的分工：换一局是去重抽一道新题（那是"再来一局"），
// 这里是"这题我走错了，原地重来"——玩家要的是同一个题，不是新题。
//
// 为什么不能只调一次 resetInk() 就完事：它只碰得到引擎里的 st.cell 与 st.history，
// UI 层的撤销栈、步数、提示次数、提示游标都是各自独立存着的缓存，不挨个点名就会把
// 半局的痕迹留在新局里（详见 Game.resetAll 的注释）。
function restart() {
  if (!game) return null;
  game.resetAll();               // 盘面 + steps + moves + hints + cursor + status + mode + lastHint + refusal
  pulse = null;                  // 上一条提示留下的高亮，属于上一局
  stroke = null;                 // 上一次没画完的拖拽手势
  el.winVeil.hidden = true;      // 结算遮罩收起：上一局赢了的遮罩不能压在重开后的盘上
  baseElapsed = 0;               // 耗时归零
  // 暂停中重开就保持停表，否则 startClock() 会把暂停期间憋下的墙钟一次性灌进计时。
  if (paused) {
    startedAt = 0;
    clearInterval(ticker);
    ticker = 0;
  } else {
    startClock();                // 没暂停就重新起跑，重开后的计时是这一局自己的
  }
  setMode(BLACK);                // 临时态：落笔模式回默认，HUD 的 aria-pressed 一起回写
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一格，以及它依据哪条规则。';
  show('game');
  syncAll();
  // 存档覆盖成本局的空盘：刷新页面不会又冒出走错那半局的线。
  // 特意**不**碰 Store 的偏好（静音 / 减动效 / 最好成绩）——那些是玩家的东西，不是这一局的东西。
  flushResume();
  renderResumeCard();
  return game;
}

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    stopClock();
    renderMenu();
  }
  if (which === 'game') draw();
  paintBrush();
  return which;
}

function renderMenu() {
  renderTiers();
  renderRecords();
  renderResumeCard();
}

const TIER_NOTE = {
  trainee: '数字给得多，一格一数就推得完',
  apprentice: '要开始数“还差几格”和“已经看满”',
  regular: '数字稀了，得连着看好几条视线',
  expert: '大半格子没数字，全靠推',
  master: '盘大数少，一步涂错整片接不上',
};

function renderTiers() {
  el.tiers.innerHTML = '';
  for (const t of TIERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = t.key;
    b.innerHTML =
      `<span class="tier-name">${t.name}</span>` +
      `<span class="tier-note">${TIER_NOTE[t.key] || ''}</span>` +
      `<span class="tier-size mono">${t.w}×${t.h} · 实测 ${t.band[0]}–${t.band[1]}</span>`;
    b.addEventListener('click', () => begin({ tier: t.key }));
    el.tiers.appendChild(b);
  }
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const t of TIERS) {
    const li = document.createElement('li');
    const best = Store.best(t.key);
    li.dataset.tier = t.key;
    li.innerHTML =
      `<b>${t.name}</b>` +
      (best
        ? `<span class="mono">${fmtMs(best.ms)}</span> · 提示 ${best.hints} · ${best.moves} 步<br><span>${best.size}</span>`
        : '<span>还没有纪录</span>');
    el.records.appendChild(li);
  }
}

function renderResumeCard() {
  const r = Store.resume();
  // Do not offer "继续" for the board already on screen.
  const live = game && game.status !== 'won' && running();
  if (!r || (live && r.seed === game.puzzle.originSeed && r.tier === game.puzzle.tier)) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `继续 ${tierFor(r.tier).name} 的一局`;
  el.resumeMeta.textContent = `${fmtMs(r.elapsedMs || 0)} · ${r.moves || 0} 步 · 提示 ${r.hints || 0} 次`;
}

function applySettings() {
  Sound.setEnabled(Store.setting('sound'));
  const reduce = !!Store.setting('reduceMotion') || systemPrefersReducedMotion();
  setReduceMotion(!!Store.setting('reduceMotion'));
  document.body.classList.toggle('reduce-motion', reduce);
  $('#btn-sound').setAttribute('aria-pressed', String(!!Store.setting('sound')));
  $('#btn-sound').textContent = Store.setting('sound') ? '音效 开' : '音效 关';
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  $('#btn-motion').textContent = reduce ? '动效 省' : '动效 全';
  // 减动效对动画层是一刀切：旗标落下、排队的帧全撤、场上任何涟漪与粒子当场清空——
  // 不是"照样建出来再乘个 0"，那样每帧还在算，屏幕上也确实还在动。
  anim.reduced = prefersReducedMotion();
  if (anim.reduced) {
    clearTimeout(kicker);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastFrame = 0;
    resetAnim(anim);
  }
}

// ---- pointer gestures: down decides the value for the whole stroke, up commits one step ------

// During a drag the cells are painted ahead of the commit so the picture follows the finger.
// Each preview remembers the state the cell had *before* the gesture, because the committed step
// has to record that as its undo target — restoring to OPEN instead would quietly eat the mark
// an erase gesture was about to remove.
function preview(t, value) {
  stroke.items.push({ cell: t, from: game.st.cell[t] });
  game.st.cell[t] = value;
  game.recompute();
}

function unpreview() {
  for (const it of stroke.items) game.st.cell[it.cell] = it.from;
  game.recompute();
}

function strokeStart(ev) {
  if (!game || game.status === 'won') return;
  if (paused) {
    el.hintRule.textContent = '这一局停着';
    el.hintLine.textContent = '按 继续 或 P 才能落笔：暂停期间涂上去的东西不会进盘面，也不会进步数。';
    return;
  }
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0) return;
  ev.preventDefault();
  el.canvas.setPointerCapture?.(ev.pointerId);
  stroke = { items: [], right: ev.button === 2 };
  // The eraser brush, the right button, and starting on a cell that already carries this mode's
  // mark all make the whole gesture a lift-off rather than a paint.
  const erase = stroke.right || erasing || game.st.cell[t] === game.mode;
  stroke.value = erase ? OPEN : game.mode;
  if (!refusePreview(t, stroke.value)) preview(t, stroke.value);
  draw();
}

// A preview goes straight into the ink array, bypassing the engine's own guard, so the guard is
// asked here: a numbered cell is never a candidate for black, and never for erasing either.
function refusePreview(t, value) {
  if (!game.noteRefusal(t, value)) return false;
  stroke.refused = true;
  return true;
}

function strokeMove(ev) {
  if (!stroke || !game) return;
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0) return;
  if (stroke.items.some((it) => it.cell === t) || game.st.cell[t] === stroke.value) return;
  if (refusePreview(t, stroke.value)) return;
  preview(t, stroke.value);
  draw();
}

function strokeEnd() {
  if (!stroke || !game) return null;
  const s = stroke;
  const cells = s.items.map((it) => it.cell);
  unpreview();
  stroke = null;
  if (!cells.length) {
    if (s.refused) refusalLine();
    syncAll();
    return null;
  }
  const step = game.stroke(cells, s.value);
  if (!step) {
    refusalLine();
    syncAll();
    return null;
  }
  if (step.skipped) refusalLine({ quiet: true });
  afterStep(s.value === OPEN ? 'rub' : 'place');
  if (!paused && game && game.status !== 'won') fxAt(cells[cells.length - 1], { color: s.value === OPEN ? Palette.hint : null });
  return step;
}

el.canvas.addEventListener('pointerdown', strokeStart);
el.canvas.addEventListener('pointermove', strokeMove);
el.canvas.addEventListener('pointerup', strokeEnd);
el.canvas.addEventListener('pointercancel', () => {
  if (!stroke) return;
  unpreview();
  stroke = null;
  syncAll();
});
el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

el.pause.addEventListener('click', togglePause);
el.restart.addEventListener('click', restart);
el.fullscreen.addEventListener('click', toggleFullscreen);
$('#btn-resume-play').addEventListener('click', () => setPaused(false));
$('#btn-help').addEventListener('click', () => toggleHelp(true));
$('#btn-help-close').addEventListener('click', () => toggleHelp(false));
$('#btn-mode-black').addEventListener('click', () => setMode(BLACK));
el.modeWhite.addEventListener('click', () => setMode(WHITE));
el.erase.addEventListener('click', () => setErase(!erasing));
$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-restart').addEventListener('click', restart);
$('#btn-new').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-menu').addEventListener('click', () => {
  flushResume();
  show('menu');
});
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume();
  if (!r) return;
  begin({ tier: r.tier, seed: r.seed, resume: r });
});
$('#btn-sound').addEventListener('click', () => {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  Sound.place();
});
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  show('menu');
});

window.addEventListener('keydown', (ev) => {
  if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
  const k = ev.key.toLowerCase();
  // 焦点在按钮上时 Enter/空格是浏览器自己的"按下这个按钮"：抢过来 preventDefault 会让
  // 键盘玩家无论 Tab 到哪个档位都开局练习档——那是无障碍缺陷，不是快捷键设计。
  const onButton = !!(ev.target && ev.target.tagName === 'BUTTON');
  if (k === 'h') useHint();
  else if (k === 'z') undo();
  else if (k === 'b') setMode(BLACK);
  else if (k === 'w') setMode(WHITE);
  else if (k === 'e') setErase(!erasing);
  else if (k === 'm' && game) setMode(game.mode === BLACK ? WHITE : BLACK);
  // R 重开同一题，**局中就能按**（不只结算后）：玩家走到一半发现走错了，当场 R 一下重来。
  // 本仓原先没有任何键占着 R（h/z/b/w/e/m 是玩法，P 暂停，F 全屏，N 静音），所以不需要换键。
  else if (k === 'r' && game) restart();
});

window.addEventListener('resize', draw);
// 进出全屏都要重算一次可用盒子：cell 尺寸由容器来，尺寸变了而几何不重来，点击就会错格。
for (const fsEv of ['fullscreenchange', 'webkitfullscreenchange']) {
  window.addEventListener(fsEv, () => { syncFullscreen(); draw(); });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);

applyThemeVars();
applySettings();
renderMenu();
registerServiceWorker();

// 离线可开、可装到桌面。两条实测出来的约束：
// * file:// 下（双击 index.html、Electron 的默认 loadFile）不注册，也不许抛未捕获异常——
//   注册会拿到 SecurityError，整页的后续 module 代码虽然照跑，控制台里却多一条红字。
// * 路径相对 document.baseURI 而不是写死 '/sw.js'：Pages 把这个仓发在 /z-biz-game-kuromasu-cos/
//   之下，绝对路径会在前缀形态下 404（同组织已经因此红过一次）。
function registerServiceWorker() {
  try {
    const proto = typeof location === 'undefined' ? '' : location.protocol;
    if (proto !== 'http:' && proto !== 'https:') return false;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
    const base = document.baseURI || location.href;
    const url = new URL('sw.js', base).href;
    const scope = new URL('./', base).href;
    navigator.serviceWorker.register(url, { scope }).catch(() => {
      /* 注册失败（无 SW 支持/被策略挡下）不影响可玩，只是离线用不了 */
    });
    return true;
  } catch {
    return false;
  }
}

window.kuromasu = {
  version: VERSION,
  view,
  get game() {
    return game;
  },
  show,
  begin,
  restart,
  useHint,
  undo,
  setMode,
  setErase,
  erase: () => erasing,
  // The harness commits through the same path a pointer release does, so a scenario that passes
  // here has driven the real state machine rather than a copy of it.
  stroke(cells, value) {
    if (!game || paused) return null;
    const v = value === undefined ? (erasing ? OPEN : game.mode) : value;
    const step = game.stroke(cells, v);
    if (step) afterStep(step.value === OPEN ? 'rub' : 'place');
    else refusalLine();
    return step;
  },
  tap(t, mode) {
    if (!game || paused) return null;
    const step = mode === undefined ? game.tap(t, erasing ? OPEN : game.mode) : game.tap(t, mode);
    if (step) afterStep(step.writes[0].to === OPEN ? 'rub' : 'place');
    else refusalLine();
    return step;
  },
  solveWithLogic() {
    if (!game) return null;
    const r = game.solveWithLogic();
    syncAll();
    if (game.status === 'won') onWin();
    return r;
  },
  elapsed: clock,
  pause: togglePause,
  paused: () => paused,
  phase,
  restart,
  fullscreen: toggleFullscreen,
  isFullscreen: fullscreenOn,
  help: toggleHelp,
  anim: () => snapshot(anim),
  fx: (cell, opts) => fxAt(cell, opts),
  state: () => (game ? { ...game.state(), elapsedMs: clock(), erasing, paused, phase: phase(), animBusy: busy(anim) } : null),
  cellAt: (x, y) => (game ? game.cellAt(x, y) : -1),
  valueOf: (t) => (game ? game.valueOf(t) : OPEN),
  markName: name,
  // A redraw on demand: the harness lives in a background tab, where the compositor is allowed to
  // skip frames, so a screenshot has to be able to say "paint now".
  redraw: draw,
  engine: {
    ...Engine,
    makePuzzle,
    generate,
    randomSolution,
    pruneClues,
    mix,
    countSolutions,
    TIERS,
    tierFor,
    Game,
    Store,
    theme: { ...Palette, Cell },
    OPEN,
    BLACK,
    WHITE,
    NO_CLUE,
  },
};

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}

// ---- 暂停：真的把仿真冻住 ----
//
// 本仓唯一持续推进的仿真是耗时时钟（startedAt 跟 Date.now 走，ticker 是它唯一心跳）。
// setPaused(true) 调 stopClock()：baseElapsed 落账、startedAt 归 0、ticker 停，
// 此后 clock() 恒等于 baseElapsed，墙钟再走多久都加不上去。
// setPaused(false) 调 startClock()：startedAt 复位成"从现在起"，
// 所以恢复后的第一帧不会把暂停期间憋下的墙钟一次性灌进来（没有 dt 尖峰）。
//
// 用 var 而不是 let：本块在文件末尾，而 startClock() 可能在它之前就被 begin() 调过；
// let 声明提升不到初始化，TDZ 会直接抛 ReferenceError。
var paused = false;
function setPaused(v) {
  v = !!v;
  if (v === paused) return paused;
  if (v) stopClock(); else startClock();
  paused = v;
  var b = document.getElementById('btn-pause');
  if (b) {
    b.setAttribute('aria-pressed', String(paused));
    b.textContent = paused ? '继续' : '暂停';
    b.title = paused ? '继续 (P)' : '暂停 (P)';
  }
  return paused;
}
function togglePause() { return setPaused(!paused); }
function isPaused() { return paused; }

document.getElementById('btn-pause').addEventListener('click', togglePause);
window.addEventListener('keydown', function (ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
  var k = ev.key;
  if (k === 'p' || k === 'P' || k === ' ') { ev.preventDefault(); togglePause(); }
});

// ---- 静音开关（N）-----------------------------------------------------------------
// M 在本仓已被玩法占用（见 keydown 里的模式切换），所以静音走 N。
// 这里只负责把按键翻译成"点一下音效按钮"：真静音在 js/audio/synth.js 里做
// （suspend AudioContext + 静音态不再新建振荡器节点），偏好由它落盘到 localStorage。
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName || '')) return;
  if (ev.key === 'n' || ev.key === 'N') {
    ev.preventDefault();
    $('#btn-sound').click();
  }
});
