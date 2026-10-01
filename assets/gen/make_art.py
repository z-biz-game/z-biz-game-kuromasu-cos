#!/usr/bin/env python3
"""黑目 (Kuromasu) 全套位图资产工厂：一张 1024 母图 + 各尺寸派生 + 游戏内纸纹/墨纹/光爆 sprite + HUD 字形。

用法（可复现：不联网、不读时钟、不碰仓库外的任何东西）：

    python3 assets/gen/make_art.py            # 全量重刷
    python3 assets/gen/make_art.py --sizes    # 只列将要产出的文件

为什么生成器在仓内自带：图标与纹理的形状就是玩法本身——一张纸、被墨 punch 掉的黑格、数字沿四条
视线数白格。拿通用母题去套，出来的是"任何游戏都能用的图"。每一步都是确定性整数运算（自带 LCG 与
整数哈希，不用 random 全局态、不用 Image.effect_noise），同一份源码重刷出的是同一批字节。

母题与配色取自 js/theme.js：纸 #F3EFE6 / 墨 #121216 / 琥珀 #FFC85C / 夜底 #0B0B0D→#17171C。
图标那块 5×5 是真的黑目盘：数字由与引擎同一条规则现算（视线穿过白格、遇第一个黑格停、自己算一格），
并校验"黑不挨黑""白不断路"——任何一条不成立就非零退出，图标不许画一个无解的盘。

产出（index.html / manifest.webmanifest / js/render/board.js 引用的就是这些路径）：
    icons/icon-1024.png                       母图
    icons/icon-{512,192,180,96,64,48,32,16}.png
    icons/icon-maskable-{512,192}.png         Android maskable（主体缩进 80% 安全区）
    icons/apple-touch-icon.png                iOS 桌面（180）
    icons/favicon-{32,16}.png                 小尺寸另走紧凑母题
    icons/icon-manifest.json                  这批文件的尺寸/字节/母题记录
    assets/og-cover.png                       1200×630 社交卡
    assets/textures/paper-grain.png           可平铺纸纹，画在盘面纸底上
    assets/textures/ink-grain.png             可平铺墨纹，画在被涂黑的格上
    assets/sprites/amber-burst.png            胜利/提示的琥珀光爆 sprite
    assets/ui/{sound-on,sound-off,pause,resume,restart,fullscreen,motion}.png  HUD 字形
"""
import argparse
import json
import math
import os
import struct
import sys

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:  # pragma: no cover
    sys.stderr.write('需要 Pillow（与量具 make_icons.py 同一条依赖）：pip3 install Pillow\n')
    raise SystemExit(3)

HERE = os.path.abspath(os.path.dirname(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))

# ---------------------------------------------------------------- 主题（与 js/theme.js 同一批值）

PAPER = (0xF3, 0xEF, 0xE6, 255)
PAPER_EDGE = (0xD8, 0xD2, 0xC4, 255)
INK = (0x12, 0x12, 0x16, 255)
INK_EDGE = (0x33, 0x33, 0x3C, 255)
BG_TOP = (0x0B, 0x0B, 0x0D, 255)
BG_BOTTOM = (0x17, 0x17, 0x1C, 255)
ACCENT = (0xFF, 0xC8, 0x5C, 255)
INFO = (0x7F, 0xB2, 0xE8, 255)
CLUE_INK = (0x14, 0x14, 0x19, 255)
CLOUD = (0xF2, 0xF2, 0xF5, 255)


def A(c, a):
    """给一个 RGBA 主题色改 alpha——常量都是 4 元组，直接拼会变成 5 元组。"""
    return c[:3] + (a,)

FONT_CJK = [
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc',
]
FONT_NUM = [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
]


def load_font(paths, px):
    for p in paths:
        try:
            return ImageFont.truetype(p, px)
        except Exception:
            continue
    try:
        return ImageFont.load_default()
    except Exception:
        return None


# ---------------------------------------------------------------- 确定性噪声

def ihash(x, y, seed):
    h = (int(x) * 374761393 + int(y) * 668265263 + int(seed) * 1274126177) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 1103515245) & 0xFFFFFFFF
    h ^= h >> 16
    return h & 0xFFFFFFFF


