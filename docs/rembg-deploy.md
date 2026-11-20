# rembg 自建部署流程

开源背景去除服务，软件免费，成本主要是云主机/电费。部署好后，把公网地址填进云函数 `REMBG_URL`，并将 `MATTING_PROVIDER` 设为 `rembg`。

官方仓库：https://github.com/danielgatis/rembg

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
REMBG_MODEL: 'u2net',   // 猫可用 u2net_animal / isnet-general-use
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
| `u2net_animal` | 动物更友好 |
| `isnet-general-use` | 通用高质量，更慢更吃资源 |

在 `REMBG_MODEL` 或请求 `?model=` 里指定。

---

## 6. 注意

- 云函数超时已配 60s；rembg CPU 推理大图可能较慢，客户端已压缩到约 720px 边长。
- 公网裸奔建议前面加 Nginx + 简单 Token / IP 白名单，避免被人刷算力。
- 若云函数报网络错误：检查安全组、是否 HTTPS 反代、是否误填内网 IP。
