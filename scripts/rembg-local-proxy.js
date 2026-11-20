/**
 * 本机 rembg JSON 代理（给微信开发者工具用）
 * 不回传超大 base64（会卡死开发者工具），改为落盘后返回短 URL。
 *
 * 用法：
 *   1) rembg s --host 127.0.0.1 --port 7000 --no-ui
 *   2) node scripts/rembg-local-proxy.js
 *   3) 小程序打 http://127.0.0.1:7001/api/remove
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

const LISTEN_PORT = Number(process.env.REMBG_PROXY_PORT || 7001)
const REMBG_BASE = String(process.env.REMBG_UPSTREAM || 'http://127.0.0.1:7000').replace(/\/$/, '')
const OUT_DIR = path.join(__dirname, '.rembg-out')

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })

function pipeToRembg(req, rembgPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(rembgPath, REMBG_BASE)
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('error', reject)
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      console.log(`[rembg-proxy] upstream POST ${u.pathname}${u.search} body=${body.length}B`)
      const started = Date.now()
      const upstream = http.request(
        {
          hostname: u.hostname,
          port: u.port || 80,
          path: `${u.pathname}${u.search}`,
          method: 'POST',
          headers: {
            'Content-Type': req.headers['content-type'] || 'application/octet-stream',
            'Content-Length': body.length,
            Accept: 'image/png'
          },
          timeout: 180000
        },
        (res) => {
          const out = []
          res.on('data', (c) => out.push(c))
          res.on('end', () => {
            const buffer = Buffer.concat(out)
            console.log(
              `[rembg-proxy] upstream done ${res.statusCode} ${buffer.length}B ${Date.now() - started}ms`
            )
            resolve({
              statusCode: res.statusCode || 0,
              buffer,
              upstreamMs: Date.now() - started
            })
          })
        }
      )
      upstream.on('timeout', () => {
        upstream.destroy()
        reject(new Error('rembg upstream timeout'))
      })
      upstream.on('error', reject)
      upstream.write(body)
      upstream.end()
    })
  })
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*'
  })
  res.end(body)
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, message: 'file not found' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': data.length,
      'Access-Control-Allow-Origin': '*'
    })
    res.end(data)
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    })
    res.end()
    return
  }

  const reqUrl = String(req.url || '/')
  if (req.method === 'GET' && (reqUrl === '/' || reqUrl === '/health')) {
    sendJson(res, 200, { ok: true, upstream: REMBG_BASE, port: LISTEN_PORT })
    return
  }

  if (req.method === 'GET' && reqUrl.indexOf('/files/') === 0) {
    const name = path.basename(reqUrl.split('?')[0])
    if (!/^[a-zA-Z0-9._-]+\.png$/.test(name)) {
      sendJson(res, 400, { ok: false, message: 'bad file' })
      return
    }
    sendFile(res, path.join(OUT_DIR, name))
    return
  }

  if (req.method !== 'POST' || reqUrl.indexOf('/api/remove') !== 0) {
    sendJson(res, 404, { ok: false, message: 'POST /api/remove only' })
    return
  }

  try {
    const upstream = await pipeToRembg(req, reqUrl)
    if (upstream.statusCode >= 400) {
      sendJson(res, 502, {
        ok: false,
        message: `rembg HTTP ${upstream.statusCode}`,
        detail: upstream.buffer.toString('utf8').slice(0, 200)
      })
      return
    }
    const isPng =
      upstream.buffer[0] === 0x89 &&
      upstream.buffer[1] === 0x50 &&
      upstream.buffer[2] === 0x4e &&
      upstream.buffer[3] === 0x47
    if (!isPng) {
      sendJson(res, 502, {
        ok: false,
        message: 'upstream not png',
        detail: upstream.buffer.toString('utf8').slice(0, 200)
      })
      return
    }

    const name = `out_${Date.now()}_${Math.random().toString(16).slice(2)}.png`
    const filePath = path.join(OUT_DIR, name)
    fs.writeFileSync(filePath, upstream.buffer)
    const url = `http://127.0.0.1:${LISTEN_PORT}/files/${name}`
    console.log(`[rembg-proxy] saved ${name} (${upstream.buffer.length}B)`)
    // 小于约 1.2MB 时附带 base64，小程序可直接落盘再加白边，避免 downloadFile/canvas 异常
    const payload = {
      ok: true,
      mime: 'image/png',
      url,
      upstreamMs: Number(upstream.upstreamMs) || 0
    }
    if (upstream.buffer.length <= 1200 * 1024) {
      payload.imageBase64 = upstream.buffer.toString('base64')
    }
    sendJson(res, 200, payload)
  } catch (e) {
    console.error('[rembg-proxy]', e)
    sendJson(res, 500, { ok: false, message: (e && e.message) || 'proxy error' })
  }
})

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`[rembg-proxy] http://127.0.0.1:${LISTEN_PORT} → ${REMBG_BASE}`)
})
