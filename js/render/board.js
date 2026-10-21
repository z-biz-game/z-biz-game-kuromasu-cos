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
import { Palette, Cell, Radius, Font } from '../theme.js';
import { OPEN, BLACK, WHITE, NO_CLUE } from '../engine/kuromasu.js';
import { rippleFrac, rippleRadius, rippleAlpha, sparkOffset, age } from './anim.js';

// 纹理与 sprite 都相对本模块解析：Pages 把这一盘发在 /z-biz-game-kuromasu-cos/ 前缀下，
// 写死 '/assets/…' 会在前缀形态下 404（同组织已经因此红过一次）。
//
// 路径写成**逐个文件的完整字面量**，而不是「目录基址 + 片段」：
// 目录基址（new URL('../../assets/', import.meta.url)）在浏览器里是对的，但部署集闸
// 只把以 '/' 结尾的引用当成「浏览器要取的那份文档」⇒ 去找 assets/index.html ⇒ 一条假红；
// 逐个文件写字面量之后，闸验的是**那三张图本身**在不在产物里，比只验目录更实。
function loadImage(url) {
  try {
    const img = new Image();
    img.src = url.href;
    return img;
  } catch {
    return null;
  }
}

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
    // 三张图都是 assets/gen/make_art.py 现产的：纸纹铺在盘底、墨纹叠在被涂黑的格上、
    // 光爆 sprite 给提示与胜利。没加载完之前一律走纯色——纹理是牙，不是信息载体。
    this.tex = {
      paper: loadImage(new URL('../../assets/textures/paper-grain.png', import.meta.url)),
      ink: loadImage(new URL('../../assets/textures/ink-grain.png', import.meta.url)),
      burst: loadImage(new URL('../../assets/sprites/amber-burst.png', import.meta.url)),
    };
    this.pat = {};
  }

  pattern(key) {
    const img = this.tex[key];
    if (!img || !img.complete || !img.naturalWidth) return null;
    if (this.pat[key] === undefined) {
      try {
        this.pat[key] = this.ctx.createPattern(img, 'repeat');
      } catch {
        this.pat[key] = null;
      }
    }
    return this.pat[key];
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

  draw(game, { pulse = null, preview = null, anim = null } = {}) {
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
    // 纸纹：assets/textures/paper-grain.png 的均值就压在 Palette.paper 上、逐通道限幅 ±6，
    // 所以这一层只给纸加牙，不动 tools/scenarios.js 里"纸就是底色"那条 tol=12 的颜色判据。
    const paperPat = this.pattern('paper');
    if (paperPat) {
      roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
      ctx.fillStyle = paperPat;
      ctx.fill();
    }

    // Squares the player has punched out. A black cell covers its whole square, which is what makes
    // "the black group" and "the white group" readable at a glance — a ring inside the cell would
    // leave a paper seam and make the shading ambiguous. Decided white needs no paint either:
    // paper *is* white, so the only mark a white cell wears is the dot that says "this one is
    // settled", and the open cells keep the bare paper. That is how the puzzle is printed.
    const inkPat = this.pattern('ink');
    for (let t = 0; t < b.n; t++) {
      if (ink[t] !== BLACK) continue;
      const r = this.cellRect(t);
      ctx.fillStyle = Palette.shade;
      ctx.fillRect(r.x, r.y, cell, cell);
      if (inkPat) {
        ctx.fillStyle = inkPat;
        ctx.fillRect(r.x, r.y, cell, cell);
      }
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

    if (anim) this.drawAnim(anim, cell);

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

  // 动画只读 `anim.clock`，一个数都不自己攒：半径/位移/透明度全是 (clock - bornAt) 的闭函数，
  // 所以 30/60/120Hz 在同一虚拟时刻画出来的必须是一模一样的像素。
  drawAnim(anim, cell) {
    const { ctx } = this;
    for (const r of anim.ripples) {
      const rect = this.cellRect(r.cell);
      const cx = rect.x + cell / 2;
      const cy = rect.y + cell / 2;
      const frac = rippleFrac(anim, r);
      const a = rippleAlpha(frac);
      if (a <= 0.01) continue;
      ctx.save();
      ctx.globalAlpha = a;
      if (r.sprite && this.tex.burst && this.tex.burst.complete && this.tex.burst.naturalWidth) {
        const span = cell * (1.1 + 2.6 * frac);
        ctx.drawImage(this.tex.burst, cx - span / 2, cy - span / 2, span, span);
      } else {
        ctx.strokeStyle = r.color || Palette.accent;
        ctx.lineWidth = Math.max(1.5, cell * 0.055 * (1 - frac * 0.55));
        ctx.beginPath();
        ctx.arc(cx, cy, rippleRadius(frac, cell), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (!anim.sparks.length) return;
    const dpr = this.geo.dpr;
    ctx.save();
    ctx.fillStyle = Palette.accentEdge;
    for (const s of anim.sparks) {
      const o = sparkOffset(s, age(anim, s));
      if (o.alpha <= 0.02) continue;
      const rect = this.cellRect(s.cell);
      ctx.save();
      ctx.globalAlpha = o.alpha;
      ctx.translate(rect.x + cell / 2 + o.x, rect.y + cell / 2 + o.y);
      ctx.rotate(o.rot);
      const w = Math.max(1.6, cell * 0.062 * s.size);
      ctx.fillRect(-w / 2, -w / 2, w, w * 0.62);
      ctx.restore();
    }
    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
