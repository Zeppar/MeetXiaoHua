# rembg 自建部署流程

开源背景去除服务，软件免费，成本主要是云主机/电费。部署好后，把公网地址填进云函数 `REMBG_URL`，并将 `MATTING_PROVIDER` 设为 `rembg`。

官方仓库：https://github.com/danielgatis/rembg

---

## 0. 推荐：常驻服务 scripts/rembg-server.py（更快）

官方 `rembg s` 会在每个请求里重新创建模型 session，而且白边要在小程序端用 canvas 逐像素算，这两步都慢。
`scripts/rembg-server.py` 做了这些事：

- 启动时加载模型并预热，之后一直常驻
- 抠图、保留主区域、加白边都在服务端用 numpy/scipy 完成，直接返回贴纸 PNG
- 小程序直接请求它，不再需要 Node 代理（`rembg-local-proxy.js`）

```bash
pip install "rembg[cpu]" pillow numpy scipy     # 有 N 卡改用 rembg[gpu]

# 本机开发者工具（替代 7000 + 7001 两个进程，小程序配置不用改）
python scripts/rembg-server.py

# 给云函数用（公网）
REMBG_TOKEN=自己设一个长随机串 python scripts/rembg-server.py --host 0.0.0.0 --port 7000
```

云函数里配置 `REMBG_URL=http://公网IP:7000`、`REMBG_TOKEN=同一个串`，`REMBG_BORDER` 默认为 true。
每个请求的分步耗时（解码 / 推理 / 白边+编码）会打印在服务端日志里。

**自动兜底：** 先用快模型 u2net（CPU 约 0.4s）。如果它对结果没把握（半透明像素占前景超过 25%，典型症状是只抠出猫头、身体变半透明），会自动换 `birefnet-general-lite` 重抠（CPU 约 10s，整只猫完整）。兜底模型启动时在后台预加载。可用 `REMBG_FALLBACK=`（留空）关闭，`REMBG_FALLBACK_RATIO` 调阈值，单次请求加 `fallback=0` 跳过。有 N 卡时 BiRefNet 会快很多（`pip install "rembg[gpu]"`）。

调试：加 `--debug` 启动，每次请求的输入、原始抠图、最终贴纸会存到 `scripts/.rembg-out/`。
想更快可以用 `--model u2netp`（约 4MB，CPU 上快好几倍，边缘稍粗），小程序端对应改 `constants/matting-mode.js` 的 `QUALITY_MODEL`。

下面是旧方案（官方镜像），仍然兼容：服务端不加白边时，小程序会自动回到端上加白边。

---

## 1. 机器要求

- 建议：2 核 4G 起（CPU）；有 GPU 会更快
- 系统：Ubuntu 20.04/22.04 或任意可跑 Docker 的 Linux
- 开放端口：`7000`（或你自定的端口）对**公网**可达  
  （微信云函数在公网侧发起请求，**不要填 `127.0.0.1`**）

---

## 2. 推荐：Docker 一键起服务

```bash
docker pull danielgatis/rembg

docker run -d \
  --name rembg \
  --restart unless-stopped \
  -p 7000:7000 \
  danielgatis/rembg \
  s --host 0.0.0.0 --port 7000 --no-ui
```

说明：

- `s` = HTTP 服务模式
- `--no-ui` 关掉 Gradio 界面，省空闲 CPU
- 首次推理会下载模型，可能要几分钟

验证：

```bash
curl -s -F file=@/path/to/cat.jpg \
  "http://127.0.0.1:7000/api/remove?model=u2net" \
  -o out.png
```

本机浏览器可打开：`http://公网IP:7000/api` 看接口文档。

云厂商安全组 / 防火墙放行入站 `TCP 7000`。

---

## 3. 备选：本机 pip 安装（无 Docker）

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

pip install "rembg[cpu,cli]"

rembg s --host 0.0.0.0 --port 7000 --no-ui
```

可用 systemd / pm2 / nssm 做成常驻进程。

---

## 4. 接到本项目

1. 在 `cloudfunctions/api/secrets.local.js`（或云函数环境变量）写：

```js
MATTING_PROVIDER: 'rembg',
REMBG_URL: 'http://你的公网IP:7000',
REMBG_MODEL: 'u2net',   // 也可用 u2netp（更快）/ isnet-general-use（更细）
```

2. 重新上传并部署云函数 `api`。

3. 小程序拍照/上传 → 走 `action: matting` → rembg 返回透明 PNG → 本地加白边。

切换回百度智能抠图：

```js
MATTING_PROVIDER: 'baidu'
```

纯本地洪水填充（不调云）：

```js
MATTING_PROVIDER: 'local'
```

---

## 5. 常用模型

| 模型 | 场景 |
|------|------|
| `u2net` | 通用（默认） |
| `u2netp` | 轻量，CPU 上快好几倍，边缘稍粗 |
| `isnet-general-use` | 通用高质量，更慢更吃资源 |

在 `REMBG_MODEL` 或请求 `?model=` 里指定。

---

## 6. 注意

- 云函数超时已配 60s；rembg CPU 推理大图可能较慢，客户端已压缩到约 720px 边长。
- 公网裸奔建议前面加 Nginx + 简单 Token / IP 白名单，避免被人刷算力。
- 若云函数报网络错误：检查安全组、是否 HTTPS 反代、是否误填内网 IP。

## 猫咪照片特征（可选）

本地查重使用照片摘要、感知哈希和颜色特征。需要对不同构图和角度的猫照做候选搜索时，可以为常驻服务启用 DINOv2 Small 图像特征。

1. 在运行 `scripts/rembg-server.py` 的环境中设置 `CAT_REID_MODEL`，指向本地 DINOv2 Small ONNX 文件。模型需接受 `float32[1,3,224,224]` 图像，并输出 384 维图像特征或包含 CLS 的序列特征。
2. 重启常驻服务，在 `api` 云函数中设置 `CAT_REID_ENABLED=1`。`/api/embed` 使用与抠图接口相同的 `REMBG_TOKEN`。
3. 图像特征用于排序疑似同一只猫的候选。新卡和确认后的记忆照片会保存参考特征，旧卡会在比对时分批补算并缓存在当前设备。
