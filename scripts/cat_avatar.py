"""
小屋分身（方案 E）：用小屋自己的插画猫 assets/art/cat-sit.svg 当模板，
按真猫照片的毛色 / 肚皮色 / 条纹重新上色。画风和小屋 100% 一致，毛色像「那一只」。

模板里可换的三种颜色：
  #f08a4b  身体（含尾巴）
  #ffe9d2  肚皮、口鼻、爪子
  #c95f2a  条纹
描边 #2b2622、耳内粉、腮红、鼻子保持不变。

用法：python scripts/cat_avatar.py 猫照片.jpg [输出目录]
"""
import colorsys
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "miniprogram" / "assets" / "art" / "cat-sit.svg"
BODY, BELLY, STRIPE = "#f08a4b", "#ffe9d2", "#c95f2a"


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(int(max(0, min(255, round(c)))) for c in rgb)


def _lum(rgb):
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]


def _tune(rgb, sat=1.15, light=0.0):
    """往插画色靠：略提饱和度，可整体提亮"""
    h, l, s = colorsys.rgb_to_hls(*(np.asarray(rgb, dtype=float) / 255))
    s = min(1.0, s * sat)
    l = min(0.96, l + light * (1 - l))
    return [c * 255 for c in colorsys.hls_to_rgb(h, l, s)]


def coat_from_cutout(rgba):
    """从抠图里读毛色：主色、浅色（肚皮）、深色（条纹），并判断是不是虎斑 / 纯黑 / 白肚"""
    arr = np.asarray(rgba)
    px = arr[arr[..., 3] > 200][:, :3]
    if len(px) < 50:
        return None
    if len(px) > 40000:
        px = px[np.random.default_rng(0).choice(len(px), 40000, replace=False)]
    side = int(np.ceil(np.sqrt(len(px))))
    pad = np.zeros((side * side, 3), dtype=np.uint8)
    pad[: len(px)] = px
    q = Image.fromarray(pad.reshape(side, side, 3), "RGB").quantize(colors=5, method=Image.Quantize.MEDIANCUT, kmeans=4)
    labels = np.asarray(q).reshape(-1)[: len(px)]
    pal = np.array(q.getpalette()[:15], dtype=float).reshape(5, 3)
    share = np.bincount(labels, minlength=5) / len(labels)
    clusters = sorted(
        [{"rgb": pal[i], "share": float(share[i]), "lum": _lum(pal[i])} for i in range(5) if share[i] > 0.03],
        key=lambda c: c["lum"],
    )
    dark, light = clusters[0], clusters[-1]
    body = max(clusters, key=lambda c: c["share"])

    if body["lum"] < 75:  # 黑猫 / 深色猫：身体用暖墨偏灰，条纹再深一点
        base = _tune(body["rgb"], sat=1.0, light=0.12)
        stripe = [c * 0.7 for c in base]
        pattern = "solid-dark"
    elif dark["lum"] < body["lum"] - 30 and dark["share"] > 0.06:
        base = _tune(body["rgb"], light=0.08)
        stripe = _tune(dark["rgb"], sat=1.1)
        pattern = "tabby"
    else:
        base = _tune(body["rgb"], light=0.08)
        stripe = [c * 0.85 for c in base]  # 没有明显条纹：用同色系深一点，几乎看不出
        pattern = "solid"

    if light["lum"] > 175 and light["share"] > 0.08 and light is not body:
        belly = _tune(light["rgb"], sat=0.9, light=0.15)
        pattern += "+white"
    else:
        belly = _tune(base, sat=0.7, light=0.55)  # 没有白肚：用主色的浅色版

    return {
        "body": _hex(base),
        "belly": _hex(belly),
        "stripe": _hex(stripe),
        "pattern": pattern,
        "clusters": [{"hex": _hex(c["rgb"]), "share": round(c["share"], 2)} for c in clusters],
    }


def avatar_svg(coat, template=None):
    svg = (template or TEMPLATE.read_text(encoding="utf-8"))
    return svg.replace(BODY, coat["body"]).replace(BELLY, coat["belly"]).replace(STRIPE, coat["stripe"])


PRESETS = {
    "橘猫（示意）": {"body": "#f08a4b", "belly": "#ffe9d2", "stripe": "#c95f2a"},
    "奶牛猫（示意）": {"body": "#3b3431", "belly": "#fbf7f0", "stripe": "#2b2622"},
    "三花（示意）": {"body": "#e8a35c", "belly": "#fbf7f0", "stripe": "#4a3a30"},
}


def _demo(src, out_dir):
    from rembg import new_session, remove

    out_dir.mkdir(parents=True, exist_ok=True)
    photo = Image.open(src).convert("RGB")
    photo.thumbnail((640, 640))
    cut = remove(photo, session=new_session("u2net"))
    coat = coat_from_cutout(cut)
    stem = Path(src).stem
    photo.save(out_dir / f"{stem}_photo.jpg", quality=90)
    cut.save(out_dir / f"{stem}_cutout.png")
    (out_dir / f"{stem}_avatar.svg").write_text(avatar_svg(coat), encoding="utf-8")
    (out_dir / f"{stem}_coat.json").write_text(json.dumps(coat, ensure_ascii=False, indent=2), encoding="utf-8")

    template = TEMPLATE.read_text(encoding="utf-8")
    presets = "".join(
        f'<div class="mini"><div class="room small">{avatar_svg(c, template)}</div><p>{name}</p></div>'
        for name, c in PRESETS.items()
    )
    swatches = "".join(f'<span style="background:{c["hex"]}"></span>' for c in coat["clusters"])
    html = f"""<!doctype html><meta charset="utf-8"><style>
body{{margin:0;background:#fbf7f0;font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#2b2622}}
.row{{display:flex;gap:16px;padding:20px 20px 8px}}
.cell{{width:300px;text-align:center}}
.box{{width:300px;height:300px;background:#fffdf9;border-radius:18px;display:flex;align-items:center;justify-content:center;overflow:hidden}}
.box img{{max-width:270px;max-height:270px}}
.room{{width:300px;height:300px;border-radius:18px;background:linear-gradient(#eaf3ee 0 64%,#cbb79a 64%);display:flex;align-items:flex-end;justify-content:center;padding-bottom:22px;box-sizing:border-box}}
.room svg{{width:170px;height:198px}}
.room.small{{width:200px;height:200px;padding-bottom:14px}}
.room.small svg{{width:110px;height:128px}}
p{{margin:10px 0 0;font-size:15px}}
.sw span{{display:inline-block;width:26px;height:26px;border-radius:6px;margin:6px 3px 0;border:1px solid #0002}}
.minis{{display:flex;gap:16px;padding:8px 20px 20px}}
.mini{{width:200px;text-align:center}}
</style>
<div class="row">
 <div class="cell"><div class="box"><img src="{stem}_photo.jpg"></div><p>原图</p></div>
 <div class="cell"><div class="box"><img src="{stem}_cutout.png"></div><p>真猫贴纸（图鉴里用）</p></div>
 <div class="cell"><div class="room">{avatar_svg(coat, template)}</div><p>小屋分身（按它的毛色上色）</p>
  <div class="sw">{swatches}</div><p style="font-size:12px;color:#7a6e63">从照片提取的毛色 · {coat["pattern"]}</p></div>
</div>
<div class="minis">{presets}</div>"""
    (out_dir / f"{stem}_compare.html").write_text(html, encoding="utf-8")
    print(json.dumps(coat, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法：python scripts/cat_avatar.py 猫照片.jpg [输出目录]")
        sys.exit(1)
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).parent / ".rembg-out" / "avatar"
    _demo(sys.argv[1], target)