class Lcg:
    """自己的 LCG：所谓"固定随机种子"就是它，与 Math.random()/random 模块无关。"""

    def __init__(self, seed):
        self.s = (seed & 0x7FFFFFFF) or 12345

    def next(self):
        self.s = (self.s * 1103515245 + 12345) & 0x7FFFFFFF
        return self.s

    def uniform(self, a, b):
        return a + (b - a) * (self.next() / float(0x7FFFFFFF))

    def randrange(self, n, m=None):
        lo, hi = (0, n) if m is None else (n, m)
        return lo + self.next() % max(1, hi - lo)


def periodic_noise(size, amp, seed):
    """周期白噪声：哈希输入直接取 (x, y) 本身，所以它以 size 为周期，天生接得上。"""
    out = bytearray(size * size)
    for y in range(size):
        row = y * size
        for x in range(size):
            out[row + x] = int(128 + (ihash(x, y, seed) / 4294967295.0 - 0.5) * amp)
            if out[row + x] < 0:
                out[row + x] = 0
            elif out[row + x] > 255:
                out[row + x] = 255
    return Image.frombytes('L', (size, size), bytes(out))


def tile_blur(img, radius):
    """要无缝就必须把噪声铺成 3×3 再模糊、裁中心：直接 GaussianBlur 会在边界断开。"""
    if radius <= 0:
        return img
    w, h = img.size
    big = Image.new(img.mode, (w * 3, h * 3))
    for i in range(3):
        for j in range(3):
            big.paste(img, (i * w, j * h))
    big = big.filter(ImageFilter.GaussianBlur(max(1, radius)))
    return big.crop((w, h, w * 2, h * 2))


