// 黑目 Kuromasu engine. Shade cells black. A number says how many white cells are visible along
// the four rays leaving that cell — the numbered cell sees itself, so a number is never 0 and a
// ray dies at the first black cell. Black cells may never touch orthogonally, and all white cells
// must stay one connected group. Those three sentences are the whole game, so the pencil solver is
// bound propagation over ray counts plus one connectivity sweep, and the acceptance test is the
// same three sentences read straight off the board.
//
// `solve()` below is the pencil path: it is the player's route, the generator's acceptance test
// and the source of every hint, so it never backtracks. Search lives only in count.js, and the
// generator trusts neither.

// A cell's own states, and a *separate* sentinel for "this cell carries no number". They cannot
// share one constant: BLACK is a real choice the player makes, and NO_CLUE is not a choice at all
// — a cell without a number is just an ordinary cell.
export const OPEN = 0; // 还没定
export const BLACK = 1; // 涂黑
export const WHITE = 2; // 留白
export const NO_CLUE = -1;

export const other = (v) => (v === BLACK ? WHITE : BLACK);
export const name = (v) => (v === BLACK ? '黑' : v === WHITE ? '白' : '空');

// Screen coordinates, y growing downward. A clue's four rays, each ordered from the clue outward,
// so "visible" is always a *prefix* of the list: the first black (or the edge) closes the ray and
// nothing behind it can ever be seen. Every rule, the counter and the renderer read this order.
export function raysAt(w, h, i) {
  const r = (i / w) | 0;
  const c = i % w;
  const up = [];
  const down = [];
  const left = [];
  const right = [];
  for (let k = r - 1; k >= 0; k--) up.push(k * w + c);
  for (let k = r + 1; k < h; k++) down.push(k * w + c);
  for (let k = c - 1; k >= 0; k--) left.push(r * w + k);
  for (let k = c + 1; k < w; k++) right.push(r * w + k);
  return [up, down, left, right];
}

// The four orthogonal neighbours — the cells a black square is never allowed to touch.
export function adjAt(w, h, i) {
  const r = (i / w) | 0;
  const c = i % w;
  const out = [];
  if (r > 0) out.push(i - w);
  if (r + 1 < h) out.push(i + w);
  if (c > 0) out.push(i - 1);
  if (c + 1 < w) out.push(i + 1);
  return out;
}

// One ray seen from a clue, over a partly decided board. Two numbers are enough:
//   `floor` — white cells that are certainly seen (the leading run of decided whites), and
//   `ceil`  — the most it could still turn out to be (everything up to the nearest decided black).
// The ray is settled exactly when the two agree. And when they differ, the cell at index `floor`
// cannot be black — a black there would have closed the ray at `floor` — so it is OPEN, which is
// what makes the two count rules below legal writes rather than guesses.
export function scanRay(a, cells) {
  const len = cells.length;
  for (let k = 0; k < len; k++) {
    const v = a[cells[k]];
    if (v === BLACK) return { floor: k, ceil: k, len };
    if (v === OPEN) {
      let ceil = len;
      for (let j = k; j < len; j++) if (a[cells[j]] === BLACK) { ceil = j; break; }
      return { floor: k, ceil, len };
    }
  }
  return { floor: len, ceil: len, len };
}

export function createBoard({ w, h, clue }) {
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) throw new Error('盘面尺寸不合法');
  const n = w * h;
  if (!clue || clue.length !== n) throw new Error(`clue 长度是 ${clue ? clue.length : 0} 个，盘面有 ${n} 格`);
  const cellName = (t) => `第${((t / w) | 0) + 1}行${(t % w) + 1}列`;
  const maxSee = w + h - 1;
  const clueCells = [];
  for (let i = 0; i < n; i++) {
    const v = clue[i];
    if (v === NO_CLUE) continue;
    if (!(v >= 1)) throw new Error(`${cellName(i)} 写着 ${v}，可带字的格子自己也看得见自己，最少是 1`);
    if (v > maxSee) throw new Error(`${cellName(i)} 写着 ${v}，可它四个方向顶多看得见 ${maxSee} 格`);
    clueCells.push(i);
  }
  if (!clueCells.length) throw new Error('盘上没有数字');
  const rays = Array.from({ length: n }, () => null);
  const sees = Array.from({ length: n }, () => []);
  for (const s of clueCells) {
    const list = raysAt(w, h, s);
    rays[s] = [Int32Array.from(list[0]), Int32Array.from(list[1]), Int32Array.from(list[2]), Int32Array.from(list[3])];
    for (let d = 0; d < 4; d++) for (let k = 0; k < list[d].length; k++) sees[list[d][k]].push([s, d, k]);
  }
  return {
    w,
    h,
    n,
    clue: Int8Array.from(clue),
    clues: clueCells.length,
    clueCells: Int32Array.from(clueCells),
    cells: Array.from({ length: n }, (_, i) => i),
    rays,
    sees,
    adj: Array.from({ length: n }, (_, i) => Int32Array.from(adjAt(w, h, i))),
    maxSee,
    cellName,
  };
}

