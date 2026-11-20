/**
 * 百度智能抠图
 * POST /rest/2.0/image-process/v1/segment
 * 可调参数很少：method / refine_mask / return_form
 */
const { getBaiduAccessToken } = require('../baidu-auth')
const { getRecognizeConfig } = require('../recognize-config')
const { request } = require('../http-util')

function normalizeBase64(input) {
  const raw = String(input || '')
  const idx = raw.indexOf('base64,')
  return idx >= 0 ? raw.slice(idx + 7) : raw
}

async function matting({ imageBase64, imageUrl } = {}) {
  const started = Date.now()
  const b64 = normalizeBase64(imageBase64)
  if (!b64 && !imageUrl) {
    return { ok: false, code: 'NO_IMAGE', message: '缺少图片', provider: 'baidu' }
  }

  const { baidu } = getRecognizeConfig()
  const method = baidu.mattingMethod === 'control' ? 'control' : 'auto'
  const refineMask = String(baidu.mattingRefineMask) === 'false' ? 'false' : 'true'
  const returnForm = baidu.mattingReturnForm === 'mask' ? 'mask' : 'rgba'

  const token = await getBaiduAccessToken('matting')
  const body = JSON.stringify({
    ...(imageUrl ? { url: imageUrl } : { image: b64 }),
    method,
    return_form: returnForm,
    refine_mask: refineMask
  })
  const url = `https://aip.baidubce.com/rest/2.0/image-process/v1/segment?access_token=${encodeURIComponent(
    token
  )}`
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body
  })
  const data = res.json || {}
  if (data.error_code) {
    return {
      ok: false,
      code: Number(data.error_code) === 18 ? 'BAIDU_QPS' : 'BAIDU_MATTING_ERROR',
      message: data.error_msg || '百度抠图失败',
      provider: 'baidu',
      raw: data,
      timing: [`百度智能抠图: ${Date.now() - started}ms`]
    }
  }
  if (!data.image) {
    return {
      ok: false,
      code: 'BAIDU_MATTING_ERROR',
      message: '百度抠图未返回图片',
      provider: 'baidu',
      timing: [`百度智能抠图: ${Date.now() - started}ms`]
    }
  }

  return {
    ok: true,
    provider: 'baidu',
    imageBase64: normalizeBase64(data.image),
    mime: 'image/png',
    timing: [`百度智能抠图: ${Date.now() - started}ms`]
  }
}

module.exports = {
  matting,
  provider: 'baidu'
}