def seamless_noise(size, amp, seed, blur=0):
    """低频可平铺噪声：先在 1/8 尺寸上做噪声、模糊后再双三次放大。

    为什么不在目标尺寸上直接大半径模糊：512 的噪声被半径 23 的核抹平之后标准差只剩 0.5，
    等于没有纹理（实测：纸纹 std 1.5，肉眼是一张塑料）。小尺寸起步能保住振幅。
    """
    small = max(8, size // 8)
    n = periodic_noise(small, amp, seed)
    n = tile_blur(n, blur if blur else max(1, small // 10))
    return n.resize((size, size), Image.BICUBIC) if n.size != (size, size) else n


# ---------------------------------------------------------------- 黑目规则（图标里的盘必须真的是解）

DIRS = ((0, -1), (1, 0), (0, 1), (-1, 0))


def sight_count(n, blacks, cell):
    """数字 = 自己那一格 + 四条视线在第一个黑格/边界之前穿过的每一格白格。"""
    if cell in blacks:
        raise AssertionError('黑格上不写字：图标里给黑格配了数字')
    cx, cy = cell
    total = 1
    for dx, dy in DIRS:
        x, y = cx + dx, cy + dy
        while 0 <= x < n and 0 <= y < n and (x, y) not in blacks:
            total += 1
            x += dx
            y += dy
    return total


def whites_connected(n, blacks):
    start = next(((x, y) for y in range(n) for x in range(n) if (x, y) not in blacks), None)
    if start is None:
        return False
    seen, stack = {start}, [start]
    while stack:
        cx, cy = stack.pop()
        for dx, dy in DIRS:
            p = (cx + dx, cy + dy)
            if 0 <= p[0] < n and 0 <= p[1] < n and p not in blacks and p not in seen:
                seen.add(p)
                stack.append(p)
    return len(seen) == n * n - len(blacks)


# 图标那块 5×5：黑格按 (x, y) 写死，数字由上面的规则现算，不手填。
ICON_N = 5
ICON_BLINDS = [(2, 0), (4, 1), (1, 2), (3, 3), (0, 4)]
ICON_CLUES = [(0, 0), (4, 4), (2, 2)]

# 社交卡那块 7×7：盘更大，视线拉得更长，右侧留白给文字。
OG_N = 7
OG_BLINDS = [(2, 0), (5, 1), (0, 3), (3, 3), (6, 3), (1, 5), (4, 6)]
OG_CLUES = [(2, 2), (4, 4), (0, 4), (6, 5)]


def validate_board(n, blacks, clues):
    bset = set(blacks)
    for (x, y) in bset:
        for dx, dy in ((1, 0), (0, 1)):
            if (x + dx, y + dy) in bset:
                raise AssertionError(f'黑不挨黑被破坏：({x},{y})')
    if not whites_connected(n, bset):
        raise AssertionError('白不断路被破坏')
    values = {}
    for c in clues:
        v = sight_count(n, bset, c)
        if not 1 <= v <= 9:
            raise AssertionError(f'数字 {v} 写不进一格')
        values[c] = v
    return values


def resolve_clues(n, blacks, want, limit=9):
    """把"想摆数字的位置"落成真正摆得下的那一格：一位数写不下 10 以上的视线和，所以从目标点
    按曼哈顿距离向外螺旋找第一格白格、且数字 ≤ limit。同一块黑格布局永远给出同一批格子。"""
    bset = set(blacks)
    taken, out = set(bset), {}
    for (wx, wy) in want:
        pick = None
        for dist in range(0, 2 * n):
            cand = [(x, y) for x in range(n) for y in range(n)
                    if abs(x - wx) + abs(y - wy) == dist and (x, y) not in bset and (x, y) not in taken]
            cand.sort(key=lambda c: (-c[0] + wx, c[1] - wy))
            good = [c for c in cand if 1 <= sight_count(n, bset, c) <= limit]
            if good:
                pick = good[0]
                break
        if pick is None:
            raise AssertionError(f'({wx},{wy}) 附近找不到一位数写得下的提示格')
        taken.add(pick)
        out[pick] = sight_count(n, bset, pick)
    return validate_board(n, blacks, sorted(out))



# ---------------------------------------------------------------- 纸与夜

def ink_field(size, seed=0):
    """夜色径向底：先在小尺寸上逐像素算渐变再双三次放大（同一条曲线，1/64 的代价）。"""
    small = 176
    c = (small - 1) / 2.0
    px = []
    for y in range(small):
        dy = (y - c * 0.86) / (small * 0.62)
        for x in range(small):
            dx = (x - c) / (small * 0.62)
            k = min(1.0, math.sqrt(dx * dx + dy * dy)) ** 1.6
            px.append(tuple(int(BG_BOTTOM[i] * (1 - k) + BG_TOP[i] * k) for i in range(3)))
    img = Image.new('RGB', (small, small))
    img.putdata(px)
    img = img.resize((size, size), Image.BICUBIC)
    grain = seamless_noise(min(size, 512), 34, seed + 11)
    if grain.size != (size, size):
        grain = grain.resize((size, size), Image.BICUBIC)
    dark = Image.new('RGB', (size, size), (0, 0, 0))
    img = Image.composite(dark, img, grain.point(lambda v: max(0, int((v - 128) * 0.42) + 3)))
    lite = Image.new('RGB', (size, size), (0x1A, 0x1A, 0x20))
    img = Image.composite(lite, img, grain.point(lambda v: max(0, int((128 - v) * 0.30))))
    return img.convert('RGBA')


def _signed(noise, scale=1.0, bias=0):
    """把均值 128 的噪声映射成 0..255 的 alpha 遮罩：正偏差往上、负偏差往下，两半各自叠一次。"""
    return noise.point(lambda v: max(0, min(255, int((v - 128) * scale) + bias)))


def paper_surface(size, seed=0, grain_amp=1.0):
    """一张和纸：暖斑 + 斜向纤维 + 两向颗粒。纤维与噪声都铺 3×3 再裁中心，所以平铺不出缝。

    这张纸就是游戏里盘面用的那张（assets/textures/paper-grain.png 与图标共用同一函数），
    所以"图标美术"和"盘上实况"是同一套画法，而不是两套对不上的图。
    """
    base = Image.new('RGB', (size, size), PAPER[:3])
    blot = seamless_noise(size, 150, seed + 3)
    warm = Image.new('RGB', (size, size), (0xDB, 0xD3, 0xC1))
    pale = Image.new('RGB', (size, size), (0xFC, 0xFA, 0xF4))
    img = Image.composite(warm, base, _signed(blot, 0.85))
    img = Image.composite(pale, img, _signed(blot, -0.7))

    fibers = Image.new('L', (size * 3, size * 3), 0)
    fd = ImageDraw.Draw(fibers)
    rnd = Lcg(seed + 5)
    for _ in range(int(size * 2.2)):
        x = rnd.randrange(size * 3)
        y = rnd.randrange(size * 3)
        ln = int(size * (0.02 + rnd.uniform(0, 0.075)))
        a = rnd.uniform(0, 2 * math.pi)
        dx, dy = int(ln * math.cos(a)), int(ln * math.sin(a))
        fd.line([(x, y), (x + dx, y + dy)], fill=rnd.randrange(70, 190), width=max(1, size // 320))
    fibers = tile_blur(fibers.crop((size, size, size * 2, size * 2)), max(1, size // 300))
    cool = Image.new('RGB', (size, size), (0xC4, 0xBD, 0xAC))
    img = Image.composite(cool, img, fibers.point(lambda v: int(v * 0.62)))

    grain = periodic_noise(size, 170, seed + 7)
    img = Image.composite(Image.new('RGB', (size, size), (0xA0, 0x99, 0x8A)), img,
                          _signed(grain, 0.46 * grain_amp))
    img = Image.composite(Image.new('RGB', (size, size), (0xFF, 0xFF, 0xFC)), img,
                          _signed(grain, -0.38 * grain_amp))
    return img.convert('RGBA')


# ---------------------------------------------------------------- 盘面绘制

def draw_board(img, size_wh, n, blacks, clue_values, *, origin=None, cell_px, pad_px,
               digits=True, ray_alpha=150, seed=0, grain_amp=1.0):
    """画一块 n×n 的黑目盘：纸、被 punch 掉的黑格、网格、数字圆盘与四条视线。

    同一份代码既画 1024 母图上的 5×5，也画社交卡上的 7×7 —— 图标准则与游戏内渲染同一套画法，
    这样"图标"不是另一套美术，而是这一盘缩小了的实况。
    """
    W, H = img.size
    cell = cell_px
    grid_w = cell * n
    if origin:
        gx, gy = origin
    else:
        gx = (size_wh[0] - grid_w) / 2.0 if isinstance(size_wh, tuple) else (W - grid_w) / 2.0
        gy = (size_wh[1] - grid_w) / 2.0 if isinstance(size_wh, tuple) else (H - grid_w) / 2.0
    gx, gy = int(round(gx)), int(round(gy))
    d = ImageDraw.Draw(img, 'RGBA')

    # 落在夜里的一层投影
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    o = pad_px * 0.75
    sd.rounded_rectangle([gx - o, gy - o + pad_px, gx + grid_w + o, gy + grid_w + o + pad_px],
                         radius=pad_px, fill=(0, 0, 0, 120))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(max(1.0, pad_px * 0.45))))

    # 纸：真纸纹裁成圆角片贴上去
    sheet_px = int(grid_w + pad_px * 2)
    tex = paper_surface(512, seed, grain_amp)
    if sheet_px != 512:
        tex = tex.resize((sheet_px, sheet_px), Image.LANCZOS)
    mask = Image.new('L', (sheet_px, sheet_px), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, sheet_px - 1, sheet_px - 1],
                                          radius=max(2, pad_px * 0.9), fill=255)
    sheet = Image.new('RGBA', (sheet_px, sheet_px), (0, 0, 0, 0))
    sheet.paste(tex, (0, 0), mask)
    img.alpha_composite(_at(sheet, gx - pad_px, gy - pad_px, W, H))

    d = ImageDraw.Draw(img, 'RGBA')
    d.rounded_rectangle([gx - pad_px, gy - pad_px, gx + grid_w + pad_px, gy + grid_w + pad_px],
                        radius=max(2, pad_px * 0.9), outline=(0, 0, 0, 52),
                        width=max(1, int(pad_px * 0.05)))

    # 墨：黑格铺满整格（不留纸缝，board.js 同一条理由），叠一层墨纹与顶光
    ink_tex = ink_grain_texture(max(8, int(cell) * n), seed + 13)
    for (bx, by) in blacks:
        rx, ry = int(gx + bx * cell), int(gy + by * cell)
        cw = int(math.ceil(cell))
        d.rectangle([rx, ry, rx + cw - 1, ry + cw - 1], fill=INK)
        crop = ink_tex.crop((int(bx * cell) % max(8, int(cell) * n), int(by * cell) % max(8, int(cell) * n),
                             min(ink_tex.width, int(bx * cell) + cw), min(ink_tex.height, int(by * cell) + cw)))
        img.alpha_composite(_at(crop, rx, ry, W, H))
        hl = max(1, int(cell * 0.022))
        d.line([rx, ry, rx + cw - 1, ry], fill=(0x3A, 0x3A, 0x46, 130), width=hl)
        d.line([rx, ry, rx, ry + cw - 1], fill=(0x2E, 0x2E, 0x38, 90), width=hl)

    # 网格：细纸边线 + 一圈重墨外框（外框权重就是 theme.js 里的 inkScale 0.055）
    lw = max(1, int(cell * 0.028))
    for i in range(n + 1):
        d.line([gx + i * cell, gy, gx + i * cell, gy + grid_w], fill=PAPER_EDGE, width=lw)
        d.line([gx, gy + i * cell, gx + grid_w, gy + i * cell], fill=PAPER_EDGE, width=lw)
    d.rectangle([gx - lw, gy - lw, gx + grid_w + lw, gy + grid_w + lw],
                outline=INK_EDGE, width=max(2, int(cell * 0.055)))

    # 数字与四条视线：每条视线画到它真正数完的那一格中心，末端一颗点——玩法本身。
    rad = cell * 0.36
    ray_w = max(2, int(cell * 0.055))
    font = load_font(FONT_NUM, int(cell * 0.44)) if digits else None
    for (cx, cy), value in sorted(clue_values.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        px, py = gx + (cx + 0.5) * cell, gy + (cy + 0.5) * cell
        for dx, dy in DIRS:
            x, y = cx + dx, cy + dy
            reach = 0
            while 0 <= x < n and 0 <= y < n and (x, y) not in blacks:
                reach += 1
                x += dx
                y += dy
            if not reach:
                continue
            ex = gx + (cx + dx * reach + 0.5) * cell
            ey = gy + (cy + dy * reach + 0.5) * cell
            d.line([px, py, ex, ey], fill=A(ACCENT, int(ray_alpha * 0.62)), width=ray_w)
            r = ray_w * 1.25
            d.ellipse([ex - r, ey - r, ex + r, ey + r], fill=A(ACCENT, min(255, ray_alpha + 40)))
        d.ellipse([px - rad, py - rad, px + rad, py + rad], fill=A(PAPER, 252),
                  outline=A(ACCENT, 255), width=max(2, int(rad * 0.17)))
        if font is not None:
            s = str(value)
            bb = font.getbbox(s)
            d.text((px - (bb[2] - bb[0]) / 2.0 - bb[0], py - (bb[3] - bb[1]) / 2.0 - bb[1]),
                   s, font=font, fill=CLUE_INK)
        else:
            k = rad * 0.32
            d.ellipse([px - k, py - k, px + k, py + k], fill=CLUE_INK)
    return (gx, gy, grid_w)


def _at(layer, x, y, W, H):
    """把一张小图贴到全幅透明层上——负坐标时不能直接 paste，所以统一走这里。"""
    big = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    big.paste(layer, (int(x), int(y)), layer)
    return big


# ---------------------------------------------------------------- 图标

def master_icon(size=1024, maskable=False, seed=7):
    img = ink_field(size, seed)
    values = resolve_clues(ICON_N, ICON_BLINDS, ICON_CLUES)
    cell = (size * 0.70) / ICON_N
    # 图标上的纸纹压到 1/3：母图最终只会被显示在 16–512px，满幅白噪声既看不见又让 PNG 翻三倍
    draw_board(img, None, ICON_N, ICON_BLINDS, values, cell_px=cell, pad_px=size * 0.055,
               digits=size >= 96, seed=seed, grain_amp=0.34)

    # 斜向高光 + 右下角一团琥珀光：让这一套图看起来是"同一盏灯下的一张纸"
    sheen = Image.new('L', (size, size), 0)
    sd = ImageDraw.Draw(sheen)
    sd.polygon([(0, size * 0.74), (size * 0.32, 0), (size * 0.70, 0), (0, size * 1.12)], fill=22)
    sd.polygon([(size, size * 0.18), (size * 0.64, size), (size * 0.88, size), (size, size * 0.5)], fill=13)
    sheen = tile_blur(sheen, max(2, int(size * 0.05)))
    img = Image.composite(Image.new('RGBA', (size, size), (255, 255, 255, 255)), img, sheen)

    flare = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    fd = ImageDraw.Draw(flare)
    r = size * 0.36
    fd.ellipse([size * 0.82 - r, size * 0.84 - r, size * 0.82 + r, size * 0.84 + r], fill=A(ACCENT, 24))
    fd.ellipse([size * 0.14 - r * 0.7, size * 0.16 - r * 0.7, size * 0.14 + r * 0.7, size * 0.16 + r * 0.7],
               fill=A(INFO, 14))
    img.alpha_composite(flare.filter(ImageFilter.GaussianBlur(max(2, int(size * 0.05)))))

    out = Image.new('RGB', (size, size), BG_TOP[:3])
    out.paste(img.convert('RGB'), (0, 0))
    if maskable:
        pad2 = int(size * 0.10)
        blank = Image.new('RGB', (size, size), BG_TOP[:3])
        blank.paste(out.resize((size - 2 * pad2, size - 2 * pad2), Image.LANCZOS), (pad2, pad2))
        out = blank
    return out


def compact_icon(size):
    """16/32/48：5×5 与数字在那儿是一团泥，只留"纸上一块墨 + 一颗琥珀视线"。"""
    img = Image.new('RGB', (size, size), BG_TOP[:3])
    d = ImageDraw.Draw(img, 'RGBA')
    m = max(1, int(round(size * 0.15)))
    r = max(1, size * 0.16)
    d.rounded_rectangle([m, m, size - m - 1, size - m - 1], radius=r, fill=PAPER[:3])
    inner = size - 2 * m
    q = inner / 2.0
    d.rectangle([m + q, m, size - m - 1, m + q], fill=INK[:3])
    d.rectangle([m, m + q, m + q, size - m - 1], fill=INK[:3])
    rad = max(1.6, size * 0.115)
    cx, cy = m + q * 0.5, m + q * 1.5
    lw = max(1, int(size * 0.045))
    if size >= 32:
        d.line([cx + rad, cy, size - m - lw, cy], fill=ACCENT[:3], width=lw)
        d.line([cx, cy - rad, cx, m + lw], fill=ACCENT[:3], width=lw)
    d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=PAPER[:3], outline=ACCENT[:3], width=lw)
    return img.convert('RGB')


SIZES = [1024, 512, 192, 180, 96, 64, 48, 32, 16]
GLYPHS = ['sound-on', 'sound-off', 'pause', 'resume', 'restart', 'fullscreen', 'motion']


# ---------------------------------------------------------------- 社交卡

def og_cover(w=1200, h=630, seed=21):
    img = Image.new('RGBA', (w, h), BG_TOP[:3] + (255,))
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = 0.5 - 0.5 * math.cos(x / float(w) * math.pi)
            px[x, y] = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)) + (255,)
    grain = seamless_noise(512, 34, seed + 4).resize((w, h), Image.BICUBIC)
    img = Image.composite(Image.new('RGBA', (w, h), (0, 0, 0, 255)), img,
                          grain.point(lambda v: max(0, int((v - 128) * 0.45) + 2)))

    values = resolve_clues(OG_N, OG_BLINDS, OG_CLUES)
    cell = 66.0
    grid_w = cell * OG_N
    origin_x = w - grid_w - 116
    origin_y = (h - grid_w) / 2.0
    draw_board(img, None, OG_N, OG_BLINDS, values, origin=(origin_x, origin_y),
               cell_px=cell, pad_px=20, digits=True, ray_alpha=126, seed=seed, grain_amp=0.5)

    d = ImageDraw.Draw(img, 'RGBA')
    tx = 84
    title = load_font(FONT_CJK, 116)
    sub = load_font(FONT_NUM, 40)
    body = load_font(FONT_CJK, 31)
    small = load_font(FONT_NUM, 20)
    d.text((tx, 84), '黑目', font=title, fill=CLOUD)
    d.text((tx + 6, 232), 'KUROMASU · KURODOKO', font=sub, fill=A(ACCENT, 235))
    for i, line in enumerate(['涂黑格子，让每个数字', '正好看见它说的那许多白格。']):
        d.text((tx, 306 + i * 48), line, font=body, fill=CLOUD[:3] + (228,))
    d.text((tx, 424), '零猜测 · 每局唯一解', font=body, fill=A(INFO, 235))
    d.text((tx, 466), '难度分与档位区间都是量出来的', font=body, fill=A(INFO, 235))
    d.line([tx, 522, tx + 214, 522], fill=A(ACCENT, 210), width=4)
    d.text((tx, 544), 'web · canvas · electron', font=small, fill=CLOUD[:3] + (150,))
    d.text((tx, 574), 'no guessing — every board proved unique', font=small,
           fill=CLOUD[:3] + (110,))
    flare = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    fd = ImageDraw.Draw(flare)
    fd.ellipse([origin_x - 60, 60, origin_x + grid_w + 120, h + 40], fill=A(ACCENT, 20))
    img.alpha_composite(flare.filter(ImageFilter.GaussianBlur(80)))
    return img.convert('RGB')


# ---------------------------------------------------------------- 纹理 / sprite / 字形

def paper_grain_texture(size=512, seed=31):
    return paper_surface(size, seed).convert('RGB')


def ink_grain_texture(size, seed=41):
    """黑格上极淡的亮斑：alpha 就是噪点本身，所以叠在黑格上只改质感、不改颜色判定（板面判黑靠
    引擎，不靠这里画了多少）。"""
    n = max(8, int(size))
    src = tile_blur(periodic_noise(96, 200, seed), 1).resize((n, n), Image.BICUBIC)
    out = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    op, np = out.load(), src.load()
    for y in range(n):
        for x in range(n):
            op[x, y] = (0x52, 0x52, 0x60, max(0, min(70, int((np[x, y] - 112) * 0.55))))
    return out


def amber_burst(size=256, seed=63):
    """琥珀光爆：径向衰减 + 四道主芒 + 八道细碎，胜利与提示共用这一张 sprite。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    px = img.load()
    c = (size - 1) / 2.0
    for y in range(size):
        dy = (y - c) / c
        for x in range(size):
            dx = (x - c) / c
            r = math.sqrt(dx * dx + dy * dy)
            if r >= 1.0:
                continue
            fall = 1 - r
            core = fall ** 3.4
            ang = math.atan2(dy, dx)
            flare = max(0.0, math.cos(ang * 2.0)) ** 9 * fall ** 1.7
            sparkle = max(0.0, math.cos(ang * 8.0 + 0.6)) ** 24 * fall ** 2.6
            v = min(1.0, core * 0.95 + flare * 0.6 + sparkle * 0.34)
            if v <= 0.004:
                continue
            t = min(1.0, core * 1.5)
            px[x, y] = (
                min(255, int(ACCENT[0] * (0.78 + 0.22 * t) + 30 * t)),
                min(255, int(ACCENT[1] * (0.76 + 0.24 * t) + 26 * t)),
                min(255, int(ACCENT[2] * (0.60 + 0.40 * t))),
                int(255 * v),
            )
    return img


def ui_glyph(name, size=96):
    """HUD 字形：圆头笔画、2px 网格、只有纸白与琥珀两色——和按钮文案说同一件事。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, 'RGBA')
    u = size / 24.0
    w = max(2, int(round(size * 0.075)))
    ink = A(ACCENT, 255) if name in ('pause', 'resume', 'motion') else CLOUD
    dim = CLOUD[:3] + (140,)

    def L(*pts, **kw):
        d.line([(x * u, y * u) for x, y in pts], fill=kw.get('fill', ink),
               width=kw.get('width', w), joint='curve')

    if name == 'sound-on':
        L((4, 9), (8, 9), (12, 5), (12, 19), (8, 15), (4, 15), (4, 9), fill=CLOUD)
        for r in (4, 7):
            d.arc([13 * u - r * u, 12 * u - r * u, 13 * u + r * u, 12 * u + r * u], -58, 58,
                  fill=A(ACCENT, 255), width=w)
    elif name == 'sound-off':
        L((4, 9), (8, 9), (12, 5), (12, 19), (8, 15), (4, 15), (4, 9), fill=dim)
        L((15, 9), (21, 15), fill=(0xFF, 0x5C, 0x7A, 255))
        L((21, 9), (15, 15), fill=(0xFF, 0x5C, 0x7A, 255))
    elif name == 'pause':
        for x in (8, 15):
            d.rounded_rectangle([x * u, 5 * u, (x + 2.6) * u, 19 * u], radius=u * 0.6, fill=ink)
    elif name == 'resume':
        d.polygon([(8 * u, 5 * u), (20 * u, 12 * u), (8 * u, 19 * u)], fill=ink)
    elif name == 'restart':
        d.arc([5 * u, 5 * u, 19 * u, 19 * u], 300, 200, fill=ink, width=w)
        L((16.4, 3.6), (19.4, 6.6), (15.2, 8.4), width=max(2, int(w * 0.85)))
    elif name == 'fullscreen':
        for cx, cy, sx, sy in ((4, 4, 1, 1), (20, 4, -1, 1), (4, 20, 1, -1), (20, 20, -1, -1)):
            L((cx, cy + 5 * sy), (cx, cy), (cx + 5 * sx, cy))
    elif name == 'motion':
        d.ellipse([6 * u, 6 * u, 18 * u, 18 * u], outline=ink, width=w)
        L((12, 12), (12, 7.6))
        L((12, 12), (15.8, 13.6))
    else:
        raise AssertionError('未知字形 ' + name)
    return img


# ---------------------------------------------------------------- 出货

def read_ihdr(path):
    with open(path, 'rb') as f:
        head = f.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n':
        raise AssertionError(f'{path} 不是 PNG')
    w, h = struct.unpack('>II', head[16:24])
    return w, h


def plan():
    rows = [f'icons/icon-{s}.png' for s in SIZES]
    rows += [f'icons/icon-maskable-{s}.png' for s in (512, 192)]
    rows += ['icons/apple-touch-icon.png', 'icons/favicon-32.png', 'icons/favicon-16.png',
             'assets/og-cover.png', 'assets/textures/paper-grain.png', 'assets/textures/ink-grain.png',
             'assets/sprites/amber-burst.png']
    rows += [f'assets/ui/{g}.png' for g in GLYPHS]
    return rows


def build():
    written = []

    def emit(rel, img, note=''):
        p = os.path.join(REPO, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        img.save(p, 'PNG', optimize=True)
        w, h = read_ihdr(p)
        size = os.path.getsize(p)
        if size <= 0:
            raise AssertionError(f'{rel} 是 0 字节')
        written.append({'path': rel, 'w': w, 'h': h, 'bytes': size, 'note': note})

    master = master_icon(1024)
    emit('icons/icon-1024.png', master, '母图')
    for s in [x for x in SIZES if x != 1024]:
        if s <= 48:
            emit(f'icons/icon-{s}.png', compact_icon(s), '紧凑母题')
        else:
            emit(f'icons/icon-{s}.png', master.resize((s, s), Image.LANCZOS), '母图缩放')
    for s in (512, 192):
        emit(f'icons/icon-maskable-{s}.png', master_icon(s, maskable=True), 'maskable 80% 安全区')
    emit('icons/apple-touch-icon.png', master.resize((180, 180), Image.LANCZOS), 'iOS 桌面')
    emit('icons/favicon-32.png', compact_icon(32), 'favicon')
    emit('icons/favicon-16.png', compact_icon(16), 'favicon')
    emit('assets/og-cover.png', og_cover(), '社交卡')
    # 256 见方：盘面格子只有 26–62px，纹理是平铺用的，做 512 只是把首屏多压 250KB 的白噪声
    emit('assets/textures/paper-grain.png', paper_grain_texture(256), '可平铺纸纹（盘面上屏）')
    emit('assets/textures/ink-grain.png', ink_grain_texture(256), '可平铺墨纹 RGBA（黑格上屏）')
    emit('assets/sprites/amber-burst.png', amber_burst(256), '光爆 sprite RGBA')
    for g in GLYPHS:
        emit(f'assets/ui/{g}.png', ui_glyph(g, 96), f'HUD 字形 {g}')

    manifest = {
        'generator': 'assets/gen/make_art.py',
        'reproduce': 'python3 assets/gen/make_art.py',
        'motif': 'punched-paper-and-sight-rays',
        'palette': {'paper': '#F3EFE6', 'ink': '#121216', 'accent': '#FFC85C', 'night': '#0B0B0D'},
        'iconBoard': {'n': ICON_N, 'blacks': [[x, y] for x, y in ICON_BLINDS],
                      'clues': [{'cell': [x, y], 'digit': v} for (x, y), v in
                                resolve_clues(ICON_N, ICON_BLINDS, ICON_CLUES).items()]},
        'ogBoard': {'n': OG_N, 'blacks': [[x, y] for x, y in OG_BLINDS],
                    'clues': [{'cell': [x, y], 'digit': v} for (x, y), v in
                              resolve_clues(OG_N, OG_BLINDS, OG_CLUES).items()]},
        'files': written,
    }
    with open(os.path.join(REPO, 'icons', 'icon-manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)
        f.write('\n')
    return manifest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sizes', action='store_true', help='只列将要产出的文件')
    a = ap.parse_args()
    if a.sizes:
        for p in plan():
            print(p)
        return 0
    man = build()
    print(f"motif={man['motif']}  图标盘 clues={[(c['cell'], c['digit']) for c in man['iconBoard']['clues']]}")
    for r in man['files']:
        print(f"{r['path']:38s} {r['w']}x{r['h']:<5d} {r['bytes']:8d}B  {r['note']}")
    print(f"共 {len(man['files'])} 张 PNG -> {REPO}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
