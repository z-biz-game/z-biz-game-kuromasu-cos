// 文档是被断言的面：README / DESIGN 里印出去的每一个「现值」都必须等于代码或脚本里的现在值。
//
// 为什么要有这个文件：引擎断言归 engine-test，浏览器断言归 verify.sh，阶梯归 balance，而散文谁都不归。
// 它可以一直抄下去，直到某天代码改了字、文档还在引用上一个世界的数——本仓现在就抄错了两处：
// README 的规模行写着「5 个验证脚本 / 2,363 行」（tools/ 实测 2,394 行），DESIGN §4 写着「前三条只数
// 一条视线」（规则表里那样的只有四条）。这里把它们钉住。
//
// 规矩（和 balance.mjs 的阶梯门禁一样）：
//   * 每一条等式都配一条「解析到的条数」的反空转断言——正则没命中不是绿，是红；
//   * 只比现值，不复测读数：ms、实测中位、命中数、抽几次、像素差这类本机测量在这里只作为
//     「文档写的数与代码里的分母/界」的关系出现（D6、D8），这里不重跑它们（重跑归 balance）；
//   * 文档改形状（表格列、句子措辞、引用格式）不是通过的理由：解析不到就是红。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TIERS, generate } from '../js/engine/generate.js';
import { Rules, OPEN, BLACK, WHITE, NO_CLUE } from '../js/engine/kuromasu.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const fail = [];
const emitted = new Set();
let rows = 0;
const ok = (cond, label, detail) => {
  rows++;
  emitted.add(label.match(/^D\d+/)[0]);
  if (!cond) fail.push(label);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label} · ${detail}`);
};
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const nlines = t => (t.endsWith('\n') ? t.split('\n').length - 1 : t.split('\n').length);

const README = read('README.md');
const DESIGN = read('DESIGN.md');
const DOCS = README + '\n' + DESIGN;
const PKG = JSON.parse(read('package.json'));
const CI = read('.github/workflows/ci.yml');
const VERIFY = read('tools/verify.sh');
const BAL = read('tools/balance.mjs');
const ENGTEST = read('tools/engine-test.mjs');
const SCEN = read('tools/scenarios.js');
const KUROMASU = read('js/engine/kuromasu.js');
const COUNT = read('js/engine/count.js');
const GENERATE = read('js/engine/generate.js');
const STORE = read('js/store.js');
const MAIN = read('js/main.js');
const HTML = read('index.html');

// ---- D1 难度表：README 那张表的每一格，凡是有代码出处的都必须是现值 ----
// 五列有出处（档名、尺寸、留数字的百分比、黑格百分比、分数带），三列是实测（中位、命中、耗时）。
// 实测那三列在这里只钉形状与分母（D6），值本身不在这里复测。
const tierRowRe = /^\| (初学|上手|熟练|高阶|大师) \| (\d+)×(\d+) \| (\d+)%(?:（黑格 (\d+)%）)? \| (\d+)–(\d+) \| ([\d.]+) \| (\d+)\/(\d+) \| ([\d.]+) \| ([\d.]+) ms \|$/gm;
const tierRows = [...README.matchAll(tierRowRe)];
ok(tierRows.length === TIERS.length, `D1a README 的档位表解析到 ${TIERS.length} 行（解析不到不等于通过）`,
  `解析 ${tierRows.length} 行 vs TIERS ${TIERS.length} 档`);
for (const t of TIERS) {
  const row = tierRows.find(m => m[1] === t.name);
  const at = row ? `文档 | ${row[1]} | ${row[2]}×${row[3]} |` : '文档里没有这一档';
  ok(!!row, `D1 ${t.name} 那一行在文档的档位表里`, at);
  ok(!!row && +row[2] === t.w && +row[3] === t.h, `D1b ${t.name} 的盘面 ${t.w}×${t.h} == TIERS 现值`,
    row ? `文档 ${row[2]}×${row[3]} vs 代码 ${t.w}×${t.h}` : at);
  ok(!!row && +row[4] === Math.round(t.keepRatio * 100), `D1c ${t.name} 留 ${Math.round(t.keepRatio * 100)}% 的数字 == keepRatio 现值`,
    row ? `文档 ${row[4]}% vs 代码 ${Math.round(t.keepRatio * 100)}%` : at);
  ok(!!row && (row[5] === undefined ? t.blackRatio === TIERS[0].blackRatio : +row[5] === Math.round(t.blackRatio * 100)),
    `D1d ${t.name} 的黑格比例：文档印了那一格就用印的，没印就必须是各档共用的那个默认`,
    row ? `文档 ${row[5] === undefined ? '未印（共用默认 ' + Math.round(TIERS[0].blackRatio * 100) + '%）' : row[5] + '%'} vs 代码 ${Math.round(t.blackRatio * 100)}%` : at);
  ok(!!row && +row[6] === t.band[0] && +row[7] === t.band[1], `D1e ${t.name} 的分数带 ${t.band[0]}–${t.band[1]} == TIERS.band 现值`,
    row ? `文档 ${row[6]}–${row[7]} vs 代码 ${t.band.join('–')}` : at);
}
const ladderClaim = DOCS.match(/`初学 → 大师` ([一二三四五六七八九十])档/);
const unsolvableClaim = DOCS.match(/([一二三四五六七八九十])档「推不出来的盘」/);
ok(!!ladderClaim && !!unsolvableClaim && CN[ladderClaim[1]] === TIERS.length && CN[unsolvableClaim[1]] === TIERS.length,
  `D1f 文档两处「N 档」都等于 TIERS 的 ${TIERS.length} 档`,
  `解析 ${[ladderClaim?.[1], unsolvableClaim?.[1]].join(' / ') || '没有'} vs 代码 ${TIERS.length}`);
const masterDoc = DESIGN.match(/大师档 ([\d×/ ]+) \/ 留 (\d+)% 数字/);
ok(!!masterDoc && masterDoc[1].trim() === `${TIERS[TIERS.length - 1].w}×${TIERS[TIERS.length - 1].h}` &&
  +masterDoc[2] === Math.round(TIERS[TIERS.length - 1].keepRatio * 100),
  'D1g DESIGN §11 那句「大师档停在 10×10 / 留 28%」等于 TIERS 最后一档',
  masterDoc ? `文档 ${masterDoc[1].trim()} / ${masterDoc[2]}% vs 代码 ${TIERS[4].w}×${TIERS[4].h} / ${Math.round(TIERS[4].keepRatio * 100)}%` : '解析不到那句');
const hintBudget = DESIGN.match(/所以 ([\d]+×[\d]+) 一路提示到底要 (\d+) 次/);
ok(!!hintBudget && hintBudget[1] === `${TIERS[4].w}×${TIERS[4].h}` && +hintBudget[2] === TIERS[4].w * TIERS[4].h,
  `D1h 「一路提示到底要 100 次」== 大师档格数 ${TIERS[4].w * TIERS[4].h}`,
  hintBudget ? `文档 ${hintBudget[1]} → ${hintBudget[2]} 次 vs 格数 ${TIERS[4].w * TIERS[4].h}` : '解析不到那句');

// ---- D2 五条规则：两份文档的表 + 页面 + 实现，名字与权重必须是同一份 ----
const ruleRowRe = /^\| (带字即白|黑不挨黑|已经看满|非看不可|白不断路) \| [^|]+ \| ([\d.]+) \|$/gm;
const docRuleRows = [...README.matchAll(ruleRowRe)];
const designRuleRows = [...DESIGN.matchAll(ruleRowRe)];
const ruleNames = Object.values(Rules).map(r => r.name);
ok(docRuleRows.length === ruleNames.length && designRuleRows.length === ruleNames.length,
  `D2a 两份文档的规则表各解析到 ${ruleNames.length} 行`,
  `README ${docRuleRows.length} 行 · DESIGN ${designRuleRows.length} 行 vs Rules ${ruleNames.length} 条`);
ok(docRuleRows.map(m => m[1]).join('|') === designRuleRows.map(m => m[1]).join('|'),
  'D2b README 与 DESIGN 的规则顺序逐条相同（两张表各漂各的就没法对齐代码）',
  `README ${docRuleRows.map(m => m[1]).join(' ')} · DESIGN ${designRuleRows.map(m => m[1]).join(' ')}`);
for (const [i, key] of Object.keys(Rules).entries()) {
  const r = Rules[key];
  const inDocs = [docRuleRows, designRuleRows].map(rowsOf => rowsOf.find(m => m[1] === r.name));
  ok(inDocs.every(Boolean), `D2 ${r.name} 在两张规则表里都还在（Rules.${key}）`,
    inDocs.map((x, k) => `${k ? 'DESIGN' : 'README'} ${x ? '有' : '没有'}`).join(' · '));
  ok(inDocs.every(x => x && +x[2] === r.weight), `D2c ${r.name} 的权重 ${r.weight} == Rules.${key}.weight 现值`,
    inDocs.map((x, k) => `${k ? 'DESIGN' : 'README'} ${x ? x[2] : '?'}`).join(' / ') + ` vs 代码 ${r.weight}`);
  ok(ruleNames.filter(n => n === r.name).length === 1 && docRuleRows.filter(m => m[1] === r.name).length === 1,
    `D2d Rules.${key} 的名字「${r.name}」在实现与 README 表里都只有一份`,
    `Rules ${ruleNames.length} 条：${ruleNames.join(' ')} · 文档 ${docRuleRows.map(m => m[1]).join(' ')}`);
}
ok(designRuleRows[designRuleRows.length - 1]?.[1] === Rules.island.name,
  'D2e 「第五条看整块连通性」说的就是白不断路（两张表的最后一行）',
  `DESIGN 最后一行是 ${designRuleRows[designRuleRows.length - 1]?.[1] || '解析不到'}`);
ok(docRuleRows.map(m => m[1]).sort().join('|') === ruleNames.slice().sort().join('|'),
  'D2d2 文档表里的规则名与 Rules 里的名字一一对应，谁也不能单方面多一条或少一条',
  `代码 ${ruleNames.join(' ')} vs 文档 ${docRuleRows.map(m => m[1]).join(' ')}`);
const ruleCountClaims = [...DOCS.matchAll(/([一二三四五六七八九十])条(?:命名)?规则/g)].map(m => CN[m[1]]);
ok(ruleCountClaims.length >= 3 && ruleCountClaims.every(v => v === ruleNames.length),
  `D2f 文档里所有「N 条规则」都是 ${ruleNames.length} 条`, `解析 ${ruleCountClaims.join(' ') || '没有'} vs 代码 ${ruleNames.length}`);
const frontClaims = [...DOCS.matchAll(/前([一二三四五六七八九十])条/g)].map(m => ({ w: m[1], n: CN[m[1]] }));
ok(frontClaims.length === 2 && frontClaims.every(x => x.n === ruleNames.length - 1),
  `D2g 「前 N 条只数一条视线或一个黑格自己的账」的 N == 规则数 - 1 == ${ruleNames.length - 1}（最后一条才是看整块的那条）`,
  `解析 ${frontClaims.length} 处：${frontClaims.map(x => `${x.w}条`).join(' / ')} vs 代码 ${ruleNames.length - 1}`);
const scenRuleCount = SCEN.match(/eq\('规则表里有([一二三四五六七八九十])条', Object\.keys\(en\.Rules\)\.length, (\d+)\)/);
ok(!!scenRuleCount && CN[scenRuleCount[1]] === ruleNames.length && +scenRuleCount[2] === ruleNames.length,
  `D2h 浏览器场景里那句「规则表里有五条」的字面量也等于 Rules 的条数`,
  scenRuleCount ? `场景写 ${scenRuleCount[1]}条 / want ${scenRuleCount[2]} vs 代码 ${ruleNames.length}` : '解析不到那条断言');
const citedRules = (README.match(/cited: \[([^\]]*)\]/) || [])[1];
ok(!!citedRules && citedRules.split(/,\s*/).every(n => ruleNames.includes(n)),
  'D2i README 的 hint 报告里点名的规则名都在 Rules 里',
  citedRules ? `文档 ${citedRules} ` : '解析不到 cited 那一列');

// ---- D3 门禁的条数：Node 那一个现跑一次拿真值，浏览器那一组只能钉自洽 ----
const engProbe = spawnSync(process.execPath, [join(ROOT, 'tools/engine-test.mjs')], { cwd: ROOT, encoding: 'utf8' });
const engCount = ((engProbe.stdout || '').match(/(\d+) 通过 \/ (\d+) 失败/) || [])[1];
ok(!!engCount && engProbe.status !== null, 'D3a engine-test 跑起来了并打印了条数（探针哑了就不是绿）',
  engCount ? `engine-test 报 ${engCount} 通过 / ${engProbe.status}` : `探针无输出（status ${engProbe.status}）`);
const engClaims = [
  ...[...DOCS.matchAll(/(\d+) 项 Node 断言/g)].map(m => +m[1]),
  ...[...DOCS.matchAll(/(\d+) 项引擎断言/g)].map(m => +m[1]),
  ...[...DOCS.matchAll(/引擎断言 (\d+) 项/g)].map(m => +m[1]),
];
ok(engClaims.length >= 3 && engClaims.every(v => v === +engCount),
  `D3 文档里每一个「引擎断言 N 项」都等于 engine-test 现在跑的 ${engCount} 项`,
  `解析 ${engClaims.join(' / ') || '没有'} vs 现跑 ${engCount}`);
const verifyRows = [...README.matchAll(/^=== (\w+) ===\s+(\d+) checks, (\d+) failed(?:\s+(\{.*\}))?$/gm)];
const scenList = ((VERIFY.match(/for s in \$\{SCENARIOS:-([^}]*)\}/) || [, ''])[1]).trim().split(/\s+/);
ok(verifyRows.length === scenList.length && verifyRows.length >= 10,
  `D3b README 的 verify 输出块与 verify.sh 的场景清单都解析到了（${verifyRows.length} 行 / ${scenList.length} 个场景）`,
  `文档 ${verifyRows.map(m => m[1]).join(' ')} vs 脚本 ${scenList.join(' ')}`);
ok(verifyRows.map(m => m[1]).join(' ') === scenList.join(' '),
  'D3c README 抄的场景名与顺序逐字等于 verify.sh 的默认清单',
  `文档 ${verifyRows.map(m => m[1]).join(' ')} vs 脚本 ${scenList.join(' ')}`);
ok(verifyRows.every(m => +m[3] === 0), 'D3d 文档那份输出里每一行的 failed 都是 0（抄一份红的日志进 README 就是文档在教人接受红）',
  verifyRows.map(m => `${m[1]} ${m[3]}`).join(' '));
const browserSum = verifyRows.reduce((a, m) => a + +m[2], 0);
const browserClaims = [...DOCS.matchAll(/([0-9一二三四五六七八九十]+) 项(?:浏览器)?断言/g)]
  .map(m => CN[m[1]] || +m[1]).filter(v => v > 200);
const ciBrowser = (CI.match(/(\d+) 项浏览器断言（(\d+) 个场景/) || []);
const scenCountClaims = [...DOCS.matchAll(/([一二三四五六七八九十\d]+) 个(?:浏览器)?场景/g)].map(m => CN[m[1]] || +m[1]);
ok(browserClaims.length >= 2 && browserClaims.every(v => v === browserSum),
  `D3e 文档里每个浏览器断言总数都等于自己那张逐场景表的和（${browserSum}）`,
  `解析 ${browserClaims.join(' / ') || '没有'} vs 表和 ${browserSum}`);
ok(!!ciBrowser && +ciBrowser[1] === browserSum, 'D3f ci.yml 注释里那句浏览器条数也等于文档那张表的和',
  ciBrowser ? `CI ${ciBrowser[1]} vs 表和 ${browserSum}` : '解析不到 CI 那句');
ok(scenCountClaims.length >= 3 && scenCountClaims.every(v => v === scenList.length),
  `D3g 文档里所有「N 个场景」都等于 verify.sh 清单的 ${scenList.length} 个`,
  `解析 ${scenCountClaims.join(' / ') || '没有'} vs 脚本 ${scenList.length}`);
const mediansDoc = (README.match(/medians: \[([^\]]*)\]/) || [])[1];
ok(!!mediansDoc && mediansDoc.split(/,\s*/).length === TIERS.length,
  `D3h gen 那行的 medians 数组有 ${TIERS.length} 个中位（一档一个，缺档就是表少了一行）`,
  mediansDoc ? `文档 ${mediansDoc.split(/,\s*/).length} 个 vs ${TIERS.length} 档` : '解析不到 medians');

// ---- D4 端口与命令：文档那几处 == server.cjs / package.json / verify.sh 的现值 ----
const srvPort = (read('server.cjs').match(/\|\| (\d+);/) || [])[1];
const devPort = (PKG.scripts?.dev || '').match(/server\.cjs (\d+)/);
const httpDoc1 = (README.match(/http:\/\/127\.0\.0\.1:(\d+)/) || [])[1];
const httpDoc2 = (README.match(/本项目专用端口 (\d+)/) || []);
const pairDoc = README.match(/HTTP (\d+) \/ CDP (\d+) 是黑目的/);
const vHttp = VERIFY.match(/HTTP=\$\{HTTP_PORT:-(\d+)\}/);
const vCdp = VERIFY.match(/PORT=\$\{CDP_PORT:-(\d+)\}/);
const httpVals = [srvPort, devPort?.[1], vHttp?.[1], httpDoc1, httpDoc2?.[1]];
ok(httpVals.every(Boolean) && vCdp && pairDoc, 'D4a 五个 HTTP 端口来源与 CDP 那两处都解析到了（少一个就是接线改了形状）',
  `server ${srvPort} · package ${devPort?.[1]} · verify ${vHttp?.[1]}/${vCdp?.[1]} · 文档 ${httpDoc1}/${httpDoc2?.[1]} · ${pairDoc?.[0].slice(0, 24)}`);
ok(httpVals.every(v => +v === +httpDoc1) && +pairDoc?.[1] === +httpDoc1,
  `D4 HTTP 端口五处一致且等于文档（${httpVals.join('/')}）`, `文档 ${httpDoc1}`);
ok(!!vCdp && !!pairDoc && +vCdp[1] === +pairDoc[2] && +vCdp[1] !== +httpDoc1,
  `D4b CDP 端口 verify.sh 与文档一致（${vCdp?.[1]}），且不等于 HTTP 端口`,
  `verify ${vCdp?.[1]} vs 文档 ${pairDoc?.[2]}`);
const npmClaims = [...new Set([...DOCS.matchAll(/npm (start|test|run ([a-z]+))/g)].map(m => m[2] || m[1]))];
const startClaim = [...README.matchAll(/^npm (start|test|run ([a-z]+))/gm)].map(m => m[2] || m[1]);
ok(startClaim.length >= 5 && startClaim.every(c => PKG.scripts[c]),
  `D4c README 命令块里的 ${startClaim.length} 条 npm 命令都真是 package.json 的脚本`,
  `解析 ${startClaim.join(' ')} · 缺：${startClaim.filter(c => !PKG.scripts[c]).join(' ') || '没有'}`);
ok(npmClaims.includes('doctest') && npmClaims.every(c => PKG.scripts[c]),
  `D4d 正文点名的 npm 脚本（含新增的 doctest）都在 package.json 里`,
  `点名 ${npmClaims.join(' ')} · 缺：${npmClaims.filter(c => !PKG.scripts[c]).join(' ') || '没有'}`);

// ---- D5 规模行：文档抄的文件数与行数 == 现在树里的文件数与行数 ----
const jsFiles = readdirSync(join(ROOT, 'js'), { recursive: true }).filter(p => String(p).endsWith('.js')).map(String);
const toolsFiles = readdirSync(join(ROOT, 'tools')).filter(p => !p.startsWith('.'));
const lineFiles = ['css/game.css', 'index.html'];
const scaleDoc = README.match(/(\d+) 个 ES Module \/ ([\d,]+) 行 JS \+ (\d+) 个验证脚本 \/ ([\d,]+) 行 \+ ([\d,]+) 行 CSS\/HTML，\*\*运行时依赖 (\d+) 个\*\*/);
const num = s => +String(s).replace(/,/g, '');
const jsLines = jsFiles.reduce((a, f) => a + nlines(read(join('js', f))), 0);
const toolLines = toolsFiles.reduce((a, f) => a + nlines(read(join('tools', f))), 0);
const cssLines = lineFiles.reduce((a, f) => a + nlines(read(f)), 0);
ok(!!scaleDoc, 'D5a README 的规模那一行解析到了六个数', scaleDoc ? `文档 ${scaleDoc.slice(1).join(' / ')}` : '解析不到这一行');
ok(!!scaleDoc && +scaleDoc[1] === jsFiles.length, `D5b ES Module 数 == js/ 下的 .js 文件数（${jsFiles.length}）`,
  scaleDoc ? `文档 ${scaleDoc[1]} vs 树里 ${jsFiles.length}` : '解析不到');
ok(!!scaleDoc && num(scaleDoc[2]) === jsLines, `D5c JS 行数 == 这 ${jsFiles.length} 个文件的行数（${jsLines}）`,
  scaleDoc ? `文档 ${scaleDoc[2]} vs 实算 ${jsLines}` : '解析不到');
ok(!!scaleDoc && +scaleDoc[3] === toolsFiles.length, `D5d 验证脚本数 == tools/ 下的文件数（${toolsFiles.length}：${toolsFiles.join(' ')}）`,
  scaleDoc ? `文档 ${scaleDoc[3]} vs 树里 ${toolsFiles.length}` : '解析不到');
ok(!!scaleDoc && num(scaleDoc[4]) === toolLines, `D5e 验证脚本行数 == tools/ 现在的行数（${toolLines}）`,
  scaleDoc ? `文档 ${scaleDoc[4]} vs 实算 ${toolLines}` : '解析不到');
ok(!!scaleDoc && num(scaleDoc[5]) === cssLines, `D5f CSS/HTML 行数 == css/game.css + index.html（${cssLines}）`,
  scaleDoc ? `文档 ${scaleDoc[5]} vs 实算 ${cssLines}` : '解析不到');
const runtimeDeps = Object.keys(PKG.dependencies || {}).length;
ok(!!scaleDoc && +scaleDoc[6] === runtimeDeps, `D5g 运行时依赖数 == package.json 的 dependencies（${runtimeDeps}）`,
  scaleDoc ? `文档 ${scaleDoc[6]} vs 代码 ${runtimeDeps}` : '解析不到');

// ---- D6 balance 台账：文档写的分母 == 脚本的循环次数；分子（实测值）不在这里复测 ----
const balDefault = (BAL.match(/process\.env\.SAMPLES \|\| (\d+)/) || [])[1];
const samplesClaims = [...DOCS.matchAll(/SAMPLES=(\d+)/g)].map(m => +m[1]);
ok(!!balDefault && samplesClaims.length >= 2 && samplesClaims.every(v => v === +balDefault),
  `D6a 文档里每处 SAMPLES=N 都等于 balance 不设 env 的默认（${balDefault}）`,
  `文档 ${samplesClaims.join(' / ') || '没有'} vs 脚本 ${balDefault}`);
const hitDenoms = [...new Set(tierRows.map(m => +m[10]))];
ok(hitDenoms.length === 1 && +hitDenoms[0] === +balDefault,
  `D6b 档位表「命中区间」那一列的分母全是样本数 ${balDefault}（分子 40 是实测，这里不复测）`,
  `文档分母 ${hitDenoms.join('/')} vs 默认样本 ${balDefault}`);
const crossDoc = DOCS.match(/穷举复核 ([\d,]+)\/(\d+)/);
const crossLoop = BAL.match(/for \(const tier of TIERS\.slice\(0, (\d+)\)[\s\S]*?for \(let s = 0; s < (\d+); s\+\+\)/);
ok(!!crossDoc && !!crossLoop && +crossDoc[2] === +crossLoop[1] * +crossLoop[2],
  `D6c 「穷举复核 N/N」的分母 == balance 的复核循环次数（slice ${crossLoop?.[1]} × ${crossLoop?.[2]}）`,
  crossDoc && crossLoop ? `文档 ${crossDoc[2]} vs 脚本 ${+crossLoop[1] * +crossLoop[2]}（分子 ${crossDoc[1]} 是这次跑出来的，不在这里复算）` : `解析：文档 ${crossDoc?.[0] || '无'} / 脚本 ${crossLoop ? '在' : '无'}`);
const driftDoc = DOCS.match(/重跑同分 (\d+)\/(\d+)/);
const seedDoc = DOCS.match(/种下的解 (\d+)\/(\d+)/);
const seedLoop = (BAL.match(/for \(let s = 0; s < (\d+); s\+\+\)\s*\{\s*const tier = TIERS\[s % TIERS\.length\]/) || [])[1];
ok(!!driftDoc && +driftDoc[2] === TIERS.length, `D6d 「重跑同分 5/5」的分母 == TIERS 档数（balance 按档报）`,
  driftDoc ? `文档 ${driftDoc[2]} vs ${TIERS.length}` : '解析不到那句');
ok(!!seedDoc && !!seedLoop && +seedDoc[2] === +seedLoop, `D6e 「种下的解 60/60」的分母 == balance 的种解循环次数`,
  seedDoc && seedLoop ? `文档 ${seedDoc[2]} vs 脚本 ${seedLoop}` : `解析：文档 ${seedDoc?.[0] || '无'} / 脚本 ${seedLoop || '无'}`);
ok(!!driftDoc && !!seedDoc && +driftDoc[1] === +driftDoc[2] && +seedDoc[1] === +seedDoc[2],
  'D6f 这两句的分子等于分母：文档记的是一次全绿的运行，不是「大约」',
  driftDoc && seedDoc ? `同分 ${driftDoc[1]}/${driftDoc[2]} · 种解 ${seedDoc[1]}/${seedDoc[2]}` : '解析不到');
const triesDoc = DESIGN.match(/抽 `tries=(\d+)` 次/);
const triesCode = (GENERATE.match(/tries = (\d+),/) || [])[1];
ok(!!triesDoc && !!triesCode && +triesDoc[1] === +triesCode, `D6g DESIGN 的 tries=${triesCode} == generate 的默认抽盘次数`,
  triesDoc && triesCode ? `文档 ${triesDoc[1]} vs 代码 ${triesCode}` : `解析：文档 ${triesDoc?.[1] || '无'} / 代码 ${triesCode || '无'}`);
const genDefaults = generate.toString().match(/w = (\d+),\s*h = (\d+)/);
ok(!!genDefaults, 'D6h generate 的默认尺寸那两行解析到了（改了签名形状就要先看文档怎么跟着改）',
  genDefaults ? `w=${genDefaults[1]} h=${genDefaults[2]}` : '解析不到');

// ---- D7 像素取证的常数：文档说「采多少个点、几个算命中」== scenarios.js 现在的那几个数 ----
const ringBody = SCEN.slice(SCEN.indexOf('function ringCount'), SCEN.indexOf('const median'));
const ringN = (ringBody.match(/for \(let a = 0; a < (\d+); a\+\+\)/) || [])[1];
const ringTh = [...SCEN.matchAll(/ringCount\(.*>= (\d+), `命中/g)].map(m => +m[1]);
const ringDocClaims = [...DOCS.matchAll(/(?:数字环|数字半径)采 (\d+) 个点/g)].map(m => +m[1]);
const ringThDoc = [...DOCS.matchAll(/(?:至少|≥)\s?(\d+) 个落在/g)].map(m => +m[1]);
ok(!!ringN && ringDocClaims.length >= 2 && ringDocClaims.every(v => v === +ringN),
  `D7a 「沿数字环采 12 个点」== ringCount 的循环上限（${ringN}）`,
  `文档 ${ringDocClaims.join(' / ') || '没有'} vs 脚本 ${ringN}`);
