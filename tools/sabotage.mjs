// 破坏试验台账（仓里被追踪的那一份）：把每一类谎各写回去一遍，看文档闸会不会**点名**变红。
//
// 用法：node tools/sabotage.mjs            跑全部刀
//       node tools/sabotage.mjs S1 S3      只跑点名的几把（调试用；台账要的是整跑）
//
// 为什么要有这个文件：`node tools/doctest.mjs` 报 133 项全绿，只说明"这一轮文档没漂"，
// 它没说**这把闸会不会红**。一把从没红过的闸和一把没接线的闸，输出是一模一样的。
// 机制照 z-biz-game-kurotto-cos/tools/sabotage.mjs：内置几把刀，每把做一个最小扰动，
// 跑目标闸，断言必须看到**预期的那一条 FAIL 行**（不是"rc 非 0"就行）；任何一把刀没能把闸
// 弄红并且点名，就整体判红并说出是哪一把。
//
// 与 kurotto 那一份的唯一差别（共享工作区逼出来的）：
//   * 刀**只打在临时副本上**（工作区根的 _tmp-kuromasu-sab-*，跑完即删）。真文件一个字节都不改，
//     所以也不需要 git checkout / stash / restore 去擦自己留下的痕迹——那些操作在共享工作区里
//     会把别人正在写的东西抹掉，是硬规矩禁止的。
//   * 因此这里额外跑一次"不带刀的副本"作对照：它必须全绿。这一条排掉了一个最省事的假红——
//     "红是复制这件事本身造出来的"。副本不绿，后面每一把刀的"红"都不作数，直接停。
//
// 四条规矩（继承 kurotto）：
//   1. 工作树必须干净：刀打在定稿的那一份上，否则台账记的是"某个半成品世界里的红"。
//   2. 针必须唯一命中：0 次或 >1 次都是 ERROR——"打不中却一声不响跑完"是台账最坏的失败。
//   3. rc != 0 **且**输出里真有那一条预期的 FAIL 行（连明细一起对上）才算红；语法炸了也是
//      rc != 0，但那不是闸红。
//   4. 期望点名的那一节（D1c / D2c / D6g）必须真的写在 doctest.mjs 里：断言被改名或被删掉，
//      台账会红在这里，而不是红在"永远等不到的那行输出"上。
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WS = join(ROOT, '..');                       // 共享工作区根：副本与日志放这里，不进仓
const TMP = join(WS, '_tmp-kuromasu-sab');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const die = msg => { console.log(`  ERROR ${msg}`); process.exit(2); };

// ---- 刀（台账本身）：where 是这一刀要证明"哪一侧漂了会被抓到" ----
const KNIVES = [
  {
    id: 'S1', where: '文档侧 · README 档位表把 keepRatio 印错',
    file: 'README.md',
    needle: '| 大师 | 10×10 | 28%（黑格 32%） |',
    repl: '| 大师 | 10×10 | 30%（黑格 32%） |',
    expect: 'D1c 大师 留 28% 的数字 == keepRatio 现值',
    detail: '文档 30% vs 代码 28%',
    why: '这一把钉的是"文档单方面改数字"：代码没动，文档的 28% 变 30%。',
  },
  {
    id: 'S2', where: '文档侧 · README 规则表把权重印错',
    file: 'README.md',
    needle: '| 白不断路 | 一涂黑就把白格劈成两截的那一格，必须是白格 | 2.5 |',
    repl: '| 白不断路 | 一涂黑就把白格劈成两截的那一格，必须是白格 | 3 |',
    expect: 'D2c 白不断路 的权重 2.5 == Rules.island.weight 现值',
    detail: 'README 3 /',
    why: '两张规则表（README 与 DESIGN）里只改一张：D2c 看的是"两张表都要等于代码"。',
  },
  {
    id: 'S3', where: '代码侧 · 规则的权重被改了，文档没跟',
    file: 'js/engine/kuromasu.js',
    needle: 'weight: 2.5,',
    repl: 'weight: 3,',
    expect: 'D2c 白不断路 的权重 3 == Rules.island.weight 现值',
    detail: 'README 2.5',
    why: '与 S2 同一条断言、相反的一侧：这里标签里的数跟着代码变成 3，明细里 README 仍是 2.5。 ' +
      '只盯标签分不出是哪一侧漂的，所以明细也要对上。',
  },
  {
    id: 'S4', where: '代码侧 · 生成器的默认抽盘次数被改了',
    file: 'js/engine/generate.js',
    needle: 'tries = 24,',
    repl: 'tries = 25,',
    expect: 'D6g DESIGN 的 tries=25 == generate 的默认抽盘次数',
    detail: '文档 24 vs 代码 25',
    why: '生成器的常数不是"实现细节"：DESIGN 印的是它的现在值，改默认就得同时改文档。',
  },
];

