"""基础特效的客观验收：读 capture.mjs 拍的三张图，算指标，对照阈值给 PASS/FAIL。
用法：python3 scripts/fx-qa/measure.py /Users/Ruihan/orca/projects/aivtb/.deps/tasks/shots/fx
需要 Pillow（pip install pillow）。输出一张表，最后一行是总结果；任何 FAIL 都不算完成。
"""
import sys, os
from PIL import Image, ImageChops, ImageStat

D = sys.argv[1]
SETS = ["ocean-study", "midnight-tales"]
W, H = 1920, 1080
# 区域（舞台坐标）：画布主体、四周边缘带、人物周围（展示布局下人物在右下）
CANVAS = (120, 196, 1364, 796)
EDGE_BANDS = [(0, 0, W, 120), (0, H - 120, W, H), (0, 0, 160, H), (W - 160, 0, W, H)]
AVATAR = (1500, 620, 1900, 1080)

def img(name): return Image.open(os.path.join(D, name)).convert("RGB")
def lum(im, box=None):
    im = im.crop(box) if box else im
    return ImageStat.Stat(im.convert("L")).mean[0]
def rgb(im, box=None):
    im = im.crop(box) if box else im
    return ImageStat.Stat(im).mean
def edge_lum(im): return sum(lum(im, b) for b in EDGE_BANDS) / len(EDGE_BANDS)
def diff(a, b, box=None):
    if box: a, b = a.crop(box), b.crop(box)
    return ImageStat.Stat(ImageChops.difference(a, b).convert("L")).mean[0]
def texture(im, box):
    return ImageStat.Stat(im.crop(box).convert("L")).stddev[0]

def check(set_, prim):
    b, p, a = img(f"{set_}-{prim}-before.png"), img(f"{set_}-{prim}-peak.png"), img(f"{set_}-{prim}-after.png")
    res = []
    # 通用：效果结束后画面回到原样（没有残留）
    res.append(("结束后无残留 diff<4", diff(b, a) < 4, round(diff(b, a), 2)))
    # 通用：高峰时确实看得出变化
    if prim != "shake": res.append(("高峰有变化 diff>6", diff(b, p) > 6, round(diff(b, p), 2)))
    if prim == "flash":
        d = lum(p) - lum(b); res.append(("全屏变亮 ≥40", d >= 40, round(d, 1)))
    elif prim == "dark":
        d = lum(b, CANVAS) - lum(p, CANVAS); res.append(("画布变暗 ≥ 原亮度 55%", d >= 0.55 * lum(b, CANVAS), round(d, 1)))
        k = lum(p, AVATAR) / max(1, lum(b, AVATAR)); res.append(("人物周围保留 ≥ 55% 亮度", k >= 0.55, round(k, 2)))
    elif prim == "pulse":
        # 边缘带变色（变暗或泛红都算），中心基本不动
        e = sum(diff(b, p, bx) for bx in EDGE_BANDS) / len(EDGE_BANDS); c = diff(b, p, (700, 400, 1200, 700))
        res.append(("边缘带明显变化 ≥12", e >= 12, round(e, 1))); res.append(("中心基本不变 ≤6", c <= 6, round(c, 1)))
    elif prim == "shake":
        # 画面整体位移：在 ±16px 里找让高峰帧和原帧对得最齐的偏移，偏移量要 ≥4px
        box = (400, 300, 1200, 800)
        ref = b.crop(box).convert("L").resize((200, 125)); best, off = 1e9, (0, 0)
        for dx in range(-16, 17, 2):
            for dy in range(-16, 17, 2):
                cand = p.crop((box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy)).convert("L").resize((200, 125))
                d = ImageStat.Stat(ImageChops.difference(ref, cand)).mean[0]
                if d < best: best, off = d, (dx, dy)
        mag = (off[0] ** 2 + off[1] ** 2) ** 0.5
        res.append(("整体位移 ≥4px", mag >= 4, f"{off}"))
    elif prim == "static":
        t = texture(p, CANVAS) - texture(b, CANVAS); res.append(("画布纹理变乱 ≥8", t >= 8, round(t, 1)))
    elif prim == "fog":
        e = edge_lum(p) - edge_lum(b); res.append(("边缘变亮发白 ≥20", e >= 20, round(e, 1)))
    elif prim == "burst":
        d = diff(b, p, CANVAS); res.append(("画布上有粒子 diff≥5", d >= 5, round(d, 2)))
    elif prim == "sweep":
        # 光带：高峰帧里最亮的那一竖条比原来亮很多
        cols = [lum(p, (x, 0, x + 80, H)) - lum(b, (x, 0, x + 80, H)) for x in range(0, W, 80)]
        res.append(("有一道竖向光带（某列变亮 ≥35）", max(cols) >= 35, round(max(cols), 1)))
    elif prim == "tint":
        cb, cp = rgb(b), rgb(p)
        shift = (cp[2] - cp[0]) - (cb[2] - cb[0]); res.append(("整体偏蓝 ≥12", shift >= 12, round(shift, 1)))
    return res

rows, ok = [], True
for s in SETS:
    for prim in ["flash", "dark", "pulse", "shake", "static", "fog", "burst", "sweep", "tint"]:
        try:
            for name, passed, val in check(s, prim):
                rows.append(f"{'PASS' if passed else 'FAIL'}  {s:15} {prim:7} {name}  ({val})"); ok &= passed
        except FileNotFoundError as e:
            rows.append(f"FAIL  {s:15} {prim:7} 缺截图 {e.filename}"); ok = False
print("\n".join(rows))
print("ALL PASS" if ok else "HAS FAIL")
