# 遇见小花猫 · 手帐设计系统

一句话：**整个小程序是一本暖色纸质的「猫咪相遇手帐」，用户拍到的每一只真猫，都是贴在里面的一张白边贴纸。**

真猫照片是主角；插画只负责搭场景，统一用「涂鸦贴纸」画风（扁平填色 + 暖墨描边），
全部是 `miniprogram/assets/art/*.svg`，不用 AI 位图（风格难统一、体积大、可能带水印）。

公共样式都在 `miniprogram/app.wxss`，页面直接用类名；组件需在 `Component({ options: { addGlobalClass: true } })` 后才能用。

---

## 1. 颜色（只用变量）

| 变量 | 值 | 用途 |
|---|---|---|
| `--color-bg` | `#fbf7f0` | 米白手帐纸（page 自带点阵纹） |
| `--color-bg-deep` | `#f4ede2` | 纸的阴面、分区底、进度条底 |
| `--color-surface` | `#fffdf9` | 卡片纸 |
| `--color-title` | `#2b2622` | 暖墨：标题、描边按钮 |
| `--color-text` / `--color-text-2` / `--color-muted` | `#4a423b` / `#6b6158` / `#9a8f84` | 正文 / 次要 / 弱化 |
| `--color-line` | 暖棕 14% | 边框、虚线 |
| `--color-primary` / `-deep` / `-ink` / `-soft` | 橘猫橙 | 主操作 / 按下 / 浅底上的橙字 / 橙色浅底 |
| `--color-mint*` | 薄荷 | 在家、成功、完成 |
| `--color-sky*` | 天蓝 | 出门、地图、来访距离 |
| `--color-blush*` | 樱粉 | 亲密度、喜欢、记忆 |
| `--color-note` | `#fff3c4` | 便签黄 |

语义约定：**橙=行动，薄荷=在家/完成，天蓝=出门/远方，樱粉=感情**。「未识别 / 未填写」不是错误，用 `--color-muted`，不要用红色。

## 2. 字

- 正文系统字体；`.hand`（系统楷体）**只**用于用户写的内容：备注、记忆、明信片正文、来访便签。
- 阶梯：`--font-2xs 20` / `xs 22` / `sm 24` / `md 28` / `lg 32` / `xl 40` / `2xl 48`（rpx），最小 20rpx。
- 标题类：`.h1 .h2 .h3`；说明：`.caption .muted .tiny`；高亮：`.marker`（马克笔刷底）。

## 3. 公共组件类（app.wxss）

| 类 | 是什么 | 什么时候用 |
|---|---|---|
| `.paper` + `.paper-pad` | 卡片纸（圆角 28、细边、轻影） | 一切内容块 |
| `.tape` (+`-mint/-sky/-blush`, `-left/-right`) | 和纸胶带，绝对定位在父元素上沿 | 「贴」照片 / 卡片，一屏最多 2~3 条 |
| `.sticker` + `.tilt-l/.tilt-r` | 真猫贴纸落影 + 轻微倾斜 | 所有真猫抠图 |
| `.stamp` (`.stamp-k/.stamp-v`) | 圆形邮戳 | 日期 + 地点 |
| `.seal` (+`-mint/-sky/-blush/-muted`) | 方形橡皮章 | 状态：在小屋 / 审核中 / 已放生 / 出门中 |
| `.postcard` | 航空信封边的明信片 | 出门报告、来访记录、放生 |
| `.note` | 黄色便签（楷体、微斜） | 备注、留言 |
| `.lined` | 横线本 | 记忆正文、长备注 |
| `.chip` / `.chip-on` | 胶囊筛选 | 品种筛选、分段切换 |
| `.tag` (+色) | 小标签 | 次要信息 |
| `.btn-primary` | 橙色实心 + 底部厚边（按下会沉） | 每屏**唯一**主操作 |
| `.btn-secondary` | 暖墨描边纸按钮 + 底部厚边 | 次操作 |
| `.btn-soft` / `.btn-ghost` | 橙色浅底 / 纯文字 | 第三级 |
| `.btn-sm` `.btn-block` `.btn-danger` | 修饰 | |
| `.list` + `.list-row` (+`.list-ico .list-title .list-sub .list-arrow`) | 设置式列表，行间虚线 | 菜单、记录列表 |
| `.section-head` `.section-title` `.section-link` | 区块标题 | |
| `.bar` + `.bar-fill` | 进度条 | 收集进度、亲密度 |
| `.mask` (+`.mask-bottom`) `.dialog` `.sheet-panel` `.sheet-grip` | 弹窗 / 底部面板 | |
| `.empty` `.empty-illus` `.empty-title` `.empty-sub` | 空状态 | 配 `assets/art/empty-*.svg` |
| `.anim-rise` `.anim-pop` `.anim-stamp` `.delay-1..4` | 进场动效 | 列表项错峰 `rise`，关键时刻 `pop/stamp` |
| `.tap-press` | 按压反馈 | 所有可点 view：`hover-class="tap-press"` |

布局工具：`.row .row-between .col .grow .center .gap-1..3 .mt-1..5 .ellipsis`。
页面容器：tab 页 `.page`（底部给 dock 让位）；二级页 `.page .page-sub`。

## 4. 插画与图标

- 插画：`assets/art/`
  - `hero-corner.svg` 首页街角；`cat-sit.svg` 示意猫；`cat-shadow.svg` 未遇见品种剪影；`logo-mark.svg` 品牌猫头
  - 空状态：`empty-album / empty-room / empty-memory / empty-map / empty-mail.svg`
  - 小屋家具：`furn-window / furn-plant / furn-cushion / furn-bowl / furn-toy.svg`
- 图标：`assets/icons/*.svg`，24 栅格、1.8 线宽、圆头；不在按钮里放 emoji。
- 新画插画沿用：暖墨 `#2b2622` 描边 3.2、圆角连接、只用色板里的颜色；SVG 里**不要用 `<text>`**（小程序渲染不稳）。

## 5. 动效

只在 4 个时刻用：**贴纸弹出、邮戳落下、明信片翻面、爪印走动（加载）**；列表进场可轻微 `rise`。其余保持安静。

## 6. 文案语气

温柔、具体、像在跟朋友讲街角发生的小事。「还没有名字」「还没选品种」而不是「未命名」「待识别」。