// The numbers a solution implies: every white cell gets a number, every black cell gets none.
// Used by the generator, and by nothing that judges a board — verify() reads the clues, never this.
export function cluesFrom(w, h, solution) {
  const out = new Int8Array(w * h);
  out.fill(NO_CLUE);
  for (let i = 0; i < w * h; i++) {
    if (solution[i] === BLACK) continue;
    let k = 1; // 数字格自己也算看得见的一格
    for (const ray of raysAt(w, h, i)) {
      for (const t of ray) {
        if (solution[t] === BLACK) break;
        k++;
      }
    }
    out[i] = k;
  }
  return out;
}

export const Rules = {
  numbered: {
    name: '带字即白',
    weight: 1,
    text: (b, d) => `${b.cellName(d.clue)} 写着 ${b.clue[d.clue]}：带字的格子必须是白格，黑格上不写字`,
  },
  saturated: {
    name: '已经看满',
    weight: 1.5,
    text: (b, d) =>
      `${b.cellName(d.clue)} 写着 ${b.clue[d.clue]}，视线里已经看见 ${d.see} 格白了，${b.cellName(d.cell)} 再留白就多一格——所以那格必须是黑格`,
  },
  starved: {
    name: '非看不可',
    weight: 2,
    text: (b, d) =>
      `${b.cellName(d.clue)} 写着 ${b.clue[d.clue]}，四条视线全打开顶多看见 ${d.most} 格，一格都少不得——${b.cellName(d.cell)} 必须留着白`,
  },
  neighbor: {
    name: '黑不挨黑',
    weight: 1,
    text: (b, d) => `${b.cellName(d.from)} 已经是黑格，黑格不许上下左右相接，${b.cellName(d.cell)} 只能留白`,
  },
  island: {
    name: '白不断路',
    weight: 2.5,
    text: (b, d) => `${b.cellName(d.cell)} 一涂黑就把白格劈成 ${d.parts} 截，永远接不上了——所以它必须是白格`,
  },
};

// 一条数字的读数：`see` 是一定看得见的（含自己），`most` 是顶多能看见的，`loose` 是还没定死的视线。
function readClue(board, derived, s) {
  const rays = board.rays[s];
  let see = 1;
  let most = 1;
  const loose = [];
  for (let d = 0; d < 4; d++) {
    const r = scanRay(derived, rays[d]);
    see += r.floor;
    most += r.ceil;
    if (r.floor < r.ceil) loose.push([d, r]);
  }
  return { see, most, loose };
}

