"""
常驻 rembg 抠图服务（替代 `rembg s` 7000 + Node 代理 7001 两层）

为什么更快：
  1. 模型 session 启动时加载一次并常驻（`rembg s` 每个请求都会 new_session 重新加载 ONNX）
  2. 启动即预热，第一张图不再额外慢
  3. 主区域清理 + 白边在这里用 numpy/scipy 做，小程序端不再跑 canvas 逐像素
  4. 少一跳 HTTP：小程序直接打这里

依赖：pip install "rembg[cpu]" pillow numpy scipy   （有 N 卡用 rembg[gpu]）

用法：
  python scripts/rembg-server.py                     # 127.0.0.1:7001，小程序开发者工具用
  python scripts/rembg-server.py --host 0.0.0.0      # 给云函数用（务必配 REMBG_TOKEN）
  环境变量：REMBG_MODEL（默认 u2net）、REMBG_TOKEN（可选，鉴权）

接口：
  GET  /health
  POST /api/remove?model=u2net&border=1&alpha=0
       body：multipart（字段 file）或原始图片字节
       返回：JSON {ok, mime, imageBase64, bordered, upstreamMs, timing}
             请求头 Accept: image/png（且不含 json）时直接返回 PNG 字节（兼容云函数 provider）
"""
import argparse
import base64
import io
import json
import os
import sys
import threading
import time
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
from PIL import Image, ImageFilter
from rembg import new_session, remove
from rembg.sessions import sessions_names
from scipy import ndimage

# Windows 控制台默认 cp1252，打印中文会直接抛 UnicodeEncodeError
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

# 旧配置里写的名字 → 当前 rembg 实际存在的模型（u2net_animal 在 rembg 2.x 里并不存在）
MODEL_ALIASES = {"u2net_animal": "u2net"}
# 只放行本机 rembg 真正支持、且适合猫贴纸的模型（大模型如 birefnet/sam 太慢，不开放）
ALLOWED_MODELS = {"u2net", "u2netp", "isnet-general-use", "silueta", "bria-rmbg", "birefnet-general-lite"} & set(sessions_names)


def resolve_model(name):
    name = MODEL_ALIASES.get(name, name)
    return name if name in ALLOWED_MODELS else None


DEFAULT_MODEL = resolve_model(os.environ.get("REMBG_MODEL", "u2net")) or "u2net"
TOKEN = os.environ.get("REMBG_TOKEN", "")
MAX_SIDE = 640  # 与小程序上传尺寸一致；模型内部本来就缩到 320
MAX_BODY = 12 * 1024 * 1024
DEBUG_DIR = None  # --debug 时为 Path
# 快模型没把握时自动改用的精细模型；设 REMBG_FALLBACK= （空）可关闭
FALLBACK_MODEL = os.environ.get("REMBG_FALLBACK", "birefnet-general-lite")
FALLBACK_RATIO = float(os.environ.get("REMBG_FALLBACK_RATIO", "0.25"))

# 白边参数：与 miniprogram/utils/cat-sticker.js 对齐（那边在 480 边长上 3~8px）
STROKE_RATIO = 0.012
MIN_STROKE = 3
MAX_STROKE = 11

_sessions = {}
_session_lock = threading.Lock()
# ONNX 本身多线程吃满 CPU，并发推理只会互相拖慢 → 串行
_infer_lock = threading.Lock()


def get_session(model):
    with _session_lock:
        sess = _sessions.get(model)
        if sess is None:
            t = time.time()
            sess = new_session(model)
            _sessions[model] = sess
            print(f"[rembg-server] loaded {model} in {int((time.time() - t) * 1000)}ms", flush=True)
        return sess


def load_image(raw):
    img = Image.open(io.BytesIO(raw))
    img.load()
    img = img.convert("RGB")
    w, h = img.size
    scale = min(1.0, MAX_SIDE / max(w, h))
    if scale < 1.0:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.BILINEAR)
    return img


SOLID_ALPHA = 128  # 实体阈值，与 scripts/cat-sticker.py 一致
EDGE_BAND = 3  # 实体外保留多少像素的半透明毛边


