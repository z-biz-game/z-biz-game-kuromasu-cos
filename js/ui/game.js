// The playable state machine: what a tap does, what an undo takes back, when a board counts as
// solved, and what a hint is allowed to say.
//
// Two deliberate bindings to js/engine/kuromasu.js:
//   * the ink lives in the engine's own `st.cell` array, and the win check is the engine's
//     independent `verify()`/`complete()` — written from the rules of the game rather than from
//     this file's bookkeeping — so "the UI said I won" cannot disagree with "every number adds up".
//   * hints are read out of a script the *clues* produced (`solve()`), never out of the player's
//     own marks. A wrong black square therefore cannot make the hints agree with the mistake: the
//     engine keeps saying what the numbers actually force.
//
// Everything the picture needs to know about a number — is it already over the line, is it exactly
// met — is the engine's own `diagnose()` answer, filtered here against `board.clueCells`. Filtered,
// never recomputed: this file does not walk a single ray.

import {
  createState,
  setCell,
  snapshot,
  undo as undoState,
  solve,
  nextDeduction,
  verify,
  complete,
  reachable,
  diagnose,
  Rules,
  name,
  OPEN,
  BLACK,
  WHITE,
  NO_CLUE,
} from '../engine/kuromasu.js';

export { OPEN, BLACK, WHITE, NO_CLUE, name, Rules };