// One sweep: every fact the numbers, the ban on touching blacks and the one-white-group rule
// already decide. Each write below holds in *every* solution of the board, which is what lets
// solve() double as the acceptance test and reachable() double as a warning that never cries wolf.
export function propagate(board, derived) {
  const found = [];
  let changed = false;
  const fail = (conflict, cell) => ({ found: [], changed: false, conflict, cell });
  const write = (i, value, rule, extra) => {
    const cur = derived[i];
    if (cur === value) return null;
    if (cur !== OPEN) {
      return fail(`${board.cellName(i)} 已经写成${name(cur)}了，可${rule.name}说它必须是${name(value)}——两条规则打起来了`, i);
    }
    derived[i] = value;
    found.push(Object.assign({ cell: i, value, rule }, extra));
    changed = true;
    return null;
  };

  // 1 · 带字的格子是白格
  for (let k = 0; k < board.clueCells.length; k++) {
    const s = board.clueCells[k];
    if (derived[s] === BLACK) return fail(`${board.cellName(s)} 写着 ${board.clue[s]}，带字的格子却被涂成了黑`, s);
    const bad = write(s, WHITE, Rules.numbered, { clue: s });
    if (bad) return bad;
  }

  // 2+3 · 数字的两端：一定看见的不能超，最多能看见的不能不够
  for (let k = 0; k < board.clueCells.length; k++) {
    const s = board.clueCells[k];
    const want = board.clue[s];
    const rays = board.rays[s];
    const r = readClue(board, derived, s);
    if (r.see > want) return fail(`${board.cellName(s)} 写着 ${want}，可它现在已经看见 ${r.see} 格白了`, s);
    if (r.most < want) return fail(`${board.cellName(s)} 写着 ${want}，可它四条视线全打开也只看见 ${r.most} 格`, s);
    if (r.see === want) {
      for (const [d, scan] of r.loose) {
        const bad = write(rays[d][scan.floor], BLACK, Rules.saturated, { clue: s, see: r.see });
        if (bad) return bad;
      }
    } else if (r.most === want) {
      for (const [d, scan] of r.loose) {
        for (let j = scan.floor; j < scan.ceil; j++) {
          const bad = write(rays[d][j], WHITE, Rules.starved, { clue: s, most: r.most });
          if (bad) return bad;
        }
      }
    }
  }

  // 4 · 黑格的四邻只能是白
  for (let i = 0; i < board.n; i++) {
    if (derived[i] !== BLACK) continue;
    for (const nb of board.adj[i]) {
      if (derived[nb] === BLACK) {
        return fail(`${board.cellName(i)} 和 ${board.cellName(nb)} 两块黑粘在了一起，黑格不许相邻`, i);
      }
      if (derived[nb] === OPEN) {
        const bad = write(nb, WHITE, Rules.neighbor, { from: i });
        if (bad) return bad;
      }
    }
  }

  // 5 · 白格是一整块
  const islands = islandScan(board, derived);
  if (islands.conflict) return fail(islands.conflict, islands.cell);
  for (const u of islands.forces) {
    const bad = write(u, WHITE, Rules.island, { parts: islands.parts[u] });
    if (bad) return bad;
  }
  return { found, changed };
}

// 在「已画白 ∪ 还没定」这张图上求割点。把一格涂黑之后，如果白格被劈成两截、每截都有已画白的格子，
// 那它们永远接不上（后面的格子只会把白越删越少，不会多出一条路来）——所以那格不能是黑。
// 反过来，如果两片已画白的格子本来就在两个连通块里，这盘已经死了。
function islandScan(board, derived) {
  const n = board.n;
  const parts = new Int32Array(n);
  const forces = [];
  let whites = 0;
  for (let i = 0; i < n; i++) if (derived[i] === WHITE) whites++;
  if (whites < 2) return { forces, conflict: '', cell: -1, parts };
  const disc = new Int32Array(n);
  const low = new Int32Array(n);
  const par = new Int32Array(n).fill(-1);
  const sub = new Int32Array(n); // 子树里已画白的格子数
  const sep = new Int32Array(n); // 涂黑 u 后会被单独切下来的带白格子树块数
  const sepWhites = new Int32Array(n);
  let timer = 0;
  let conflict = '';
  let cell = -1;
  let rep0 = -1;

  // 盘面最大 100 格，DFS 深度就是格数，递归够用也最好读。
  const dfs = (u, comp) => {
    timer++;
    disc[u] = low[u] = timer;
    comp.push(u);
    for (const v of board.adj[u]) {
      if (derived[v] === BLACK) continue;
      if (!disc[v]) {
        par[v] = u;
        dfs(v, comp);
        if (low[v] < low[u]) low[u] = low[v];
      } else if (v !== par[u] && disc[v] < low[u]) low[u] = disc[v];
    }
  };

  for (let root = 0; root < n; root++) {
    if (derived[root] === BLACK || disc[root]) continue;
    const comp = [];
    dfs(root, comp);
    let compWhites = 0;
    let rep = -1;
    for (const u of comp) {
      sub[u] = derived[u] === WHITE ? 1 : 0;
      if (derived[u] === WHITE) {
        compWhites++;
        if (rep < 0) rep = u;
      }
    }
    if (compWhites) {
      if (rep0 >= 0 && !conflict) {
        conflict = `${board.cellName(rep0)} 那一片和 ${board.cellName(rep)} 那一片白格已经断成两截，中间再也接不上了`;
        cell = rep;
      }
      if (rep0 < 0) rep0 = rep;
    }
    // DFS 前序里父总在子前面，倒着走一遍就能把子树的白格数收上来，同时结算割点
    for (let a = comp.length - 1; a >= 0; a--) {
      const u = comp[a];
      const p = par[u];
      if (p < 0) continue;
      if (low[u] >= disc[p]) {
        if (sub[u] > 0) sep[p]++;
        sepWhites[p] += sub[u];
      }
      sub[p] += sub[u];
    }
    for (const u of comp) {
      if (derived[u] !== OPEN) continue;
      const rest = compWhites - sepWhites[u];
      parts[u] = sep[u] + (rest > 0 ? 1 : 0);
      if (parts[u] >= 2) forces.push(u);
    }
  }
  return { forces, conflict, cell, parts };
}