def keep_main_region(rgba):
    """
    只留主区域：在「实体」(alpha>=128) 上找最大连通块；若它贴底又矮，改选上方次大块（脸）。
    返回 (清理后的 rgba, solid)。solid 只含主区域实体，用来生成白边；
    实体外只保留紧贴它的一圈半透明毛边，更远的低 alpha 残影（背景没抠干净的部分）清零。
    """
    alpha = rgba[..., 3]
    labels, count = ndimage.label(alpha >= SOLID_ALPHA)
    if count < 1:
        return None
    ids = np.arange(1, count + 1)
    areas = ndimage.sum(np.ones_like(alpha, dtype=np.int32), labels, ids)
    boxes = ndimage.find_objects(labels)
    h = alpha.shape[0]
    main = int(np.argmax(areas))
    ys = boxes[main][0]
    main_h = ys.stop - ys.start
    if ys.start > h * 0.55 and main_h < h * 0.35:
        main_cy = (ys.start + ys.stop) / 2
        alt = -1
        for i in range(count):
            if i == main:
                continue
            b = boxes[i][0]
            if (b.start + b.stop) / 2 >= main_cy:
                continue
            if alt < 0 or areas[i] > areas[alt]:
                alt = i
        if alt >= 0 and areas[alt] >= areas[main] * 0.35:
            main = alt
    solid = labels == (main + 1)
    # 只填主体内部的小洞（眼睛反光、胡须间隙被判成半透明）；尾巴圈、腿间这类大空隙保留
    holes = ndimage.binary_fill_holes(solid) & ~solid
    if holes.any():
        hl, hn = ndimage.label(holes)
        hareas = ndimage.sum(np.ones_like(hl, dtype=np.int32), hl, np.arange(1, hn + 1))
        small_ids = np.nonzero(hareas < max(16, solid.sum() * 0.004))[0] + 1
        solid = solid | np.isin(hl, small_ids)
    soft = ndimage.binary_dilation(solid, iterations=EDGE_BAND) & (alpha > 8)
    out = rgba.copy()
    out[~(solid | soft)] = 0
    return out, solid


def add_white_border(rgba, solid):
    ys, xs = np.where(solid)
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    # 把毛边带一起裁进来，白边下面才有柔和过渡
    y0, x0 = max(0, y0 - EDGE_BAND), max(0, x0 - EDGE_BAND)
    y1, x1 = min(rgba.shape[0], y1 + EDGE_BAND), min(rgba.shape[1], x1 + EDGE_BAND)
    cat = rgba[y0:y1, x0:x1]
    hard = solid[y0:y1, x0:x1]
    h, w = hard.shape
    r = int(min(MAX_STROKE, max(MIN_STROKE, round(min(h, w) * STROKE_RATIO))))
    pad = r + 3

    hard_pad = np.zeros((h + pad * 2, w + pad * 2), dtype=bool)
    hard_pad[pad : pad + h, pad : pad + w] = hard
    yy, xx = np.ogrid[-r : r + 1, -r : r + 1]
    disk = xx * xx + yy * yy <= r * r
    dilated = ndimage.binary_dilation(hard_pad, structure=disk)
    stroke = Image.fromarray(dilated.astype(np.uint8) * 255, "L").filter(ImageFilter.GaussianBlur(0.6))
    sa = np.asarray(stroke, dtype=np.float32) / 255.0

    oh, ow = sa.shape
    cat_rgb = np.zeros((oh, ow, 3), dtype=np.float32)
    ca = np.zeros((oh, ow), dtype=np.float32)
    cat_rgb[pad : pad + h, pad : pad + w] = cat[..., :3]
    # 只把「实体」内部 alpha 抬到不透明（补模型留下的小透洞）；
    # 实体外的半透明毛边保持原 alpha，叠在白边上自然过渡，不会把背景残影变成实心
    ca[pad : pad + h, pad : pad + w] = np.where(hard, 255, cat[..., 3]) / 255.0

    out_a = ca + sa * (1.0 - ca)
    out_rgb = cat_rgb * ca[..., None] + 255.0 * sa[..., None] * (1.0 - ca[..., None])
    safe_a = np.where(out_a > 0, out_a, 1.0)
    out_rgb = out_rgb / safe_a[..., None]  # 存为非预乘 RGBA
    result = np.dstack([np.clip(out_rgb, 0, 255), np.clip(out_a * 255.0, 0, 255)]).astype(np.uint8)
    img = Image.fromarray(result, "RGBA")
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def run_model(img, model, alpha_matting):
    sess = get_session(model)
    with _infer_lock:
        return remove(
            img,
            session=sess,
            alpha_matting=alpha_matting,
            alpha_matting_foreground_threshold=200,
            alpha_matting_background_threshold=15,
            alpha_matting_erode_size=4,
        )


