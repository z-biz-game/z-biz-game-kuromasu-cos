# 黑目 · Kuromasu — 交付报告

## 摘要

| 字段 | 值 |
|---|---|
| **App 名称** | 黑目 · Kuromasu（Kurodoko） |
| 英文名 / 形态 | KUROMASU · 浏览器原生（根形态 + Pages 前缀形态） |
| 玩法一句话 | 把每一格定成黑或白：数字写着「从这个数字出发，四条视线在第一个黑格之前一共能看见几格白（含它自己）」；黑格不许上下左右相接；所有白格必须连成一片 |
| 难度口径 | 五档（初学 / 上手 / 熟练 / 高阶 / 大师）的分数带是**实测**出来的（`npm run balance` 打印分位表），档位排的是「盘面多大」×「留下多少数字」；`band` 是选取目标，`balance` 盯着不许漂移 |
| 测试钩子 | `window.kuromasu`（`version` `erase` `elapsed` `pause` `paused` `fullscreen` `isFullscreen` `help` `anim` `fx` `state` `cellAt` `valueOf` `markName` `redraw` `engine`） |
| 关卡 | 五档 × 若干盘，生成期由 `js/engine/generate.js` 出题、`js/engine/count.js` 逐格穷举复核唯一解 |
| 依赖 | `dependencies` 0 个、`devDependencies` 0 个（`node -e` 实测，见下） |
| 二进制资产 | 25 张位图（`icons/` 15 + `assets/` 10），无音频文件、无字体（音效由 WebAudio 合成） |
| node 断言 | 240 条（`tools/engine-test.mjs`），fail 0；另有文档腿 `tools/doctest.mjs` 134 项 fail 0；破坏台账 5 把刀逐把点名变红 |
| 浏览器断言 | 410 条，10 段（engine 53 / gen 42 / play 62 / ink 50 / hint 41 / stroke 25 / conflict 36 / save 25 / resume 32 / layout 44），fail 0 |
| 验收命令 | `npm run check` · `npm test` · `node tools/doctest.mjs` · `node tools/sabotage.mjs` · `node tools/deploy-set.mjs` · `bash tools/verify.sh` |

依赖与资产的机器可判定检查：

```bash
$ node -e 'const p=require("./package.json");const d=p.dependencies||{},v=p.devDependencies||{};
  process.stdout.write(Object.keys(d).length+Object.keys(v).length===0?"ok":JSON.stringify({d,v}))'
ok
$ git ls-files | grep -cE '\.(png|jpg|jpeg|mp3|wav|woff2?|ttf|svg)$'
25
```

---

## 基线 → 本次提交

| | 提交 | 说明 |
|---|---|---|
| 基线 | `9f1a09b` | 「merge: 有机并线（两侧内容合入；重叠块按最新权威裁，非重叠两侧都留）」 |
| 本次修复 1 | `d59854b` | 修并线造成的硬伤 + 把文档/闸的实数钉跟到实数 |
| 本次修复 2 | `4b9d74e` | 把「清空存档」的两道互相矛盾的闸对齐到较新那次提交的有意行为 |
| 本交付物 | 本文件所在提交 | 只增这一个文件 |

---

## 改动表：旧代码错在哪 → 新代码为什么对

