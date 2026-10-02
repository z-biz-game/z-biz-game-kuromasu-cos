#!/usr/bin/env bash
# One-shot browser verification: real Chrome, real DOM, scripted scenarios.
#
#   ./tools/verify.sh                 # engine + gen + play + ink + hint + stroke + conflict + save/resume + layout
#   SCENARIOS="play hint" ./tools/verify.sh
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-kuromasu-cos/ ./tools/verify.sh
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates every core and, with no CDP client attached, Chrome will not exit
# on its own.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
# 文档门禁排在浏览器之前：README / DESIGN 印出去的每一个现值都要等于代码的现在值，这一条不需要
# Chrome、也不需要服务，只需读文件（外加跑一次 engine-test 拿它的条数）。文档漂了就没必要再花
# 几十秒开设备跑十个场景。它对 verify.sh 的断言是读这个脚本的**源码**得来的（场景清单、端口），
# 不是读它的输出，所以谁先谁后都一样——排在前面只是为了早点红。
node "$HERE/tools/doctest.mjs" >/tmp/kuromasu-doctest.log 2>&1 || {
  echo "doctest FAILED：文档与代码漂了（详见 /tmp/kuromasu-doctest.log）" >&2
  grep '^  FAIL' /tmp/kuromasu-doctest.log | head -20 >&2
  tail -2 /tmp/kuromasu-doctest.log >&2
  exit 5
}
echo "doctest: $(grep '^rows:' /tmp/kuromasu-doctest.log)"
PORT=${CDP_PORT:-9363}
# 5173 is Xcode/ashen-ring's default and a long-lived server there will happily serve a
# *different* app, so this harness deliberately uses its own port. Other agents in this repo
# farm run their own verify.sh at the same time, each on its own pair of ports: 5254 and
# 9363 belong to 黑目 and to nothing else. Bumping either one is how two runs test each other's app.
HTTP=${HTTP_PORT:-5254}
# 两道档：logic = doctest（文档等式）+ sabotage（破坏台账）；browser = 下面 10 个场景的真 Chrome
#   计数，逐条对那张 EXPECTS 表。刀只落在工作区根的临时副本里，真文件一个字节都不改，跑完即删；
#   它要求工作树干净——刀打在半成品上，台账记的就是一个半成品世界里的红。
# 上面那对端口（24-29 行）不要往上下挪：README 与 tools/doctest.mjs 的 D10b 把这个行段钉成了
#   「端口写死在这里」的锚点，锚点里的第 24 行必须还坐着 CDP_PORT。
node "$HERE/tools/sabotage.mjs" >/tmp/kuromasu-sabotage.log 2>&1 || {
  echo "sabotage FAILED：破坏台账没能把文档闸弄红并点名（或无刀副本不绿、或工作树脏）" >&2
  grep -E '^  (ERROR|没红|对照)' /tmp/kuromasu-sabotage.log | head -20 >&2
  tail -3 /tmp/kuromasu-sabotage.log >&2
  exit 6
}
echo "sabotage: $(grep -c '^  红得住' /tmp/kuromasu-sabotage.log) 把刀把 doctest 弄红并点到了名 · $(grep '^  对照' /tmp/kuromasu-sabotage.log)"
BASE=${BASE_URL:-http://127.0.0.1:$HTTP/}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

LOCAL=0
case "$BASE" in "http://127.0.0.1:$HTTP/"*) LOCAL=1 ;; esac
SPID=0
if [ "$LOCAL" = 1 ]; then
  node "$HERE/server.cjs" "$HTTP" >/tmp/kuromasu-server.log 2>&1 &
  SPID=$!
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$HTTP/" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
# Pre-flight: prove the bytes we are about to test are this app's, not some other repo's
# index.html served on the same port.
SERVED=$(curl -fsS -m 3 "$BASE" 2>/dev/null || true)
case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at $BASE (see /tmp/kuromasu-server.log)" >&2; exit 2 ;; esac
echo "$SERVED" | grep -qi kuromasu || { echo "port $HTTP is serving a different app, not 黑目/kuromasu" >&2; exit 2; }

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir=$UDD \
  --window-size=900,900 --no-first-run --no-default-browser-check about:blank >/tmp/kuromasu-chrome.log 2>&1 &
