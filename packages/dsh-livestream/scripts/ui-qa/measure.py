"""画布 UI 的客观验收：读 capture 拍的 <布景>-<场景>.png/.json，加上源码检查，给 PASS/FAIL。
用法：python3 scripts/ui-qa/measure.py <截图目录> [--baseline <改动前的截图目录>]
需要 Pillow。最后一行 ALL PASS 才算过；任何 FAIL 都不算完成。

量什么：
  源码  画布样式（stage.css 里画布元素的规则）不写死颜色，颜色都走变量；布景只改变量，不逐个元素打补丁；深色布景换了标题字体
  截图  深色布景的画布元素里没有浅色布景的颜色（淡蓝白底、品牌蓝）；每个元素自己的明暗反差够（字看得清）
  布局  元素框和改动前一致（只换皮肤，不动编排）
"""
import json, os, re, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SETS = ["ocean-study", "midnight-tales"]
args = sys.argv[1:]
D = args[0]
BASE = args[args.index("--baseline") + 1] if "--baseline" in args else None

# 画布元素用到的类（src/page/draw/*.tsx）；这些规则里不许出现颜色字面量
CANVAS = re.compile(r"\.(draw|clue-pin|flow-(arrow|step)|fx-(arrow|highlight|pulse|ring|seal|stamp|strike|wave)|guess-(answer|median|plot)|poll-(bar|row)|race-row|score-(axis|bins)|soup-(back|cols?|face)|tier-(chip|items|judging|row|votes)|tl-(axis|dot|node)|vs-side|wall-pf|link-spark)\b")
LITERAL = re.compile(r"#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(")
# 截图里不该在深色布景出现的颜色：浅色布景的淡蓝白底、品牌蓝
def pale(r, g, b): return r >= 200 and g >= 205 and b >= 225 and b - r >= 12
def brand(r, g, b): return b >= 180 and b - r >= 70 and r < 150
NO_INK = {"image", "sticker"}  # 不量反差的（图片、emoji）

rows, ok = [], True
def check(name, passed, val):
    global ok
    rows.append(f"{'PASS' if passed else 'FAIL'}  {name}  ({val})"); ok &= bool(passed)

def rules(path):
    css = re.sub(r"/\*.*?\*/", "", open(path, encoding="utf8").read(), flags=re.S)
    return [(m.group(1).strip(), m.group(2)) for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css)]

# ---- 源码 ----
stage_css = os.path.join(ROOT, "src/page/stage.css")
bad = [sel for sel, body in rules(stage_css) if CANVAS.search(sel) and not sel.startswith(".stage[data-set") and LITERAL.search(body)]
check("源码 stage.css 画布规则里写死的颜色 = 0", not bad, f"{len(bad)} 条：{'; '.join(s[:50] for s in bad[:6])}")
for s in SETS:
    path = os.path.join(ROOT, "sets", s, "set.css")
    per_item = [sel for sel, body in rules(path) if CANVAS.search(sel)]
    check(f"源码 {s}/set.css 逐个画布元素打补丁的规则 ≤ 4（其余走变量）", len(per_item) <= 4, len(per_item))
mt = open(os.path.join(ROOT, "sets/midnight-tales/set.css"), encoding="utf8").read()
check("源码 midnight-tales 换了标题字体（覆盖 --display）", re.search(r"--display\s*:", mt) is not None, "有" if re.search(r"--display\s*:", mt) else "没有")

# ---- 截图 ----
shots = sorted(f[:-5] for f in os.listdir(D) if f.endswith(".json"))
check("截图齐全：两个布景 × 15 个场景", len(shots) == 30, len(shots))
for shot in shots:
    boxes = json.load(open(os.path.join(D, shot + ".json")))
    im = Image.open(os.path.join(D, shot + ".png")).convert("RGB")
    dark = shot.startswith("midnight-tales")
    for i, bx in enumerate(boxes):
        x0, y0 = max(0, bx["x"]), max(0, bx["y"])
        x1, y1 = min(im.width, bx["x"] + bx["w"]), min(im.height, bx["y"] + bx["h"])
        if x1 - x0 < 8 or y1 - y0 < 8: continue
        crop = im.crop((x0, y0, x1, y1))
        px = list(crop.get_flattened_data() if hasattr(crop, 'get_flattened_data') else crop.getdata())
        tag = f"{shot} #{i} {bx['kind']}"
        if dark and bx["kind"] not in NO_INK:
            leak = sum(1 for p in px if pale(*p) or brand(*p)) / len(px) * 100
            check(f"截图 {tag} 浅色布景的颜色 < 0.5%", leak < 0.5, f"{leak:.2f}%")
        if bx["kind"] not in NO_INK:
            lum = sorted(0.299 * r + 0.587 * g + 0.114 * b for r, g, b in px)
            spread = lum[int(len(lum) * 0.99)] - lum[int(len(lum) * 0.01)]
            check(f"截图 {tag} 明暗反差 ≥ 100", spread >= 100, round(spread))

# ---- 布局：只换皮肤，元素框不变 ----
if BASE:
    for shot in shots:
        b0 = os.path.join(BASE, shot + ".json")
        if not os.path.exists(b0): check(f"布局 {shot} 有改动前的框", False, "缺基线"); continue
        a, b = json.load(open(b0)), json.load(open(os.path.join(D, shot + ".json")))
        same = len(a) == len(b) and all(p["kind"] == q["kind"] and max(abs(p[k] - q[k]) for k in "xywh") <= 8 for p, q in zip(a, b))
        check(f"布局 {shot} 元素框和改动前一致（±8px）", same, f"{len(a)}→{len(b)} 个")
else:
    check("布局 给了 --baseline 改动前的截图目录", False, "没给")

print("\n".join(rows))
print("ALL PASS" if ok else "HAS FAIL")