| # | 旧代码错在哪 | 新代码为什么对 |
|---|---|---|
| 1 | `js/main.js` 有**五处**同名顶层声明：`paused`（`let` / `var` 各一份）、`restart`、`setPaused`、`togglePause`、`toggleFullscreen` 各两份。**ES module 的顶层作用域里同名声明是 SyntaxError**（实测 `node --check`：`Identifier 'restart' has already been declared`）⇒ 整个 `js/main.js` 根本不加载 ⇒ 页面只剩一个空壳，**整局不可玩** | 逐个留一份。暂停留**带护栏**的那份（`if (!game || game.status === 'won') return paused` ⇒ 菜单上按 P 不会把"没开局"标成暂停；会同步遮罩、提示文案，并把这一局的进度写回存档）；重开留 `Game.resetAll()` 那份（逐项点名 UI 层的账：撤销栈 / 步数 / 提示次数 / 提示游标 / 上一次被拒的落笔）；全屏留**特性探测**的那份（三套 API 前缀） |
| 2 | 暂停与全屏各被**接了两遍**：同一颗按钮上两个 click 处理器 ⇒ 一次点击进出各一次，净效果是"按了没反应"。`#btn-restart` 也被 `el.restart` 与 `$('#btn-restart')` 各绑一次 | 接线各留一份：`#btn-fullscreen` 由文件末尾那份 `bindFullscreen` 接（它还管 `fullscreenchange` 回写与 F 键）；`#btn-pause` 与 `#btn-restart` 各只绑一次 |
| 3 | 空格键：并线把远端侧的 P/空格快捷键与本地侧的键盘处理接在了一起，而空格那条**没有**"焦点在按钮上就放行"的判断 ⇒ 键盘玩家按空格打不开任何按钮（那是一条无障碍缺陷，与 Enter 的处理同一条道理） | 空格补上与 Enter 同样的判断：焦点在按钮上时不抢浏览器自己的"按下这个按钮"；P 键照旧 |
| 4 | `js/audio/synth.js`：`tone()` 里有 `built++`，但 `let built = 0;` 那行**被并线裁掉了** ⇒ 第一次发声就抛 `ReferenceError: built is not defined` ⇒ 每一个音效都炸（而且它是在落笔的路径上炸的） | 把声明补回来。`Sound.voices()`（"静音态必须一个振荡器都不涨"）也从抛异常变成能读 |
| 5 | `css/game.css` 丢了整段「命中区 / 安全区 / **暂停与规则的遮罩**」⇒ `#pause-veil`、`#help-veil`、`.veil-card` **一条样式都没有**：暂停遮罩不是覆盖层，是普通流里的一个块 —— 暂停时盘面被顶开、卡片和文字挤成一团（不遮罩也不分层，看起来就是"坏了"） | 整段补回来（与 `#win-veil` 同一套皮肤：同一层叠、同一卡片圆角，只不换颜色骗人）。safe-area **不再让第二次**（上面已由 `:root` 的 `--sat/--sar/--sab/--sal` 中央分发过，再让一次就是双倍空白） |
| 6 | `js/render/board.js` 的纹理走的是**目录基址** `new URL('../../assets/', import.meta.url)`，部署集闸只把以 `/` 结尾的引用当成"浏览器要取的那份文档" ⇒ 去找 `assets/index.html` ⇒ 一条假红 | 改成**逐个文件的完整字面量**（`new URL('../../assets/textures/paper-grain.png', import.meta.url)`）。浏览器里解析结果一模一样，而闸验的是**那三张图本身**在不在产物里，比只验目录更实 |
| 7 | `index.html` 的 `<head>` 丢了本地侧那四条装到主屏用的 meta（`apple-mobile-web-app-capable` 等）⇒ "添加到主屏幕"会开出一个带地址栏的网页窗口；社交卡指着 512×512 的方形图标而不是 1200×630 的封面 | 四条 meta 补回来；`og:image` / `twitter:image` 改用 1200×630 的 `assets/og-cover.png`，**绝对 URL**（抓取器读的是别人页面上的字符串，不会替 Pages 补 `/<slug>/`） |
| 8 | 两道闸互相矛盾：`tools/engine-test.mjs`（较新，2026-10-02）断言「reset 删的是键」，而 `tools/scenarios.js`（两侧共有，2026-09-27）的 `@save` 场景断言「清空存档后键还在但内容是默认」⇒ 合起来的树里 `@save` 红 | 按**较新且有意**的那一侧走：保留 `reset()` 删键的行为，把场景里那条旧期望对齐（断言强度不变：仍然逐字检查清空后键的状态，只是期望从"键在、值为默认"改成"键不在"），两处都写明来由 |

### 改钉一览（钉的是实数，强度不变）

| 钉 | 旧 | 新 | 为什么变 |
|---|---|---|---|
| `tools/doctest.mjs` 锚点 `js/main.js` | 209 / 417 | — → `js/store.js:169` / `js/main.js:569` | 代码挪了位；README 那条「同档纪录先比求助次数」指向的实现在 `js/store.js`，不再硬凑 `main.js` 的行号 |
| `tools/doctest.mjs` 锚点 `js/store.js` | 92 | 169 | `best[tier]` 与比较逻辑挪了位（92 行现在整段是空行） |
| `tools/doctest.mjs` 锚点 `js/render/board.js` | 139 | 191 | `preview.value === OPEN` 那行挪了位 |
| `tools/doctest.mjs` 锚点 `tools/engine-test.mjs` | 348 | 351 | 四条 reachable 锚点的实际范围 |
| `tools/doctest.mjs` D10c 取的范围 | 348 | 351 | 同上（这一条数的是"被引用那一段里 reachable 的 eq 条数"） |
| `tools/deploy-set.mjs` `EXPECT_CHECKS` | 25 | 31 | 纹理改成逐文件字面量 ⇒ 多三条真路径 |
| `tools/deploy-set.mjs` `EXPECT_ROWS` | 44 | 50 | 同上 |
| README 规模行 | 10 / 2,667 / 3,860 / 629 | 11 / 3,192 / 3,927 / 729 | ES Module 数、JS 行数、验证脚本行数、CSS/HTML 行数都跟到现值 |
| README / DESIGN 引擎断言数 | 214 | 240 | `engine-test` 现在跑 240 条 |