def faint_ratio(cut):
    """
    半透明像素占「前景」的比例 = 模型的没把握程度。
    实测：u2net 抠得好的图约 0.02~0.05；把猫身体判成半透明（只剩个头）的图约 0.6。
    """
    a = np.asarray(cut)[..., 3]
    solid = int((a >= SOLID_ALPHA).sum())
    faint = int(((a > 8) & (a < SOLID_ALPHA)).sum())
    return faint / max(1, solid + faint)


def process(raw, model, border, alpha_matting, allow_fallback=True):
    timing = []
    t0 = time.time()
    img = load_image(raw)
    timing.append(f"decode: {int((time.time() - t0) * 1000)}ms {img.size[0]}x{img.size[1]}")

    t1 = time.time()
    cut = run_model(img, model, alpha_matting)
    infer_ms = int((time.time() - t1) * 1000)
    ratio = faint_ratio(cut)
    timing.append(f"rembg({model}): {infer_ms}ms faint={ratio:.2f}")

    # 快模型没把握 → 用 BiRefNet 重抠（CPU 上约 10s，但整只猫完整）
    if allow_fallback and FALLBACK_MODEL and model != FALLBACK_MODEL and ratio > FALLBACK_RATIO:
        t_fb = time.time()
        cut = run_model(img, FALLBACK_MODEL, False)
        fb_ms = int((time.time() - t_fb) * 1000)
        infer_ms += fb_ms
        model = FALLBACK_MODEL
        timing.append(f"fallback({FALLBACK_MODEL}): {fb_ms}ms faint={faint_ratio(cut):.2f}")

    t2 = time.time()
    rgba = np.asarray(cut.convert("RGBA"))
    bordered = False
    out_img = cut
    if border:
        kept = keep_main_region(rgba)
        if kept is not None:
            out_img = add_white_border(*kept)
            bordered = True
    buf = io.BytesIO()
    # compress_level=1：PNG 压缩最耗时的那部分几乎省掉，体积只略大
    out_img.save(buf, "PNG", compress_level=1)
    timing.append(f"border+encode: {int((time.time() - t2) * 1000)}ms")
    if DEBUG_DIR:
        # 调试：留存 输入 / rembg 原始透明图 / 最终贴纸，方便对照边缘问题
        stem = DEBUG_DIR / f"{int(time.time() * 1000)}_{model}"
        img.save(f"{stem}_in.jpg", quality=92)
        cut.save(f"{stem}_raw.png")
        out_img.save(f"{stem}_out.png")
    return buf.getvalue(), bordered, infer_ms, timing


