// Persistence. Everything lives under one key so a reset is one line, and a run in progress is
// stored as (origin seed, tier, the ink laid down so far, what the run has cost) rather than a
// copy of the clue set or the solution — the generator is deterministic, so the board never has
// to travel through storage, and a solved 10×10 comes to a couple of hundred bytes.
//
// Nothing here keys on wall-clock time: `at` is a display field, never part of an identity, so the
// same seed always redraws the same board no matter when the save was written.

const KEY = 'kuromasu.save.v1';
// 存档结构变了就 bump 这个数：旧版本的记录会被当成"不认识的那一条"单独丢掉，
// 而不是让新代码去猜一份形状已经变过的 JSON。
const SCHEMA = 1;

const defaults = () => ({
  v: SCHEMA,
  settings: { sound: true, reduceMotion: false },
  best: {},
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0 },
});

// Cell states are 0 没定 / 1 黑 / 2 白, and an early board is mostly 0s — run-length coding is why
// a 100-cell save is not a 3 KB JSON array. No offset is needed: nothing here is negative. (The
// engine's NO_CLUE is -1, and it never appears in this array: it belongs to the clue layer, which
// is regenerated from the seed and therefore never stored.)
function rleEncode(board) {
  const out = [];
  let run = board[0] ?? 0;
  let n = 1;
  for (let i = 1; i < board.length; i++) {
    if (board[i] === run && n < 255) n++;
    else {
      out.push(run, n);
      run = board[i];
      n = 1;
    }
  }
  out.push(run, n);
  return out;
}

// ---- 两段式解码 ----
// 第一段只管"这串字节是不是一个对象"，第二段才逐条核对形状。分开写是因为它们坏的原因不同：
// 第一段坏 = 存储被截断/被人塞了垃圾（整份退回默认是唯一诚实的答案），
// 第二段坏 = 某一条记录自己不成形（那就只丢那一条）。旧写法把两段揉在一个 try 里，
// 于是一条写坏的 resume 会让玩家的最佳纪录与设置一起回到出厂——那是数据丢失，不是容错。

function count(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function parseRecord(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// 游程对必须是 [0..2 的值, 1..255 的个数]，而且总长不能超出格数：超出说明这一份 ink
// 根本不属于这块盘。退回 null 而不是"截断到 len"——静悄悄少几格的墨比没有存档更危险。
function decodeInk(pairs, len) {
  const b = new Uint8Array(len);
  let i = 0;
  for (let p = 0; p < pairs.length; p += 2) {
    const v = pairs[p];
    const n = pairs[p + 1];
    if (!Number.isInteger(v) || v < 0 || v > 2) return null;
    if (!Number.isInteger(n) || n < 1 || n > 255) return null;
    if (i + n > len) return null;
    for (let k = 0; k < n; k++) b[i++] = v;
  }
  return b;
}

function cleanBest(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const tier of Object.keys(input)) {
    const r = input[tier];
    if (!r || typeof r !== 'object') continue;
    const ms = count(r.ms);
    const hints = count(r.hints);
    const moves = count(r.moves);
    if (ms === null || hints === null || moves === null) continue;
    out[tier] = { ms, hints, moves, size: typeof r.size === 'string' ? r.size : '', at: count(r.at) || 0 };
  }
  return out;
}

function cleanResume(r) {
  if (!r || typeof r !== 'object') return null;
  const cells = count(r.cells);
  if (cells === null || cells < 1 || cells > 4096) return null;
  if (typeof r.seed !== 'string' || !r.seed) return null;
  if (typeof r.tier !== 'string' || !r.tier) return null;
  if (!Array.isArray(r.ink)) return null;
  if (!decodeInk(r.ink, cells)) return null;
  // 只留"存进去的那几个字段"：墨的格子数组是读的时候现算的（见 resume()），
  // 把它一起存等于把 100 个键名写进 JSON，游程编码省下来的那点字节当场还回去。
  return {
    ...r,
    cells,
    elapsedMs: count(r.elapsedMs) || 0,
    moves: count(r.moves) || 0,
    hints: count(r.hints) || 0,
  };
}

function decodeSave(raw) {
  const base = defaults();
  const parsed = parseRecord(raw);
  if (!parsed) return base;
  const settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
  return {
    v: SCHEMA,
    // 设置是唯一可以整份信任的段：它只有两个布尔，坏值直接退回默认。
    settings: {
      sound: settings.sound !== false,
      reduceMotion: settings.reduceMotion === true,
    },
    best: cleanBest(parsed.best),
    resume: cleanResume(parsed.resume),
    totals: { ...base.totals, ...(parsed.totals && typeof parsed.totals === 'object' ? parsed.totals : {}) },
  };
}

function load() {
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // 隐私模式里 localStorage 本身就会抛：那是环境不给存，不是存档坏了。
    return defaults();
  }
  return decodeSave(saved);
}

export const Store = {
  KEY,
  SCHEMA,
  decodeSave,
  data: load(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* private mode / quota — the game is still playable, just forgetful */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },
  // Best time is decided by *least help taken* first: a record must mean "I worked this board
  // out myself", and a fast run built on six hints is not that.
  recordBest(tier, { ms, hints, moves, size }) {
    const cur = this.data.best[tier];
    const better =
      !cur ||
      hints < cur.hints ||
      (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  saveResume(puzzle, state, elapsedMs, run) {
    this.data.resume = {
      // The generator derives an internal seed from what it is handed, so a resume has to store
      // the *origin* seed or the rebuilt board would not be the same one.
      seed: puzzle.originSeed || puzzle.seed,
      tier: puzzle.tier,
      elapsedMs,
      cells: puzzle.w * puzzle.h,
      ink: rleEncode(state),
      // The cost of the run travels with the board. Without it a player could take six hints,
      // close the tab, come back, and finish with a clean 提示 0 record — the number that
      // decides the best time is counted from actions, and actions are not saved.
      moves: run.moves,
      hints: run.hints,
      at: Date.now(),
    };
    this.save();
  },

  // 读回来时已经校验过了（decodeSave），所以这里不再"猜一次形状"：坏的那条在解码阶段就是 null，
  // 玩家看到的只是"没有可继续的牌局"，其余存档一个字都没动。
  resume() {
    const r = this.data.resume;
    if (!r) return null;
    const board = decodeInk(r.ink, r.cells);
    return board ? { ...r, board } : null;
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    this.data = defaults();
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* 不给删就算了，内存里已经是干净的 */
    }
  },
};
