// 难度实测台. Reads the difficulty of each tier off generated boards — it does not set it.
//
// The numbers printed here are what TIERS[].band is supposed to contain. Changing the rules or the
// pruning without re-running this is how a band becomes decoration and the README's measured table
// becomes a lie.
//
//   node tools/balance.mjs              40 boards per tier
//   SAMPLES=12 node tools/balance.mjs   a quick look while iterating
//
// The exit code is the build: 0 only when the ladder really orders, the independent counter agrees
// with the pencil solver on every board it could finish, and nothing had to be skipped.

import { performance } from 'node:perf_hooks';
import { TIERS, makePuzzle, randomSolution, pruneClues } from '../js/engine/generate.js';
import { createBoard, cluesFrom, solve, verify, complete } from '../js/engine/kuromasu.js';
import { countSolutions, UNIQUE } from '../js/engine/count.js';

const N = Number(process.env.SAMPLES || 40);
const q = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))] : NaN);
const line = (label, arr, fmt = (v) => v) => {
  const a = arr.slice().sort((x, y) => x - y);
  console.log(`    ${label.padEnd(10)} p25 ${fmt(q(a, 0.25))}  中位 ${fmt(q(a, 0.5))}  p75 ${fmt(q(a, 0.75))}  max ${fmt(a[a.length - 1])}`);
};

let worst = 0;
const ladder = [];
for (const tier of TIERS) {
  const scores = [];
  const steps = [];
  const clues = [];
  const cells = tier.w * tier.h;
  let accepted = 0;
  let inBand = 0;
  let ms = 0;
  let unsolvable = 0;
  let drawn = 0;
  for (let s = 0; s < N; s++) {
    const t0 = performance.now();
    const p = makePuzzle(`balance|${s}`, tier.key);
    ms += performance.now() - t0;
    if (!p) continue;
    accepted++;
    drawn += p.gen || 1;
    if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
    if (!solve(p.board).ok) unsolvable++;
    scores.push(p.score);
    steps.push(p.steps);
    clues.push(p.clues);
  }
  console.log(`\n${tier.name} ${tier.key} ${tier.w}×${tier.h}（留 ${Math.round(tier.keepRatio * 100)}% 的数字，黑格约 ${Math.round((tier.blackRatio || 0.3) * 100)}%，目标分 ${tier.band[0]}–${tier.band[1]}）`);
  console.log(`    出货成功率 ${accepted}/${N}，命中目标区间 ${inBand}/${accepted}，平均每局抽 ${(drawn / Math.max(1, accepted)).toFixed(1)} 次，耗时 ${(ms / Math.max(1, N)).toFixed(1)} ms/局`);
  line('分数', scores, (v) => (v || 0).toFixed(1));
  line('推理步数', steps);
  line('留下的数字', clues, (v) => `${v}/${cells}`);
  console.log(`    推不出来的盘 ${unsolvable}`);
  ladder.push({ label: `${tier.name} ${tier.w}×${tier.h}`, median: q(scores.slice().sort((a, b) => a - b), 0.5) || 0, inBand, accepted });
  worst = Math.max(worst, ms / Math.max(1, N));
}

// The ladder is the product promise: 初学 must read easier than 大师, and a tier that never lands
// in its own band means the band is decoration.
console.log('\n== 档位阶梯（中位分数必须单调，命中率不能是个位数）==');
let mono = true;
{
  let prev = -Infinity;
  for (const l of ladder) {
    const okScore = l.median > prev;
    const okHit = l.accepted === 0 || l.inBand / l.accepted >= 0.8;
    if (!okScore || !okHit) mono = false;
    console.log(`  ${okScore && okHit ? '✓' : '✗'} ${l.label} 中位 ${l.median.toFixed(1)}  命中区间 ${l.inBand}/${l.accepted}`);
    prev = l.median;
  }
  console.log(mono ? '  阶梯成立' : '  阶梯不成立：band 需要重测');
}