ok(ringTh.length >= 3 && ringTh.every(v => v === Math.max(...ringTh)) && ringThDoc.length >= 2 && ringThDoc.every(v => v === ringTh[0]),
  `D7b 环的命中门槛 ${ringTh.join('/')} 全为同一个数，文档那两处「至少/≥ N 个」等于它`,
  `脚本 ${ringTh.join(' ')} · 文档 ${ringThDoc.join(' / ') || '没有'}`);
const accentBody = SCEN.slice(SCEN.indexOf('accentCount'), SCEN.indexOf('function edgeProfile'));
const accentSide = (accentBody.match(/for \(let i = 0; i <= (\d+); i\+\+\)/) || [])[1];
const accentPts = accentSide ? (+accentSide + 1) * 4 : 0;
const accentDoc = [...DOCS.matchAll(/采 (\d+) 个点找 accent/g)].map(m => +m[1]);
ok((accentBody.match(/pts\.push\(/g) || []).length === 4 && accentDoc.length === 1 && accentDoc[0] === accentPts,
  `D7c 「沿格子轮廓采 28 个点」== 每边 ${+accentSide + 1} 点 × 4 边（${accentPts}）`,
  accentDoc.length ? `文档 ${accentDoc[0]} vs 脚本 ${accentPts}` : '解析不到那句');
const edgeN = (SCEN.match(/function edgeProfile[\s\S]*?const N = (\d+);/) || [])[1];
const edgeDoc = [...DOCS.matchAll(/密采 (\d+) 个点|必须 (\d+) 点全中/g)].map(m => +(m[1] || m[2]));
ok(!!edgeN && edgeDoc.length >= 2 && edgeDoc.every(v => v === +edgeN),
  `D7d 虚线取证那两条句子里的点数都等于 edgeProfile 的 N（${edgeN}）`,
  `文档 ${edgeDoc.join(' / ') || '没有'} vs 脚本 ${edgeN}`);
const darkTh = (SCEN.match(/disc\.dark >= (\d+)/) || [])[1];
const darkDoc = (DESIGN.match(/数暗像素 ≥(\d+)/) || [])[1];
const boxDoc = (DESIGN.match(/中心 ([\d.]+)×cell 的框/) || [])[1];
const boxCode = (SCEN.match(/Math\.round\(r\.size \* ([\d.]+)\)/) || [])[1];
ok(!!darkTh && !!darkDoc && +darkDoc === +darkTh, `D7e 「暗像素 ≥6」== 场景里的那个门槛`, `文档 ${darkDoc} vs 脚本 ${darkTh}`);
ok(!!boxDoc && !!boxCode && +boxDoc === +boxCode, `D7f 「中心 0.5×cell 的框」== 场景取的框尺寸`, `文档 ${boxDoc} vs 脚本 ${boxCode}`);
const tolDoc = (DESIGN.match(/图例色块与画布像素允许误差 (\d+)/) || [])[1];
const tolCode = [...SCEN.matchAll(/near\(rgb\(getComputedStyle\(\$\('\.sw-[a-z]+'\)\)\.backgroundColor\), \w+, (\d+)\)/g)].map(m => +m[1]);
ok(!!tolDoc && tolCode.length >= 2 && tolCode.every(v => v === +tolDoc),
  `D7g 图例颜色那条误差 ${tolDoc} == 场景里 near() 用的容差（${tolCode.join('/')}）`,
  tolDoc ? `文档 ${tolDoc} vs 脚本 ${[...new Set(tolCode)].join('/')}` : '解析不到那句');
const rasterBody = SCEN.slice(SCEN.indexOf('async function rasterSettled'), SCEN.indexOf('const settled'));
const rasterWait = (rasterBody.match(/await wait\((\d+)\)/) || [])[1];
const rasterStreak = (rasterBody.match(/seen\.slice\(-(\d+)\)/) || [])[1];
const rasterDoc = DESIGN.match(/每 (\d+) ms 重绘一次，\*\*连续([一二三四五六七八九十])次哈希相同/);
ok(!!rasterWait && !!rasterStreak && !!rasterDoc && +rasterDoc[1] === +rasterWait && CN[rasterDoc[2]] === +rasterStreak,
  `D7h 光栅停机的两句（每 ${rasterWait} ms / 连续 ${rasterStreak} 次）等于场景现在的写法`,
  rasterDoc ? `文档 ${rasterDoc[1]} ms × ${rasterDoc[2]} 次 vs 脚本 ${rasterWait} × ${rasterStreak}` : '解析不到那句');

// ---- D8 负数对照组：文档写的循环数与门槛 == scenarios.js 的现在值（实测分子不复测）----
const checkedCode = (SCEN.match(/const checked = (\d+);/) || [])[1];
const checkedDoc = [...DOCS.matchAll(/(\d+) 盘里/g)].map(m => +m[1]);
const genRow = README.match(/notUnique: (\d+), many: (\d+), fooled: (\d+), checked: (\d+)/);
const designCtl = DESIGN.match(/实测 (\d+) 个，其中 `MANY` (\d+)/);
ok(!!checkedCode && checkedDoc.length >= 2 && checkedDoc.every(v => v === +checkedCode),
  `D8a 两份文档那句「12 盘里」都等于对照组循环的 checked=${checkedCode}`,
  `文档 ${checkedDoc.join(' / ') || '没有'} vs 脚本 ${checkedCode}`);
const ctlTh = (SCEN.match(/notUnique >= (\d+)/) || [])[1];
const ctlDoc = (DESIGN.match(/必须造出 ≥(\d+) 个多解盘/) || [])[1];
ok(!!ctlTh && +ctlDoc === +ctlTh, `D8b 「必须造出 ≥6 个多解盘」== 场景那条门槛`, `文档 ${ctlDoc} vs 脚本 ${ctlTh}`);
ok(!!genRow && +genRow[4] === +checkedCode, `D8c gen 那行的 checked 等于循环次数`,
  genRow ? `文档 ${genRow[4]} vs 脚本 ${checkedCode}` : '解析不到那一行');
ok(!!genRow && !!designCtl && +genRow[1] === +designCtl[1] && +genRow[2] === +designCtl[2] && +genRow[1] === +genRow[2],
  `D8d README 的 notUnique/many 与 DESIGN 的「实测 8 个，其中 MANY 8」是同一份读数，且这一轮里两个数相等`,
  genRow && designCtl ? `文档 ${genRow[1]}/${genRow[2]} vs DESIGN ${designCtl[1]}/${designCtl[2]}` : '解析不到');
ok(!!genRow && +genRow[3] === 0, `D8e 对照组那句「一次都没有被骗到」写的是 fooled: 0`,
  genRow ? `文档 fooled ${genRow[3]}` : '解析不到');

// ---- D9 模型常数与存储：文档印的每个字面量都从代码取现值 ----
const cellSet = DESIGN.match(/\{OPEN=(-?\d+), BLACK=(-?\d+), WHITE=(-?\d+)\}/);
ok(!!cellSet && +cellSet[1] === OPEN && +cellSet[2] === BLACK && +cellSet[3] === WHITE,
  'D9a 三种墨的数值 == kuromasu.js 导出的 OPEN/BLACK/WHITE',
  cellSet ? `文档 ${cellSet.slice(1).join('/')} vs 代码 ${OPEN}/${BLACK}/${WHITE}` : '解析不到那句');
const noClueDoc = DESIGN.match(/\{NO_CLUE=(-?\d+)\}/);
ok(!!noClueDoc && +noClueDoc[1] === NO_CLUE, `D9b NO_CLUE 的哨兵值 == 代码的 ${NO_CLUE}`,
  noClueDoc ? `文档 ${noClueDoc[1]}` : '解析不到');
const maxSeeCode = (KUROMASU.match(/const maxSee = w \+ h - (\d+);/) || [])[1];
const maxSeeDoc = DESIGN.match(/一条十字顶多 `w\+h-(\d+)` 格/);
ok(!!maxSeeCode && !!maxSeeDoc && +maxSeeDoc[1] === +maxSeeCode, `D9c 十字上界 w+h-1 == createBoard 用的 maxSee`,
  `文档 ${maxSeeDoc?.[1]} vs 代码 w+h-${maxSeeCode}`);
const guardRows = [...DESIGN.matchAll(/^\| [^|]+\| `(if \((.+?) throw (?:…|')([^`|]+)'?)` \|$/gm)].map(m => [m[2], m[3]]);
ok(guardRows.length === 3, `D9d DESIGN §1 那张「三个结构性事实」的表解析到 3 行守卫`,
  `${guardRows.length} 行（不是 3 行就是表格改了形状）`);
for (const g of guardRows) {
  const cond = g[0].trim();
  const msg = g[1].trim();
  ok(KUROMASU.includes(cond) && KUROMASU.includes(msg),
    `D9 守卫「if (${cond.slice(0, 24)}…」在 kuromasu.js 里，且报错文案尾段逐字相同`,
    `条件${KUROMASU.includes(cond) ? '在' : '不在'} · 文案「${msg.slice(0, 26)}」${KUROMASU.includes(msg) ? '在' : '不在'}`);
}
const statusNames = [...new Set((COUNT.match(/export const (UNIQUE|MANY|NONE|OVERBUDGET) =/g) || []).map(x => x.split(' ')[2]))];
const statusDoc = (DESIGN.match(/（`(.+)`）/g) || []).map(x => x.replace(/[（`）]/g, ''));
const statusList = DESIGN.match(/`(UNIQUE \/ MANY \/ NONE \/ OVERBUDGET)`/);
ok(statusNames.length === 4 && !!statusList && statusList[1].split(' / ').every(s => statusNames.includes(s)),
  `D9e DESIGN 列的四种计数结论（${statusList?.[1] || '解析不到'}）都在 count.js 的导出里（${statusNames.join(' ')}）`,
  `代码 ${statusNames.join(' ')} · 文档 ${statusList?.[1] || '无'}`);
const sharedImports = (COUNT.match(/import \{([^}]*)\} from '\.\/kuromasu\.js'/) || [, ''])[1].split(',').map(x => x.trim()).filter(Boolean);
const sharedDoc = DESIGN.match(/只共享([一二三四五六七八九十])个常量/);
ok(sharedImports.length === 4 && !!sharedDoc && CN[sharedDoc[1]] === sharedImports.length &&
  sharedImports.every(n => KUROMASU.includes(`export const ${n} =`)),
  `D9f 「只共享四个常量」== count.js 从 kuromasu.js import 的那 ${sharedImports.length} 个名字（${sharedImports.join(' ')}）`,
  `代码 ${sharedImports.join(' ')} vs 文档 ${sharedDoc?.[1] || '无'} 个`);
const budgetCode = (COUNT.match(/budget = ([\d_]+)/) || [])[1];
const budgetDocs = [
  ...[...DOCS.matchAll(/预算是 ([\d,]{7}) 节点/g)].map(m => num(m[1])),
  ...[...DOCS.matchAll(/([\d,]{7}) 预算里的/g)].map(m => num(m[1])),
];
const budgetLedger = [...GENERATE.matchAll(/([\d]{3},[\d]{3}) 节点预算/g)].map(m => num(m[1]));
ok(!!budgetCode && budgetDocs.length >= 2 && budgetDocs.every(v => v === +budgetCode),
  `D9g 文档两处「400,000 节点」的预算 == countSolutions 的默认 budget（${budgetCode}）`,
  `文档 ${budgetDocs.join(' / ') || '没有'} vs 代码 ${budgetCode}`);
const nodeLedger = [...DOCS.matchAll(/独立计数器在 ([\d]+×[\d]+) 上最多花\n?([\d,]{5,}) 个节点，而 ([\d]+×[\d]+) 的 (\d+) 盘探针已经要吃掉 ([\d,]{7}) 预算里的 ([\d,]{5,})/g)];
const genLedger = GENERATE.match(/at most ([\d,]+) nodes on ([\d]+×[\d]+); an (\d+)-board probe of ([\d]+×[\d]+)[\s\S]{0,12}?already needed ([\d,]+) of the ([\d,]+) node budget/);
ok(nodeLedger.length === 1 && !!genLedger, `D9h 节点台账两侧都解析到了（DESIGN 一处 / generate.js 注释一处）`,
  `解析 ${nodeLedger.length} 处 · 注释${genLedger ? '在' : '不在'}`);
if (nodeLedger.length && genLedger) {
  const d = nodeLedger[0];
  ok(num(d[2]) === num(genLedger[1]) && d[1] === genLedger[2] && +d[4] === +genLedger[3] && d[3] === genLedger[4] &&
    num(d[6]) === num(genLedger[5]) && num(d[5]) === num(genLedger[6]) && num(d[5]) === +budgetCode,
    `D9 节点台账逐格等于 generate.js 里记着的那次 bench（${genLedger[1]}@${genLedger[2]} · ${genLedger[3]} 盘 ${genLedger[4]} → ${genLedger[5]} / ${genLedger[6]}）`,
    `文档 ${d[2]}@${d[1]} · ${d[4]} 盘 ${d[3]} → ${d[6]} / ${d[5]}`);
  ok(num(d[2]) < num(d[6]) && num(d[6]) < +budgetCode && `${TIERS[4].w}×${TIERS[4].h}` === d[1],
    'D9i 台账的方向性：10×10 的最坏 < 11×11 探针 < 预算，而大师档就停在文档说的那一档',
    `${num(d[2])} < ${num(d[6])} < ${budgetCode} · 文档 ${d[1]} · 大师 ${TIERS[4].w}×${TIERS[4].h}`);
}
const keyDoc = DESIGN.match(/一个键 `([^`]+)`/);
const keyCode = (STORE.match(/const KEY = '([^']+)';/) || [])[1];
const keyDecls = (STORE.match(/const KEY = /g) || []).length;
ok(!!keyCode && keyDecls === 1 && keyDoc?.[1] === keyCode, `D9j 存档键 ${keyCode} == store.js 唯一的那个 KEY`,
  `文档 ${keyDoc?.[1]} vs 代码 ${keyCode}（KEY 声明 ${keyDecls} 处）`);
const saveBody = STORE.slice(STORE.indexOf('saveResume(puzzle'), STORE.indexOf('this.save();', STORE.indexOf('saveResume(puzzle')));
const saveKeys = [...saveBody.matchAll(/^\s{6}(\w+)(?::|,)/gm)].map(m => m[1]);
const fieldsDoc = (DESIGN.match(/续局记 `\{([^}]*)\}`/) || [])[1];
ok(!!fieldsDoc && saveKeys.length >= 6 && fieldsDoc.split(/,\s*/).join(',') === saveKeys.join(','),
  `D9k DESIGN §10 那串续局字段逐字等于 store.js 的 saveResume 写的键（${saveKeys.join(', ')}）`,
  fieldsDoc ? `文档 {${fieldsDoc}} vs 代码 {${saveKeys.join(', ')}}` : '解析不到那串字段');
const orderDoc = [...DOCS.matchAll(/排序是 `?(hints → moves → ms)`?|先比求助次数/g)].length;
const orderCode = /hints < cur\.hints[\s\S]*?moves < cur\.moves[\s\S]*?ms < cur\.ms/.test(STORE);
ok(orderDoc >= 2 && orderCode, 'D9l 两份文档的 hints → moves → ms 排序 == recordBest 里那三层比较的顺序',
  `文档 ${orderDoc} 处 · 代码顺序${orderCode ? '一致存在' : '找不到'}`);

// ---- D10 引用不漂：每一条 path:NN 都落在真实行数内，带锚点的还要真指到那个名字 ----
const RESOLVE = ['js', 'js/engine', 'js/ui', 'js/render', 'tools', 'css', '.'];
const resolvePath = p => {
  if (existsSync(join(ROOT, p))) return p;
  for (const dir of RESOLVE) if (existsSync(join(ROOT, dir, p))) return join(dir, p);
  return null;
};
const cites = [...DOCS.matchAll(/((?:tools\/|js\/)?[\w./-]+\.(?:js|mjs|cjs|sh|html)):(\d+)(?:-(\d+))?/g)];
const citeMap = new Map();
const bad = [];
for (const c of cites) {
  const p = resolvePath(c[1]);
  if (!p) { bad.push(`${c[1]}:${c[2]}（文件不存在）`); continue; }
  const n = nlines(read(p));
  const end = c[3] ? +c[3] : +c[2];
  if (+c[2] > n || end > n) bad.push(`${c[1]}:${c[2]}${c[3] ? '-' + c[3] : ''}（${p} 只有 ${n} 行）`);
  if (!citeMap.has(`${p}:${c[2]}`)) citeMap.set(`${p}:${c[2]}`, { p, start: +c[2], end });
}
ok(cites.length >= 12, `D10a 文档里的行号引用解析到 ${cites.length} 条（少于 12 条说明引用格式改了）`, `${cites.length} 条`);
ok(bad.length === 0, 'D10 每一条 path:NN 引用都落在真实文件的行数内', bad.length ? `越界：${bad.join('，')}` : `${cites.length} 条全部在范围内`);
const anchors = [
  ['js/engine/kuromasu.js', 72, 'createBoard'], ['js/engine/generate.js', 89, 'pruneClues'],
  ['js/engine/generate.js', 71, 'randomSolution'], ['js/main.js', 209, '提示次数'],
  ['js/main.js', 417, 'function preview'], ['js/ui/game.js', 252, 'nextDeduction'],
  ['js/ui/game.js', 161, 'refusal = null'], ['js/store.js', 92, 'best[tier]'],
  ['js/render/board.js', 139, 'preview.value === OPEN'], ['tools/scenarios.js', 193, 'NO_CLUE'],
  ['tools/engine-test.mjs', 348, 'reachable'], ['tools/verify.sh', 24, 'CDP_PORT'],
];
for (const [file, line, token] of anchors) {
  const hit = citeMap.get(`${file}:${line}`);
  let body = '';
  if (hit) body = read(hit.p).split('\n').slice(hit.start - 1, hit.end).join('\n');
  ok(!!hit && body.includes(token), `D10b ${file}:${hit ? hit.start : '?'}${hit && hit.end !== hit.start ? '-' + hit.end : ''} 真的坐着 ${token}`,
    hit ? `引用范围 ${hit.start}-${hit.end} ${body.includes(token) ? '含' : '不含'}「${token}」` : `文档没有引用 ${file}:${line}`);
}
const reachableAnchor = DESIGN.match(/([一二三四五六七八九十])条锚点/);
const engRange = citeMap.get('tools/engine-test.mjs:348');
const anchorCount = engRange ? [...read('tools/engine-test.mjs').split('\n').slice(engRange.start - 1, engRange.end)
  ].filter(l => /eq\('[^']*', reachable\(/.test(l)).length : 0;
ok(!!reachableAnchor && CN[reachableAnchor[1]] === anchorCount && anchorCount === 4,
  `D10c 「四条锚点钉住方向」== 被引用的那一段里 reachable 的 eq 条数（${anchorCount}）`,
  reachableAnchor ? `文档 ${reachableAnchor[1]}条 vs 段内 ${anchorCount} 条` : '解析不到那句');
const pathMentions = [...new Set((DOCS.match(/(?:tools|js|css)\/[\w./-]+\.(?:js|mjs|cjs|sh)/g) || []))];
ok(pathMentions.length >= 8 && pathMentions.every(x => existsSync(join(ROOT, x))),
  `D10d 文档点名的 ${pathMentions.length} 个 tools/ 与 js/ 文件都还在树里（删掉一个工具就得同时删掉提到它的话）`,
  pathMentions.filter(x => !existsSync(join(ROOT, x))).join('，') || pathMentions.join(' '));
const treeRows = [...README.slice(README.indexOf('## 目录'), README.indexOf('## 许可'))
  .matchAll(/^(\S+\.(?:js|mjs|css|html|sh))\s{2,}/gm)].map(m => m[1]);
const treeBad = treeRows.filter(p => {
  const q = resolvePath(p);
  return !q || !read(q).trim();
});
ok(treeRows.length >= 7 && treeBad.length === 0, `D10e README 目录树列的 ${treeRows.length} 个路径都解析得到内容`,
  treeBad.length ? `找不到：${treeBad.join('，')}` : `${treeRows.length} 个文件都在`);
const toolsLine = (README.match(/^tools\/.*$/m) || [''])[0];
const gateBases = toolsFiles.map(f => f.replace(/\.[^.]+$/, ''));
const unnamed = gateBases.filter(b => !toolsLine.includes(b));
ok(toolsLine.length > 10 && unnamed.length === 0,
  `D10f README 目录那一行点名了 tools/ 里的全部 ${gateBases.length} 个门禁（新增一道门禁不能只在 tools/ 里躺着）`,
  `没点名：${unnamed.join(' ') || '没有'} · 那一行「${toolsLine.trim()}」`);

// ---- D11 键位：README 操作表印的按键 == main.js 真处理的那几个 ----
// 只数表格行：把整节散文都当"文档说了这颗键"的话，删掉操作表那一行还能靠后一句护栏话蒙过去
// （本轮的阳性对照就是这么打不红的，于是改成只认 `| ... |` 行）。
// 按键现在分散在四处监听里，写法也不统一：玩法那组是 `const k = ev.key.toLowerCase(); k === 'h'`，
// 暂停是 `k === 'p'`，全屏/静音是 `ev.key === "f"`（双引号）。早期这里只认 `k === 'x'` 一种形态，
// 于是 P 落地那天闸是绿的、文档里根本没有这颗键——两种引号形态都认，少认一种就是漏一颗键的文档。
const keysSpan = README.slice(README.indexOf('## 玩法'), README.indexOf('判胜用的是')).split('\n')
  .filter((l) => l.startsWith('| ')).join('\n');
const keysDoc = [...new Set([...keysSpan.matchAll(/`([A-Z])`/g)].map(m => m[1]))].sort();
const keysCode = [...new Set([...MAIN.matchAll(/(?:k|ev\.key)\s*===\s*['"]([A-Za-z])['"]/g)]
  .map(m => m[1].toUpperCase()))].sort();
ok(keysDoc.length >= 9 && keysCode.length >= 9,
  `D11a 两边的按键都解析到了（操作表 ${keysDoc.length} 个字母键、代码 ${keysCode.length} 个分支，都不许是空解析）`,
  `文档 ${keysDoc.join('')} vs 代码 ${keysCode.join('')}`);
ok(keysDoc.join('') === keysCode.join(''), 'D11 文档的按键集合与 main.js 的 keydown 分支一一对应（谁也不能单方面多一个少一个）',
  `文档 ${keysDoc.join(' ')} · 代码 ${keysCode.join(' ')} · 只有文档有：${keysDoc.filter(k => !keysCode.includes(k)).join('') || '无'} · 只有代码有：${keysCode.filter(k => !keysDoc.includes(k)).join('') || '无'}`);

// ---- D12 本文件自审：写了的每一节都得真跑到（删掉一节就是红，不是"少了几行输出"）----
const ownSections = [...new Set([...read('tools/doctest.mjs').matchAll(/^\/\/ ---- (D\d+)/gm)].map(m => m[1]))];
ok(ownSections.length >= 10, `D12 自审这一节自己在跑（这一条是它唯一能自证的一次）`, `本文件写了 ${ownSections.length} 个小节`);
ok(ownSections.every(s => emitted.has(s)),
  `D12b 本文件写的 ${ownSections.length} 个小节全部发出了断言（emitted ${emitted.size} 个标签）`,
  `小节 ${ownSections.join(' ')} · 没跑到的：${ownSections.filter(s => !emitted.has(s)).join(' ') || '没有'}`);
ok(rows >= 100, `D12c 这一次至少跑出 100 条文档等式（少了就是某整节的解析哑了）`, `本次 ${rows} 条`);

console.log(`\n合计 ${rows} 项，${fail.length} 项失败`);
console.log(`rows: ${rows} fail: ${fail.length}`);
if (fail.length) {
  for (const f of fail) console.log(`  未过：${f}`);
  process.exit(1);
}
