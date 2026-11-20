const querystring = require('querystring')
const { request } = require('./http-util')
const { getRecognizeConfig } = require('./recognize-config')

/** @type {Record<string, { accessToken: string, expiresAt: number }>} */
const cachedTokens = {}

function pickBaiduCreds(purpose) {
  const { baidu } = getRecognizeConfig()
  if (purpose === 'matting') {
    return {
      apiKey: baidu.mattingApiKey || baidu.apiKey,
      secretKey: baidu.mattingSecretKey || baidu.secretKey,
      label: baidu.mattingApiKey
        ? 'BAIDU_MATTING_API_KEY / BAIDU_MATTING_SECRET_KEY'
        : 'BAIDU_API_KEY / BAIDU_SECRET_KEY'
    }
  }
  return {
    apiKey: baidu.apiKey,
    secretKey: baidu.secretKey,
    label: 'BAIDU_API_KEY / BAIDU_SECRET_KEY'
  }
}

/**
 * @param {'recognize'|'matting'} [purpose]
 */
async function getBaiduAccessToken(purpose = 'recognize') {
  const key = purpose === 'matting' ? 'matting' : 'recognize'
  const now = Date.now()
  const cached = cachedTokens[key]
  if (cached && cached.accessToken && cached.expiresAt > now + 60 * 1000) {
    return cached.accessToken
  }

  const { apiKey, secretKey, label } = pickBaiduCreds(key)
  if (!apiKey || !secretKey) {
    const err = new Error(`未配置百度密钥：请填 ${label}`)
    err.code = 'NO_BAIDU_KEY'
    throw err
  }

  const url =
    'https://aip.baidubce.com/oauth/2.0/token?' +
    querystring.stringify({
      grant_type: 'client_credentials',
      client_id: apiKey,
      client_secret: secretKey
    })
  const res = await request(url, { method: 'GET' })
  const data = res.json || {}
  if (!data.access_token) {
    const err = new Error(data.error_description || data.error || '获取百度 access_token 失败')
    err.code = 'BAIDU_TOKEN_ERROR'
    throw err
  }
  cachedTokens[key] = {
    accessToken: data.access_token,
    expiresAt: now + Math.max(60, Number(data.expires_in || 2592000) - 300) * 1000
  }
  return cachedTokens[key].accessToken
}

module.exports = {
  getBaiduAccessToken
}