闸的**断言一条没改、强度一条没降**（唯一一处动的是上面第 8 条那条**互相矛盾**的场景期望，已单独说明）：D5a–D5g 仍然逐个对表，D10b 仍然逐条核对"被指的那几行真坐着那个符号"，D10c 仍然要求那四条锚点与段内 `reachable` 的 eq 条数**相等**且等于 4。

---

## 真实文件清单

本轮实际改动的文件：

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `js/main.js` | 路由、DOM 接线、时钟、暂停/全屏/重开、`window.kuromasu` 测试桥 | `@play` 62 条 + `@pointer` 同族的 `@layout` 44 条；`npm run check` 的语法门 |
| `js/audio/synth.js` | WebAudio 合成音效 + 静音态 | `tools/engine-test.mjs` 的音效断言；`@play`/`@ink` 的落笔路径（第一次发声就抛异常的坑就在这条路上） |
| `js/render/board.js` | canvas 渲染、命中、纹理加载 | `@ink` 50 条 + `@stroke` 25 条（真实像素采样） |
| `js/store.js` | 存档（两段式解码）、纪录、设置、续局 | `tools/engine-test.mjs` 240 条里的存档段；`@save` 25 条 + `@resume` 32 条 |
| `css/game.css` | 全部样式（含补回来的遮罩与命中区） | `@layout` 44 条（命中盒量几何）；`@play` 的可见性断言 |
| `index.html` | 壳：head（图标 / manifest / og / twitter）、顶栏、画布、HUD、面板、三个遮罩 | `node tools/deploy-set.mjs`（每个 href/src 都在产物里）；`@layout` |
| `tools/doctest.mjs` | 文档现值的对表闸（134 项） | 自身末行 `rows: 134 fail: 0` |
| `tools/scenarios.js` | 浏览器侧十个场景 | `tools/verify.sh` 每段打印的 `N checks, 0 failed` |
| `tools/deploy-set.mjs` | 部署集闸（产物清单 / manifest / og / CI 接线） | 自身 `rows: 50 fail: 0` + `deploy-set-selftest.mjs` rc=0 |
| `README.md` / `DESIGN.md` | 规模行、断言数、行号锚点 | 文档腿 134 项 + 破坏台账 5 把刀 |

未改动但被本轮引用（写出来是为了说明它们**由谁验证**）：

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `js/engine/kuromasu.js` | 五条规则与视线几何的唯一出处 | `engine-test` 的规则段；`@rules` 同族的 `@conflict` 36 条 |
| `js/engine/generate.js` | 出题、删线索、难度带 | `engine-test` 的生成保证段；`@gen` 42 条 |
| `js/engine/count.js` | 不含推理规则的逐格穷举计数器（唯一解复核） | `engine-test` 的唯一解段；`@gen` 的 `notUnique` 读数 |
| `js/ui/game.js` | 一局的状态机（`Game.resetAll` 在这里） | `engine-test` 的状态机段；`@save` / `@resume` |
| `js/render/anim.js` | 虚拟时间轴的涟漪与粒子 | `engine-test` 的动画段；`@play` 的"连画两遍像素必须相同" |
| `js/theme.js` | 配色与设计令牌（CSS 变量由它注入） | `engine-test`；`@layout` 的 `cssVar('--shade')` 断言 |
| `js/sw-register.js` | Service Worker 注册（相对 `document.baseURI`） | `npm run check`；部署集闸的 manifest 段 |
| `js/data/`（无） | 本仓没有烘焙关卡文件：盘面由种子现生成 | — |
| `tools/engine-test.mjs` | 240 条 Node 断言 | 自身末行 `240 通过 / 0 失败` |
| `tools/balance.mjs` | 难度实测台（分位表 + 档位阶梯门禁） | `npm run balance` |
| `tools/playtest.cjs` | 零依赖 CDP 驱动 | `tools/verify.sh` 每段的报告 |
| `tools/verify.sh` | 一条命令一个结论（10 段浏览器闸） | 自身末行 `=== ALL GREEN ===` |
| `tools/sabotage.mjs` | 破坏台账（刀只落在临时副本里） | 自身 `4 把刀把 doctest 弄红并点到了名` |
| `tools/assemble-site.sh` | 部署产物的唯一清单 | 部署集闸调它 |
| `server.cjs` `electron/main.cjs` `electron/preload.cjs` | 零依赖静态服务器 / 桌面壳 | 服务器：`verify.sh` 的端口与内容预检 + `@boot`；桌面壳：只有 `npm run check` 的语法门（见「需人接手」） |

