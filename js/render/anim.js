// 所有"随时间变"的画面状态集中在这一份里，而且只守一条规则：**状态是虚拟时长的闭函数**。
//
// 每帧只做一件事——把 dt 累到 `clock` 上；半径、位移、透明度全部由 `clock - bornAt` 现算。
// 逐帧积分（`x += v*dt` 之后再来一句 `v *= 0.96`）才是帧率依赖的源头：步长一变，截断误差就变，
// 30Hz 与 120Hz 会跑出两条不同的曲线。这里阻力项写成解析解 x(t)=x0+(v0/λ)(1-e^(-λt))，
// 常数加速度项写成 ½gt²，同一虚拟时长在任何刷新率下都给出同一个数。
//
// 回收也写成时钟的函数（`age >= life`）而不是"第几帧发现它过期"，否则两档刷新率会在不同的
// 虚拟时刻把同一个粒子摘掉。

import { prefersReducedMotion } from '../theme.js';

export const RIPPLE_LIFE = 0.85; // 秒
export const SPARK_LIFE = 1.15;
export const SPARK_DRAG = 3.4; // 1/秒：速度衰减常数，写成 e^(-λt) 就不需要逐帧乘系数
export const SPARK_GRAVITY = 260; // px/秒²

// 自己的 LCG：粒子的初速度必须可复现，否则"同种子同盘面画两遍像素相同"那条浏览器断言会被
// Math.random() 每次跑出不同形状的光爆打掉。
function lcg(seed) {
  let s = (seed | 0) || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function createAnim() {
  return { clock: 0, ripples: [], sparks: [], reduced: prefersReducedMotion() };
}

export function resetAnim(a) {
  a.clock = 0;
  a.ripples.length = 0;
  a.sparks.length = 0;
  return a;
}

export function age(a, item) {
  return a.clock - item.bornAt;
}

// 减动效落地为一刀切：涟漪与粒子根本不建，标题与提示只剩静态那一圈（由 board.js 画）。
// 不是"建了再乘个 0"——那样每帧还在算，屏幕上也确实还在动。
export function spawnRipple(a, cell, { color = null, life = RIPPLE_LIFE, sprite = false } = {}) {
  if (a.reduced) return null;
  const r = { cell, bornAt: a.clock, life, color, sprite };
  a.ripples.push(r);
  return r;
}

export function spawnBurst(a, cell, { count = 14, seed = 1, speed = 190 } = {}) {
  if (a.reduced) return [];
  const rnd = lcg(seed * 2654435761 + cell * 40503 + 7);
  const out = [];
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + rnd() * 0.42;
    const v = speed * (0.55 + rnd() * 0.7);
    const s = {
      cell,
      bornAt: a.clock,
      life: SPARK_LIFE * (0.72 + rnd() * 0.5),
      vx: Math.cos(ang) * v,
      vy: Math.sin(ang) * v,
      spin: (rnd() - 0.5) * 6,
      size: 0.9 + rnd() * 1.5,
    };
    a.sparks.push(s);
    out.push(s);
  }
  return out;
}

// 唯一的"吃帧 dt"的地方：整份动画只有这一个累加器。
export function advance(a, dt) {
  if (!(dt > 0)) return a;
  a.clock += dt;
  if (a.ripples.length) a.ripples = a.ripples.filter((r) => age(a, r) < r.life);
  if (a.sparks.length) a.sparks = a.sparks.filter((s) => age(a, s) < s.life);
  return a;
}

// ---- 以下全是虚拟时刻的纯函数：给同一个 (a, t) 必然给出同一个数 ----

export function rippleFrac(a, r) {
  return Math.max(0, Math.min(1, age(a, r) / r.life));
}

// 半径：起步快、收尾慢（1-(1-f)²），单位是格子的边长。
export function rippleRadius(frac, cellSize) {
  return cellSize * (0.34 + 1.12 * (1 - (1 - frac) * (1 - frac)));
}

export function rippleAlpha(frac) {
  const k = 1 - frac;
  return k * k * (0.9 - 0.55 * frac);
}

export function sparkOffset(s, t) {
  const tt = Math.max(0, Math.min(t, s.life));
  const k = 1 - Math.exp(-SPARK_DRAG * tt);
  return {
    x: (s.vx / SPARK_DRAG) * k,
    y: (s.vy / SPARK_DRAG) * k + 0.5 * SPARK_GRAVITY * tt * tt,
    alpha: tt >= s.life ? 0 : Math.pow(1 - tt / s.life, 1.8),
    rot: s.spin * tt,
  };
}

export function busy(a) {
  return a.ripples.length > 0 || a.sparks.length > 0;
}

// 给帧率对拍与线上一句自证用：把当前状态摊平成一串可比的数。
export function snapshot(a) {
  return {
    clock: a.clock,
    ripples: a.ripples.map((r) => ({ cell: r.cell, age: age(a, r), life: r.life })),
    sparks: a.sparks.map((s) => {
      const t = age(a, s);
      const o = sparkOffset(s, t);
      return { cell: s.cell, t, x: o.x, y: o.y, alpha: o.alpha };
    }),
  };
}
