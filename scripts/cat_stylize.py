"""
小屋画风化（方案 A，不用 AI）：把抠好的真猫变成「扁平填色 + 暖墨描边」的涂鸦贴纸。
和 miniprogram/assets/art/*.svg 的小屋插画对齐：暖墨 #2b2622 描边、少量扁平色块。
保留真猫的毛色和花纹分布，所以卡通分身看起来还是「那一只」。

用法：
  在 rembg-server.py 里：POST /api/remove?style=doodle  → 返回画风化后的 PNG
  单独试效果：python scripts/cat_stylize.py 猫照片.jpg [输出目录]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

INK = np.array([43, 38, 34], dtype=np.float32)  # 暖墨 #2b2622，与小屋插画描边一致
COLORS = 5            # 扁平色块数量：太少丢花纹，太多像照片
OUTLINE_RATIO = 0.022  # 外描边粗细 ≈ 短边的 2.2%（小屋插画约 2.7%）
INNER_LINE_DIFF = 95   # 相邻色块亮度差超过它才画内线（猫纹、眼睛）
SEG_SIDE = 170         # 在这个尺寸上分色：色块更大更整，像手绘平涂
DARK_PERCENT = 8       # 原图最暗的这部分（眼睛、瞳孔、深色条纹）单独描成暖墨，保住神态
MIN_REGION = 0.004     # 小于猫面积 0.4% 的碎色块并进周围


def _largest_solid(alpha):
    solid = alpha >= 128
    labels, n = ndimage.label(solid)
    if n > 1:
        sizes = ndimage.sum(solid, labels, range(1, n + 1))
        solid = labels == (int(np.argmax(sizes)) + 1)
    return ndimage.binary_fill_holes(solid)


def _smooth_mask(mask, sigma):
    """去掉毛发碎边，得到卡通一样圆润的轮廓"""
    blurred = ndimage.gaussian_filter(mask.astype(np.float32), sigma)
    return blurred >= 0.5


def _disk(r):
    yy, xx = np.ogrid[-r : r + 1, -r : r + 1]
    return xx * xx + yy * yy <= r * r


def _flat_palette(palette):
    """色块调得更「插画」：略提饱和、往亮处收，最暗的一档统一成暖墨偏棕"""
    pal = palette.astype(np.float32)
    lum = pal @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    gray = lum[:, None]
    pal = np.clip(gray + (pal - gray) * 1.35, 0, 255)          # 饱和度 +35%，避免发灰
    pal = np.clip(pal * 0.88 + 255 * 0.12, 0, 255)              # 整体提亮，像水彩平涂
    darkest = int(np.argmin(lum))
    if lum[darkest] < 70:
        pal[darkest] = pal[darkest] * 0.4 + INK * 0.6           # 深色斑纹 / 眼睛 → 暖墨棕
    return pal


def stylize(rgba):
    """rgba: HxWx4 uint8（抠图结果）→ 画风化后的 RGBA PIL 图（已按内容裁边）"""
    rgba = np.asarray(rgba, dtype=np.uint8)
    solid = _largest_solid(rgba[..., 3])
    if solid.sum() < 64:
        return Image.fromarray(rgba, "RGBA")

    ys, xs = np.where(solid)
    h, w = int(ys.max() - ys.min() + 1), int(xs.max() - xs.min() + 1)
    short = min(h, w)
    outline = int(max(3, round(short * OUTLINE_RATIO)))
    pad = outline + 4

    # 裁到猫附近并留出描边位置
    y0, y1 = max(0, ys.min() - pad), min(rgba.shape[0], ys.max() + 1 + pad)
    x0, x1 = max(0, xs.min() - pad), min(rgba.shape[1], xs.max() + 1 + pad)
    crop = rgba[y0:y1, x0:x1]
    mask = solid[y0:y1, x0:x1]
    ph = np.zeros((crop.shape[0] + pad * 2, crop.shape[1] + pad * 2, 4), dtype=np.uint8)
    ph[pad:-pad, pad:-pad] = crop
    pm = np.zeros(ph.shape[:2], dtype=bool)
    pm[pad:-pad, pad:-pad] = mask
    crop, mask = ph, pm

    # 1) 平滑轮廓
    mask = _smooth_mask(mask, sigma=max(1.5, short * 0.006))

    # 2) 缩小后磨皮、分色：色块更大更整；背景填平均色，避免背景自成一档
    H, W = mask.shape
    rgb = crop[..., :3].copy()
    mean = rgb[mask].mean(axis=0) if mask.any() else np.array([200, 200, 200])
    rgb[~mask] = mean.astype(np.uint8)
    scale = min(1.0, SEG_SIDE / max(1, min(H, W)))
    small = Image.fromarray(rgb, "RGB").resize((max(8, int(W * scale)), max(8, int(H * scale))), Image.LANCZOS)
    for _ in range(2):
        small = small.filter(ImageFilter.MedianFilter(3))
    q = small.quantize(colors=COLORS, method=Image.Quantize.MEDIANCUT, kmeans=4)
    pal = np.array(q.getpalette()[: COLORS * 3], dtype=np.float32).reshape(-1, 3)
    small_labels = np.asarray(Image.fromarray(np.asarray(q, dtype=np.uint8), "L").filter(ImageFilter.ModeFilter(3)), dtype=np.uint8)

    # 3) 放回原尺寸，并把每个色块的边界磨圆（逐色块高斯后取最大），去掉锯齿
    up = np.asarray(Image.fromarray(small_labels, "L").resize((W, H), Image.NEAREST), dtype=np.uint8)
    sigma = max(1.5, 1.2 / max(scale, 1e-3))
    present = [k for k in range(len(pal)) if (up == k).any()]
    scores = np.stack([ndimage.gaussian_filter((up == k).astype(np.float32), sigma) for k in present])
    labels = np.array(present, dtype=np.uint8)[np.argmax(scores, axis=0)]

    # 碎色块并进周围：太小的连通块改成它外圈最常见的颜色
    min_px = max(16, int(mask.sum() * MIN_REGION))
    for k in present:
        comp, n = ndimage.label((labels == k) & mask)
        if not n:
            continue
        sizes = ndimage.sum(np.ones_like(comp), comp, range(1, n + 1))
        for idx in np.where(sizes < min_px)[0]:
            region = comp == (idx + 1)
            border = ndimage.binary_dilation(region, iterations=2) & ~region & mask
            if border.any():
                vals = labels[border]
                labels[region] = np.bincount(vals).argmax()

    flat_pal = _flat_palette(pal)
    out_rgb = flat_pal[np.clip(labels, 0, len(flat_pal) - 1)]

    # 4) 内线：亮度差大的色块交界画细墨线（花纹、五官），差小的不画，保持干净
    lum = flat_pal @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    lab_lum = lum[np.clip(labels, 0, len(lum) - 1)]
    edge = np.zeros_like(mask)
    for dy, dx in ((0, 1), (1, 0)):
        a = lab_lum
        b = np.roll(lab_lum, shift=(-dy, -dx), axis=(0, 1))
        diff = (np.abs(a - b) > INNER_LINE_DIFF) & (labels != np.roll(labels, shift=(-dy, -dx), axis=(0, 1)))
        edge |= diff
    edge &= ndimage.binary_erosion(mask, iterations=outline)  # 内线不贴着外描边
    inner_w = max(1, outline // 3)
    edge = ndimage.binary_dilation(edge, iterations=inner_w - 1) if inner_w > 1 else edge
    inner_a = ndimage.gaussian_filter(edge.astype(np.float32), 0.6) * 0.75
    out_rgb = out_rgb * (1 - inner_a[..., None]) + INK * inner_a[..., None]

    # 4b) 五官和深色花纹：用原图最暗的一小部分描成暖墨，分色时被抹掉的眼睛就回来了
    lum0 = ndimage.gaussian_filter(crop[..., :3].astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32), 0.8)
    inside = ndimage.binary_erosion(mask, iterations=outline)
    if inside.any():
        thr = np.percentile(lum0[inside], DARK_PERCENT)
        dark = (lum0 < thr) & inside
        dark = ndimage.binary_opening(dark, iterations=1)
        comp, n = ndimage.label(dark)
        if n:
            sizes = ndimage.sum(np.ones_like(comp), comp, range(1, n + 1))
            keep = np.isin(comp, np.where(sizes >= max(6, mask.sum() * 0.0004))[0] + 1)
            dark_a = np.clip(ndimage.gaussian_filter(keep.astype(np.float32), 1.0) * 1.4 - 0.2, 0, 1) * 0.92
            out_rgb = out_rgb * (1 - dark_a[..., None]) + INK * dark_a[..., None]

    # 5) 外描边：轮廓外扩一圈暖墨，边缘做一点抗锯齿
    ring = ndimage.binary_dilation(mask, structure=_disk(outline))
    ring_a = np.clip(ndimage.gaussian_filter(ring.astype(np.float32), 0.8), 0, 1)
    fill_a = np.clip(ndimage.gaussian_filter(mask.astype(np.float32), 0.6), 0, 1)
    final_rgb = INK[None, None, :] * (1 - fill_a[..., None]) + out_rgb * fill_a[..., None]
    final_a = np.maximum(ring_a, fill_a)

    out = np.dstack([np.clip(final_rgb, 0, 255), np.clip(final_a * 255, 0, 255)]).astype(np.uint8)
    result = Image.fromarray(out, "RGBA")
    bbox = result.getbbox()
    return result.crop(bbox) if bbox else result


def _demo(src, out_dir):
    """本机试效果：rembg 抠图 → 画风化 → 拼一张对比图（原图 | 真猫 | 小屋画风放进小屋背景）"""
    import time

    from rembg import new_session, remove

    out_dir.mkdir(parents=True, exist_ok=True)
    photo = Image.open(src).convert("RGB")
    photo.thumbnail((640, 640))
    cut = remove(photo, session=new_session("u2net"))
    t = time.time()
    doodle = stylize(np.asarray(cut.convert("RGBA")))
    ms = int((time.time() - t) * 1000)
    stem = Path(src).stem
    cut.save(out_dir / f"{stem}_cutout.png")
    doodle.save(out_dir / f"{stem}_doodle.png")

    # 对比图：小屋背景色取 constants/backgrounds.js 默认「青瓷小屋」
    cell = 360
    sheet = Image.new("RGB", (cell * 3 + 40, cell + 70), (251, 247, 240))
    room = Image.new("RGB", (cell, cell), (234, 243, 238))
    room.paste(Image.new("RGB", (cell, cell // 3), (203, 183, 154)), (0, cell - cell // 3))
    for i, im in enumerate([photo, cut, doodle]):
        tile = room.copy() if i == 2 else Image.new("RGB", (cell, cell), (255, 253, 249))
        fit = im.copy()
        fit.thumbnail((cell - 30, cell - 30))
        ox, oy = (cell - fit.width) // 2, (cell - fit.height) // 2
        if fit.mode == "RGBA":
            tile.paste(fit, (ox, oy), fit)
        else:
            tile.paste(fit, (ox, oy))
        sheet.paste(tile, (10 + i * (cell + 10), 10))
    sheet.save(out_dir / f"{stem}_compare.jpg", quality=92)
    print(f"{stem}: 画风化 {ms}ms → {out_dir}")
    return ms


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法：python scripts/cat_stylize.py 猫照片.jpg [输出目录]")
        sys.exit(1)
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).parent / ".rembg-out" / "stylize"
    for path in sys.argv[1:2]:
        _demo(path, target)