export class Game {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.board = puzzle.board;
    this.w = puzzle.board.w;
    this.h = puzzle.board.h;
    this.st = createState(puzzle.board);
    this.steps = [];
    // The whole hint script is computed once, from the clues alone. `solve()` is the same
    // function the generator used to accept this board, so a hint can never be a fact the
    // clues do not force.
    this.script = solve(puzzle.board).rows;
    this.cursor = 0;
    this.moves = 0;
    this.hints = 0;
    this.status = 'playing';
    this.mode = BLACK;
    this.lastHint = null;
    // The last write this file refused, and why. A refusal is information for the player, not a
    // state change: the engine never took the mark, so nothing here has to be rolled back.
    this.refusal = null;
    this.recompute();
  }

  // One call, four engine readouts. The renderer and every DOM stat read *these*; nobody
  // downstream re-derives a number from the ink.
  recompute() {
    this.diag = diagnose(this.board, this.st.cell);
    this.problems = verify(this.board, this.st.cell);
    this.stuck = !reachable(this.board, this.st.cell);
    const clueCell = new Int8Array(this.board.n);
    for (const s of this.board.clueCells) clueCell[s] = 1;
    // diagnose() reports both broken numbers *and* the cells that carry a different kind of break
    // (two blacks touching, a white group cut in two). The numbered-cell paint wants only the
    // numbers, so the two sets are split by what the cell actually is.
    this.clueBad = new Set();
    this.clueGood = new Set();
    this.otherBad = new Set();
    for (const s of this.board.clueCells) {
      if (this.diag.violated.has(s)) this.clueBad.add(s);
      else if (this.diag.satisfied.has(s)) this.clueGood.add(s);
    }
    for (const c of this.diag.violated) if (!clueCell[c]) this.otherBad.add(c);
    return this.diag;
  }

  cellAt(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  valueOf(t) {
    return t >= 0 && t < this.board.n ? this.st.cell[t] : OPEN;
  }

  // Every gesture consumes exactly one engine snapshot and records the cells it changed with
  // their prior values, so 撤销 is an exact reverse rather than a re-derivation.
  commit(kind, info) {
    this.steps.push({ kind, ...info });
    if (kind === 'hint') this.hints++;
    else this.moves++;
    this.recompute();
    this.checkWin();
    return this.steps[this.steps.length - 1];
  }

  // A numbered cell is the puzzle's own ink: it may be marked white (that is rule 带字即白), but
  // shading it in — or erasing the number off the board — is not a move. The engine refuses the
  // write outright; this file says so in words.
  refuses(t, value) {
    if (this.board.clue[t] === NO_CLUE) return null;
    if (value === BLACK) return `${this.board.cellName(t)} 写着 ${this.board.clue[t]}：数字格自己必须是白格，涂黑它不是一个动作。`;
    if (value === OPEN) return `${this.board.cellName(t)} 写着 ${this.board.clue[t]}：数字那一格不用擦，它天生是白格。`;
    return null;
  }

  // The gesture layer skips cells it is not allowed to write, and a skip has to be explained with
  // the same words the rules use — so the refusal is recorded here rather than paraphrased in
  // pointer code that knows nothing about clues.
  noteRefusal(t, value) {
    const why = this.refuses(t, value);
    if (why) this.refusal = { cell: t, why };
    return !!why;
  }

  // One predictable rule for both modes: tapping a cell that already wears this mode's mark erases
  // it, tapping anything else puts this mode's mark there.
  tap(t, mode = this.mode) {
    if (this.status === 'won' || t < 0 || t >= this.board.n) return null;
    const from = this.st.cell[t];
    const want = from === mode ? OPEN : mode;
    // The eraser landing on bare paper is not a refusal and not a move: there was nothing there.
    // Saying so here keeps a stale complaint from the previous gesture on screen.
    if (want === from) {
      this.refusal = null;
      return null;
    }
    const why = this.refuses(t, want);
    if (why) {
      this.refusal = { cell: t, why };
      return null;
    }
    if (!setCell(this.st, t, want)) return null;
    this.refusal = null;
    return this.commit('tap', { writes: [{ cell: t, from, to: want }], value: want });
  }

  // A drag paints one value, never toggling — sweeping back over your own black squares must not
  // eat them. The whole gesture is one step, so 撤销 undoes a stroke rather than a cell of it.
  stroke(cells, value) {
    if (this.status === 'won') return null;
    const writes = [];
    const seen = new Set();
    let skipped = 0;
    for (const t of cells) {
      if (t < 0 || t >= this.board.n || seen.has(t)) continue;
      seen.add(t);
      if (this.refuses(t, value)) {
        skipped++;
        continue;
      }
      if (this.st.cell[t] === value) continue;
      writes.push({ cell: t, from: this.st.cell[t], to: value });
    }
    if (skipped) this.refusal = { cell: null, why: '数字那一格不参与涂黑：白格是它自己的事。' };
    if (!writes.length) return null;
    snapshot(this.st);
    for (const w of writes) this.st.cell[w.cell] = w.to;
    // A gesture that painted most of what it crossed still owes the player the reason one cell was
    // left out, so a partial skip does not wipe the note.
    if (!skipped) this.refusal = null;
    return this.commit('stroke', { writes, value, skipped });
  }

  // Only a resume path uses this: the saved ink goes back verbatim, without a history entry per
  // cell, and the run's own judgement is recomputed straight from the engine.
  load(cells) {
    for (let t = 0; t < this.board.n; t++) {
      const v = cells[t];
      this.st.cell[t] = v === BLACK || v === WHITE ? v : OPEN;
    }
    this.recompute();
    this.checkWin();
    return this;
  }

  undo() {
    const step = this.steps.pop();
    if (!step) return null;
    undoState(this.st);
    for (const w of step.writes || []) this.st.cell[w.cell] = w.from;
    // A hint taken back is still a hint that was taken: records rank runs by help used, so
    // refunding the counter would let a player undo their way to a clean 提示 0.
    if (step.kind !== 'hint') this.moves = Math.max(0, this.moves - 1);
    this.recompute();
    return step;
  }

  // The next fact the clues force that the player has not drawn yet. Everything before it in the
  // script is already on the board, so a hint is always one step of real progress — and when the
  // script is exhausted the board is solved, so "nothing to say" cannot be charged for.
  hint() {
    if (this.status === 'won') return null;
    while (this.cursor < this.script.length) {
      const row = this.script[this.cursor];
      if (this.st.cell[row.cell] === row.value) {
        this.cursor++;
        continue;
      }
      if (this.st.cell[row.cell] !== OPEN) {
        // the player's own mark contradicts what the clues force: say so, and charge nothing
        return {
          conflict: `数字推到了 ${this.board.cellName(row.cell)}：这里必须是${name(row.value)}，可你已经写了${name(this.st.cell[row.cell])}。`,
          cell: row.cell,
        };
      }
      const from = this.st.cell[row.cell];
      setCell(this.st, row.cell, row.value);
      this.cursor++;
      this.commit('hint', { writes: [{ cell: row.cell, from, to: row.value }], value: row.value, rule: row.rule.name });
      const info = {
        rule: row.rule.name,
        cell: row.cell,
        value: row.value,
        node: row.clue,
        why: row.rule.text(this.board, row),
        charged: true,
      };
      this.lastHint = info;
      return info;
    }
    // The generator only accepts a board whose clue-derived script fills it, so reaching here with
    // ink still down means the player painted something the clues never asked for. Ask the engine
    // what the current board forces instead of claiming there is nothing left to say.
    const nxt = nextDeduction(this.board, this.st.cell);
    if (nxt && nxt.conflict) return { conflict: nxt.conflict, cell: nxt.cell };
    if (nxt) {
      const from = this.st.cell[nxt.cell];
      setCell(this.st, nxt.cell, nxt.value);
      this.commit('hint', { writes: [{ cell: nxt.cell, from, to: nxt.value }], value: nxt.value, rule: nxt.rule.name });
      const info = {
        rule: nxt.rule.name,
        cell: nxt.cell,
        value: nxt.value,
        node: nxt.clue,
        why: nxt.rule.text(this.board, nxt),
        charged: true,
      };
      this.lastHint = info;
      return info;
    }
    return { stalled: true, text: '数字能推的都已经推完了：剩下的格只能自己收尾。' };
  }

  checkWin() {
    this.status = complete(this.board, this.st.cell) ? 'won' : 'playing';
    return this.status === 'won';
  }

  // Only used by the verification harness and the "solve it for me" path: play the clue-derived
  // script to the end. Every cell it writes is one the pencil rules justify.
  solveWithLogic({ cap = 4000 } = {}) {
    let k = 0;
    while (this.status !== 'won' && k++ < cap) {
      const before = this.steps.length;
      const h = this.hint();
      if (!h || h.stalled || h.conflict) break;
      if (this.steps.length === before) break;
    }
    return { status: this.status, steps: k };
  }

  state() {
    const g = this.diag;
    return {
      tier: this.puzzle.tier,
      name: this.puzzle.tierName,
      seed: this.puzzle.seed,
      originSeed: this.puzzle.originSeed,
      moves: this.moves,
      hints: this.hints,
      status: this.status,
      filled: g.filled,
      total: g.total,
      remaining: g.remaining,
      blacks: count(this.st.cell, BLACK),
      whites: count(this.st.cell, WHITE),
      clues: g.clues,
      satisfied: this.clueGood.size,
      badClues: this.clueBad.size,
      conflicts: g.violated.size,
      stuck: this.stuck,
      problems: this.problems.length,
      script: this.script.length,
      cursor: this.cursor,
      score: this.puzzle.score,
      steps: this.steps.length,
      mode: this.mode,
    };
  }
}

function count(cells, value) {
  let n = 0;
  for (let t = 0; t < cells.length; t++) if (cells[t] === value) n++;
  return n;
}
