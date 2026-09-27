// Browser-side scenario suite, injected by tools/playtest.cjs and run against the real page.
//
// The rule for anything asserted here: read the DOM, the geometry and the canvas pixels, not a
// flag. A `.hidden` boolean says what the code intended; a client rect and a pixel say what the
// player got. The interesting failures in this game are exactly the ones where the state is right
// and the picture or the click is wrong — a square shaded in the engine but painted as paper on
// screen, or a number whose count says one thing while its digit is drawn in another colour.
//
// window.kuromasu.engine is the shipped module graph, so a scenario that passes here has passed on
// the same solver the player's hints come from — not a second copy kept for testing.
//
// ck(name, condition, detail) is truthiness; eq(name, got, want) is equality. Mixing them up is
// how `ck('count', 0)` reads as a failure to a human and a pass to a boolean — every "must equal"
// below therefore goes through eq.

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    // rows is copied, not aliased: the array is cleared below, and a live reference would hand
    // back an empty report that still reads as "0 failed".
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const A = () => w.kuromasu;
  const E = () => w.kuromasu.engine;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shown = (sel) => {
    const e = $(sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };

  function pointer(type, x, y, button = 0) {
    const ev = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
    });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }
  const at = (t) => {
    const r = A().view.cellRect(t);
    const box = A().view.canvas.getBoundingClientRect();
    return { x: box.left + r.x + r.size / 2, y: box.top + r.y + r.size / 2, size: r.size };
  };
  async function tap(t, button = 0) {
    const p = at(t);
    pointer('pointerdown', p.x, p.y, button);
    pointer('pointerup', p.x, p.y, button);
    return wait(24);
  }
  // One interpolated sweep of moves: a real finger never teleports from cell to cell, and the
  // gesture code only paints the cell it is told about, so a test that jumps would silently drag
  // across two cells instead of the whole run.
  function glide(x0, y0, x1, y1) {
    const cell = A().view.geo.cell || 30;
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (cell / 3)));
    for (let i = 1; i <= steps; i++) pointer('pointermove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
  }
  async function drag(from, to, button = 0) {
    const a = at(from);
    const b = at(to);
    pointer('pointerdown', a.x, a.y, button);
    glide(a.x, a.y, b.x, b.y);
    pointer('pointerup', b.x, b.y, button);
    return wait(24);
  }
  // The longest run of neighbours carrying no number. A drag that had to step over a clue is two
  // gestures, and "one gesture, one step" would prove nothing with one.
  function freeRun(board, kind, index) {
    const cells = [];
    if (kind === 'row') for (let c = 0; c < board.w; c++) cells.push(index * board.w + c);
    else for (let r = 0; r < board.h; r++) cells.push(r * board.w + index);
    let best = [];
    let cur = [];
    for (const t of cells) {
      if (board.clue[t] !== board.clue[t] ? false : board.clue[t] !== E().NO_CLUE) {
        cur = [];
        continue;
      }
      cur.push(t);
      if (cur.length > best.length) best = cur.slice();
    }
    return best;
  }
  // Every line of the board that offers a run at least `min` long, longest first. Which row carries
  // the run is the board's business, not the test's: pinning it to "row 0 of seed X" made the check
  // fail the moment the generator moved a number, while testing nothing about the gesture. The
  // caller still asserts the list is long enough — a drag of one cell would prove nothing.
  function freeRuns(board, kind, min) {
    const lines = kind === 'row' ? board.h : board.w;
    const out = [];
    for (let i = 0; i < lines; i++) {
      const r = freeRun(board, kind, i);
      if (r.length >= min) out.push(r);
    }
    return out.sort((a, b) => b.length - a.length || a[0] - b[0]);
  }
  // The same gesture as `drag`, but stopped halfway and never released — the harness holds the
  // pointer down so a scenario can read the preview that is painted while the finger is still on
  // the glass.
  function dragHold(from, to) {
    const a = at(from);
    const b = at(to);
    const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (a.size / 3)));
    pointer('pointerdown', a.x, a.y);
    for (let i = 1; i <= steps; i++) {
      pointer('pointermove', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    }
    return { a, b };
  }

  const hex = (h) => {
    const m = String(h).replace('#', '');
    return m.length < 6 ? [-1, -1, -1] : [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  const rgb = (s) => {
    const m = String(s).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [-1, -1, -1];
  };
  const near = (p, c, tol = 10) => p.length === 3 && p.every((v, i) => Math.abs(v - c[i]) <= tol);
  function pixel(x, y) {
    const v = A().view;
    const d = v.geo.dpr;
    const p = v.ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  // The middle of a cell: the one point every role in this game has to answer for — a shaded
  // square covers it, a decided white wears its dot there, an open cell leaves bare paper.
  const centrePixel = (t) => {
    const r = A().view.cellRect(t);
    return pixel(r.x + r.size / 2, r.y + r.size / 2);
  };
  // A point on the sheet but off any cell mark, used to prove the paper itself is the background.
  const sheetPixel = () => {
    const v = A().view;
    return pixel(v.geo.x / 2, v.geo.y / 2);
  };
  // Sample the ring a number is drawn with: the digit sits inside it, the paper disc under that, so
  // the only place a colour decision is visible is exactly on the disc's radius.
  function ringCount(t, colour, tol = 40) {
    const v = A().view;
    const r = v.cellRect(t);
    const rad = v.geo.cell * E().theme.Cell.clueScale;
    let hits = 0;
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const p = pixel(r.x + r.size / 2 + Math.cos(ang) * rad, r.y + r.size / 2 + Math.sin(ang) * rad);
      if (near(p, colour, tol)) hits++;
    }
    return hits;
  }
  const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[(a.length - 1) >> 1] : NaN);
  const sum = (arr) => arr.reduce((a, v) => a + v, 0);
  const firstWhere = (arr, pred, from = 0) => {
    for (let i = from; i < arr.length; i++) if (pred(arr[i], i)) return i;
    return -1;
  };
  // A cheap fingerprint of the whole canvas buffer. Two paints of the same seed must agree on it,
  // which is how "the picture never depends on the wall clock" is tested rather than claimed.
  function canvasHash() {
    const v = A().view;
    const d = v.ctx.getImageData(0, 0, v.canvas.width, v.canvas.height).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 7) {
      h ^= d[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return `${h}/${d.length}`;
  }

  // ---------- engine ----------

  const engine = async () => {
    const en = E();
    ck('页面挂出了可测的引擎', !!(en && en.createBoard && en.solve && en.diagnose));
    eq('格子的三个状态', `${en.OPEN},${en.BLACK},${en.WHITE}`, '0,1,2');
    eq('没有数字的哨兵是 -1', en.NO_CLUE, -1);
    ck('哨兵与三种状态都不重合', en.NO_CLUE !== en.OPEN && en.NO_CLUE !== en.BLACK && en.NO_CLUE !== en.WHITE, `${en.NO_CLUE} vs ${en.OPEN}`);
    eq('状态名读得出', [en.OPEN, en.BLACK, en.WHITE].map(en.name).join(''), '空黑白');
    eq('规则表里有五条', Object.keys(en.Rules).length, 5);
    eq(
      '规则名与页面上那五条一致',
      Object.values(en.Rules).map((r) => r.name).join(','),
      [...document.querySelectorAll('.rules li b')].map((x) => x.textContent).join(','),
    );
    eq('档位有五级', en.TIERS.length, 5);
    let ordered = true;
    for (let i = 1; i < en.TIERS.length; i++) {
      if (!(en.TIERS[i].band[0] > en.TIERS[i - 1].band[0])) ordered = false;
      if (!(en.TIERS[i].w > en.TIERS[i - 1].w)) ordered = false;
    }
    ck('档位按难度与尺寸同时递增', ordered, JSON.stringify(en.TIERS.map((t) => [t.w, t.band])));
    eq('档位不认识时退回上手', en.tierFor('nope').key, 'apprentice');

    // geometry, hand-checked on paper: cell (row 2, col 1) of a 4×4 board looks up two cells,
    // down one, left one, right three — and its four neighbours are exactly those first steps.
    const rays = en.raysAt(4, 4, 9).map((r) => r.join(','));
    eq('视线按从近到远排', rays.join(' | '), '5,1 | 13 | 8 | 10,11');
    eq('四邻就是四条视线的第一格', en.adjAt(4, 4, 9).join(','), '5,13,8,10');
    eq('角上的格子只有两条视线', en.raysAt(4, 4, 0).map((r) => r.length).join(','), '0,3,0,3');

    // scanRay: floor = certainly seen, ceil = at most it could still see. Hand-checked against the
    // definition — the first black closes a ray, an open cell only postpones the count.
    const ray = Int32Array.from([1, 2, 3, 4]);
    const open = new Int8Array(5);
    const half = Int8Array.from([0, 0, 0, 1, 0]);
    const run = Int8Array.from([0, 2, 2, 1, 0]);
    eq('全空的视线：一定看见 0 格，顶多 4 格', JSON.stringify(en.scanRay(open, ray)), JSON.stringify({ floor: 0, ceil: 4, len: 4 }));
    eq('中途有黑就只数到那儿', JSON.stringify(en.scanRay(half, ray)), JSON.stringify({ floor: 0, ceil: 2, len: 4 }));
    eq('连着画白直到黑格就数定了', JSON.stringify(en.scanRay(run, ray)), JSON.stringify({ floor: 2, ceil: 2, len: 4 }));

    // clues, hand-computed on a 2×2 sheet whose only black square is the top-right cell:
    //   第1行1列 sees itself plus the cell below (its right ray is blocked at once)  → 2
    //   第2行1列 sees up, right and itself                                            → 3
    //   第2行2列 sees its left neighbour                                              → 2
    const small = en.createBoard({ w: 2, h: 2, clue: Int8Array.from([2, -1, 3, 2]) });
    const sol22 = Int8Array.from([en.WHITE, en.BLACK, en.WHITE, en.WHITE]);
    eq('手算的数字与 cluesFrom 相同', Array.from(en.cluesFrom(2, 2, sol22)).join(','), '2,-1,3,2');
    const ss = en.solve(small);
    ck('两格盘推得完', ss.ok === true, ss.conflict);
    eq('推出来的就是手算的解', Array.from(ss.derived).join(','), Array.from(sol22).join(','));
    eq('推出来的盘通过独立验收', en.verify(small, ss.derived).length, 0);
    eq('推出来即完整', en.complete(small, ss.derived), true);
    eq('穷举计数判定唯一', en.countSolutions(small, { cap: 2, budget: 20000 }).status, 'UNIQUE');
    // two blacks that touch, and the number next to them starves as a result
    const broken = Int8Array.from([en.WHITE, en.BLACK, en.WHITE, en.BLACK]);
    const bad = en.verify(small, broken).map((x) => x.why);
    ck('黑格相邻被独立验收抓到', bad.includes('黑格相邻'), bad.join(','));
    ck('数字对不上被独立验收抓到', bad.includes('看见的白格不够') || bad.includes('看见的白格多了'), bad.join(','));
    eq('空盘不算完整', en.complete(small, new Int8Array(4)), false);
    eq('空盘也没有冲突', en.diagnose(small, new Int8Array(4)).conflicts, 0);
    eq('粘在一起的黑盘被判定为死局', en.reachable(small, broken), false);

    // what the clue layer refuses to even hold: a 0 on a numbered cell, a number bigger than the
    // longest possible sight line, and a board with no numbers at all.
    const throwsWith = (re, fn) => {
      try {
        fn();
        return '没有报错';
      } catch (e) {
        return re.test(e.message) ? true : e.message;
      }
    };
    eq('数字最小是 1', throwsWith(/最少是 1/, () => en.createBoard({ w: 3, h: 1, clue: Int8Array.from([0, -1, -1]) })), true);
    eq('数字不能超过最长视线', throwsWith(/顶多看得见 3/, () => en.createBoard({ w: 3, h: 1, clue: Int8Array.from([4, -1, -1]) })), true);
    eq('没有数字的盘直接拒绝', throwsWith(/盘上没有数字/, () => en.createBoard({ w: 3, h: 1, clue: Int8Array.from([-1, -1, -1]) })), true);
    eq('长度不对也拒绝', throwsWith(/clue 长度/, () => en.createBoard({ w: 3, h: 1, clue: Int8Array.from([1, -1]) })), true);

    // the shipped board: every assertion above re-run on a real 7×7
    const p = en.makePuzzle('scen|engine', 'regular');
    ck('出一局', !!p);
    const b = p.board;
    eq('盘面尺寸就是档位', `${b.w}×${b.h}`, '7×7');
    eq('格数', b.n, 49);
    const full = en.cluesFrom(b.w, b.h, p.solution);
    const fullClues = Array.from(full).filter((v) => v !== -1).length;
    ck('出货盘的数字比满盘少', b.clues < fullClues, `${b.clues} vs ${fullClues}`);
    ck('数字都在 1..最长视线之间', Array.from(b.clue).every((v) => v === -1 || (v >= 1 && v <= b.maxSee)));
    ck('黑格上没有数字', Array.from(b.clue).every((v, i) => v === -1 || p.solution[i] !== en.BLACK));
    const s = en.solve(b);
    ck('铅笔推到底', s.ok === true, s.conflict);
    eq('推到底与种下的解同盘', Array.from(s.derived).join(','), Array.from(p.solution).join(','));
    eq('推出来的盘通过独立验收', en.verify(b, s.derived).length, 0);
    const c = en.countSolutions(b, { cap: 2, budget: 600000 });
    eq('穷举计数判定唯一', c.status, 'UNIQUE');
    eq('穷举与铅笔逐格同解', Array.from(c.first).join(','), Array.from(s.derived).join(','));
    eq('空盘读数是满格没定', [en.diagnose(b, new Int8Array(b.n)).filled, en.diagnose(b, new Int8Array(b.n)).remaining].join(','), `0,${b.n}`);
    // one flipped square must break at least one number on a fully numbered board
    const fullBoard = en.createBoard({ w: b.w, h: b.h, clue: full });
    const oneBad = Int8Array.from(p.solution);
    const flip = firstWhere(Array.from(full), (v, i) => v !== -1 && i + b.w < b.n && full[i + b.w] !== -1);
    oneBad[flip] = en.BLACK;
    ck('涂黑一个数字格必有数字对不上', en.verify(fullBoard, oneBad).length >= 1, JSON.stringify(en.verify(fullBoard, oneBad).slice(0, 3)));
    // the engine's own guard: shading a numbered cell is not a write, so it leaves no history
    const st = en.createState(b);
    eq('引擎拒绝把数字格涂黑', en.setCell(st, b.clueCells[0], en.BLACK), false);
    eq('被拒绝的写不留历史', st.history.length, 0);
    eq('引擎接受把数字格留白', en.setCell(st, b.clueCells[0], en.WHITE), true);
    eq('重复写同一格不算一次', en.setCell(st, b.clueCells[0], en.WHITE), false);
    eq('撤销真的回到空盘', en.undo(st) && Array.from(st.cell).every((v) => v === en.OPEN), true);
    const d0 = s.rows[0];
    ck('提示脚本的每条都带规则与格', !!(d0.rule && d0.cell >= 0 && d0.clue >= 0));
    ck('规则文本带坐标', /第\d+行\d+列/.test(d0.rule.text(b, d0)), d0.rule.text(b, d0));
    ck('每条提示的理由都指着它要写的那一格', s.rows.every((row) => row.rule.text(b, row).includes(b.cellName(row.cell))), b.cellName(s.rows[3].cell) + ' -> ' + s.rows[3].rule.text(b, s.rows[3]));
    ck('脚本推完之后再没有新的推理，盘也满了', (() => {
      const probe = Int8Array.from(s.derived);
      return en.nextDeduction(b, probe) === null && en.complete(b, s.derived) === true;
    })(), true);
    return report({ score: p.score, clues: b.clues, steps: s.steps });
  };

  // ---------- gen ----------

  const gen = async () => {
    const en = E();
    const medians = [];
    for (const tier of en.TIERS) {
      const scores = [];
      const clueCount = [];
      let inBand = 0;
      let unique = 0;
      let finishable = 0;
      let ms = 0;
      for (let s = 0; s < 4; s++) {
        const t0 = performance.now();
        const p = en.makePuzzle(`gen|${tier.key}|${s}`, tier.key);
        ms += performance.now() - t0;
        if (!p) continue;
        scores.push(p.score);
        clueCount.push(p.clues);
        if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
        if (en.solve(p.board).ok) finishable++;
        if (en.countSolutions(p.board, { cap: 2, budget: 600000 }).status === 'UNIQUE') unique++;
      }
      const whiteCells = Math.round(tier.w * tier.h * 0.7);
      eq(`${tier.key} 出货 4/4`, scores.length, 4);
      ck(`${tier.key} 命中难度区间`, inBand >= 3, `${inBand}/4 在 ${tier.band}`);
      eq(`${tier.key} 每局唯一解`, unique, scores.length);
      eq(`${tier.key} 每局推得完`, finishable, scores.length);
      ck(`${tier.key} 数字确实被删过`, median(clueCount) < whiteCells, `${median(clueCount)}/${whiteCells}`);
      ck(`${tier.key} 出题够快`, ms / 4 < 1400, `${(ms / 4).toFixed(0)} ms/局`);
      medians.push({ key: tier.key, m: median(scores), size: `${tier.w}×${tier.h}`, clues: median(clueCount), full: whiteCells });
    }
    let mono = true;
    for (let i = 1; i < medians.length; i++) if (!(medians[i].m > medians[i - 1].m)) mono = false;
    ck('档位中位分数单调递增', mono, medians.map((o) => `${o.key}:${o.m}`).join(' '));
    eq('每档盘面都比上一档大', new Set(medians.map((o) => o.size)).size, 5);
    // the same seed must give the same board — a save stores only the seed
    const a = en.makePuzzle('gen|same', 'expert');
    eq('同种子同盘', Array.from(en.makePuzzle('gen|same', 'expert').board.clue).join(','), Array.from(a.board.clue).join(','));
    ck('不同种子不同盘', Array.from(en.makePuzzle('gen|other', 'expert').board.clue).join(',') !== Array.from(a.board.clue).join(','));
    eq('出货记下原始种子', a.originSeed, 'gen|same');
    ck('派生种子带 trials 编号', /^gen\|same#\d+$/.test(a.seed), a.seed);
    eq('解与盘面同尺寸', a.solution.length, a.board.n);
    ck('解自己合法：黑不挨黑', (() => {
      for (let t = 0; t < a.board.n; t++) {
        if (a.solution[t] !== en.BLACK) continue;
        for (const nb of en.adjAt(a.board.w, a.board.h, t)) if (a.solution[nb] === en.BLACK) return false;
      }
      return true;
    })());
    ck('解自己合法：白格是一整块', en.verify(a.board, a.solution).length === 0, JSON.stringify(en.verify(a.board, a.solution).slice(0, 2)));
    // The control group that says the generator's acceptance gate is doing real work. Take a board
    // the gate accepted and delete three *more* numbers with no test at all: the exhaustive counter
    // then finds multiple solutions often enough to matter. Sound but not complete is the honest
    // claim about these pencil rules, so the direction that would be a lie is the one asserted
    // against: a board with more than one solution must never be reported as finished by the rules.
    let notUnique = 0;
    let many = 0;
    let fooled = 0;
    const checked = 12;
    for (let s = 0; s < checked; s++) {
      const rand = en.mix(`past-the-gate|${s}`);
      const sol = en.randomSolution(6, 6, rand, 0.3);
      const full = en.createBoard({ w: 6, h: 6, clue: en.cluesFrom(6, 6, sol) });
      const gated = en.createBoard({ w: 6, h: 6, clue: en.pruneClues(full, rand, 12) });
      const clue = Int8Array.from(gated.clue);
      const numbered = Array.from(clue).map((v, i) => (v === en.NO_CLUE ? -1 : i)).filter((i) => i >= 0);
      const order = numbered.slice();
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (const i of order.slice(0, 3)) clue[i] = en.NO_CLUE;
      const b = en.createBoard({ w: 6, h: 6, clue });
      const c = en.countSolutions(b, { cap: 2, budget: 400000 });
      if (c.status !== 'UNIQUE') notUnique++;
      if (c.status === 'MANY') many++;
      if (c.status !== 'UNIQUE' && en.solve(b).ok) fooled++;
    }
    ck('门控后再乱删会造出多解盘（对照组不是空的）', notUnique >= 6, `${notUnique}/${checked}，其中 MANY ${many}`);
    eq('多解盘不会被规则误判推完', fooled, 0);
    // and the gated path on the same kind of deletion: keep a removal only if the pencil still
    // finishes, and every one of those boards survives the exhaustive counter.
    let gated = 0;
    for (let s = 0; s < 4; s++) {
      const rand = en.mix(`gated|${s}`);
      const sol = en.randomSolution(5, 5, rand, 0.3);
      const full = en.createBoard({ w: 5, h: 5, clue: en.cluesFrom(5, 5, sol) });
      const pruned = en.createBoard({ w: 5, h: 5, clue: en.pruneClues(full, rand, 9) });
      if (en.solve(pruned).ok && en.countSolutions(pruned, { cap: 2, budget: 400000 }).status === 'UNIQUE') gated++;
    }
    eq('门控后的删数仍然每局唯一', gated, 4);
    return report({ medians: medians.map((o) => o.m), notUnique, many, fooled, checked });
  };

  // ---------- play ----------

  const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  const play = async () => {
    const en = E();
    en.Store.reset();
    A().show('menu');
    await wait(40);
    ck('开局停在选档页', shown('#view-menu') && !shown('#view-game'));
    ck('标题写的是黑目', /黑目/.test(document.title) && /Kurodoko/i.test(document.title), document.title);
    ck('画布有可读的 aria 标签', /黑目/.test(A().view.canvas.getAttribute('aria-label')), A().view.canvas.getAttribute('aria-label'));
    eq('选档页有五档', document.querySelectorAll('#tier-list button.tier').length, 5);
    eq(
      '五档的 key 与引擎一致',
      [...document.querySelectorAll('#tier-list button.tier')].map((x) => x.dataset.tier).join(','),
      en.TIERS.map((x) => x.key).join(','),
    );
    eq('页面上是五条规则', document.querySelectorAll('.rules li').length, 5);
    eq('图例五项', document.querySelectorAll('.legend span').length, 5);
    eq('统计项七条', document.querySelectorAll('.stats .stat').length, 7);
    const hero = text('.menu-hero p');
    ck('前言给了三个承诺', /没有运气题/.test(hero) && /只有一个答案/.test(hero) && /靠逻辑推到底/.test(hero), hero);
    ck('页脚点名验收脚本', /tools\/verify\.sh/.test(text('.foot')), text('.foot'));
    ck('规则讲的是视线、黑不挨黑与白格连通', /视线/.test(text('.rules')) && /不许再是黑格/.test(text('.rules')) && /劈成两截/.test(text('.rules')), text('.rules').slice(0, 80));

    document.querySelector('#tier-list button[data-tier="regular"]').click();
    await wait(90);
    ck('点档位进对局', shown('#view-game') && !shown('#view-menu'));
    eq('进的对局就是那一档', A().state().tier, 'regular');
    eq('盘面尺寸跟着档位', `${A().game.w}×${A().game.h}`, '7×7');
    eq('默认笔是涂黑', A().game.mode, en.BLACK);
    eq('橡皮笔默认关', A().erase(), false);
    eq('画布写着黑笔', A().view.canvas.dataset.mode, 'black');
    eq('画布写着落墨', A().view.canvas.dataset.brush, 'ink');
    eq('黑按钮是按下的', $('#btn-mode-black').getAttribute('aria-pressed'), 'true');
    eq('开局没有冲突', A().state().conflicts, 0);
    eq('开局状态行是空的', text('#state-line'), '');
    eq('开局没定满盘', A().state().remaining, A().game.board.n);

    $('#btn-mode-white').click();
    await wait(20);
    eq('点白按钮换了笔', A().game.mode, en.WHITE);
    eq('画布跟着换笔色', A().view.canvas.dataset.mode, 'white');
    eq('白按钮按下', $('#btn-mode-white').getAttribute('aria-pressed'), 'true');
    eq('黑按钮弹起', $('#btn-mode-black').getAttribute('aria-pressed'), 'false');
    $('#btn-erase').click();
    await wait(20);
    eq('橡皮笔开了', A().erase(), true);
    eq('画布写着擦', A().view.canvas.dataset.brush, 'erase');
    eq('橡皮笔不改墨色', A().view.canvas.dataset.mode, 'white');
    $('#btn-mode-black').click();
    await wait(20);
    eq('重新选黑笔会关掉橡皮', `${A().erase()},${A().game.mode}`, `false,${en.BLACK}`);
    eq('画布回到落墨', A().view.canvas.dataset.brush, 'ink');
    key('w');
    eq('W 键换白笔', A().game.mode, en.WHITE);
    key('e');
    eq('E 键开橡皮', A().erase(), true);
    key('b');
    eq('B 键回到黑笔并关橡皮', `${A().erase()},${A().game.mode}`, `false,${en.BLACK}`);
    key('m');
    eq('M 键在黑白之间换', A().game.mode, en.WHITE);
    key('m');
    key('b');
    eq('换回来还是黑笔', A().game.mode, en.BLACK);

    eq('面板提示计数为零', text('#stat-hints'), '0');
    const h0 = A().useHint();
    await wait(30);
    ck('提示写了一格', !!(h0 && h0.charged), JSON.stringify(h0));
    eq('一次提示记一笔', text('#stat-hints'), '1');
    eq('提示角标同步', text('#hint-count'), '1');
    ck('提示说得出规则名', /^规则：/.test(text('#hint-rule')), text('#hint-rule'));
    ck('规则名是引擎里那五条之一', Object.values(en.Rules).some((r) => `规则：${r.name}` === text('#hint-rule')), text('#hint-rule'));
    ck('理由里带坐标', /第\d+行\d+列/.test(text('#hint-line')), text('#hint-line'));
    eq('提示记的是提示数而不是步数', `${A().state().moves},${A().state().hints}`, '0,1');
    eq('已定跟着涨', text('#stat-filled'), `${A().game.diag.filled}/${A().game.board.n}`);
    const statPlain = firstWhere(Array.from(A().game.board.clue), (v) => v === en.NO_CLUE);
    A().stroke([statPlain], en.WHITE);
    await wait(20);
    eq('自己涂一笔记一步', text('#stat-moves'), '1');
    A().undo();
    await wait(20);
    eq('撤销退回那一步', text('#stat-moves'), '0');
    A().undo();
    await wait(20);
    eq('撤销不退还提示', text('#stat-hints'), '1');
    eq('撤销擦掉了墨', A().state().filled, 0);

    $('#btn-sound').click();
    await wait(20);
    eq('音效开关进了存档', JSON.parse(localStorage.getItem('kuromasu.save.v1')).settings.sound, false);
    eq('音效按钮写着关', text('#btn-sound'), '音效 关');
    eq('音效按钮 aria 跟着', $('#btn-sound').getAttribute('aria-pressed'), 'false');
    $('#btn-motion').click();
    await wait(20);
    eq('省动效进了存档', en.Store.setting('reduceMotion'), true);
    ck('省动效落到 body 类上', document.body.classList.contains('reduce-motion'));
    eq('动效按钮写着省', text('#btn-motion'), '动效 省');
    ck('省动效写进了样式时长', (() => {
      const d = getComputedStyle(document.documentElement).getPropertyValue('--dur-ink').trim();
      return d === '0ms' || d === '0s' || parseFloat(d) === 0 || document.body.classList.contains('reduce-motion');
    })(), true);
    $('#btn-motion').click();
    $('#btn-sound').click();
    await wait(20);
    eq('再点一下音效回来了', en.Store.setting('sound'), true);
    ck('body 类也跟着撤掉', !document.body.classList.contains('reduce-motion'));

    const plain = firstWhere(Array.from(A().game.board.clue), (v) => v === en.NO_CLUE);
    A().stroke([plain], en.WHITE);
    await wait(30);
    A().show('menu');
    await wait(40);
    ck('回选档留下继续卡', shown('#resume-card'));
    ck('继续卡写着继续', /继续/.test(text('#resume-name')), text('#resume-name'));
    ck('继续卡写着成本', /步/.test(text('#resume-meta')), text('#resume-meta'));
    ck('继续卡与引擎的存档同源', !!en.Store.resume());
    A().show('game');
    return report({ tier: A().state().tier, hints: A().state().hints });
  };

  // ---------- ink: taps and strokes through the real pointer path ----------

  const ink = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'trainee', seed: 'scen|ink' });
    await wait(80);
    const g = A().game;
    const b = g.board;
    const plain = firstWhere(Array.from(b.clue), (v) => v === en.NO_CLUE);
    const numbered = b.clueCells[0];
    eq('这一格没有数字', b.clue[plain], en.NO_CLUE);
    ck('那一格写着数字', b.clue[numbered] >= 1, String(b.clue[numbered]));
    eq('开局盘上没有墨', A().state().filled, 0);

    await tap(plain);
    eq('点一下涂黑', A().valueOf(plain), en.BLACK);
    eq('点一下记一步', text('#stat-moves'), '1');
    await tap(plain);
    eq('再点一下擦掉', A().valueOf(plain), en.OPEN);
    eq('擦也算一步', text('#stat-moves'), '2');
    A().setMode(en.WHITE);
    await tap(plain);
    eq('白笔点出留白', A().valueOf(plain), en.WHITE);
    await tap(plain);
    eq('白笔再点擦掉', A().valueOf(plain), en.OPEN);

    const movesBefore = A().state().moves;
    A().setMode(en.BLACK);
    await tap(numbered);
    eq('数字格不肯被涂黑', A().valueOf(numbered), en.OPEN);
    eq('被拒的一笔不记步数', A().state().moves, movesBefore);
    eq('被拒的也没进历史', A().game.st.history.length, g.steps.length);
    eq('提示标题写着这一笔没有落', text('#hint-rule'), '这一笔没有落');
    ck('拒绝讲清了道理', /数字格自己必须是白格/.test(text('#hint-line')), text('#hint-line'));
    ck('game.refusal 说的是同一句', A().game.refusal && /数字格/.test(A().game.refusal.why), JSON.stringify(A().game.refusal));
    A().setMode(en.WHITE);
    await tap(numbered);
    eq('数字格可以留白（带字即白）', A().valueOf(numbered), en.WHITE);
    eq('这一笔记了步数', A().state().moves, movesBefore + 1);
    eq('留白之后没有拒绝', A().game.refusal, null);
    const m2 = A().state().moves;
    A().setErase(true);
    await tap(numbered);
    eq('橡皮笔擦不掉数字', A().valueOf(numbered), en.WHITE);
    eq('这一笔也不记步数', A().state().moves, m2);
    ck('理由讲的是不用擦', /不用擦/.test(text('#hint-line')), text('#hint-line'));
    A().setErase(false);
    // the eraser landing on bare paper is neither a move nor a refusal
    A().setMode(en.BLACK);
    await tap(plain);
    eq('落墨一点就成黑', A().valueOf(plain), en.BLACK);
    eq('落墨之后没有拒绝', A().game.refusal, null);
    const m3 = A().state().moves;
    A().setErase(true);
    const empty = firstWhere(Array.from(g.st.cell), (v, i) => v === en.OPEN && b.clue[i] === en.NO_CLUE);
    await tap(empty);
    eq('橡皮落在空处什么也不写', A().valueOf(empty), en.OPEN);
    eq('橡皮落在空处不记步数', A().state().moves, m3);
    eq('橡皮落在空处也不算拒绝', A().game.refusal, null);
    A().setErase(false);

    // ---- gestures on a bare sheet: one drag = one step ----
    A().begin({ tier: 'trainee', seed: 'scen|ink-drag' });
    await wait(70);
    const b3 = A().game.board;
    const g3 = A().game;
    const twoRows = freeRuns(b3, 'row', 3);
    const rowA = twoRows[0] || [];
    const rowB = twoRows[1] || [];
    ck('两行都有够长的连续无数字格', rowA.length >= 3 && rowB.length >= 3, JSON.stringify([rowA.length, rowB.length]));
    A().setMode(en.BLACK);
    const stepsBefore = A().state().steps;
    const movesAtDrag = A().state().moves;
    await drag(rowA[0], rowA[rowA.length - 1]);
    ck('拖动一路都涂上了', rowA.every((t) => A().valueOf(t) === en.BLACK), JSON.stringify(rowA.map((t) => A().valueOf(t))));
    eq('一整笔只记一步', A().state().moves - movesAtDrag, 1);
    eq('一整笔只算一步历史', A().state().steps - stepsBefore, 1);
    // one gesture that walks forward and back must keep what it painted: the drag paints one
    // value, it never toggles cell by cell
    const steps2 = A().state().steps;
    const pA = at(rowB[0]);
    const pB = at(rowB[rowB.length - 1]);
    pointer('pointerdown', pA.x, pA.y);
    glide(pA.x, pA.y, pB.x, pB.y);
    glide(pB.x, pB.y, pA.x, pA.y);
    pointer('pointerup', pA.x, pA.y);
    await wait(24);
    ck('同一笔里来回走过的格不会被吃掉', rowB.every((t) => A().valueOf(t) === en.BLACK), JSON.stringify(rowB.map((t) => A().valueOf(t))));
    eq('来回走仍然只是一步', A().state().steps - steps2, 1);
    // …but starting on a cell that already wears this brush lifts the whole run off, which is the
    // 从已定的格里起笔就是擦 the panel promises
    const moves3 = A().state().moves;
    await drag(rowB[0], rowB[rowB.length - 1]);
    ck('从已定的格里起笔就是擦', rowB.every((t) => A().valueOf(t) === en.OPEN), JSON.stringify(rowB.map((t) => A().valueOf(t))));
    eq('这一笔也是一步', A().state().moves - moves3, 1);
    // a stroke never escapes the sheet: a press in the margin is not a cell
    const steps4 = A().state().steps;
    const box = A().view.canvas.getBoundingClientRect();
    pointer('pointerdown', box.left + 2, box.top + 2);
    pointer('pointermove', box.left + A().view.geo.x + 4, box.top + A().view.geo.y + 4);
    pointer('pointerup', box.left + 2, box.top + 2);
    await wait(24);
    eq('盘外按下不产生任何一步', A().state().steps, steps4);
    eq('盘外按下也没写进任何格', A().valueOf(rowA[0]), en.BLACK);
    // a drag that crosses a numbered cell keeps painting on both sides of it
    A().begin({ tier: 'trainee', seed: 'scen|ink2' });
    await wait(60);
    const b4 = A().game.board;
    const g4 = A().game;
    let triple = null;
    for (let r = 0; r < b4.h && !triple; r++) {
      for (let c = 0; c + 2 < b4.w; c++) {
        const t = g4.cellAt(c, r);
        if (b4.clue[t] === en.NO_CLUE && b4.clue[t + 1] !== en.NO_CLUE && b4.clue[t + 2] === en.NO_CLUE) triple = [t, t + 1, t + 2];
      }
    }
    ck('找得到“空-数字-空”三连', !!triple, JSON.stringify(triple && triple.map((t) => b4.cellName(t))));
    if (triple) {
      A().setMode(en.BLACK);
      const mv = A().state().moves;
      await drag(triple[0], triple[2]);
      eq('拖过数字格时那一格没被涂', A().valueOf(triple[1]), en.OPEN);
      ck('数字格两边的格照样涂上', A().valueOf(triple[0]) === en.BLACK && A().valueOf(triple[2]) === en.BLACK, JSON.stringify(triple.map((t) => A().valueOf(t))));
      eq('这一笔仍然只记一步', A().state().moves - mv, 1);
      ck('跳过的那格有句话说明', /数字/.test(text('#hint-line')) || /数字/.test(text('#state-line')), text('#hint-line'));
    }
    // the right button lifts marks off whatever it crosses, without moving the brush
    A().begin({ tier: 'trainee', seed: 'scen|ink-drag' });
    await wait(60);
    const b5 = A().game.board;
    const g5 = A().game;
    const colRuns = freeRuns(b5, 'col', 3);
    const col = colRuns[0] || [];
    ck('有一列够长的连续无数字格', col.length >= 3, String(col.length));
    A().setMode(en.WHITE);
    await drag(col[0], col[col.length - 1]);
    ck('白笔一路留白', col.every((t) => A().valueOf(t) === en.WHITE), JSON.stringify(col.map((t) => A().valueOf(t))));
    const brushBefore = `${A().view.canvas.dataset.mode},${A().view.canvas.dataset.brush}`;
    await drag(col[0], col[col.length - 1], 2);
    ck('右键一笔擦掉了墨', col.every((t) => A().valueOf(t) === en.OPEN), JSON.stringify(col.map((t) => A().valueOf(t))));
    eq('右键不改画笔状态', `${A().view.canvas.dataset.mode},${A().view.canvas.dataset.brush}`, brushBefore);
    eq('右键也不打开橡皮', A().erase(), false);

    // undo all the way back to a bare sheet
    let guard = 0;
    while (A().undo() && guard++ < 200);
    eq('撤销能一路退回空盘', A().state().filled, 0);
    eq('退到底步数归零', A().state().moves, 0);
    eq('退到底历史也空', A().game.st.history.length, 0);
    eq('再撤销返回空', A().undo(), null);
    return report({ steps: A().state().steps, moves: A().state().moves });
  };

  // ---------- hint: every reason comes from a rule the clues actually forced ----------

  const hint = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'trainee', seed: 'scen|hint' });
    await wait(70);
    const g = A().game;
    const b = g.board;
    eq('提示脚本铺满全盘', g.script.length, b.n);
    let charged = 0;
    let last = null;
    let k = 0;
    const cited = new Set();
    while (k++ < 400) {
      last = A().useHint();
      if (!last) break;
      if (last.charged) charged++;
      if (last.rule) cited.add(last.rule);
      if (last.conflict || last.stalled) break;
    }
    eq('每一点提示都真写了一格', charged, b.n);
    eq('一路提示能推到胜利', g.status, 'won');
    eq('提示没有多点一次', A().state().hints, b.n);
    ck('提示引用的规则都在引擎的规则表里', [...cited].every((n) => Object.values(en.Rules).some((r) => r.name === n)), [...cited].join(','));
    ck('规则文本都带坐标', Object.values(en.Rules).every((r) => {
      const detail = { clue: b.clueCells[0], cell: firstWhere(Array.from(b.clue), (v) => v === en.NO_CLUE), see: 2, most: 3, from: 0, parts: 2 };
      return /第\d+行\d+列/.test(r.text(b, detail));
    }));
    ck('提示从不把数字格涂黑', Array.from(g.st.cell).every((v, i) => b.clue[i] === en.NO_CLUE || v !== en.BLACK));
    eq('提示写的每一格都就是解', Array.from(g.st.cell).join(','), Array.from(g.puzzle.solution).join(','));
    ck('胜利遮罩可见', shown('#win-veil'));
    ck('胜利卡写着成本', /提示 \d+ 次/.test(text('#win-meta')), text('#win-meta'));
    ck('胜利卡写着纪录', /纪录/.test(text('#win-record')), text('#win-record'));
    eq('胜利后状态行是空的', text('#state-line'), '');
    const hintsAfterWin = A().state().hints;
    eq('胜利后提示不再收钱', A().useHint(), null);
    eq('胜利后提示次数不变', A().state().hints, hintsAfterWin);
    eq('胜利后涂不动格', A().tap(0, en.WHITE), null);
    ck('纪录进了存档', !!en.Store.best('trainee'), JSON.stringify(en.Store.best('trainee')));

    // the hint's own bookkeeping: a hint names the number that justifies it
    A().begin({ tier: 'regular', seed: 'scen|hint2' });
    await wait(70);
    const g2 = A().game;
    const b2 = g2.board;
    const seenNode = [];
    for (let i = 0; i < 12; i++) {
      const h = A().useHint();
      if (!h || !h.charged) break;
      seenNode.push(h);
    }
    ck('每条提示都指出那个数字', seenNode.every((h) => h.node >= 0 && h.node < b2.n), JSON.stringify(seenNode.map((h) => h.node)));
    ck('数字格自己那一条说的是带字即白', seenNode.filter((h) => h.cell === h.node).every((h) => h.rule === '带字即白'), JSON.stringify(seenNode.slice(0, 4)));
    ck('别的规则都指着写了数字的那一格', seenNode.filter((h) => h.cell !== h.node).every((h) => b2.clue[h.node] >= 1), JSON.stringify(seenNode.filter((h) => h.cell !== h.node).slice(0, 4)));
    ck('已定确实在涨', A().state().filled > 0, String(A().state().filled));
    eq('面板上的看对与引擎同源', text('#stat-satisfied'), `${g2.clueGood.size}/${b2.clues}`);

    // every tier is finishable by logic alone, through the shipped hint path
    for (const tier of en.TIERS) {
      A().begin({ tier: tier.key, seed: `scen|logic|${tier.key}` });
      await wait(40);
      const r = A().solveWithLogic();
      eq(`${tier.key} 靠逻辑推到胜利`, A().game.status, 'won', JSON.stringify(r));
      ck(`${tier.key} 的逻辑不是一步到位`, r.steps > 2, JSON.stringify(r));
      eq(`${tier.key} 推完没有冲突`, A().state().conflicts, 0);
      eq(`${tier.key} 每个数字都数对了`, A().state().satisfied, A().game.board.clues);
      $('#btn-menu-2').click();
      await wait(20);
    }
    return report({ charged, cited: [...cited] });
  };

  // ---------- stroke: the pointer gestures themselves ----------

  // The preview box is drawn on the cell's own outline, so the only honest way to see it is to walk
  // the outline and look for the accent colour the brush uses.
  function accentCount(t) {
    const v = A().view;
    const r = v.cellRect(t);
    const accent = hex(E().theme.accent);
    let hits = 0;
    const pts = [];
    const inset = 1.5;
    for (let i = 0; i <= 6; i++) {
      const f = i / 6;
      pts.push([r.x + inset + (r.size - inset * 2) * f, r.y + inset]);
      pts.push([r.x + r.size - inset, r.y + inset + (r.size - inset * 2) * f]);
      pts.push([r.x + inset + (r.size - inset * 2) * f, r.y + r.size - inset]);
      pts.push([r.x + inset, r.y + inset + (r.size - inset * 2) * f]);
    }
    for (const [x, y] of pts) if (near(pixel(x, y), accent, 34)) hits++;
    return hits;
  }

  // Solid or dashed, read off the top edge of the cell outline. The dash is a claim about the
  // gesture rather than about the tool — js/render/board.js picks the dashed branch from
  // preview.value === OPEN, not from the eraser flag — so the honest instrument is the line itself:
  // walk the edge densely and count how often the accent gives way to paper. A solid stroke covers
  // every sample (measured 240/240 at cell 62), the dash leaves periodic gaps (measured 145 hits
  // over 240 samples with 5 edges). The two are far apart, so the thresholds below cannot be
  // satisfied by the same drawing.
  function edgeProfile(t) {
    const r = A().view.cellRect(t);
    const accent = hex(E().theme.accent);
    const N = 240;
    const L = r.size - 3;
    let hits = 0;
    let edges = 0;
    let prev = null;
    for (let i = 0; i < N; i++) {
      const on = near(pixel(r.x + 1.5 + (L * i) / (N - 1), r.y + 1.5), accent, 34);
      if (on) hits++;
      if (prev !== null && on !== prev) edges++;
      prev = on;
    }
    return { hits, edges, n: N };
  }

  const stroke = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'trainee', seed: 'scen|stroke-run' });
    await wait(70);
    const g = A().game;
    const b = g.board;
    const plain = [];
    for (let t = 0; t < b.n; t++) if (b.clue[t] === en.NO_CLUE) plain.push(t);
    A().setMode(en.BLACK);
    const before = Array.from(g.st.cell).join(',');
    const stepsBefore = A().state().steps;
    const movesBefore = A().state().moves;
    // The preview has to be dragged along cells the pointer actually travels over. `plain` is in
    // index order, so its first four are not a line — a sweep from the first to the fourth of them
    // walks down a column and only paints the two ends.
    const lines = [...freeRuns(b, 'row', 4), ...freeRuns(b, 'col', 4)].sort((x, y) => y.length - x.length || x[0] - y[0]);
    const run = (lines[0] || []).slice(0, 4);
    ck('找得到一笔拖得过去的连续四格', run.length === 4, JSON.stringify(lines.map((l) => l.length)));
    dragHold(run[0], run[run.length - 1]);
    await wait(20);
    ck('按住拖动时预览已经落在盘上', run.every((t) => A().valueOf(t) === en.BLACK), JSON.stringify(run.map((t) => A().valueOf(t))));
    eq('预览还没有提交步数', A().state().moves, movesBefore);
    eq('预览还不是一步历史', A().state().steps, stepsBefore);
    ck('预览画出了笔形框', accentCount(run[0]) >= 3, `命中 ${accentCount(run[0])}/28`);
    // the control the dash claim needs: this gesture lays ink, so its outline is one unbroken line
    const solid = edgeProfile(run[0]);
    ck('落墨的一笔描出完整一圈', solid.hits >= solid.n * 0.9 && solid.edges <= 2, JSON.stringify(solid));
    const box = A().view.canvas.getBoundingClientRect();
    pointer('pointerup', box.left + A().view.geo.x + 4, box.top + A().view.geo.y + 4);
    await wait(24);
    eq('抬手才记成一步', A().state().moves, movesBefore + 1);
    eq('抬手提交的是同一格集', A().state().steps, stepsBefore + 1);
    ck('抬手之后预览框消失了', accentCount(run[0]) === 0, `命中 ${accentCount(run[0])}/28`);
    ck('抬手之后墨还在盘上', run.every((t) => A().valueOf(t) === en.BLACK), before);
    A().undo();
    await wait(20);
    eq('撤销一次就回到整笔之前', Array.from(g.st.cell).join(','), before);

    // a cancelled gesture must leave nothing behind, not even a half-painted preview
    const filledBefore = A().state().filled;
    dragHold(run[0], run[run.length - 1]);
    await wait(20);
    const stepsAtCancel = A().state().steps;
    // The preview writes into st.cell while the finger is down, so 已定 really does move during a
    // hold: reading it here would compare the cancelled board against the preview instead of against
    // the sheet the gesture started from.
    ck('按住的时候预览确实把格定上了', A().state().filled > filledBefore, `${A().state().filled} vs ${filledBefore}`);
    A().view.canvas.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
    await wait(20);
    eq('取消之后盘上没多一笔', A().state().steps, stepsAtCancel);
    eq('取消之后墨回到了原样', Array.from(g.st.cell).join(','), before);
    eq('取消之后已定也没变', A().state().filled, filledBefore);
    ck('取消之后画面上也没有预览框', accentCount(run[0]) === 0, `命中 ${accentCount(run[0])}/28`);

    // the erase preview is drawn dashed: the gesture has to say what it does while it is happening
    A().setErase(true);
    dragHold(run[0], run[run.length - 1]);
    await wait(20);
    ck('橡皮笔的预览也是画出来的', accentCount(run[0]) >= 3, `命中 ${accentCount(run[0])}/28`);
    // ...and it says 橡皮 in the only language the screen has: the same edge, sampled the same way,
    // now comes apart into dashes.
    const dashed = edgeProfile(run[0]);
    ck('橡皮的预览是断开的虚线', dashed.hits <= dashed.n * 0.8 && dashed.edges >= 4, JSON.stringify(dashed));
    pointer('pointerup', at(run[0]).x, at(run[0]).y);
    await wait(24);
    eq('橡皮笔抬手才提交', A().valueOf(run[0]), en.OPEN);
    A().setErase(false);

    // winning through the same commit path a pointer release uses
    const sol = g.puzzle.solution;
    const blacks = [];
    const whites = [];
    for (let t = 0; t < b.n; t++) (sol[t] === en.BLACK ? blacks : whites).push(t);
    A().stroke(whites, en.WHITE);
    await wait(20);
    ck('半张盘还不算赢', A().game.status !== 'won');
    A().stroke(blacks, en.BLACK);
    await wait(40);
    eq('照解涂完就赢了', A().game.status, 'won');
    eq('涂完的盘就是解', Array.from(g.st.cell).join(','), Array.from(sol).join(','));
    ck('胜利遮罩在笔路里也弹出来', shown('#win-veil'));
    eq('面板已定写满', text('#stat-filled'), `${b.n}/${b.n}`);
    eq('面板看对写满', text('#stat-satisfied'), `${b.clues}/${b.clues}`);
    return report({ plain: plain.length, steps: A().state().steps });
  };

  // ---------- conflict: the wrong ink is never allowed to redefine the rules ----------

  const conflict = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'regular', seed: 'scen|conflict' });
    await wait(70);
    let g = A().game;
    let b = g.board;

    // 1 · one wrong black square. A single bad mark usually leaves every number still numerically
    // reachable — that is exactly why the UI also asks `reachable()`, which runs the rules to fixpoint.
    const wrong = g.script.find((row) => row.value === en.WHITE && b.clue[row.cell] === en.NO_CLUE);
    ck('找得到一条要求留白的推理', !!wrong, JSON.stringify(wrong && wrong.rule.name));
    A().stroke([wrong.cell], en.BLACK);
    await wait(20);
    let st = A().state();
    ck('涂错一格会被认出来：数字对不上或整盘已死', st.stuck || st.badClues > 0, JSON.stringify({ stuck: st.stuck, badClues: st.badClues, conflicts: st.conflicts }));
    ck('状态行讲的是这些墨救不回来', /矛盾|对不上/.test(text('#state-line')), text('#state-line'));
    // the hints must keep telling what the numbers force, not agree with the mistake
    let charged = 0;
    let h = null;
    let k = 0;
    while (k++ < 300) {
      const before = A().state().hints;
      h = A().useHint();
      if (!h) break;
      if (h.charged) charged++;
      if (h.conflict) {
        eq('说矛盾的提示不收钱', A().state().hints, before);
        break;
      }
    }
    ck('提示最后指着那一格说矛盾', !!(h && h.conflict), JSON.stringify(h));
    ck('矛盾的话讲的是玩家自己写的墨', !!(h && h.conflict) && /你已经写了黑/.test(h.conflict), h && h.conflict);
    eq('提示标题写着这里和数字矛盾', text('#hint-rule'), '这里和数字矛盾');
    ck('提示没有把错的格擦掉', A().valueOf(wrong.cell) === en.BLACK, String(A().valueOf(wrong.cell)));
    ck('这一路的提示都真写了格', charged > 0, String(charged));
    let guard = 0;
    while (A().undo() && guard++ < 200);
    eq('撤销干净之后没有冲突', A().state().conflicts, 0);
    eq('撤销干净之后盘也空了', A().state().filled, 0);

    // 2 · a number that is plainly over-counted: the panel has to go red
    A().begin({ tier: 'regular', seed: 'scen|conflict2' });
    await wait(70);
    g = A().game;
    b = g.board;
    let over = null;
    for (const s of b.clueCells) {
      for (const ray of b.rays[s]) {
        if (!ray || ray.length < b.clue[s] + 1) continue;
        const cells = Array.from(ray).slice(0, b.clue[s] + 1);
        if (cells.includes(s)) continue;
        over = { s, cells };
        break;
      }
      if (over) break;
    }
    ck('找得到一条够长的视线', !!over, JSON.stringify(over && { clue: b.cellName(over.s), want: b.clue[over.s] }));
    A().stroke(over.cells, en.WHITE);
    await wait(30);
    st = A().state();
    ck('数多了的数字被标出来了', st.badClues >= 1, JSON.stringify({ badClues: st.badClues, conflicts: st.conflicts }));
    ck('冲突统计不为零', Number(text('#stat-conflicts')) > 0, text('#stat-conflicts'));
    ck('冲突那条被标红', $('#stat-conflicts').closest('.stat').classList.contains('bad'));
    ck('看对那条也跟着标红', $('#stat-satisfied').closest('.stat').classList.contains('bad'));
    eq('面板上的看对就是引擎那张表', text('#stat-satisfied'), `${st.satisfied}/${st.clues}`);
    // the renderer's two tables are a partition of the engine's one answer, not a second opinion
    const d = g.diag;
    eq('两张渲染表合起来就是引擎的 violated', d.violated.size, g.clueBad.size + g.otherBad.size);
    ck('clueBad 里全是写着数字的格', [...g.clueBad].every((c) => b.clue[c] >= 1), [...g.clueBad].map((c) => b.cellName(c)).join(','));
    ck('otherBad 里全是不写字的格', [...g.otherBad].every((c) => b.clue[c] === en.NO_CLUE), [...g.otherBad].map((c) => b.cellName(c)).join(','));
    ck('数对了的与对不上的不重叠', [...g.clueGood].every((c) => !g.clueBad.has(c)));

    // 3 · two blacks touching: the ban is the engine's, and it names the neighbour white
    A().begin({ tier: 'regular', seed: 'scen|conflict3' });
    await wait(70);
    g = A().game;
    b = g.board;
    const blackRow = g.script.find((row) => row.value === en.BLACK && Array.from(b.adj[row.cell]).some((nb) => b.clue[nb] === en.NO_CLUE));
    ck('找得到一条要求涂黑的推理', !!blackRow, JSON.stringify(blackRow && blackRow.rule.name));
    const probe = Int8Array.from(g.st.cell);
    probe[blackRow.cell] = en.BLACK;
    const sweep = en.propagate(b, probe);
    ck('黑不挨黑是引擎推出来的一条', sweep.found.some((f) => f.rule.name === '黑不挨黑' && f.value === en.WHITE), JSON.stringify(sweep.found.slice(0, 4).map((f) => [f.rule.name, f.value])));
    const pair = (() => {
      for (let t = 0; t < b.n; t++) {
        if (b.clue[t] !== en.NO_CLUE) continue;
        for (const nb of b.adj[t]) if (nb > t && b.clue[nb] === en.NO_CLUE) return [t, nb];
      }
      return null;
    })();
    ck('找得到两个相邻的无数字格', !!pair, JSON.stringify(pair));
    A().stroke(pair, en.BLACK);
    await wait(30);
    const whys = en.verify(b, A().game.st.cell).map((x) => x.why);
    ck('独立验收抓到黑格相邻', whys.includes('黑格相邻'), whys.join(','));
    st = A().state();
    ck('相邻的黑格进了 otherBad', st.conflicts >= 1 && g.diag.violated.has(pair[0]), JSON.stringify({ conflicts: st.conflicts }));
    ck('状态行讲的是断通路', /贴在一起|断成|矛盾|对不上/.test(text('#state-line')), text('#state-line'));

    // 4 · a board painted all black is nowhere near won: the numbers are still unwritten
    A().begin({ tier: 'trainee', seed: 'scen|conflict4' });
    await wait(60);
    g = A().game;
    b = g.board;
    A().stroke(Array.from({ length: b.n }, (_, i) => i), en.BLACK);
    await wait(30);
    eq('全涂黑不算赢', A().game.status, 'playing');
    eq('数字格那一层还没写', A().state().remaining, b.clues);
    eq('全涂黑只记一步', A().state().moves, 1);
    ck('全涂黑当然有冲突', A().state().conflicts > 0, String(A().state().conflicts));
    eq('遮罩没弹出来', $('#win-veil').hidden, true);

    // 5 · the solution itself is the only ink with nothing to complain about
    const sol = g.puzzle.solution;
    A().begin({ tier: 'trainee', seed: 'scen|conflict4' });
    await wait(60);
    g = A().game;
    b = g.board;
    A().stroke(Array.from({ length: b.n }, (_, i) => i).filter((t) => sol[t] === en.WHITE), en.WHITE);
    A().stroke(Array.from({ length: b.n }, (_, i) => i).filter((t) => sol[t] === en.BLACK), en.BLACK);
    await wait(40);
    eq('照解涂完冲突归零', A().state().conflicts, 0);
    eq('照解涂完每个数字都数对了', A().state().satisfied, b.clues);
    eq('照解涂完胜利', A().game.status, 'won');
    eq('胜利后没有拒绝挂着', A().game.refusal, null);
    return report({ stuck: st.stuck, badClues: st.badClues });
  };

  // ---------- save: only the seed and the cost travel ----------

  const save = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'regular', seed: 'scen|save' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const plain = [];
    for (let t = 0; t < b.n; t++) if (b.clue[t] === en.NO_CLUE) plain.push(t);
    for (let i = 0; i < 6; i++) A().stroke([plain[i]], g.puzzle.solution[plain[i]]);
    A().useHint();
    await wait(30);
    const raw = JSON.parse(localStorage.getItem('kuromasu.save.v1'));
    ck('存档键名是本作的', !!raw && !!raw.resume, Object.keys(raw || {}).join(','));
    eq('存档写原始种子', raw.resume.seed, g.puzzle.originSeed);
    eq('存档写档位', raw.resume.tier, 'regular');
    eq('存档写格数', raw.resume.cells, b.n);
    eq('存档写步数', raw.resume.moves, g.moves);
    eq('存档写提示数', raw.resume.hints, g.hints);
    ck('存档写用时', raw.resume.elapsedMs > 0, raw.resume.elapsedMs);
    ck('存档不过一千字节', JSON.stringify(raw.resume).length < 1000, JSON.stringify(raw.resume).length);
    ck('存档里没有抄数字', !JSON.stringify(raw.resume).includes('"clue'), JSON.stringify(raw.resume).slice(0, 200));
    ck('存档里没有抄解', !('solution' in raw.resume) && !('clue' in raw.resume), Object.keys(raw.resume).join(','));
    const back = en.Store.resume();
    eq('墨一格不差地回来', Array.from(back.board).join(','), Array.from(g.st.cell).join(','));
    ck('空格在存档里还是空格', back.board.some((v) => v === en.OPEN) && back.board.every((v) => v >= en.OPEN && v <= en.WHITE), Array.from(back.board).slice(0, 10).join(','));
    ck('游程编码比一格一数省', back.ink.length < b.n * 2, `${back.ink.length} vs ${b.n * 2}`);
    eq('默认设置音效开', en.Store.setting('sound'), true);
    ck('本作没有别的游戏的设置项', !('showNotes' in raw.settings), JSON.stringify(raw.settings));
    const solvedBefore = en.Store.data.totals.solved;
    en.Store.recordSolve(1000, 2);
    eq('总局数按局累加', en.Store.data.totals.solved, solvedBefore + 1);
    ck('累计提示在涨', en.Store.data.totals.hints >= 2, en.Store.data.totals.hints);
    en.Store.data.best = {};
    eq('首个纪录直接成立', en.Store.recordBest('regular', { ms: 50000, hints: 1, moves: 20, size: '7×7' }), true);
    eq('更快但更靠提示的不算破纪录', en.Store.recordBest('regular', { ms: 1000, hints: 2, moves: 5, size: '7×7' }), false);
    eq('同求助次数下省步算破纪录', en.Store.recordBest('regular', { ms: 60000, hints: 1, moves: 12, size: '7×7' }), true);
    eq('步数也相同时才比时间', en.Store.recordBest('regular', { ms: 90000, hints: 1, moves: 12, size: '7×7' }), false);
    eq('纪录留的是最好的那次', en.Store.best('regular').moves, 12);
    eq('纪录里也留着更少的提示', en.Store.best('regular').hints, 1);
    en.Store.data.best = {};
    localStorage.setItem('another-game.save.v1', JSON.stringify({ settings: { showNotes: false }, resume: { seed: 'x' } }));
    eq('不读别的游戏的存档键', en.Store.setting('sound'), true);
    localStorage.removeItem('another-game.save.v1');
    en.Store.reset();
    eq('清空存档后键还在但内容是默认', JSON.parse(localStorage.getItem('kuromasu.save.v1')).resume, null);
    return report({ bytes: JSON.stringify(raw.resume).length });
  };

  // ---------- resume: reload really lands back on the same sheet ----------

  const resume = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'expert', seed: 'scen|resume' });
    await wait(70);
    const g = A().game;
    const clueBefore = Array.from(g.board.clue).join(',');
    const plain = [];
    for (let t = 0; t < g.board.n; t++) if (g.board.clue[t] === en.NO_CLUE) plain.push(t);
    for (let i = 0; i < 8; i++) A().stroke([plain[i]], g.puzzle.solution[plain[i]]);
    A().useHint();
    A().useHint();
    await wait(30);
    const saved = { cell: Array.from(g.st.cell).join(','), moves: g.moves, hints: g.hints };
    A().show('menu');
    await wait(40);
    ck('回选档留下继续卡', shown('#resume-card'));
    ck('继续卡写着档位', /高阶/.test(text('#resume-name')), text('#resume-name'));
    const r = en.Store.resume();
    eq('续局取回了墨', Array.from(r.board).join(','), saved.cell);
    A().begin({ tier: r.tier, seed: r.seed, resume: r });
    await wait(60);
    const g2 = A().game;
    eq('续局重绘出同一块盘', Array.from(g2.board.clue).join(','), clueBefore);
    eq('续局还原全部墨', Array.from(g2.st.cell).join(','), saved.cell);
    eq('续局还原步数', g2.moves, saved.moves);
    eq('续局还原提示数', g2.hints, saved.hints);
    eq('面板显示还原后的提示', text('#stat-hints'), String(saved.hints));
    eq('面板显示还原后的步数', text('#stat-moves'), String(saved.moves));
    ck('续局接着计时', A().elapsed() >= r.elapsedMs, `${A().elapsed()} vs ${r.elapsedMs}`);
    eq('面板已定与引擎一致', text('#stat-filled').split('/')[0], String(g2.diag.filled));
    eq('续局不能撤销到重开之前', A().undo(), null);
    eq('续局之后墨还在', Array.from(g2.st.cell).join(','), saved.cell);

    // A cold boot in a same-origin frame: a second copy of the shipped module graph that has never
    // seen this board in memory and only gets localStorage. This is the reload the player does.
    const frame = document.createElement('iframe');
    frame.setAttribute('title', 'scen-resume');
    frame.style.cssText = 'position:fixed;left:-3000px;top:0;width:1280px;height:900px;border:0';
    document.body.appendChild(frame);
    frame.src = location.href.split('#')[0];
    let fw = null;
    let tries = 0;
    while (tries++ < 200) {
      await wait(50);
      fw = frame.contentWindow;
      if (fw && fw.kuromasu && fw.kuromasu.game === null && fw.document.querySelector('#tier-list').children.length) break;
    }
    ck('冷启动的第二份代码跑起来了', !!(fw && fw.kuromasu), `等了 ${tries} 次`);
    if (fw && fw.kuromasu) {
      const fd = fw.document;
      ck('冷启动的选档页上有继续卡', !fd.getElementById('resume-card').hidden);
      ck('继续卡写的是同一档', /高阶/.test(fd.getElementById('resume-name').textContent), fd.getElementById('resume-name').textContent);
      fd.getElementById('btn-resume').click();
      let tries2 = 0;
      while (tries2++ < 40 && !fw.kuromasu.game) await wait(25);
      const fg = fw.kuromasu.game;
      eq('冷启动读回的是同一块盘', Array.from(fg.board.clue).join(','), clueBefore);
      eq('冷启动还原了墨', Array.from(fg.st.cell).join(','), saved.cell);
      eq('冷启动还原了步数', fg.moves, saved.moves);
      eq('冷启动还原了提示数', fg.hints, saved.hints);
      eq('冷启动的存档键与本作同名', fw.kuromasu.engine.Store.KEY, 'kuromasu.save.v1');
    }
    frame.remove();
    await wait(30);

    const hintsAtResume = g2.hints;
    A().begin({ tier: r.tier, seed: r.seed, resume: r });
    await wait(60);
    const g3 = A().game;
    const res = A().solveWithLogic();
    eq('续局可以推到胜利', g3.status, 'won', JSON.stringify(res));
    ck('推到底用了逻辑', res.steps > 1, res.steps);
    ck('提示次数没被续局清零', g3.hints >= hintsAtResume, `${g3.hints} vs ${hintsAtResume}`);
    ck('破纪录按求助最少算', !en.Store.best('expert') || en.Store.best('expert').hints <= g3.hints, JSON.stringify(en.Store.best('expert')));
    eq('胜利后续局被清掉', en.Store.resume(), null);
    ck('胜利遮罩可见', shown('#win-veil'));
    $('#btn-menu-2').click();
    await wait(40);
    ck('胜利后回选档不再给继续', !shown('#resume-card'));
    ck('总局数累加了', en.Store.data.totals.solved >= 1, en.Store.data.totals.solved);
    $('#btn-reset').click();
    await wait(40);
    eq('清空存档清掉纪录', en.Store.best('expert'), null);
    ck('清空存档回到选档', shown('#view-menu'));
    eq('清空后续档也没了', en.Store.resume(), null);
    return report({ saved, coldBoot: !!(fw && fw.kuromasu) });
  };

  // ---------- layout: what the player actually sees ----------

  const layout = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'master', seed: 'scen|layout' });
    await wait(120);
    const g = A().game;
    const b = g.board;
    eq('大师档 10×10', `${g.w}×${g.h}`, '10×10');
    const rect = A().view.canvas.getBoundingClientRect();
    ck('最大盘也在视口里', rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1, JSON.stringify({ l: rect.left, r: rect.right, b: rect.bottom, vw: window.innerWidth, vh: window.innerHeight }));
    ck('格子不小于可点最小值', A().view.geo.cell >= en.theme.Cell.min, String(A().view.geo.cell));
    ck('页面没有横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `${document.documentElement.scrollWidth} vs ${document.documentElement.clientWidth}`);
    let misses = 0;
    for (let t = 0; t < b.n; t++) {
      const p = at(t);
      if (A().view.hitCell(p.x, p.y) !== t) misses++;
    }
    eq('大棋盘每一格都点得中', misses, 0);
    eq('行优先的格子编号', g.cellAt(3, 2), 2 * b.w + 3);
    const outside = A().view.hitCell(rect.left + 1, rect.top + 1);
    eq('盘外的点不属于任何格', outside, -1);

    // the three states have to be three different pictures, or a screenshot proves nothing
    const plain = [];
    for (let t = 0; t < b.n; t++) if (b.clue[t] === en.NO_CLUE) plain.push(t);
    const blackCell = plain[0];
    const whiteCell = plain[1];
    const openCell = plain[2];
    A().setMode(en.BLACK);
    A().stroke([blackCell], en.BLACK);
    A().setMode(en.WHITE);
    A().stroke([whiteCell], en.WHITE);
    await wait(60);
    const paper = hex(en.theme.paper);
    const shade = hex(en.theme.shade);
    const edge = hex(en.theme.paperEdge);
    ck('纸就是底色', near(sheetPixel(), paper, 12), `${sheetPixel()} vs ${paper}`);
    ck('涂黑的格是一整块墨', near(centrePixel(blackCell), shade, 20), `${centrePixel(blackCell)} vs ${shade}`);
    ck('留白的格中心有个点', near(centrePixel(whiteCell), edge, 20), `${centrePixel(whiteCell)} vs ${edge}`);
    ck('没定的格就是纸', near(centrePixel(openCell), paper, 12), `${centrePixel(openCell)} vs ${paper}`);
    ck('三种状态两两能分开', !near(centrePixel(blackCell), centrePixel(openCell), 60) && !near(centrePixel(whiteCell), centrePixel(openCell), 12), JSON.stringify([centrePixel(blackCell), centrePixel(whiteCell), centrePixel(openCell)]));
    eq('画布的颜色就是主题令牌', cssVar('--shade'), en.theme.shade);
    eq('纸色也是主题令牌', cssVar('--paper'), en.theme.paper);
    ck('令牌与 CSS 同一份来源', cssVar('--error').toUpperCase() === en.theme.error.toUpperCase(), `${cssVar('--error')} vs ${en.theme.error}`);

    // a digit that is really inked: count dark strokes inside the paper disc. The cell chosen is one
    // the engine calls neither right nor wrong, so a colour decision cannot fake the sample.
    const quietMaster = [...b.clueCells].find((s) => !g.clueBad.has(s) && !g.clueGood.has(s));
    const disc = (() => {
      const s = quietMaster;
      const r = A().view.cellRect(s);
      const d = A().view.geo.dpr;
      const box = Math.round(r.size * 0.5);
      const x = Math.round((r.x + r.size / 2 - box / 2) * d);
      const y = Math.round((r.y + r.size / 2 - box / 2) * d);
      const img = A().view.ctx.getImageData(x, y, Math.round(box * d), Math.round(box * d)).data;
      let dark = 0;
      for (let i = 0; i < img.length; i += 4) if (img[i] + img[i + 1] + img[i + 2] < 420) dark++;
      return { s, dark };
    })();
    ck('找得到一个还没被判定的数字', disc.s >= 0, String(disc.s));
    ck('数字真的被画出来', disc.dark >= 6, `暗像素 ${disc.dark} @${b.cellName(disc.s)}`);

    // colour follows the engine's judgement and nothing else
    A().begin({ tier: 'regular', seed: 'scen|ring' });
    await wait(70);
    const g6 = A().game;
    const b6 = g6.board;
    const quiet = [...b6.clueCells].find((s) => !g6.clueBad.has(s) && !g6.clueGood.has(s));
    A().redraw();
    await wait(20);
    ck('没定的数字是墨色', ringCount(quiet, hex(cssVar('--clue-ink'))) >= 4, `命中 ${ringCount(quiet, hex(cssVar('--clue-ink')))}/12`);
    let over = null;
    for (const s of b6.clueCells) {
      for (const ray of b6.rays[s]) {
        if (!ray || ray.length < b6.clue[s] + 1) continue;
        const cells = Array.from(ray).slice(0, b6.clue[s] + 1);
        if (cells.includes(s)) continue;
        over = { s, cells };
        break;
      }
      if (over) break;
    }
    A().stroke(over.cells, en.WHITE);
    await wait(60);
    const err = hex(cssVar('--error'));
    const ok = hex(cssVar('--success'));
    ck('对不上的数字画了红环', ringCount(over.s, err) >= 4, `命中 ${ringCount(over.s, err)}/12`);
    ck('对不上的数字没画成绿的', ringCount(over.s, ok) === 0, `命中 ${ringCount(over.s, ok)}/12`);
    ck('红环与面板同源', g6.clueBad.has(over.s), String(g6.clueBad.size));
    A().begin({ tier: 'regular', seed: 'scen|ring' });
    await wait(70);
    let k = 0;
    while (k++ < 200 && A().game.clueGood.size === 0) A().useHint();
    const good = [...A().game.clueGood][0];
    await wait(40);
    ck('数对了的数字画了绿环', ringCount(good, ok) >= 4, `命中 ${ringCount(good, ok)}/12 @${b6.cellName(good)} k=${k}`);
    ck('数对了的没画成红', ringCount(good, err) === 0, `命中 ${ringCount(good, err)}/12`);

    // the brush badge: which ink the pointer is holding has to be readable off the board
    A().begin({ tier: 'trainee', seed: 'scen|badge' });
    await wait(60);
    const badge = () => getComputedStyle(A().view.canvas, '::after').content;
    ck('黑笔时角标写着黑', /■/.test(badge()) && /黑/.test(badge()), badge());
    A().setMode(en.WHITE);
    ck('白笔时角标写着白', /□/.test(badge()) && /白/.test(badge()), badge());
    A().setErase(true);
    ck('开橡皮时角标写着擦', /擦/.test(badge()), badge());
    A().setErase(false);
    ck('关橡皮后角标回到白', /白/.test(badge()), badge());
    A().setMode(en.BLACK);

    // the same seed has to draw the same picture, twice, with no clock in it
    // Measured 2026-09-27 in a fresh Chrome process: two paints of one blank board hashed differently
    // — 7116 of 114244 pixels moved, mean |ΔR|+|ΔG|+|ΔB| 38 on those pixels, nothing else about the
    // board different (same geo, same palette). It arrived once, between a draw at ~230 ms and a
    // redraw at ~930 ms after the page loaded, never to revert; wrapping the 2D context in recording
    // proxies (which keeps Chrome off its accelerated raster path) made the two paints agree
    // byte-for-byte while the recorded call stream stayed the same. So a hash taken across that
    // switch measures the browser's warm-up, not the app. Wait for the picture to stop changing
    // first — and if it never stops, that check goes red with the hashes it saw. The comparison
    // underneath stays byte-exact.
    async function rasterSettled() {
      const seen = [];
      for (let i = 0; i < 12; i++) {
        await wait(300);
        A().redraw();
        seen.push(canvasHash());
        if (seen.length >= 3 && new Set(seen.slice(-3)).size === 1) return { ok: true, seen };
      }
      return { ok: false, seen };
    }
    const settled = await rasterSettled();
    ck('光栅状态先停下来了才比像素', settled.ok, JSON.stringify(settled.seen));
    const planFor = (game) => {
      const out = [];
      for (let t = 0; t < game.board.n; t++) if (game.board.clue[t] === en.NO_CLUE && game.puzzle.solution[t] === en.BLACK) out.push(t);
      return out;
    };
    const paintPlan = async () => {
      A().begin({ tier: 'trainee', seed: 'scen|hash' });
      await wait(60);
      const plan = planFor(A().game);
      A().stroke(plan, en.BLACK);
      A().redraw();
      return { hash: canvasHash(), cells: plan.length };
    };
    const one = await paintPlan();
    const two = await paintPlan();
    eq('同种子同盘面画两遍像素相同', two.hash, one.hash);
    ck('画进去的黑格够多', one.cells >= 3, String(one.cells));
    const h1 = one.hash;

    eq('图例五项', document.querySelectorAll('.legend span').length, 5);
    ck('图例的黑块与画布同一个颜色', near(rgb(getComputedStyle($('.sw-black')).backgroundColor), shade, 12), `${getComputedStyle($('.sw-black')).backgroundColor} vs ${shade}`);
    ck('图例的纸块与画布同一个颜色', near(rgb(getComputedStyle($('.sw-paper')).backgroundColor), paper, 12), `${getComputedStyle($('.sw-paper')).backgroundColor} vs ${paper}`);
    ck('图例的坏块是那个红', near(rgb(getComputedStyle($('.sw-bad')).backgroundColor), hex(cssVar('--error')), 12), getComputedStyle($('.sw-bad')).backgroundColor);
    ck('操作提示讲清三种手势', /拖动/.test(text('.keyhint')) && /橡皮/.test(text('.keyhint')) && /撤销/.test(text('.keyhint')), text('.keyhint'));
    eq('统计项七条', document.querySelectorAll('.stats .stat').length, 7);
    ck('按钮都够点', [...document.querySelectorAll('.acts button, .modes button, .top-actions button')].every((x) => x.getBoundingClientRect().height >= 28), JSON.stringify([...document.querySelectorAll('.modes button')].map((x) => Math.round(x.getBoundingClientRect().height))));
    ck('顶部按钮不重叠', (() => {
      const bs = [...document.querySelectorAll('.top-actions button')].map((x) => x.getBoundingClientRect());
      for (let i = 1; i < bs.length; i++) if (bs[i].left < bs[i - 1].right - 1) return false;
      return true;
    })());
    ck('提示框不横向溢出', (() => {
      const e = $('.hint-box');
      return e.scrollWidth <= e.clientWidth + 1;
    })(), `${$('.hint-box').scrollWidth} vs ${$('.hint-box').clientWidth}`);
    ck('三档笔并排放得下', (() => {
      const bs = [...document.querySelectorAll('.modes button')].map((x) => x.getBoundingClientRect());
      return bs.length === 3 && bs.every((x) => x.width > 30);
    })(), JSON.stringify([...document.querySelectorAll('.modes button')].map((x) => Math.round(x.getBoundingClientRect().width))));

    A().begin({ tier: 'trainee', seed: 'scen|layout-win' });
    await wait(60);
    const g8 = A().game;
    const b8 = g8.board;
    const sol = g8.puzzle.solution;
    A().stroke(Array.from({ length: b8.n }, (_, i) => i).filter((t) => sol[t] === en.WHITE), en.WHITE);
    A().stroke(Array.from({ length: b8.n }, (_, i) => i).filter((t) => sol[t] === en.BLACK), en.BLACK);
    await wait(60);
    eq('照解画完就胜利', g8.status, 'won');
    ck('胜利卡居中在棋盘内', (() => {
      const card = $('.win-card').getBoundingClientRect();
      const wrap = $('#board-wrap').getBoundingClientRect();
      return card.left >= wrap.left - 1 && card.right <= wrap.right + 1 && card.top >= wrap.top - 1 && card.bottom <= wrap.bottom + 1;
    })(), JSON.stringify({ c: $('.win-card').getBoundingClientRect(), w: $('#board-wrap').getBoundingClientRect() }));
    ck('胜利按钮点得到', $('#btn-again').getBoundingClientRect().width > 40);
    ck('胜利时每个数字都是绿的', [...A().game.clueGood].length === b8.clues, `${A().game.clueGood.size}/${b8.clues}`);
    return report({ cell: A().view.geo.cell, dpr: A().view.geo.dpr, hash: h1 });
  };

  w.__ng = { engine, gen, play, ink, hint, stroke, conflict, save, resume, layout };
})(window);
