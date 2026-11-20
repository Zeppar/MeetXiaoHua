/**
 * rembg 自建服务抠图
 * POST {REMBG_URL}/api/remove  multipart file
 * 查询参数：model / a / af / ab / ae
 */
const { getRecognizeConfig } = require('../recognize-config')
const { request, buildMultipart } = require('../http-util')

function normalizeBase64(input) {
  const raw = String(input || '')
  const idx = raw.indexOf('base64,')
  return idx >= 0 ? raw.slice(idx + 7) : raw
}

function getRembgEndpoint() {
  const { rembg } = getRecognizeConfig()
  const base = String(rembg.url || '').trim().replace(/\/$/, '')
  if (!base) {
    const err = new Error('未配置 REMBG_URL（例如 http://your-vps-ip:7000）')
    err.code = 'NO_REMBG_URL'
    throw err
  }
  const model = String(rembg.model || 'u2net_animal').trim()
  let endpoint = base.indexOf('/api/remove') >= 0 ? base.split('?')[0] : `${base}/api/remove`
  const qs = []
  if (model) qs.push(`model=${encodeURIComponent(model)}`)
  if (rembg.alphaMatting) {
    qs.push('a=true')
    qs.push(`af=${encodeURIComponent(String(rembg.alphaForeground || 240))}`)
    qs.push(`ab=${encodeURIComponent(String(rembg.alphaBackground || 10))}`)
    qs.push(`ae=${encodeURIComponent(String(rembg.alphaErode || 10))}`)
  }
  if (qs.length) endpoint += `?${qs.join('&')}`
  return endpoint
}

async function matting({ imageBase64 } = {}) {
  const started = Date.now()
  const b64 = normalizeBase64(imageBase64)
  if (!b64) {
    return { ok: false, code: 'NO_IMAGE', message: '缺少图片', provider: 'rembg' }
  }

  const endpoint = getRembgEndpoint()
  const buffer = Buffer.from(b64, 'base64')
  const { boundary, body } = buildMultipart(
    {},
    {
      name: 'file',
      filename: 'cat.jpg',
      contentType: 'image/jpeg',
      buffer
    }
  )

  const res = await request(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Accept: 'image/png'
    },
    body,
    timeoutMs: 120000
  })

  if (res.statusCode >= 400) {
    return {
      ok: false,
      code: 'REMBG_ERROR',
      message: `rembg HTTP ${res.statusCode}: ${(res.text || '').slice(0, 200)}`,
      provider: 'rembg',
      timing: [`rembg: ${Date.now() - started}ms`]
    }
  }

  if (res.json && res.json.image) {
    return {
      ok: true,
      provider: 'rembg',
      imageBase64: normalizeBase64(res.json.image),
      mime: 'image/png',
      timing: [`rembg: ${Date.now() - started}ms`]
    }
  }

  if (!res.buffer || res.buffer.length < 100) {
    return {
      ok: false,
      code: 'REMBG_ERROR',
      message: 'rembg 未返回有效图片',
      provider: 'rembg',
      timing: [`rembg: ${Date.now() - started}ms`]
    }
  }

  const isPng =
    res.buffer[0] === 0x89 &&
    res.buffer[1] === 0x50 &&
    res.buffer[2] === 0x4e &&
    res.buffer[3] === 0x47
  if (!isPng) {
    return {
      ok: false,
      code: 'REMBG_ERROR',
      message: `rembg 返回非 PNG：${res.text.slice(0, 120)}`,
      provider: 'rembg',
      timing: [`rembg: ${Date.now() - started}ms`]
    }
  }

  return {
    ok: true,
    provider: 'rembg',
    imageBase64: res.buffer.toString('base64'),
    mime: 'image/png',
    timing: [`rembg: ${Date.now() - started}ms`]
  }
}

module.exports = {
  matting,
  provider: 'rembg'
}
