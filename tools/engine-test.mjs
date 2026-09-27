// Engine unit tests, run in plain Node: `node tools/engine-test.mjs`. The engine is DOM-free on
// purpose, so this file needs nothing but js/engine/*.
//
// The risk in this repo is not arithmetic but soundness: one rule that wrote a cell the numbers do
// not force, and every board would still ship, the hints would still be self-consistent, and
// "每局都能推到底" would be a caption on a coin flip. So every expectation below is hand-derived
// from a board worked out on paper and written as a LITERAL — never read back off the solver.

import {
  createBoard,
  cluesFrom,
  solve,
  verify,
  complete,
  diagnose,
  reachable,
  propagate,
  nextDeduction,
  Rules,
  OPEN,
  BLACK,
  WHITE,
  NO_CLUE,
  other,
  raysAt,
  adjAt,
  scanRay,
  createState,
  snapshot,
  undo,
  setCell,
  eraseCell,
  resetInk,
} from '../js/engine/kuromasu.js';
import { countSolutions, UNIQUE, MANY, NONE, OVERBUDGET } from '../js/engine/count.js';
import { generate, makePuzzle, randomSolution, pruneClues, tierFor, TIERS, mix } from '../js/engine/generate.js';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`);
  }
};
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};
const throws = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};
// 'cell:value' 串按格号排序，用来比较「同一批格子」而不牵扯两次推导的先后
const sortKeys = (arr) => arr.slice().sort((x, y) => Number(x.split(':')[0]) - Number(y.split(':')[0])).join('|');

// ---- 盘面包写手 ----
// 只给形状：'#' 黑格，'.' 白格。数字由规则本身算出来，也就是出题器种下答案之后的「全数字盘」。
const fromSol = (rows) => {
  const h = rows.length;
  const w = rows[0].length;
  const sol = new Int8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) sol[r * w + c] = rows[r][c] === '#' ? BLACK : WHITE;
  return { b: createBoard({ w, h, clue: cluesFrom(w, h, sol) }), sol, w, h };
};
// 手写的数字：'#' 黑格没有数字，'.' 白格没有数字，数字就是那个数字（带字的格子必定是白格）。
const hand = (rows) => {
  const h = rows.length;
  const grid = rows.map((line) => line.trim().split(/\s+/));
  const w = grid[0].length;
  const clue = new Int8Array(w * h);
  clue.fill(NO_CLUE);
  const sol = new Int8Array(w * h);
  grid.forEach((line, r) => line.forEach((tok, c) => {
    const i = r * w + c;
    if (tok === '#') sol[i] = BLACK;
    else if (tok !== '.') clue[i] = Number(tok);
  }));
  return { b: createBoard({ w, h, clue }), sol, w, h };
};

// ---------- 几何：视线、四邻、一条射线能看见几格 ----------

// 中心格 (1,1) 的四条视线，都是"离数字格由近到远"。3×3 盘上它就是上下左右各一格。
{
  const R = raysAt(3, 3, 4);
  eq('中心格向上只有 1 格', JSON.stringify(R[0]), JSON.stringify([1]));
  eq('中心格向下只有 7', JSON.stringify(R[1]), JSON.stringify([7]));
  eq('中心格向左只有 3', JSON.stringify(R[2]), JSON.stringify([3]));
  eq('中心格向右只有 5', JSON.stringify(R[3]), JSON.stringify([5]));
  const C = raysAt(3, 3, 0);
  eq('左上角往上是盘外', JSON.stringify(C[0]), JSON.stringify([]));
  eq('左上角向下是 3 再 6', JSON.stringify(C[1]), JSON.stringify([3, 6]));
  eq('左上角向右是 1 再 2', JSON.stringify(C[3]), JSON.stringify([1, 2]));
  // 4×3 盘上的 (1,2) = 第 6 格：上 (0,2)=2、下 (2,2)=10、左 (1,1)(1,0)=5,4、右 (1,3)=7
  eq('非方形盘上的四条视线', JSON.stringify(raysAt(4, 3, 6)), JSON.stringify([[2], [10], [5, 4], [7]]));
  eq('四邻按上下左右排', JSON.stringify(adjAt(3, 3, 4)), JSON.stringify([1, 7, 3, 5]));
  eq('角上的四邻只有两格', JSON.stringify(adjAt(3, 3, 0)), JSON.stringify([3, 1]));
}

// 一条视线的读数：floor 是一定看见的（开头连续已定白格），ceil 是顶多能看见的。
{
  const S = (a) => scanRay(Int8Array.from(a), [0, 1, 2]);
  eq('全空的视线：看见 0 格，最多 3 格', JSON.stringify(S([OPEN, OPEN, OPEN])), JSON.stringify({ floor: 0, ceil: 3, len: 3 }));
  eq('一路白：定死 3 格', JSON.stringify(S([WHITE, WHITE, WHITE])), JSON.stringify({ floor: 3, ceil: 3, len: 3 }));
  eq('第二格是黑：定死 1 格', JSON.stringify(S([WHITE, BLACK, WHITE])), JSON.stringify({ floor: 1, ceil: 1, len: 3 }));
  eq('白、空、黑：1 到 2 格', JSON.stringify(S([WHITE, OPEN, BLACK])), JSON.stringify({ floor: 1, ceil: 2, len: 3 }));
  eq('白、空、白：1 到 3 格', JSON.stringify(S([WHITE, OPEN, WHITE])), JSON.stringify({ floor: 1, ceil: 3, len: 3 }));
  eq('空、黑、白：定死 0 格', JSON.stringify(S([OPEN, BLACK, WHITE])), JSON.stringify({ floor: 0, ceil: 1, len: 3 }));
  eq('空、黑、白的第一格必是空（所以规则敢写它）', S([OPEN, BLACK, WHITE]).floor, 0);
  eq('空视线的长度记在案上', JSON.stringify(scanRay(new Int8Array(0), [])), JSON.stringify({ floor: 0, ceil: 0, len: 0 }));
}

// 3×3 盘，只把两个对角的格子涂黑。白格是一整块、黑格不相邻，所以这是个合法答案。
// 每个数字都手数过：数字格自己也算看得见的一格，视线撞上黑格就停。
//   # 4 3
//   4 5 4
//   3 4 #
// 例：第 1 行 2 列 = 自己 + 下面 4、7 两格 + 右边 2 一格 + 左边被 # 挡住 = 4。
{
  const { b, sol } = fromSol(['#..', '...', '..#']);
  eq('全数字盘的手算数字', Array.from(b.clue).join(','), '-1,4,3,4,5,4,3,4,-1');
  eq('带字的格子有几块', b.clues, 7);
  eq('这块盘上最多能看见几格 = w+h-1', b.maxSee, 5);
  eq('中心格的数字正好是上限', b.clue[4], 5);
  const p = solve(b);
  eq('全数字盘能推到底', p.ok, true);
  eq('铅笔和种下的解同盘', Array.from(p.derived).join(','), Array.from(sol).join(','));
  eq('推导步数 = 格数', p.steps, 9);
  eq('分数手算：7×1 + 2×1.5', p.score, 10);
  eq('规则用量手算', JSON.stringify(p.breakdown), JSON.stringify({ 带字即白: 7, 已经看满: 2 }));
  eq('没有矛盾', p.conflict, '');
  // 第 8 格（右下角）是第 9 次落子，由第 1 行 3 列的 3 逼出来：它已经看见自己、1、0 三格
  eq('最后一子由哪个数字逼出', `${p.rows[8].cell}:${p.rows[8].value}:${p.rows[8].clue}`, '8:1:2');
}

// ---------- 给定数字必须先成立 ----------

eq('太小的盘不开', throws(() => createBoard({ w: 0, h: 3, clue: new Int8Array(0) })), '盘面尺寸不合法');
eq('不是整数的边长不开', throws(() => createBoard({ w: 2.5, h: 2, clue: new Int8Array(4) })), '盘面尺寸不合法');
eq('长度不对的数组不放行', throws(() => createBoard({ w: 2, h: 2, clue: new Int8Array(3) })), 'clue 长度是 3 个，盘面有 4 格');
eq('写 0 的数字自相矛盾', throws(() => createBoard({ w: 2, h: 2, clue: Int8Array.from([0, -1, -1, -1]) })), '第1行1列 写着 0，可带字的格子自己也看得见自己，最少是 1');
eq('负数不是数字', throws(() => createBoard({ w: 2, h: 2, clue: Int8Array.from([-2, -1, -1, -1]) })), '第1行1列 写着 -2，可带字的格子自己也看得见自己，最少是 1');
eq('超过四方向总格数不放行', throws(() => createBoard({ w: 2, h: 2, clue: Int8Array.from([-1, -1, -1, 4]) })), '第2行2列 写着 4，可它四个方向顶多看得见 3 格');
eq('1×1 盘写 2 当场拒绝', throws(() => createBoard({ w: 1, h: 1, clue: Int8Array.from([2]) })), '第1行1列 写着 2，可它四个方向顶多看得见 1 格');
eq('一个数字都没有的盘没有解', throws(() => createBoard({ w: 2, h: 2, clue: Int8Array.from([-1, -1, -1, -1]) })), '盘上没有数字');
// 1×3 盘上两头各写 2。手数：0 和 2 是白格；2 要求"除了自己只看见 1 格白"，可 0 要看见 2 就
// 必须让中间那格是白，中间是白又让 0 一路看见 1、2 两格 —— 怎么都不成立，所以这盘无解。
{
  const t = hand(['2 . 2']);
  eq('两个数字互相矛盾时判为无解', countSolutions(t.b, { cap: 2, budget: 100000 }).status, NONE);
  eq('矛盾盘不会被规则推完', solve(t.b).ok, false);
  ok('矛盾说法点出是哪一个数字', /写着 2，可它现在已经看见 3 格白/.test(solve(t.b).conflict), solve(t.b).conflict);
  // 而且这盘是被"白格必须连通"逼死的：中间那格先被写成白，数字才溢出
  eq('白不断路这条规则确实落了子', JSON.stringify(solve(t.b).breakdown), JSON.stringify({ 带字即白: 2, 白不断路: 1 }));
  eq('被逼出来的一格', solve(t.b).derived[1], WHITE);
}

// ---------- 每条规则都说得出该落哪一格 ----------

{
  const { b } = fromSol(['#..', '...', '..#']);
  ok('规则表是 5 条', Object.keys(Rules).length === 5);
  eq('每条规则的权重都是正数', Object.values(Rules).every((r) => r.weight > 0), true);
  const d = { cell: 4, clue: 1, from: 0, see: 4, most: 5, parts: 2, value: WHITE };
  for (const r of Object.values(Rules)) {
    ok(`${r.name} 的文本带坐标`, /第\d+行\d+列/.test(r.text(b, d)), r.text(b, d));
    ok(`${r.name} 的文本说得出黑白`, /黑|白/.test(r.text(b, d)), r.text(b, d));
  }
  // 一次扫描就该把全盘写完：7 个带字的格子被写成白，再由两个数字把两角逼成黑
  const derived = new Int8Array(b.n);
  const sweep = propagate(b, derived);
  eq('第一扫落子数', sweep.found.length, 9);
  eq('第一扫的头一子是带字的格子变白', `${sweep.found[0].cell}:${sweep.found[0].value}`, '1:2');
  eq('第一扫的最后两子是黑格', sweep.found.slice(-2).map((f) => `${f.cell}${f.value}`).join(' '), '01 81');
  eq('最后两子用的规则', sweep.found[8].rule.name, '已经看满');
  eq('已经看满说得出是哪个数字', sweep.found[7].clue, 1);
  eq('第二扫无事可做', propagate(b, derived).changed, false);
}

// ---------- 两套互不信任的实现必须同解 ----------

// The falsifiable claim, stated honestly for a game whose pencil path is NOT complete:
//   计数器说 UNIQUE 且铅笔推完 → 两者必须给出同一盘墨；
//   铅笔推完 → 计数器绝不能说 MANY / 无解；
//   而"唯一但铅笔推不动"是允许的（那种盘出题器不会要），所以只统计、不当成罪。
// Boards come from three sources — full clues, the generator's own gated pruning, and a naive
// 78% random deletion that no filter has touched — because only the last two can disagree.
{
  const rand = (seed) => {
    let x = seed >>> 0 || 7;
    return () => {
      x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
      return x / 4294967296;
    };
  };
  let unique = 0;
  let many = 0;
  let none = 0;
  let over = 0;
  let disagree = 0;
  let pencilButNotUnique = 0;
  let uniqueButStalled = 0;
  let gatedStalled = 0;
  let fullStalled = 0;
  let boards = 0;
  for (let s = 0; s < 45; s++) {
    const w = 5 + (s % 3);
    const r = rand(5000 + s * 977);
    const sol = randomSolution(w, w, r, 0.3);
    const full = createBoard({ w, h: w, clue: cluesFrom(w, w, sol) });
    const loose = Int8Array.from(full.clue);
    const idx = [...loose.keys()].sort((a, b) => r() - r());
    for (const i of idx.slice(0, Math.floor(idx.length * 0.78))) loose[i] = NO_CLUE;
    const boardsOf = [
      ['full', full],
      ['gated', createBoard({ w, h: w, clue: pruneClues(full, r, Math.round(w * w * 0.42)) })],
      ['loose', createBoard({ w, h: w, clue: loose })],
    ];
    for (const [src, b] of boardsOf) {
      boards++;
      const c = countSolutions(b, { cap: 2, budget: 200000 });
      const p = solve(b);
      if (c.status === OVERBUDGET) {
        over++;
        continue;
      }
      if (c.status === UNIQUE) {
        unique++;
        if (!p.ok) {
          uniqueButStalled++;
          if (src === 'full') fullStalled++;
          if (src === 'gated') gatedStalled++;
        } else if (Array.from(p.derived).join(',') !== Array.from(c.first).join(',')) disagree++;
      } else if (c.status === MANY) {
        many++;
        if (p.ok) pencilButNotUnique++;
      } else {
        none++;
        if (p.ok) pencilButNotUnique++;
      }
    }
  }
  eq('样本是 135 块盘', boards, 135);
  eq('唯一盘一律与穷举同解', disagree, 0, `${unique} 个唯一盘`);
  eq('多解盘不会被规则误判推完', pencilButNotUnique, 0, `${many} 个多解盘`);
  ok('样本里两种判定都够多', unique >= 40 && many >= 10, `唯一 ${unique} 多解 ${many}`);
  eq('一块都不许超预算', over, 0);
  eq('种了答案的盘不会判成无解', none, 0);
  eq('全数字盘铅笔一定推得完', fullStalled, 0, `${uniqueButStalled} 块唯一但推不动`);
  eq('闸门剪出来的盘铅笔一定推得完', gatedStalled, 0);
}

// ---------- 验收器只读盘面和墨迹 ----------

{
  const { b, sol } = fromSol(['#..', '...', '..#']);
  eq('种下的解通过验收', verify(b, sol).length, 0);
  eq('验收认它为完整', complete(b, sol), true);
  // 把中心那格涂黑：数字格不能是黑格、四边数字看不见那么多、白格还被劈成两截
  const flip = Int8Array.from(sol);
  flip[4] = BLACK;
  const bad = verify(b, flip);
  const why = bad.map((x) => x.why);
  ok('中心涂黑被判：数字格被涂黑', why.includes('数字格被涂黑'), JSON.stringify(bad));
  ok('中心涂黑被判：白格断成几截', why.includes('白格断成几截'), JSON.stringify(bad));
  ok('中心涂黑被判：看见的白格不够', why.includes('看见的白格不够'), JSON.stringify(bad));
  const c1 = bad.find((x) => x.why === '看见的白格不够' && x.cell === 1);
  eq('第1行2列 写着 4，现在只看见 2', `${c1.want}/${c1.have}`, '4/2');
  // 断掉的两截：从第 1 行 2 列走得到 1、2、5，从第 2 行 1 列那截才轮到 3、6、7
  const isl = bad.find((x) => x.why === '白格断成几截');
  eq('断开说的是第二截的第一格', isl.cell, 3);
  eq('几截', isl.have, 2);
  // 全盘留白：第 1 行 2 列看见自己 + 2 + 4 + 7 = 5 格，比 4 多一格
  const allWhite = new Int8Array(b.n).fill(WHITE);
  const over = verify(b, allWhite).find((x) => x.cell === 1);
  eq('全白时第1行2列看见 5 格', over.have, 5);
  eq('多出来的是哪一句', over.why, '看见的白格多了');
  // 两块黑粘在一起
  const touching = Int8Array.from(sol);
  touching[1] = BLACK;
  ok('黑格相邻被点出来', verify(b, touching).some((x) => x.why === '黑格相邻'), JSON.stringify(verify(b, touching)));
  eq('粘在一起的盘不算走完', complete(b, touching), false);
  // 留空格
  const hole = Int8Array.from(sol);
  hole[3] = OPEN;
  eq('留空格被判错', verify(b, hole).filter((x) => x.why === '空格').length, 1);
  eq('留空格不算走完', complete(b, hole), false);
  // 2×2 盘，只有第 1 行 2 列与第 2 行 1 列写着 2：手数有两个答案
  //（左上黑右下白，或左上白右下黑），两个都通得过验收，可铅笔一格也推不动。
  const two = hand(['. 2', '2 .']);
  const A = Int8Array.from([BLACK, WHITE, WHITE, WHITE]);
  const Bw = Int8Array.from([WHITE, WHITE, WHITE, BLACK]);
  eq('答案一通过验收', verify(two.b, A).length, 0);
  eq('答案二也通过验收', verify(two.b, Bw).length, 0);
  eq('两个答案都是完整的', `${complete(two.b, A)}:${complete(two.b, Bw)}`, 'true:true');
  eq('穷举也说是两解', countSolutions(two.b, { cap: 2, budget: 100000 }).status, MANY);
  eq('铅笔推不完这块多解盘', solve(two.b).ok, false);
  // 3×3 盘只给第 1 行 1 列写 1：它要求右边和下边第一格都是黑，于是自己被封死。
  // 手数到"无解"，两套实现都得这么说。
  const k1 = hand(['1 . .', '. . .', '. . .']);
  eq('角落写 1 是块死盘（穷举）', countSolutions(k1.b, { cap: 2, budget: 100000 }).status, NONE);
  const sk1 = solve(k1.b);
  eq('角落写 1 铅笔也判死', sk1.ok, false);
  eq('铅笔推到的墨迹手算一致', Array.from(sk1.derived).join(','), '2,1,2,1,2,0,2,0,0');
  ok('死因说得出断在哪两片白格', /第1行1列[\s\S]*第1行3列/.test(sk1.conflict), sk1.conflict);
}

// ---------- 诊断读数 ----------

{
  const { b, sol } = fromSol(['#..', '...', '..#']);
  const flip = Int8Array.from(sol);
  flip[4] = BLACK;
  const dg = diagnose(b, flip);
  eq('诊断：格子填满', dg.filled, 9);
  eq('诊断：总数', dg.total, 9);
  eq('诊断：没有剩余', dg.remaining, 0);
  eq('诊断：数字个数', dg.clues, 7);
  eq('诊断：冲突的数字是 1、3、4、5、7', [...dg.violated].sort((x, y) => x - y).join(','), '1,3,4,5,7');
  eq('诊断：冲突计数与集合一致', dg.conflicts, dg.violated.size);
  eq('诊断：还对上的数字是 2、6', [...dg.satisfied].sort((x, y) => x - y).join(','), '2,6');
  const empty = diagnose(b, new Int8Array(b.n));
  eq('空墨迹：没填任何格', empty.filled, 0);
  eq('空墨迹：剩余等于格数', empty.remaining, 9);
  eq('空墨迹：没有数字算对上', empty.satisfied.size, 0);
  eq('空墨迹：也没有数字算违反', empty.conflicts, 0);
  eq('照解画满：全都对上', diagnose(b, sol).satisfied.size, 7);
  eq('照解画满：零冲突', diagnose(b, sol).conflicts, 0);
}

// ---------- 还能活下去的墨迹：reachable 的单方向可靠 ----------

// `reachable` says "no completion of this ink exists" only when the forced writes themselves
// contradict — so it must never cry wolf on a board that still has a solution.
{
  const p = makePuzzle('unit|reach', 'regular');
  const b = p.board;
  eq('空盘当然可完成', reachable(b, new Int8Array(b.n)), true);
  eq('照解画满是可完成', reachable(b, p.solution), true);
  eq('画满且合法时不报警', verify(b, p.solution).length, 0);
  // 第一个不是"带字即白"的强制落子：把它画反，五类规则里必有一类当场打架
  const forced = solve(b).rows.find((r) => r.rule !== Rules.numbered);
  ok('这块盘确有非数字格的强制落子', !!forced, JSON.stringify(solve(b).rows[0]));
  const wrong = Int8Array.from(p.solution);
  wrong[forced.cell] = other(forced.value);
  eq('把被逼出来的一格画反，判为矛盾', reachable(b, wrong), false);
  eq('只画错那一格也判矛盾', reachable(b, (() => { const ink = new Int8Array(b.n); ink[forced.cell] = other(forced.value); return ink; })()), false);
  eq('画对一格仍可完成', reachable(b, (() => { const ink = new Int8Array(b.n); ink[forced.cell] = forced.value; return ink; })()), true);
  ok('矛盾不一定违反某个数字（所以验收器看不出来）', verify(b, wrong).length === 0 || reachable(b, wrong) === false, JSON.stringify(verify(b, wrong)));
  // 手数的一块盘：3×3 全数字盘上全盘留白，第 1 行 2 列已经看见 5 格白 > 4，报警是对的
  const full = fromSol(['#..', '...', '..#']);
  eq('全盘留白在死盘上报警', reachable(full.b, new Int8Array(9).fill(WHITE)), false);
  eq('全盘留白在死盘上也通不过验收', verify(full.b, new Int8Array(9).fill(WHITE)).length > 0, true);
  eq('照答案画满不报警', reachable(full.b, full.sol), true);
}

// ---------- 状态机：落子、撤销、历史上限 ----------

{
  const { b } = fromSol(['#..', '...', '..#']); // 数字在 1..7，只有 0 和 8 没带字
  const st = createState(b);
  eq('开局没有墨', Array.from(st.cell).join(','), new Array(9).fill('0').join(','));
  eq('开局没有历史', st.history.length, 0);
  eq('空历史撤销返回 false', undo(st), false);
  eq('拒绝把带字的格子涂黑', setCell(st, 4, BLACK), false);
  eq('被拒绝的落子不留历史', st.history.length, 0);
  eq('拒绝越界的格子', setCell(st, b.n, BLACK), false);
  eq('拒绝没有的颜色', setCell(st, 0, 7), false);
  let steps = 0;
  // 1..7 全带字，只有 0 和 8 能涂黑；带字格只能画白，画白再擦掉也是一步
  const plays = [[0, BLACK], [8, BLACK], [1, WHITE], [1, OPEN], [2, WHITE]];
  for (const [t, v] of plays) if (setCell(st, t, v)) steps++;
  eq('五次落子都算一步', steps, 5);
  eq('历史栈与步数对齐', st.history.length, steps);
  eq('最后一格写进去了', st.cell[2], WHITE);
  eq('落子前的快照是落子前的样子', Array.from(st.history[4]).join(','), '1,0,0,0,0,0,0,0,1');
  eq('同一格涂第二次不算落子', setCell(st, 2, WHITE), false);
  eq('擦掉一格', eraseCell(st, 2), true);
  eq('擦干净是空格', st.cell[2], OPEN);
  eq('擦掉也要留历史', st.history.length, 6);
  eq('撤销把白格还回来', `${undo(st)}:${st.cell[2]}`, 'true:2');
  eq('撤销退掉一步', st.history.length, 5);
  eq('再撤两笔退回到涂白之后', `${undo(st)}:${undo(st)}:${Array.from(st.cell).join(',')}`, `true:true:1,2,0,0,0,0,0,0,1`);
  eq('剩下三笔历史', st.history.length, 3);
  eq('退到底之后撤销不再动', `${(() => { while (undo(st)); return true; })()}:${Array.from(st.cell).join(',')}:${st.history.length}`, `true:0,0,0,0,0,0,0,0,0:0`);
  eq('空历史再撤销返回 false', undo(st), false);
  // 历史上限
  const deep = createState(b);
  for (let i = 0; i < 620; i++) snapshot(deep);
  eq('历史栈封顶 500', deep.history.length, 500);
  eq('封顶之后留下的是最近的快照', (deep.cell[0] = WHITE, snapshot(deep), deep.history[499][0]), WHITE);
  eq('快照存的是整盘而不是增量', deep.history[0].length, b.n);
  const back = createState(b);
  setCell(back, 0, BLACK);
  resetInk(back);
  eq('重开清空墨迹', Array.from(back.cell).join(','), new Array(9).fill('0').join(','));
  eq('重开清空历史', back.history.length, 0);
}

// ---------- 提示来自数字，不来自玩家的墨迹 ----------

{
  const p = makePuzzle('unit|hint', 'regular');
  const b = p.board;
  const script = solve(b);
  eq('提示脚本能走完这局', script.ok, true);
  const names = new Set(Object.values(Rules).map((r) => r.name));
  // 一次 propagate 会把整条规则链一口气推到底，而提示一次只能揭一格：
  // UI 收钱的那一格 = 在墨迹的副本上推一遍，只把推出来的第一格写回玩家的墨迹。
  const ink = new Int8Array(b.n);
  const shown = [];
  const takeHint = () => {
    const probe = Int8Array.from(ink);
    const d = nextDeduction(b, probe);
    if (!d || d.conflict) return d || null;
    ink[d.cell] = d.value;
    return d;
  };
  let charged = 0;
  let badRule = 0;
  let outOfRange = 0;
  let noCoord = 0;
  let order = 0;
  for (let k = 0; k < b.n * 4; k++) {
    const d = takeHint();
    if (!d) break;
    charged++;
    shown.push(`${d.cell}:${d.value}`);
    if (!names.has(d.rule.name)) badRule++;
    if (!(d.cell >= 0 && d.cell < b.n)) outOfRange++;
    if (!/第\d+行\d+列/.test(d.rule.text(b, d))) noCoord++;
    if (ink[d.cell] !== d.value) badRule++;
  }
  eq('一路提示能走完这局', complete(b, ink), true);
  eq('每格正好被提示一次', charged, b.n);
  eq('提示次数与脚本等长', charged, script.rows.length);
  eq('提示从不越界', outOfRange, 0);
  eq('提示说的规则与写下的格都合法', badRule + noCoord, 0);
  eq('提示揭开的格与脚本逐格同值', sortKeys(shown), sortKeys(script.rows.map((r) => `${r.cell}:${r.value}`)));
  eq('第一次提示就是脚本第一行', shown[0], `${script.rows[0].cell}:${script.rows[0].value}`);
  eq('走完之后不再收费', `${takeHint() === null}:${charged}:${b.n}`, 'true:49:49');
}

// A wrong square must not teach the hints to agree with it: the script comes from the numbers, so
// an unproductive hint names the contradiction and takes no money.
{
  const p = makePuzzle('unit|wrong', 'trainee');
  const b = p.board;
  const forced = solve(b).rows.find((r) => r.rule !== Rules.numbered);
  let wallet = 0;
  const hint = (ink) => {
    const d = nextDeduction(b, ink);
    if (!d || d.conflict) return d || { stalled: true };
    wallet++;
    return d;
  };
  const ink = new Int8Array(b.n);
  ink[forced.cell] = other(forced.value);
  const first = hint(ink);
  ok('与数字矛盾时提示拒绝落子', !!first.conflict, JSON.stringify(first));
  eq('矛盾时不收钱', wallet, 0);
  ok('矛盾说明写清了断在哪', /黑|白|看见|接不上/.test(first.conflict), first.conflict);
  eq('那一格还留着玩家自己的墨', ink[forced.cell], other(forced.value));
  const clean = hint(new Int8Array(b.n));
  ok('干净的墨迹给得出落子', clean.value === WHITE || clean.value === BLACK, JSON.stringify(clean));
  eq('这次才计一次提示', wallet, 1);
  const again = hint(new Int8Array(b.n));
  eq('两次提示说的是同一件事', `${again.cell}:${again.value}`, `${clean.cell}:${clean.value}`);
  eq('提示的脚本不依赖墨迹', clean.cell, solve(b).rows[0].cell);
}

// ---------- 存档形状的成本字段：同一颗种子必须重绘同一块盘 ----------

{
  const p = makePuzzle('unit|store', 'expert');
  eq('形状：档位', p.tier, 'expert');
  eq('形状：档位名', p.tierName, '高阶');
  eq('形状：原始种子', p.originSeed, 'unit|store');
  eq('形状：尺寸', p.size, '8×8');
  eq('形状：宽高', `${p.w}×${p.h}`, '8×8');
  eq('形状：分数是数', typeof p.score, 'number');
  eq('形状：步数是数', typeof p.steps, 'number');
  eq('形状：留下的数字', p.clues, p.board.clues);
  eq('形状：盘面里的数字同一条', Array.from(p.board.clue).join(','), Array.from(makePuzzle('unit|store', 'expert').board.clue).join(','));
  ok('形状：抽了几次才出货', p.gen >= 1 && p.gen <= 24, String(p.gen));
  eq('形状：种下的解就是验收认的解', Array.from(p.solution).join(','), Array.from(solve(p.board).derived).join(','));
  eq('重绘的分数一模一样', makePuzzle('unit|store', 'expert').score, p.score);
  // 时间不许进选择：把墙上时钟冻住，同一颗种子还得给出同一块盘
  const realNow = Date.now;
  let clock = '';
  try {
    Date.now = () => {
      throw new Error('抽盘用了墙上时钟');
    };
    const q = makePuzzle('unit|store', 'expert');
    clock = Array.from(q.board.clue).join(',') === Array.from(p.board.clue).join(',') ? '' : '重绘出了另一块盘';
  } catch (e) {
    clock = e.message;
  } finally {
    Date.now = realNow;
  }
  eq('出题不看表（续局不会换盘）', clock, '');
  eq('认不出的档位落到上手', tierFor('no-such-tier').key, TIERS[1].key);
  eq('档位一共 5 档', TIERS.length, 5);
  eq('档位的键与名字按顺序', TIERS.map((t) => `${t.key}:${t.name}`).join(' '), 'trainee:初学 apprentice:上手 regular:熟练 expert:高阶 master:大师');
  ok('每档都带着量出来的区间', TIERS.every((t) => t.band[0] > 0 && t.band[1] > t.band[0]), JSON.stringify(TIERS.map((t) => t.band)));
  // 一支都抽不到时必须老实交代
  const nothing = generate({ w: 6, h: 6, seed: 'unit|none', tries: 0 });
  eq('抽不到时 ok 是 false', nothing.ok, false);
  eq('抽不到时不给盘', nothing.board, null);
  eq('抽不到时给出中文理由', nothing.reason, '没找到既唯一又能纯逻辑推到底的盘面');
  eq('混种子是确定的', Array.from({ length: 3 }, () => mix('a#0')()).join('|'), Array.from({ length: 3 }, () => mix('a#0')()).join('|'));
  ok('种子不同就给出不同的数', mix('a#0')() !== mix('b#0')());
}

// ---------- 难度：阶梯是量出来的，区间不是说出来的 ----------

{
  const med = (a) => a.slice().sort((x, y) => x - y)[(a.length - 1) >> 1];
  const rows = [];
  for (const tier of TIERS) {
    const scores = [];
    let inBand = 0;
    let unsolvable = 0;
    let unique = 0;
    let disagree = 0;
    let ms = 0;
    for (let s = 0; s < 6; s++) {
      const t0 = Date.now();
      const p = makePuzzle(`band|${tier.key}|${s}`, tier.key);
      ms += Date.now() - t0;
      if (!p) continue;
      scores.push(p.score);
      if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
      if (!solve(p.board).ok) unsolvable++;
      const c = countSolutions(p.board, { cap: 2, budget: 200000 });
      if (c.status === UNIQUE) unique++;
      if (c.status !== UNIQUE || Array.from(solve(p.board).derived).join(',') !== Array.from(c.first || []).join(',')) disagree++;
    }
    rows.push({ key: tier.key, median: med(scores), inBand, n: scores.length, unsolvable, unique, disagree, ms: ms / 6 });
    eq(`${tier.key} 出货 6/6`, scores.length, 6);
    eq(`${tier.key} 每局都能推到底`, unsolvable, 0);
    eq(`${tier.key} 每局都唯一解`, unique, scores.length);
    eq(`${tier.key} 每局两套实现同解`, disagree, 0);
    ok(`${tier.key} 分数落在自己的区间里`, inBand >= 5, `${inBand}/6 在 ${tier.band}`);
    ok(`${tier.key} 出题够快`, ms / 6 < 900, `${(ms / 6).toFixed(0)} ms/局`);
  }
  let mono = true;
  for (let i = 1; i < rows.length; i++) if (!(rows[i].median > rows[i - 1].median)) mono = false;
  eq('档位中位分数单调递增', mono, true);
  const noband = generate({ w: 5, h: 5, seed: 'band|noband', tries: 4 });
  ok('不给区间也能出货', noband.ok && noband.offBand === 0);
  const tiny = generate({ w: 4, h: 4, seed: 'band|tiny', tries: 6, keepRatio: 0.95 });
  ok('数字给满时更简单', tiny.ok && tiny.score > 0, tiny.score);
  const dense = generate({ w: 7, h: 7, seed: 'band|dense', tries: 6, keepRatio: 0.8 });
  ok('留得多就推得快', dense.ok && dense.score < TIERS[2].band[0], `${dense.score} vs ${TIERS[2].band[0]}`);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