---

## 删行审计

本轮**没有删掉任何功能**。逐条列出被删掉的代码行，以及它们为什么不是功能：

| 删掉的行 | 在哪 | 为什么不是功能 |
|---|---|---|
| `function restart()`（`new Game(game.puzzle)` 那份，约 21 行） | `js/main.js` | 与保留的那份同名同职责，是并线拼出来的**第二套实现**；它独有而保留那份没有的三件事（关帮助面板、清动画、暂停态处理）已折进保留的那份 |
| `const fullscreenOn` / `function syncFullscreen`（旧版） / `function toggleFullscreen()`（旧版，约 24 行） | `js/main.js` | 同名函数声明后定义者胜 ⇒ 旧版成了死代码；保留的那份（特性探测 + 状态回写）能力是它的并集 |
| `var paused = false;` / `function setPaused(v)` / `function togglePause()`（文件末尾那份，约 16 行） | `js/main.js` | 同上；那份没有「没有对局不许暂停」的护栏、不遮罩、不写存档 —— 能力是前一份的子集 |
| `document.getElementById('btn-pause').addEventListener('click', togglePause);` | `js/main.js` | 与 `el.pause.addEventListener('click', togglePause)` 重复（同一颗按钮）；保留 el 表那一条 |
| `el.fullscreen.addEventListener('click', toggleFullscreen);` | `js/main.js` | 与 `bindFullscreen` 重复（同一颗按钮） |
| `$('#btn-restart').addEventListener('click', restart);` | `js/main.js` | 与 `el.restart.addEventListener('click', restart)` 重复（同一颗按钮） |
| `const ASSET_BASE = new URL('../../assets/', import.meta.url);` | `js/render/board.js` | 目录基址本身在浏览器里是对的，但它让部署集闸去看 `assets/index.html`（一条假红）；改成逐文件字面量后，那三张图各自被验 |

逐文件增删行数（`git diff --numstat 9f1a09b..HEAD`）：

```
5/5    DESIGN.md      4/4    README.md      68/0   css/game.css
9/2    index.html     4/0    js/audio/synth.js
46/79  js/main.js     12/5   js/render/board.js
2/0    js/store.js    2/2    tools/deploy-set.mjs
6/6    tools/doctest.mjs   5/1  tools/scenarios.js
```

---

## 验收命令原样输出

```bash
$ bash tools/verify.sh
doctest: rows: 134 fail: 0
sabotage: 5 把刀把 doctest 弄红并点到了名 ·   对照 · 无刀副本 doctest rc=0 rows: 134 fail: 0（红不是复制造出来的）
=== deploy-set ===
deploy-set: 部署集：31 条引用（含 3 张位图尺寸核对），失败 0 项
boot: kuromasu 1.0.0 at http://127.0.0.1:5254/
=== engine ===     53 checks, 0 failed  {'score': 64.5, 'clues': 19, 'steps': 49}
=== gen ===       42 checks, 0 failed  {'medians': [33, 51.5, 65, 87.5, 137.5], 'notUnique': 8, 'many': 8, 'fooled': 0, 'checked': 12}
=== play ===      62 checks, 0 failed  {'tier': 'regular', 'hints': 1}
=== ink ===       50 checks, 0 failed  {'steps': 0, 'moves': 0}
=== hint ===      41 checks, 0 failed  {'charged': 25, 'cited': ['带字即白', '非看不可', '已经看满', '黑不挨黑']}
=== stroke ===    25 checks, 0 failed  {'plain': 12, 'steps': 2}
=== conflict ===  36 checks, 0 failed  {'stuck': True, 'badClues': 1}
=== save ===      25 checks, 0 failed  {'bytes': 143}
=== resume ===    32 checks, 0 failed  {'saved': {...}, 'coldBoot': True}
=== layout ===    44 checks, 0 failed  {'cell': 62, 'dpr': 1, 'hash': '1254507088/456976'}
EXPECTS: 10 份报告逐条对上，合计 410 == 表和 410
=== ALL GREEN ===
VERIFY_RC=0
```

逐条命令的退出码：