const only = process.argv.slice(2);
const picked = only.length ? KNIVES.filter(k => only.includes(k.id)) : KNIVES;
if (only.length && picked.length !== only.length) {
  die(`点名的刀有几把不在台账上：${only.filter(x => !picked.some(k => k.id === x)).join(' ')}`);
}
if (!picked.length) die('台账上一把刀都没选中');

// ---- 预检 ----
const dirty = (spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout || '').trim();
if (dirty) die(`工作树不干净，刀不能打在半成品上（先 commit 或先把这些挪开）：\n${dirty}`);
const DOCTEST = read('tools/doctest.mjs');
const hits = (src, needle) => {
  let n = 0;
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) n++;
  return n;
};
for (const k of picked) {
  let src;
  try { src = read(k.file); } catch { die(`${k.id} 的文件不存在：${k.file}`); }
  const n = hits(src, k.needle);
  if (n !== 1) die(`${k.id} 的针在 ${k.file} 里命中 ${n} 次（必须恰好 1 次；打不中或打多了都不许跑）`);
  if (k.repl === k.needle) die(`${k.id} 的 repl 与 needle 相同，这一刀不会改变任何东西`);
  const id = k.expect.split(' ')[0];
  if (!new RegExp('[`\'\)]' + id.replace('$', '\\$') + '[ $]').test(DOCTEST) && !DOCTEST.includes(id + ' ')) {
    die(`${k.id} 期望点名的「${id}」在 tools/doctest.mjs 里找不到——断言被改名或删掉了，台账不许假装跑过`);
  }
  console.log(`  预检 ${k.id} · ${k.file} 针唯一命中 · 期望点名「${k.expect}」`);
}

// ---- 临时副本：整棵树（去掉 .git / node_modules / 缓存 / 别人的 _tmp），刀只打在副本里 ----
const EXCLUDE = /(^|\/)(\.git|node_modules|_site|dist|_tmp-[^/]*|\.electron-cache)(\/|$)/;
const copyRepo = dst => {
  rmSync(dst, { recursive: true, force: true });
  cpSync(ROOT, dst, {
    recursive: true,
    filter: src => !EXCLUDE.test(relative(ROOT, src) || '.'),
  });
};
const sh = (cmd, args, cwd, timeout = 600000) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout });
  const out = (r.stdout || '') + (r.stderr || '');
  return { rc: r.status === null ? -1 : r.status, out, timedOut: !!r.error && r.error.code === 'ETIMEDOUT' };
};

mkdirSync(TMP, { recursive: true });
const log = (name, body) => writeFileSync(join(WS, `_tmp-kuromasu-sab-${name}.log`), body);

