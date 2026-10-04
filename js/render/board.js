// Canvas renderer. It reads the Game's engine state and paints; it decides nothing — no number is
// "satisfied" here, no square is judged wrong here — so the picture cannot disagree with the solver
// that the hints and the win check both use.
//
// Layout lives here too (cell size from the container, board origin, DPR) because hitCell has to
// answer with the *same* numbers draw() used. Those two drifting apart is how a board renders
// correctly but takes clicks one cell off.
//
// What each colour means is the engine's answer, filtered in js/ui/game.js:
//   * `game.clueBad` / `game.clueGood` are that engine's violated/satisfied sets restricted to the
//     cells that actually carry a number,
//   * `game.otherBad` is the same engine's violated set restricted to the cells that carry no
//     number — the two blacks that touched, the white group that got cut in two.
// This file never walks a ray and never counts a white cell.

// The engine's own "this cell breaks a rule" answer for cells that carry no number: two blacks
// that touched, or a white group cut in two. The square keeps its colour — it is what it is — and
// only the ring says the placement is the problem. That judgement is `game.otherBad`, filtered in
// js/ui/game.js out of the engine's diagnose() result; nothing is decided here.

/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：js/render/board.js 的重绘由 pointerdown / click / keydown 触发，全仓 requestAnimationFrame 出现 0 次；唯一的周期性调用是 js/main.js:127 那个 1 秒 ticker（刷新用时读数 + 重画静态盘面）
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, Cell, Radius, Font } from '../theme.js';
import { OPEN, BLACK, WHITE, NO_CLUE } from '../engine/kuromasu.js';

