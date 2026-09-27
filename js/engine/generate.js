// Generator. Solution first: shade a random-but-legal set of black cells — never touching, never
// cutting the white group — and the number of white cells each white cell sees *is* the clue. So a
// board cannot be born unsolvable, which is the opposite of guessing a clue set and hoping.
//
// Difficulty then comes from the one knob the game actually has: how many of those numbers get
// removed. A removal is kept only if the pencil path still finishes the board, so "unique" and "no
// guessing" are the same test here, and the exhaustive counter in count.js exists to check that the
// two have not drifted apart.

import { BLACK, WHITE, NO_CLUE, createBoard, cluesFrom, solve, adjAt } from './kuromasu.js';

// 只认种子，绝不看表：存档按种子重绘同一块盘，任何一次抽盘用到墙上时间，续局就会换盘。
export function mix(seed) {
  let x = typeof seed === 'string' ? 2166136261 : seed >>> 0;
  if (typeof seed === 'string') {
    for (let i = 0; i < seed.length; i++) {
      x ^= seed.charCodeAt(i);
      x = Math.imul(x, 16777619) >>> 0;
    }
  }
  x = x || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

function shuffled(list, rand) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 白格必须还是整块： BFS 走一遍，从第一个白格出发能不能把所有白格走到。
function whitesConnected(w, h, cell) {
  const n = w * h;
  let start = -1;
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (cell[i] === WHITE) {
      total++;
      if (start < 0) start = i;
    }
  }
  if (total <= 1) return true;
  const seen = new Uint8Array(n);
  const stack = [start];
  seen[start] = 1;
  let got = 0;
  while (stack.length) {
    const u = stack.pop();
    got++;
    for (const v of adjAt(w, h, u)) {
      if (seen[v] || cell[v] !== WHITE) continue;
      seen[v] = 1;
      stack.push(v);
    }
  }
  return got === total;
}

// 种一个完整合法的答案：按随机顺序试涂黑，粘上别的黑格或者切断白格就撤回去。
// 于是「有解」这件事是结构上成立的，而不是碰运气碰来的。
export function randomSolution(w, h, rand, blackRatio = 0.3) {
  const n = w * h;
  const out = new Int8Array(n);
  out.fill(WHITE);
  for (const i of shuffled(Array.from({ length: n }, (_, k) => k), rand)) {
    if (rand() >= blackRatio) continue;
    let touching = false;
    for (const nb of adjAt(w, h, i)) if (out[nb] === BLACK) touching = true;
    if (touching) continue;
    out[i] = BLACK;
    if (!whitesConnected(w, h, out)) out[i] = WHITE;
  }
  return out;
}

// Greedy removal down to `target` numbers. Order is shuffled, so which numbers survive is a
// property of the seed, not of the scan direction — and a removal is kept only if the pencil path
// still finishes the board without backtracking.
export function pruneClues(board, rand, target) {
  const clue = Int8Array.from(board.clue);
  let kept = board.clues;
  const order = shuffled(
    Array.from({ length: board.n }, (_, i) => i).filter((i) => clue[i] !== NO_CLUE),
    rand,
  );
  for (const i of order) {
    if (kept <= target) break;
    const before = clue[i];
    clue[i] = NO_CLUE;
    kept--;
    const probe = createBoard({ w: board.w, h: board.h, clue });
    if (!solve(probe).ok) {
      clue[i] = before;
      kept++;
    }
  }
  return clue;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function generate(opts = {}) {
  const {
    w = 6,
    h = 6,
    seed = 'plain',
    keepRatio = 0.35,
    blackRatio = 0.3,
    band = null,
    tries = 24,
    report = () => {},
  } = opts;
  const target = Math.max(1, Math.round(w * h * keepRatio));
  let best = null;
  for (let k = 0; k < tries; k++) {
    const trial = `${seed}#${k}`;
    const rand = mix(trial);
    const solution = randomSolution(w, h, rand, blackRatio);
    let board;
    let clue;
    try {
      board = createBoard({ w, h, clue: cluesFrom(w, h, solution) });
      clue = pruneClues(board, rand, target);
      board = createBoard({ w, h, clue });
    } catch {
      continue;
    }
    const p = solve(board);
    if (!p.ok) continue;
    const offBand = band ? Math.abs(p.score - clamp(p.score, band[0], band[1])) : 0;
    const cand = {
      board,
      solution,
      seed: trial,
      score: p.score,
      steps: p.steps,
      breakdown: p.breakdown,
      clues: board.clues,
      offBand,
      gen: k + 1,
    };
    if (!best || cand.offBand < best.offBand) best = cand;
    report({ k, score: p.score, clues: board.clues, offBand });
    if (band && cand.offBand === 0) break;
  }
  if (!best) return { ok: false, board: null, reason: '没找到既唯一又能纯逻辑推到底的盘面' };
  return { ok: true, ...best };
}

// The bands below are selection targets, and every number in them is measured — see
// tools/balance.mjs, which prints the spread per tier and fails the build when the ladder stops
// ordering. The 2026-09-27 bench (40 boards per tier, `band` set to null so nothing was selected,
// every one of them called UNIQUE by the independent counter and finished by the pencil path) gave
// medians 34 / 49.5 / 68 / 90.5 / 144.5 with a ±3 spread around each — the ladder really is
// (grid size × how many numbers survive), and the bands are drawn around those medians. The same
// bench cost the independent counter at most 53,390 nodes on 10×10; an 8-board probe of 11×11
// already needed 303,819 of the 400,000 node budget, so 大师 stays on 10×10 rather than turning the
// cross-check into "unverified". Bumping a band without re-running the bench is how a band becomes
// decoration.
export const TIERS = [
  { key: 'trainee', name: '初学', w: 5, h: 5, keepRatio: 0.5, blackRatio: 0.3, band: [31, 37] },
  { key: 'apprentice', name: '上手', w: 6, h: 6, keepRatio: 0.42, blackRatio: 0.3, band: [45, 54] },
  { key: 'regular', name: '熟练', w: 7, h: 7, keepRatio: 0.38, blackRatio: 0.3, band: [64, 73] },
  { key: 'expert', name: '高阶', w: 8, h: 8, keepRatio: 0.34, blackRatio: 0.3, band: [85, 99] },
  { key: 'master', name: '大师', w: 10, h: 10, keepRatio: 0.28, blackRatio: 0.32, band: [130, 148] },
];

export function tierFor(key) {
  return TIERS.find((t) => t.key === key) || TIERS[1];
}

export function makePuzzle(seed, tierKey) {
  const tier = tierFor(tierKey);
  const r = generate({ ...tier, seed });
  if (!r.ok) return null;
  return {
    ...r,
    tier: tier.key,
    tierName: tier.name,
    originSeed: seed,
    size: `${tier.w}×${tier.h}`,
    w: tier.w,
    h: tier.h,
  };
}

export { NO_CLUE };
