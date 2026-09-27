// 第二套互不信任的代码：an exhaustive counter that shares nothing with kuromasu.js but the four
// constants. The rays are walked again here from the rules of the game, and the ray state is
// carried as bitmasks instead of by re-scanning cell lists, so a mistake in one implementation has
// no way to show up in the other.
//
// It answers one question — how many completions does this clue set have? — and stops at `cap`,
// spending its node budget rather than lying about a board it could not finish counting.
//
// Cells are decided in scan order and every constraint is checked the moment the last cell it
// depends on lands: a ray's count is settled by its leading whites plus the first black, black
// adjacency by the two cells involved, a number by its own cell plus its four rays, and the white
// group by the cell that just got shaded. That is what keeps the search off the 2^(w*h) floor.

import { OPEN, BLACK, WHITE, NO_CLUE } from './kuromasu.js';

export const UNIQUE = 'UNIQUE';
export const MANY = 'MANY';
export const NONE = 'NONE'; // provably no completion — distinct from MANY, which is "≥ cap"
export const OVERBUDGET = 'OVERBUDGET';

const ctz = (x) => 31 - Math.clz32(x & -x);
const DIRS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export function countSolutions(board, { cap = 2, budget = 400000 } = {}) {
  const w = board.w;
  const h = board.h;
  const clue = board.clue;
  const n = w * h;

  // ---- geometry, rebuilt from the rules, not imported -------------------------
  // 四邻：黑格不许碰到的那四格
  const nbr = Array.from({ length: n }, (_, i) => {
    const r = (i / w) | 0;
    const c = i % w;
    const out = [];
    if (r > 0) out.push(i - w);
    if (r + 1 < h) out.push(i + w);
    if (c > 0) out.push(i - 1);
    if (c + 1 < w) out.push(i + 1);
    return out;
  });

  // 每条视线一段：从数字格出发逐格往外推，直到盘边。owner/len/cells 各自独立成表。
  const owner = [];
  const len = [];
  const cellsOf = [];
  const base = new Int32Array(n).fill(-1); // 数字格 → 它第一条视线在表里的下标
  const clueIds = [];
  for (let s = 0; s < n; s++) {
    if (clue[s] === NO_CLUE) continue;
    clueIds.push(s);
    base[s] = owner.length;
    const r = (s / w) | 0;
    const c = s % w;
    for (const [dr, dc] of DIRS) {
      const list = [];
      for (let rr = r + dr, cc = c + dc; rr >= 0 && rr < h && cc >= 0 && cc < w; rr += dr, cc += dc) {
        list.push(rr * w + cc);
      }
      owner.push(s);
      len.push(list.length);
      cellsOf.push(list);
    }
  }
  const nRays = owner.length;
  const fullMask = new Int32Array(nRays);
  for (let k = 0; k < nRays; k++) fullMask[k] = (1 << len[k]) - 1;
  // 每一格落在哪些视线的第几个位置上（平铺：ray, bit, ray, bit, …）
  const cellRay = Array.from({ length: n }, () => []);
  for (let k = 0; k < nRays; k++) {
    const list = cellsOf[k];
    for (let j = 0; j < list.length; j++) cellRay[list[j]].push(k, 1 << j);
  }

  // ---- search state ----------------------------------------------------------
  const assign = new Int8Array(n); // 全是 OPEN 开局
  const am = new Int32Array(nRays); // 这条视线上已经定了的格子（位 = 离数字格第几格）
  const bm = new Int32Array(nRays); // 其中是黑格的
  const fl = new Int32Array(nRays); // 一定看得见几格
  const cl = new Int32Array(nRays); // 顶多能看见几格

  function refresh(k) {
    const gap = ~(am[k] & ~bm[k]) & fullMask[k]; // 第一个「不是已定白格」的位置
    fl[k] = gap ? ctz(gap) : len[k];
    cl[k] = bm[k] ? ctz(bm[k]) : len[k];
  }
  for (let k = 0; k < nRays; k++) refresh(k);

  let tick = 0; // 视线重算的去重时钟
  let mark = 0; // BFS 的访问时钟
  const touched = new Int32Array(n);
  const seen = new Int32Array(n);
  const queue = new Int32Array(n);
  let whiteCount = 0;

  // 数字格 s 此刻的可能区间：自己那一格 + 四条视线。合法解里 s 必是白格，所以「自己」这一格在下限
  // 里也得算上——只有被涂黑才是死路。区间和 want 不相交就剪掉；区间收成一点时，上下界同时卡住它，
  // 不必再单独判一次。
  function clueFeasible(s) {
    if (assign[s] === BLACK) return false; // 带字的格子必须是白格
    const b = base[s];
    let low = 1;
    let high = 1;
    for (let d = 0; d < 4; d++) {
      low += fl[b + d];
      high += cl[b + d];
    }
    const want = clue[s];
    return low <= want && high >= want;
  }

  // 把 x 涂黑之后，所有已画白的格子必须还在同一片里（可以穿过还没定的格子）。
  // x 只有一头可走时不可能切开谁，那就不用走一遍全图。
  function splitByBlack(x) {
    if (whiteCount < 2) return false;
    let start = -1;
    let walkable = 0;
    for (const nb of nbr[x]) {
      if (assign[nb] === BLACK) continue;
      walkable++;
      if (start < 0) start = nb;
    }
    if (walkable < 2) return false;
    mark++;
    let head = 0;
    let tail = 0;
    seen[start] = mark;
    queue[tail++] = start;
    let reached = 0;
    while (head < tail) {
      const u = queue[head++];
      if (assign[u] === WHITE) reached++;
      for (const v of nbr[u]) {
        if (v === x || seen[v] === mark || assign[v] === BLACK) continue;
        seen[v] = mark;
        queue[tail++] = v;
      }
    }
    return reached < whiteCount;
  }

  function apply(t, v) {
    assign[t] = v;
    if (v === WHITE) whiteCount++;
    tick++;
    const list = cellRay[t];
    for (let p = 0; p < list.length; p += 2) {
      const k = list[p];
      const bit = list[p + 1];
      am[k] |= bit;
      if (v === BLACK) bm[k] |= bit;
      refresh(k);
      const s = owner[k];
      if (touched[s] !== tick) {
        touched[s] = tick;
        if (!clueFeasible(s)) return false;
      }
    }
    // 数字格自己不落在自己的任何一条视线上，所以它的可行性要单独点一次。
    if (base[t] >= 0 && !clueFeasible(t)) return false;
    if (v === BLACK) {
      for (const nb of nbr[t]) if (nb < t && assign[nb] === BLACK) return false; // 两块黑粘在一起
      if (splitByBlack(t)) return false;
    } else if (whiteCount > 1 && nbr[t].length > 0) {
      let boxed = true;
      for (const nb of nbr[t]) if (assign[nb] !== BLACK) boxed = false;
      if (boxed) return false; // 这格白子被彻底围死，再也接不上别的白格
    }
    return true;
  }

  function unapply(t, v) {
    const list = cellRay[t];
    for (let p = 0; p < list.length; p += 2) {
      const k = list[p];
      const bit = list[p + 1];
      am[k] &= ~bit;
      if (v === BLACK) bm[k] &= ~bit;
      refresh(k);
    }
    if (v === WHITE) whiteCount--;
    assign[t] = OPEN;
  }

  // 叶子上的整体复核：用最直白的走格子方式把三条规则再读一遍，和上面那套位掩码互不信任。
  function leafLegal() {
    let firstWhite = -1;
    let whites = 0;
    for (let i = 0; i < n; i++) {
      if (assign[i] === BLACK) {
        const r = (i / w) | 0;
        const c = i % w;
        if (r + 1 < h && assign[i + w] === BLACK) return false;
        if (c + 1 < w && assign[i + 1] === BLACK) return false;
      } else {
        whites++;
        if (firstWhite < 0) firstWhite = i;
      }
    }
    for (const s of clueIds) {
      if (assign[s] === BLACK) return false;
      const r = (s / w) | 0;
      const c = s % w;
      let k = 1;
      for (const [dr, dc] of DIRS) {
        for (let rr = r + dr, cc = c + dc; rr >= 0 && rr < h && cc >= 0 && cc < w; rr += dr, cc += dc) {
          if (assign[rr * w + cc] === BLACK) break;
          k++;
        }
      }
      if (k !== clue[s]) return false;
    }
    if (whites > 1) {
      mark++;
      let head = 0;
      let tail = 0;
      seen[firstWhite] = mark;
      queue[tail++] = firstWhite;
      let got = 0;
      while (head < tail) {
        const u = queue[head++];
        if (assign[u] === WHITE) got++;
        for (const v of nbr[u]) {
          if (seen[v] === mark || assign[v] === BLACK) continue;
          seen[v] = mark;
          queue[tail++] = v;
        }
      }
      if (got !== whites) return false;
    }
    return true;
  }

  let nodes = 0;
  let solutions = 0;
  let first = null;
  let over = false;

  function go(t) {
    if (over) return true;
    if (nodes++ > budget) {
      over = true;
      return true;
    }
    if (t === n) {
      if (!leafLegal()) return false;
      solutions++;
      if (!first) first = Int8Array.from(assign);
      return solutions >= cap;
    }
    for (const v of [WHITE, BLACK]) {
      const good = apply(t, v);
      const stop = good && go(t + 1);
      unapply(t, v); // 不管是走进去了还是直接被剪掉，这一格都得擦干净再试下一个值
      if (stop || over) return true;
    }
    return false;
  }
  go(0);

  if (over) return { status: OVERBUDGET, solutions, nodes, first: null };
  // cap 只管什么时候收手；判定本身按解的个数说话，0 个是无解，1 个才是唯一。
  const status = solutions >= 2 ? MANY : solutions === 1 ? UNIQUE : NONE;
  return { status, solutions, nodes, first };
}
