# 可选：用 AI 生图替换的插画（提示词包）

现在所有插画都是手绘 SVG（`miniprogram/assets/art/`），风格统一、体积很小，可以直接上线。
如果之后想在少数「门面」位置换成更精致的画，可以用下面的提示词在豆包 / 即梦 / Midjourney 里生成，**务必保持同一套风格词**，否则会回到风格不统一的老问题。

## 统一风格词（每条都要带上）

> flat doodle sticker illustration, warm cream paper background #FBF7F0, thick warm dark-brown outline (#2B2622), rounded line joins, limited palette: tangerine orange #F08A4B, cream #FFE9D2, mint #7CC6A4, sky blue #8DB8E8, blush pink #F2A7B5, light wood #D9A86C, cozy hand-drawn journal style, no gradients, no 3D, no text, no watermark

中文：扁平涂鸦贴纸插画，米白纸色背景，粗的暖深棕描边，圆角线条，只用橘橙/奶油/薄荷/天蓝/樱粉/浅木色，温暖的手帐风，无渐变、无 3D、无文字、**无水印**。

## 建议替换的位置

| 文件 | 画面 | 尺寸 |
|---|---|---|
| `hero-corner.svg` → `hero-corner.png` | 傍晚的街角，一只橘猫坐在矮砖墙上，旁边路灯和盆栽，远处屋顶剪影 | 1380×760，横版 |
| `empty-room.svg` | 空着的藤编猫窝，旁边一团粉色毛线球和小窗 | 720×600 |
| `empty-album.svg` | 摊开的手帐本，一页贴着虚线框的「?」猫贴纸位，一支铅笔 | 720×600 |
| 小屋背景（新增） | 侧视温馨小房间：墙面 + 木地板 + 踢脚线，留出中间空地给猫，**不要画猫和家具** | 1500×1200，每种背景色各一张 |

## 注意

- 生成后用 `scripts/` 里的压缩方式控制体积：PNG 量化到 256 色或转 JPG，单张 ≤ 120KB，主包总体积不能超过 2MB。
- 有透明需求的（猫窝、家具）导出带透明通道的 PNG。
- 检查四角有没有平台水印（之前的 `mascot.png` 就带了「豆包 AI 生成」）。