// Cross-check: the pencil solver says "one solution, reachable by pencil"; the exhaustive counter is
// allowed to disagree and must not. A capped budget counts as "unverified", never as "ok" — which
// is why 大师 is not sampled here and why skipping a board fails the build instead of passing it.
console.log('\n== 独立计数复核（穷举解数，并逐格比对答案）==');
let checked = 0;
let bad = 0;
let skipped = 0;
for (const tier of TIERS.slice(0, 4)) {
  for (let s = 0; s < 4; s++) {
    const p = makePuzzle(`cross|${s}`, tier.key);
    if (!p) continue;
    const c = countSolutions(p.board, { cap: 2, budget: 400000 });
    if (c.status === 'OVERBUDGET') {
      skipped++;
      console.log(`  ✗ ${tier.name} seed ${s}: 穷举超出 ${400000} 节点预算，这一局的唯一性没被独立核过`);
      continue;
    }
    checked++;
    if (c.status !== UNIQUE) {
      bad++;
      console.log(`  ✗ ${tier.name} seed ${s}: 穷举解数 ${c.solutions}（${c.status}），而铅笔求解器判定可推完`);
      continue;
    }
    const mine = Array.from(solve(p.board).derived).join(',');
    if (Array.from(c.first).join(',') !== mine) {
      bad++;
      console.log(`  ✗ ${tier.name} seed ${s}: 两套实现给出的解答不是同一盘`);
    }
  }
}
console.log(`  ${checked - bad}/${checked} 局穷举复核与铅笔判定一致（含逐格解答比对），超预算未核 ${skipped} 局`);

// A second, independent read on the score: re-solving the accepted board must reproduce it, or the
// score is a property of the generator's state and not of the board — and the save file redraws
// boards from a seed, so a drifting score would move the stars under the player's feet.
console.log('\n== 复解一致（同一块盘重跑一次必须同分）==');
{
  let drift = 0;
  for (const tier of TIERS) {
    const p = makePuzzle(`drift|1`, tier.key);
    if (!p) continue;
    const again = solve(p.board);
    if (!again.ok || again.score !== p.score || again.steps !== p.steps) {
      drift++;
      console.log(`  ✗ ${tier.name} 复解不一致`, again.ok, again.score, p.score, again.steps, p.steps);
    }
    const reread = solve(createBoard({ w: tier.w, h: tier.h, clue: Int8Array.from(p.board.clue) }));
    if (reread.score !== p.score) {
      drift++;
      console.log(`  ✗ ${tier.name} 从存档字段重绘后换了分数`, reread.score, p.score);
    }
  }
  console.log(`  复解一致：${TIERS.length - drift}/${TIERS.length} 档`);
}

// The generator plants a solution and then removes numbers. Whatever it produces must still pass
// the check that has nothing to do with how it was built — and the planted answer must be that one.
console.log('\n== 出题器种下的解，与验收器认的解 ==');
{
  let total = 0;
  let broken = 0;
  for (let s = 0; s < 60; s++) {
    const tier = TIERS[s % TIERS.length];
    const r = ((seed) => {
      let x = seed >>> 0 || 11;
      return () => {
        x ^= (x << 13); x >>>= 0; x ^= x >> 17; x ^= (x << 5); x >>>= 0;
        return x / 4294967296;
      };
    })(90000 + s);
    const sol = randomSolution(tier.w, tier.h, r, tier.blackRatio || 0.3);
    const full = createBoard({ w: tier.w, h: tier.h, clue: cluesFrom(tier.w, tier.h, sol) });
    const b = createBoard({ w: tier.w, h: tier.h, clue: pruneClues(full, r, Math.round(tier.w * tier.h * tier.keepRatio)) });
    total++;
    const errs = verify(b, sol);
    if (errs.length || !complete(b, sol)) {
      broken++;
      if (broken <= 3) console.log(`  ✗ ${tier.name} 种下的解没通过验收`, errs.slice(0, 2));
    }
  }
  console.log(`  种解合法：${total - broken}/${total}`);
}

console.log(`\n最慢档位 ${worst.toFixed(1)} ms/局`);
process.exit(mono && bad === 0 && skipped === 0 ? 0 : 1);