// ---- 对照：不带任何刀的副本必须先全绿，否则后面每一把"红"都可能是复制造出来的 ----
const ctlDir = join(TMP, 'control');
copyRepo(ctlDir);
const ctl = sh(process.execPath, ['tools/doctest.mjs'], ctlDir);
log('control', ctl.out);
const ctlRows = (ctl.out.match(/^rows: (\d+) fail: (\d+)/m) || [])[0];
if (ctl.rc !== 0 || !/^rows: \d+ fail: 0$/m.test(ctl.out)) {
  die(`不带刀的副本里 doctest 竟然不绿（rc=${ctl.rc}，${ctlRows || '没有 rows: 那行'}）：` +
    `先把这一条解释清楚，否则后面每一把刀的红都不作数（详见 _tmp-kuromasu-sab-control.log）`);
}
console.log(`  对照 · 无刀副本 doctest rc=0 ${ctlRows}（红不是复制造出来的）`);
const baselineRows = +ctlRows.match(/(\d+)/)[1];

const results = [];
for (const k of picked) {
  const dir = join(TMP, k.id);
  copyRepo(dir);
  const p = join(dir, k.file);
  const src = readFileSync(p, 'utf8');
  if (hits(src, k.needle) !== 1) { die(`${k.id} 落刀前副本里的针命中数不是 1（复制没抄全？）`); }
  writeFileSync(p, src.replace(k.needle, k.repl));
  const r = sh(process.execPath, ['tools/doctest.mjs'], dir);
  // 只 rc != 0 不算红：点名的那一行必须是**红行**（FAIL / 未过），而且明细也要对上，
  // 否则"标签被抄在一条通过的断言上"就会被当成闸认出了这把刀。
  const named = r.out.split('\n').filter(l => /(FAIL|未过)/.test(l) && l.includes(k.expect) && l.includes(k.detail));
  const ranIt = /^rows: \d+ fail: [1-9]\d*$/m.test(r.out);   // 闸真的跑完了、而且判红了
  log(k.id, `knife ${k.id} · ${k.file}\n${k.needle}\n  -> ${k.repl}\nrc=${r.rc}\n${'='.repeat(60)}\n${r.out}`);
  const okKnife = r.rc !== 0 && named.length > 0 && ranIt && !r.timedOut;
  results.push({ id: k.id, rc: r.rc, named: named.length, ok: okKnife, timedOut: r.timedOut });
  console.log(`  ${okKnife ? '红得住' : '没红/没点名'} ${k.id} · ${k.where} · rc=${r.rc} 点名 ${named.length} 行`);
  for (const l of named.slice(0, 1)) console.log(`      ${l.trim()}`);
  if (r.timedOut) console.log('      （超时被掐：这不是闸红）');
  rmSync(dir, { recursive: true, force: true });   // 副本用完即删，仓外不留现场（日志除外）
}

const bad = results.filter(x => !x.ok);
if (bad.length) {
  die(`有 ${bad.length} 把刀没能把闸弄红并点名：${bad.map(x => `${x.id}(rc=${x.rc} 点名 ${x.named})`).join(' ')}` +
    `——这把闸是空转的，去看 _tmp-kuromasu-sab-<id>.log`);
}

// ---- 收尾：树仍然干净（刀从没碰过真文件，这一条是这件事的凭证），并且闸本身还是绿的 ----
const stillDirty = (spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout || '').trim();
if (stillDirty) die(`跑完刀之后工作树脏了（刀不该碰过真文件）：\n${stillDirty}`);
const eng = sh(process.execPath, ['tools/engine-test.mjs'], ctlDir);
log('engine-control', eng.out);
if (eng.rc !== 0) die(`对照跑 engine-test 红了（rc=${eng.rc}）：刀之外还有东西坏着，先看 _tmp-kuromasu-sab-engine-control.log`);
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${picked.length} 把刀全部把闸弄红并且点到了名；无刀副本 doctest ${baselineRows} 行 fail:0；真树 rc 全程 0 未改（git status 干净）。`);
if (only.length) console.log('（这是点名的调试跑：台账要的是不带参数的整跑。）');
console.log('反空转：任何一把刀没红 → 本脚本 rc=2 并点名是哪一把；无刀副本不绿 → 同样 rc=2 并停在这里。');
process.exit(0);
