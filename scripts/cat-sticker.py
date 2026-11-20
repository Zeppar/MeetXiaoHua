"""
猫咪贴纸算法参考实现（rembg 抠图 + 白色外描边）。
小程序端对应：miniprogram/utils/cat-sticker.js（拍照 / 上传后共用）。
用法：python scripts/cat-sticker.py input.jpg output.png
"""
from pathlib import Path
import sys
import collections
import numpy as np
from PIL import Image, ImageFilter
from rembg import remove
from scipy import ndimage

STROKE_RATIO = 0.016
MIN_STROKE = 5


def keep_largest_component(mask: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    best_coords = None
    best_size = 0
    for y in range(h):
        for x in range(w):
            if visited[y, x] or not mask[y, x]:
                visited[y, x] = True
                continue
            q = collections.deque([(x, y)])
            visited[y, x] = True
            coords = []
            while q:
                cx, cy = q.popleft()
                coords.append((cy, cx))
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if 0 <= nx < w and 0 <= ny < h and not visited[ny, nx]:
                        visited[ny, nx] = True
                        if mask[ny, nx]:
                            q.append((nx, ny))
            if len(coords) > best_size:
                best_size = len(coords)
                best_coords = coords
    out = np.zeros_like(mask, dtype=bool)
    if best_coords:
        ys, xs = zip(*best_coords)
        out[list(ys), list(xs)] = True
    return out


def circular_dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return mask.copy()
    structure = np.zeros((radius * 2 + 1, radius * 2 + 1), dtype=bool)
    yy, xx = np.ogrid[-radius : radius + 1, -radius : radius + 1]
    structure[xx * xx + yy * yy <= radius * radius] = True
    return ndimage.binary_dilation(mask, structure=structure)


def make_sticker(src: Path, dst: Path) -> None:
    img = Image.open(src).convert("RGBA")
    cut = remove(img)
    alpha = np.array(cut.split()[-1])
    hard = keep_largest_component(alpha >= 128)
    if not hard.any():
        raise SystemExit("找不到猫咪")

    ys, xs = np.where(hard)
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    hard = hard[y0:y1, x0:x1]
    rgb = cut.crop((x0, y0, x1, y1)).convert("RGBA")
    base_a = np.where(hard, np.maximum(np.array(rgb.split()[-1]), 200), 0).astype(np.uint8)

    h, w = hard.shape
    stroke_r = max(MIN_STROKE, int(round(min(h, w) * STROKE_RATIO)))
    pad = stroke_r + 4
    hard_pad = np.zeros((h + pad * 2, w + pad * 2), dtype=bool)
    hard_pad[pad : pad + h, pad : pad + w] = hard
    dilated = circular_dilate(hard_pad, stroke_r)
    dil_img = Image.fromarray((dilated.astype(np.uint8) * 255), mode="L")
    dil_img = dil_img.filter(ImageFilter.GaussianBlur(radius=0.6))
    stroke_a = (np.array(dil_img) > 40).astype(np.uint8) * 255

    out_h, out_w = stroke_a.shape
    white = np.zeros((out_h, out_w, 4), dtype=np.uint8)
    white[..., :3] = 255
    white[..., 3] = stroke_a

    cat = np.zeros((out_h, out_w, 4), dtype=np.uint8)
    rgb_arr = np.array(rgb)
    cat[pad : pad + h, pad : pad + w, :3] = rgb_arr[..., :3]
    cat[pad : pad + h, pad : pad + w, 3] = base_a

    ca = cat[..., 3].astype(np.float32) / 255.0
    sa = white[..., 3].astype(np.float32) / 255.0
    out_rgb = cat[..., :3].astype(np.float32) * ca[..., None] + white[..., :3].astype(
        np.float32
    ) * sa[..., None] * (1.0 - ca[..., None])
    out_a = ca + sa * (1.0 - ca)
    result = np.zeros((out_h, out_w, 4), dtype=np.uint8)
    result[..., :3] = np.clip(out_rgb, 0, 255).astype(np.uint8)
    result[..., 3] = np.clip(out_a * 255.0, 0, 255).astype(np.uint8)

    img_out = Image.fromarray(result, "RGBA")
    bbox = img_out.getbbox()
    if bbox:
        img_out = img_out.crop(bbox)
    dst.parent.mkdir(parents=True, exist_ok=True)
    img_out.save(dst, "PNG")
    print("saved", dst, img_out.size)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: python scripts/cat-sticker.py input.jpg output.png")
        raise SystemExit(1)
    make_sticker(Path(sys.argv[1]), Path(sys.argv[2]))