def read_upload(handler):
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0 or length > MAX_BODY:
        raise ValueError("bad body size")
    body = handler.rfile.read(length)
    ctype = handler.headers.get("Content-Type", "")
    if ctype.startswith("multipart/form-data"):
        msg = BytesParser(policy=email_policy).parsebytes(
            f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
        )
        for part in msg.iter_parts():
            if part.get_param("name", header="content-disposition") == "file":
                return part.get_payload(decode=True)
        raise ValueError("multipart 缺少 file 字段")
    return body


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # 访问日志：确认小程序到底有没有连到这里（含 /health）
        print(f"[rembg-server] {self.client_address[0]} {fmt % args}", flush=True)

    def send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def authorized(self, qs):
        if not TOKEN:
            return True
        got = self.headers.get("X-Rembg-Token") or (qs.get("token") or [""])[0]
        return got == TOKEN

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/health"):
            self.send_json(200, {"ok": True, "models": sorted(_sessions.keys()), "default": DEFAULT_MODEL})
            return
        self.send_json(404, {"ok": False, "message": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/api/remove":
            self.send_json(404, {"ok": False, "message": "POST /api/remove only"})
            return
        qs = parse_qs(u.query)
        if not self.authorized(qs):
            self.send_json(401, {"ok": False, "message": "bad token"})
            return
        asked = (qs.get("model") or [DEFAULT_MODEL])[0]
        model = resolve_model(asked)
        if not model:
            self.send_json(400, {"ok": False, "message": f"unsupported model {asked}，可用：{sorted(ALLOWED_MODELS)}"})
            return
        border = (qs.get("border") or ["0"])[0] in ("1", "true")
        alpha = (qs.get("a") or qs.get("alpha") or ["0"])[0] in ("1", "true")
        allow_fallback = (qs.get("fallback") or ["1"])[0] not in ("0", "false")
        started = time.time()
        try:
            raw = read_upload(self)
            png, bordered, infer_ms, timing = process(raw, model, border, alpha, allow_fallback)
        except Exception as e:  # noqa: BLE001
            print("[rembg-server] fail", repr(e), flush=True)
            self.send_json(500, {"ok": False, "message": str(e) or "rembg fail"})
            return
        total = int((time.time() - started) * 1000)
        print(f"[rembg-server] {model} border={int(bordered)} {len(png)}B total={total}ms | " + " | ".join(timing), flush=True)

        accept = self.headers.get("Accept", "")
        if "image/png" in accept and "json" not in accept:
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.send_header("X-Rembg-Bordered", "1" if bordered else "0")
            self.end_headers()
            self.wfile.write(png)
            return
        self.send_json(
            200,
            {
                "ok": True,
                "mime": "image/png",
                "imageBase64": base64.b64encode(png).decode("ascii"),
                "bordered": bordered,
                "upstreamMs": total,
                "timing": timing,
            },
        )


def warmup(model):
    sess = get_session(model)
    sample = Path(__file__).with_name(".warmup.jpg")
    img = Image.open(sample).convert("RGB") if sample.exists() else Image.new("RGB", (320, 320), (200, 180, 160))
    t = time.time()
    remove(img, session=sess)
    print(f"[rembg-server] warmup {model} {int((time.time() - t) * 1000)}ms", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("REMBG_PORT", 7001)))
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--debug", action="store_true", help="把每次的输入/原始抠图/贴纸存到 scripts/.rembg-out/")
    args = ap.parse_args()
    global DEBUG_DIR
    if args.debug:
        DEBUG_DIR = Path(__file__).with_name(".rembg-out")
        DEBUG_DIR.mkdir(exist_ok=True)
        print(f"[rembg-server] debug dump → {DEBUG_DIR}", flush=True)
    model = resolve_model(args.model)
    if not model:
        raise SystemExit(f"不支持的模型 {args.model}，可用：{sorted(ALLOWED_MODELS)}")
    args.model = model
    if args.host not in ("127.0.0.1", "localhost") and not TOKEN:
        print("[rembg-server] 警告：对外监听但未设置 REMBG_TOKEN，任何人都能刷你的算力", flush=True)
    warmup(args.model)
    global FALLBACK_MODEL
    if FALLBACK_MODEL and FALLBACK_MODEL not in sessions_names:
        print(f"[rembg-server] 兜底模型 {FALLBACK_MODEL} 不存在，已关闭兜底", flush=True)
        FALLBACK_MODEL = ""
    if FALLBACK_MODEL and FALLBACK_MODEL != args.model:
        # 后台预加载 + 预热兜底模型，第一次兜底不用再等加载；不阻塞服务启动
        threading.Thread(target=warmup, args=(FALLBACK_MODEL,), daemon=True).start()
        print(f"[rembg-server] fallback={FALLBACK_MODEL} when faint>{FALLBACK_RATIO}", flush=True)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[rembg-server] http://{args.host}:{args.port}  model={args.model}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