// The pencil path from an empty board to a finished one. Returns the deductions in the order the
// clues forced them — that list *is* the hint script, and it never reads the player's ink, so a
// wrong black square cannot make the hints agree with the mistake.
export function solve(board) {
  const derived = new Int8Array(board.n);
  const rows = [];
  const used = new Map();
  let conflict = '';
  let guard = 0;
  for (;;) {
    const sweep = propagate(board, derived);
    if (sweep.conflict) {
      conflict = sweep.conflict;
      break;
    }
    if (!sweep.changed) break;
    for (const f of sweep.found) {
      const key = f.rule.name;
      const cur = used.get(key) || { n: 0, weight: f.rule.weight };
      cur.n++;
      used.set(key, cur);
      rows.push(f);
    }
    if (++guard > 400) {
      conflict = '推导没有收敛（引擎缺陷）';
      break;
    }
  }
  const filled = !conflict && derived.every((v) => v !== OPEN);
  let score = 0;
  for (const x of used.values()) score += x.n * x.weight;
  return {
    ok: filled,
    conflict,
    derived,
    rows,
    steps: rows.length,
    score: Math.round(score * 10) / 10,
    breakdown: Object.fromEntries([...used].map(([k, v]) => [k, v.n])),
  };
}

// The next thing the clues force that the player has not drawn yet.
export function nextDeduction(board, derived) {
  const sweep = propagate(board, derived);
  if (sweep.conflict) return { conflict: sweep.conflict };
  return sweep.found[0] || null;
}

// ---- is this ink still survivable? --------------------------------------------

// Every write the rules make is true in *every* solution, so if seeding the player's own squares
// and then running those rules hits a contradiction, no completion of this board exists. That is
// the one thing a player cannot see coming — one wrong black square can leave every number still
// numerically reachable — and it is worth saying out loud.
export function reachable(board, cell) {
  const derived = Int8Array.from(cell);
  for (let round = 0; round < board.n + 4; round++) {
    const sweep = propagate(board, derived);
    if (sweep.conflict) return false;
    if (!sweep.changed) break;
  }
  return true;
}

// ---- readouts for the UI -----------------------------------------------------

// 已经画白的格子在不穿黑格的前提下分成几片。空格算作路（它还能画白接上），所以只有连空格都走不通
// 的断开才算真断。
function whiteIslands(board, cell) {
  const seen = new Uint8Array(board.n);
  const stack = [];
  let count = 0;
  let first = -1;
  let sample = -1;
  for (let start = 0; start < board.n; start++) {
    if (cell[start] !== WHITE || seen[start]) continue;
    count++;
    if (count === 1) first = start;
    else if (sample < 0) sample = start;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    while (stack.length) {
      const u = stack.pop();
      for (const v of board.adj[u]) {
        if (seen[v] || cell[v] === BLACK) continue;
        seen[v] = 1;
        if (cell[v] === WHITE) stack.push(v);
      }
    }
  }
  return { count, first, sample };
}