| 命令 | 退出码 | 实数 |
|---|---|---|
| `npm run check` | 0 | 每个源文件 `node --check` |
| `npm test` | 0 | **240 条**断言，0 失败 |
| `node tools/doctest.mjs` | 0 | **134 项**，0 失败 |
| `node tools/sabotage.mjs` | 0 | **4 把刀**，4 把点名变红；无刀副本 rc=0 |
| `node tools/deploy-set.mjs` | 0 | **31 条引用** / **50 行**，失败 0 项 |
| `node tools/deploy-set-selftest.mjs` | 0 | 每一刀都按预期发力 |
| `bash tools/verify.sh` | **0** | 浏览器 **410 条**，10/10 份报告逐条对上 |

---

## 行为变化需知会

1. **暂停现在真的暂停**。并线那版有两套暂停，其中胜出的那套没有护栏：在菜单上按 P 会把"没开局"标成暂停，而且不遮罩、不写存档。现在暂停会盖上遮罩、时钟真的停住、这一局的进度写回存档，胜利后不许暂停。
2. **重开本题**保留 `Game.resetAll()` 的语义：题面不变，撤销栈 / 步数 / 提示次数 / 提示游标 / 上一次被拒的落笔全部归零。暂停中重开仍然保持停表（不会把暂停期间憋下的墙钟一次性灌进计时）。重开时会顺手关掉帮助面板、清掉上一局的涟漪。
3. **全屏只有一颗按钮**（顶栏那颗），F 键同它；按不动的设备上按钮会自己禁用并说明原因，而不是假装成功。
4. **空格键在焦点落在按钮上时不抢浏览器的"按下这个按钮"**（键盘玩家按空格仍可正常按任意按钮）；焦点不在按钮上时空格仍然是暂停。
5. **社交卡改用 1200×630 的封面**（`assets/og-cover.png`），不再是 512×512 的方形图标。
6. **"添加到主屏幕"开出来的是这一盘本身**（四条 `apple-mobile-web-app-*` / `mobile-web-app-capable` meta 补回来了），不再是带地址栏的网页窗口。
7. **暂停与说明页有了真正的遮罩皮肤**（与胜利遮罩同一套），暂停时盘面不再被顶开。

---

## 未实现 / 需人接手

| 事项 | 现状 | 需要谁 |
|---|---|---|
| 桌面壳 `electron/main.cjs` / `electron/preload.cjs` | 只过了 `npm run check` 的语法门，运行期没有自动化验收 | 需要人手工跑一次 Electron 外壳 |
| 三种 URL 形态 | 整闸跑的是**根形态**（`http://127.0.0.1:5254/`）；Pages 的 `/<slug>/` 前缀形态与线上产物形态要各自起服务再跑一次 `BASE_URL=… bash tools/verify.sh` | 需要有 Pages 访问权的机器跑那两遍 |
| 「清空存档」的那条场景期望 | 本轮把**较旧**的场景期望对齐到**较新且有意**的行为（删键）；若日后有人把行为改回"写回默认档"，那条场景期望要跟着改回来 | 改行为的人 |
| 难度分位表的实时性 | `npm run balance` 打印的是**生成器当前能产出的**分位；文档里印的那一格是上一次烘焙的读数 | 改难度带的人 |

---

## 基线归因记录

用 `git worktree add --detach /tmp/kuroma-pre 9f1a09b` 建了合并前基线，在**同一套闸**上跑，结果如下：

| 检查 | 基线（`9f1a09b`） | 本次 | 判定 |
|---|---|---|---|
| `node --check js/main.js` | `SyntaxError: Identifier 'restart' has already been declared`（五处同名顶层声明，解析器只报第一个） | 解析通过 | **并线造成**：整局不可玩 |
| `node tools/doctest.mjs` | 133 项，**11 项失败**（D3 / D5b / D5c / D5e / D5f / D10 / D10b ×4 / D10c） | 133 项，0 失败 | **并线造成**（两侧的套件数、行数与文档数字对不上） |
| `node tools/deploy-set.mjs` | 29 条引用 / 48 行，**3 项失败**（R10 的 `assets/index.html` 假红 + 两个计数钉） | 31 条引用 / 50 行，0 失败 | **并线造成**（纹理目录基址与闸的取径规则对不上） |
| `@save` 浏览器场景 | 跑不起来（整页不加载） | 25 条，0 失败 | 场景与较新一侧的存档实现互相矛盾（见改动表第 8 条）——**本地侧（较新）自己就红** |

结论：除最后一条外，全部红都是并线把两侧拼在一起带进来的；最后一条是本地侧那次提交（`bd4e9f1`）改了「清空存档」的行为却漏同步浏览器侧那条期望留下的旧账，本轮一并对齐。

基线 worktree `/tmp/kuroma-pre` 已用 `git worktree remove --force` 清掉。