CPID=$!
cleanup() {
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  kill -9 $CPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and
# inside a pipeline it would hold the write end open long after the tests finished.
( sleep ${WD_TIMEOUT:-420}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools later than a warm profile: wait on the endpoint.
for i in $(seq 1 120); do
  curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$PORT" >&2; exit 3; }

export CDP_PORT=$PORT
export BASE_URL=$BASE
cd "$HERE"
node tools/playtest.cjs open "$BASE" | head -5

BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.cjs eval "window.kuromasu?window.kuromasu.version:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot: kuromasu $BOOT at $BASE"
[ "$BOOT" = "nope" ] && { echo "window.kuromasu never appeared at $BASE" >&2; exit 4; }

FAILED=0
# 每个场景的断言条数表（值取自 README 那段 verify 输出与 ci.yml 的注释，是已经在印的那一组，不是新测的）。
# 为什么要在闸里数这一遍：tools/doctest.mjs 的 D3b/D3c 只钉这份清单的「名字、顺序、每行 failed=0」，
# D3e/D3f 只钉总和。也就是说单行值以前没人守——engine 少一条、layout 多一条，总和还是 410，文档闸
# 照样绿。这张表把 10 格一格一格钉死；清单里冒出一个表上没有的场景名也一样红（新增场景必须登记条数，
# 不能让文档抄一个猜的数）。SCENARIOS 只跑子集时逐条对表照做，但末尾那个总和对不上，所以不判。
EXPECTS='engine=53 gen=42 play=62 ink=50 hint=41 stroke=25 conflict=36 save=25 resume=32 layout=44'
export EXPECTS
COUNTS=/tmp/kuromasu-browser-counts.txt
: >"$COUNTS"
for s in ${SCENARIOS:-engine gen play ink hint stroke conflict save resume layout}; do
  echo "=== $s ==="
  node tools/playtest.cjs scenario "$s" 2>/tmp/kuromasu-$s.console.log | tail -1 | sed 's/^RESULT //' | python3 -c "
import sys, json, os
name = sys.argv[1]
raw = sys.stdin.read().strip()
if not raw:
    print('  NO RESULT (see /tmp/kuromasu-$s.console.log)'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception as e:
    print('  UNPARSED:', raw[:300]); sys.exit(1)
for r in d['rows']:
    if not r['pass']: print('  FAIL %-46s %s' % (r['test'], r['detail']))
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
if not d['rows']:
    print('  NO CHECKS RUN — a scenario that asserts nothing cannot be green'); sys.exit(1)
table = dict(kv.split('=') for kv in os.environ['EXPECTS'].split())
if name not in table:
    print('  RED %s：EXPECTS 表里没有这一格（新增或改名的场景必须登记条数）' % name); sys.exit(1)
if len(d['rows']) != int(table[name]):
    print('  RED %s：断言 %d 条，EXPECTS 写 %d 条——README/ci.yml 抄的就是这张表，漂了要当场说'
          % (name, len(d['rows']), int(table[name]))); sys.exit(1)
open('/tmp/kuromasu-browser-counts.txt', 'a').write('%s %d\\n' % (name, len(d['rows'])))
print('  %d checks, %d failed  %s' % (len(d['rows']), d['fail'], extra if extra else ''))
sys.exit(1 if d['fail'] else 0)
" "$s" || FAILED=1
  if [ -s /tmp/kuromasu-$s.console.log ]; then
    echo "  --- console ---"
    sed 's/^/  /' /tmp/kuromasu-$s.console.log | tail -12
  fi
done

# 整跑（10 份报告都到了）才判总和：这一条把「EXPECTS 表和 README 那张表是同一组数」钉在浏览器腿上，
# 而不是只在文档里自洽（D3e 比的是文档表自己加起来等于自己）。
GOT=$(awk '{ s += $2 } END { printf "%d", s + 0 }' "$COUNTS")
NR=$(wc -l <"$COUNTS" | tr -d ' ')
NW=$(echo "$EXPECTS" | wc -w | tr -d ' ')
if [ "$NR" = "$NW" ]; then
  WANT=$(for kv in $EXPECTS; do echo "${kv#*=}"; done | awk '{ s += $1 } END { printf "%d", s }')
  echo "EXPECTS: $NR 份报告逐条对上，合计 $GOT == 表和 $WANT"
  [ "$GOT" = "$WANT" ] || { echo "  RED 合计 $GOT ≠ EXPECTS 表和 $WANT" >&2; FAILED=1; }
else
  echo "EXPECTS: 子集跑（$NR/$NW 份报告），逐条对表已判，总和不判"
fi

if [ -n "${SHOTS:-}" ]; then
  mkdir -p tools/shots
  for shot in menu board win; do
    case $shot in
      menu) node tools/playtest.cjs eval "window.kuromasu.show('menu');'ok'" nonav >/dev/null 2>&1 ;;
      board) node tools/playtest.cjs eval "window.kuromasu.begin({tier:'expert',seed:'shot-board'});for(let i=0;i<14;i++)window.kuromasu.useHint();window.kuromasu.redraw();'ok'" nonav >/dev/null 2>&1 ;;
      win) node tools/playtest.cjs eval "window.kuromasu.begin({tier:'regular',seed:'shot-win'});window.kuromasu.solveWithLogic();window.kuromasu.redraw();'ok'" nonav >/dev/null 2>&1 ;;
    esac
    sleep 1.4
    node tools/playtest.cjs shot tools/shots/$shot-$SHOTS.png >/dev/null
  done
  echo "shots: $(ls tools/shots/*-$SHOTS.png | tr '\n' ' ')"
fi

kill $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