// Judged straight from the rules of the game: a numbered cell sees exactly that many white cells,
// blacks do not touch, the white cells are one group, and nothing stays undecided. Nothing here
// reads `derived` or the hint script, so a bug in the propagation cannot fake a win.
export function verify(board, cell) {
  const bad = [];
  for (let i = 0; i < board.n; i++) if (cell[i] === OPEN) bad.push({ why: '空格', cell: i, want: WHITE, have: OPEN });
  for (let k = 0; k < board.clueCells.length; k++) {
    const s = board.clueCells[k];
    const want = board.clue[s];
    if (cell[s] === BLACK) {
      bad.push({ why: '数字格被涂黑', cell: s, want: WHITE, have: BLACK });
      continue;
    }
    let see = cell[s] === WHITE ? 1 : 0;
    let most = see + (cell[s] === OPEN ? 1 : 0);
    for (const ray of board.rays[s]) {
      const r = scanRay(cell, ray);
      see += r.floor;
      most += r.ceil;
    }
    if (see > want) bad.push({ why: '看见的白格多了', cell: s, want, have: see });
    else if (most < want) bad.push({ why: '看见的白格不够', cell: s, want, have: see, most });
  }
  for (let i = 0; i < board.n; i++) {
    if (cell[i] !== BLACK) continue;
    for (const nb of board.adj[i]) if (nb > i && cell[nb] === BLACK) bad.push({ why: '黑格相邻', cell: i, node: nb, want: 0, have: 2 });
  }
  const isl = whiteIslands(board, cell);
  if (isl.count > 1) bad.push({ why: '白格断成几截', cell: isl.sample, want: 1, have: isl.count });
  return bad;
}

export function complete(board, cell) {
  return verify(board, cell).length === 0 && cell.every((v) => v !== OPEN);
}

export function diagnose(board, cell) {
  let filled = 0;
  for (let t = 0; t < board.n; t++) if (cell[t] !== OPEN) filled++;
  const violated = new Set();
  const satisfied = new Set();
  for (const s of board.clueCells) {
    const want = board.clue[s];
    if (cell[s] === BLACK) {
      violated.add(s);
      continue;
    }
    let see = cell[s] === WHITE ? 1 : 0;
    let most = see + (cell[s] === OPEN ? 1 : 0);
    let loose = 0;
    for (const ray of board.rays[s]) {
      const r = scanRay(cell, ray);
      see += r.floor;
      most += r.ceil;
      if (r.floor < r.ceil) loose++;
    }
    if (see > want || most < want) violated.add(s);
    else if (see === want && loose === 0) satisfied.add(s);
  }
  for (let i = 0; i < board.n; i++) {
    if (cell[i] !== BLACK) continue;
    for (const nb of board.adj[i]) if (nb > i && cell[nb] === BLACK) violated.add(i);
  }
  const isl = whiteIslands(board, cell);
  if (isl.count > 1) {
    violated.add(isl.first);
    violated.add(isl.sample);
  }
  return {
    filled,
    total: board.n,
    remaining: board.n - filled,
    clues: board.clues,
    violated,
    satisfied,
    conflicts: violated.size,
  };
}

// ---- the player's own ink ----------------------------------------------------

export function createState(board) {
  return { board, cell: new Int8Array(board.n), history: [] };
}

export function snapshot(st) {
  st.history.push(Int8Array.from(st.cell));
  if (st.history.length > 500) st.history.shift();
  return st;
}

export function undo(st) {
  const last = st.history.pop();
  if (!last) return false;
  st.cell.set(last);
  return true;
}

export function setCell(st, t, value) {
  if (!(t >= 0 && t < st.board.n)) return false;
  if (value !== BLACK && value !== WHITE && value !== OPEN) return false;
  // 数字格天生是白格：把它涂黑不是一个动作，是一次误触，引擎直接不接（也就不留历史）。
  if (value === BLACK && st.board.clue[t] !== NO_CLUE) return false;
  if (st.cell[t] === value) return false;
  snapshot(st);
  st.cell[t] = value;
  return true;
}

export function eraseCell(st, t) {
  return setCell(st, t, OPEN);
}

export function resetInk(st) {
  st.cell.fill(OPEN);
  st.history.length = 0;
  return st;
}