// The board is one sheet of paper: everything not punched out is white, so the layout only has to
// fit w×h cells and a hairline border into the box it is handed.
export function layoutFor(w, h, availW, availH) {
  const pad = 14;
  const size = Math.max(0, Math.min((availW - pad * 2) / w, (availH - pad * 2) / h));
  const cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(size)));
  return { cell, boardW: cell * w, boardH: cell * h, pad };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1 };
  }

  // The backing buffer is sized in device pixels while every draw call stays in CSS pixels: one
  // setTransform at the top keeps the digits crisp on a Retina display without doubling every
  // constant in this file.
  resize(game, availW, availH) {
    const l = layoutFor(game.w, game.h, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const size = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: size.w, h: size.h, dpr };
    this.game = game;
    return this.geo;
  }

  cellRect(t) {
    const { cell, x, y } = this.geo;
    return { x: (t % this.game.w) * cell + x, y: (((t / this.game.w) | 0) * cell) + y, size: cell };
  }

  // Screen point → cell index, in the board's own coordinates. The caller passes client
  // coordinates; the padding is part of the canvas, so it comes off before the division.
  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const game = this.game;
    if (!cell || !game) return -1;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    if (px < 0 || py < 0) return -1;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= game.w || gy >= game.h) return -1;
    return gy * game.w + gx;
  }

  draw(game, { pulse = null, preview = null } = {}) {
    this.game = game;
    const { ctx, geo } = this;
    const { cell } = geo;
    const b = game.board;
    const ink = game.st.cell;
    const won = game.status === 'won';
    ctx.clearRect(0, 0, geo.w, geo.h);

    // The sheet.
    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.paper;
    ctx.fill();

    // Squares the player has punched out. A black cell covers its whole square, which is what makes
    // "the black group" and "the white group" readable at a glance — a ring inside the cell would
    // leave a paper seam and make the shading ambiguous. Decided white needs no paint either:
    // paper *is* white, so the only mark a white cell wears is the dot that says "this one is
    // settled", and the open cells keep the bare paper. That is how the puzzle is printed.
    for (let t = 0; t < b.n; t++) {
      if (ink[t] !== BLACK) continue;
      const r = this.cellRect(t);
      ctx.fillStyle = Palette.shade;
      ctx.fillRect(r.x, r.y, cell, cell);
    }

    // Settled white: a small dot in the middle, so "I decided this one" survives the black squares.
    ctx.fillStyle = Palette.paperEdge;
    for (let t = 0; t < b.n; t++) {
      if (ink[t] !== WHITE) continue;
      const r = this.cellRect(t);
      ctx.beginPath();
      ctx.arc(r.x + cell / 2, r.y + cell / 2, Math.max(2, cell * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }

    // Grid.
    ctx.strokeStyle = Palette.paperEdge;
    ctx.lineWidth = 1;
    for (let i = 0; i <= game.w; i++) line(ctx, geo.x + i * cell + 0.5, geo.y, geo.x + i * cell + 0.5, geo.y + game.h * cell);
    for (let j = 0; j <= game.h; j++) line(ctx, geo.x, geo.y + j * cell + 0.5, geo.x + game.w * cell, geo.y + j * cell + 0.5);
    ctx.strokeStyle = Palette.shadeEdge;
    ctx.lineWidth = Math.max(1.5, cell * Cell.inkScale);
    ctx.strokeRect(geo.x - 1, geo.y - 1, game.w * cell + 2, game.h * cell + 2);

    // The engine's own "this cell breaks a rule" answer for cells that carry no number: two blacks
    // that touched, or a white group cut in two. The square keeps its colour — it is what it is —
    // and only the ring says the placement is the problem.
    if (!won && game.otherBad.size) {
      ctx.lineWidth = Math.max(2, cell * 0.08);
      ctx.strokeStyle = Palette.error;
      for (const t of game.otherBad) {
        const r = this.cellRect(t);
        roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
        ctx.stroke();
      }
    }

    // The box under the finger, before it is committed: a preview is paint, never ink. A stroke
    // that lifts marks off the paper is drawn dashed, so "this gesture erases" is visible while
    // the finger is still down rather than only after the hand moves away.
    if (preview && preview.cells && preview.cells.length) {
      const erase = preview.value === OPEN;
      ctx.strokeStyle = Palette.accent;
      ctx.lineWidth = Math.max(2, cell * 0.06);
      if (erase) ctx.setLineDash([Math.max(4, cell * 0.2), Math.max(3, cell * 0.14)]);
      for (const t of preview.cells) {
        const r = this.cellRect(t);
        if (erase) {
          ctx.strokeRect(r.x + 1.5, r.y + 1.5, cell - 3, cell - 3);
        } else {
          roundRect(ctx, r.x + 1.5, r.y + 1.5, cell - 3, cell - 3, Radius.cell);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }

    // Numbers last, so a clue always sits on top of the sheet it counts.
    const rad = cell * Cell.clueScale;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const font = `700 ${Math.round(rad * 1.15)}px ${Font.sans}`;
    for (const s of b.clueCells) {
      const r = this.cellRect(s);
      const bad = !won && game.clueBad.has(s);
      const good = won || game.clueGood.has(s);
      const colour = bad ? Palette.error : good ? Palette.success : Palette.clueInk;
      // A number is always read off paper: if the player somehow shaded under it the square is
      // punched out, so the disc carries its own background.
      ctx.beginPath();
      ctx.arc(r.x + cell / 2, r.y + cell / 2, rad, 0, Math.PI * 2);
      ctx.fillStyle = Palette.paper;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, rad * 0.16);
      ctx.strokeStyle = colour;
      ctx.stroke();
      ctx.font = font;
      ctx.fillStyle = colour;
      ctx.fillText(String(b.clue[s]), r.x + cell / 2, r.y + cell / 2 + 1);
    }

    // What a hint just named — the only place the UI is allowed to say "look here".
    if (pulse && pulse.cell != null) {
      const r = this.cellRect(pulse.cell);
      ctx.strokeStyle = pulse.color || Palette.hint;
      ctx.lineWidth = Math.max(2, cell * 0.09);
      roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
      ctx.stroke();
      const node = pulse.node;
      if (node != null && b.clue[node] !== NO_CLUE) {
        const p = this.cellRect(node);
        ctx.beginPath();
        ctx.arc(p.x + cell / 2, p.y + cell / 2, rad + Math.max(2, cell * 0.08), 0, Math.PI * 2);
        ctx.strokeStyle = Palette.hint;
        ctx.lineWidth = Math.max(1.5, cell * 0.05);
        ctx.stroke();
      }
    }
  }
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
