/**
 * 百度动物识别
 * 文档：https://ai.baidu.com/ai-doc/IMAGERECOGNITION/Zk3bcxdfr
 * 密钥：BAIDU_API_KEY / BAIDU_SECRET_KEY（控制台「应用」里的 API Key / Secret Key）
 */
const https = require('https')
const querystring = require('querystring')
const { getRecognizeConfig } = require('../recognize-config')
const {
  UNKNOWN_LABEL,
  CONFIDENCE_THRESHOLD,
  pickBreedFromLabels,
  isCatName,
  isDogName
} = require('../breed-map')

let cachedToken = {
  accessToken: '',
  expiresAt: 0
}

function normalizeBase64(input) {
  const raw = String(input || '')
  const idx = raw.indexOf('base64,')
  return idx >= 0 ? raw.slice(idx + 7) : raw
}

function httpsRequest(url, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method,
        headers
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch (e) {
            json = null
          }
          if (res.statusCode >= 400) {
            const err = new Error(
              (json && (json.error_msg || json.error_description || json.error)) ||
                `HTTP ${res.statusCode}`
            )
            err.code = (json && (json.error_code || json.error)) || 'BAIDU_HTTP_ERROR'
            err.body = json || text
            reject(err)
            return
          }
          resolve(json || { raw: text })
        })
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function getAccessToken() {
  const now = Date.now()
  if (cachedToken.accessToken && cachedToken.expiresAt > now + 60 * 1000) {
    return cachedToken.accessToken
  }

  const { baidu } = getRecognizeConfig()
  const { apiKey, secretKey } = baidu
  if (!apiKey || !secretKey) {
    const err = new Error(
      '未配置百度密钥：请填云函数环境变量或 secrets.local.js 的 BAIDU_API_KEY / BAIDU_SECRET_KEY'
    )
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
  const res = await httpsRequest(url, { method: 'GET' })
  if (!res.access_token) {
    const err = new Error(res.error_description || res.error || '获取百度 access_token 失败')
    err.code = 'BAIDU_TOKEN_ERROR'
    throw err
  }
  cachedToken = {
    accessToken: res.access_token,
    expiresAt: now + Math.max(60, Number(res.expires_in || 2592000) - 300) * 1000
  }
  return cachedToken.accessToken
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isQpsLimitError(resOrErr) {
  const code = Number(
    (resOrErr && (resOrErr.error_code || resOrErr.code)) || 0
  )
  const msg = String(
    (resOrErr && (resOrErr.error_msg || resOrErr.message)) || ''
  )
  return code === 18 || /qps request limit/i.test(msg)
}

async function callAnimalRecognize({ imageBase64, imageUrl }) {
  const token = await getAccessToken()
  const form = {
    top_num: 6,
    baike_num: 0
  }
  if (imageUrl) {
    form.url = imageUrl
  } else {
    form.image = imageBase64
  }
  const body = querystring.stringify(form)
  const url = `https://aip.baidubce.com/rest/2.0/image-classify/v1/animal?access_token=${encodeURIComponent(
    token
  )}`

  // 免费档约 2 QPS：遇 18 限流则退避重试
  let last = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await httpsRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        },
        body
      })
      if (isQpsLimitError(res) && attempt < 4) {
        const wait = 400 * attempt
        console.warn(`[baidu] QPS limit, retry in ${wait}ms (#${attempt})`)
        await sleep(wait)
        last = res
        continue
      }
      return res
    } catch (e) {
      if (isQpsLimitError(e) && attempt < 4) {
        const wait = 400 * attempt
        console.warn(`[baidu] QPS limit(http), retry in ${wait}ms (#${attempt})`)
        await sleep(wait)
        last = e
        continue
      }
      throw e
    }
  }
  return last
}

function buildRawDebug({ results, mappedBreed, errorText }) {
  const lines = ['—— 百度动物识别原始结果 ——']
  const list = Array.isArray(results) ? results : []
  if (!list.length) {
    lines.push('result: 无')
  } else {
    list.slice(0, 10).forEach((item, i) => {
      const score = Number(item.score)
      const pct = Number.isFinite(score)
        ? (score <= 1 ? score * 100 : score).toFixed(1)
        : String(item.score || '')
      lines.push(`${i + 1}. ${item.name} ${pct}%`)
    })
  }
  if (mappedBreed) lines.push(`我们映射品种: ${mappedBreed}`)
  if (errorText) lines.push(`错误: ${errorText}`)
  return {
    text: lines.join('\n'),
    labels: list.slice(0, 10).map((item) => {
      const score = Number(item.score)
      const confidence = Number.isFinite(score)
        ? Math.round(score <= 1 ? score * 100 : score)
        : 0
      return { name: item.name, confidence }
    })
  }
}

function toLabelList(results) {
  return (results || []).map((item) => {
    const score = Number(item.score)
    const confidence = Number.isFinite(score)
      ? Math.max(0, Math.min(100, score <= 1 ? score * 100 : score))
      : 0
    return { Name: item.name, Confidence: confidence }
  })
}

function inferPetType(labels) {
  let bestCat = 0
  let bestDog = 0
  for (let i = 0; i < labels.length; i++) {
    const name = labels[i].Name
    const conf = labels[i].Confidence
    if (isCatName(name)) bestCat = Math.max(bestCat, conf)
    if (isDogName(name)) bestDog = Math.max(bestDog, conf)
  }
  if (bestCat >= 40 && bestCat >= bestDog) return { petName: 'cat', score: bestCat }
  if (bestDog >= 40 && bestDog > bestCat) return { petName: 'dog', score: bestDog }
  return null
}

async function recognizePet(input = {}) {
  const totalStart = Date.now()
  const timing = []
  const imageBase64 = normalizeBase64(input.imageBase64)
  const imageUrl = input.imageUrl || ''

  console.log('[baidu timing] start', {
    hasBase64: !!imageBase64,
    b64Len: imageBase64 ? imageBase64.length : 0,
    hasUrl: !!imageUrl
  })

  if (!imageBase64 && !imageUrl) {
    return {
      ok: false,
      code: 'NO_CAT',
      message: '找不到猫咪',
      breed: '',
      confidence: 0,
      provider: 'baidu',
      timing: [`云函数总耗时: ${Date.now() - totalStart}ms`]
    }
  }

  let apiRes
  try {
    const tokenStart = Date.now()
    await getAccessToken()
    timing.push(`获取access_token: ${Date.now() - tokenStart}ms`)

    const apiStart = Date.now()
    apiRes = await callAnimalRecognize({ imageBase64, imageUrl })
    timing.push(`动物识别API: ${Date.now() - apiStart}ms`)
  } catch (e) {
    const code = (e && e.code) || 'BAIDU_ERROR'
    if (code === 'NO_BAIDU_KEY') throw e
    const raw = buildRawDebug({
      results: [],
      mappedBreed: '',
      errorText: `${code} ${(e && e.message) || e}`
    })
    timing.push(`云函数总耗时: ${Date.now() - totalStart}ms`)
    raw.text += `\n—— 耗时 ——\n${timing.join('\n')}`
    raw.timing = timing.slice()
    console.log('[baidu raw]', raw.text)
    return {
      ok: false,
      code: 'BAIDU_ERROR',
      message: (e && e.message) || '百度识别失败',
      breed: '',
      confidence: 0,
      provider: 'baidu',
      labels: [],
      rawDebug: raw,
      timing: raw.timing
    }
  }

  // 百度业务错误（如未检测到动物 / QPS 限流）
  if (apiRes && apiRes.error_code) {
    const raw = buildRawDebug({
      results: [],
      mappedBreed: '',
      errorText: `${apiRes.error_code} ${apiRes.error_msg || ''}`
    })
    timing.push(`云函数总耗时: ${Date.now() - totalStart}ms`)
    raw.text += `\n—— 耗时 ——\n${timing.join('\n')}`
    raw.timing = timing.slice()
    console.log('[baidu raw]', raw.text)
    if (isQpsLimitError(apiRes)) {
      return {
        ok: false,
        code: 'BAIDU_QPS',
        message:
          '百度 QPS 受限。请到控制台对「动物识别」开通按量后付费（免费 1 万次仍先扣，未用完不收费），QPS 会升到约 10',
        breed: '',
        confidence: 0,
        provider: 'baidu',
        labels: [],
        rawDebug: raw,
        timing: raw.timing
      }
    }
    return {
      ok: false,
      code: 'NO_CAT',
      message: '找不到猫咪',
      breed: '',
      confidence: 0,
      provider: 'baidu',
      labels: [],
      rawDebug: raw,
      timing: raw.timing
    }
  }

  const results = Array.isArray(apiRes.result) ? apiRes.result : []
  const labels = toLabelList(results)
  const inferred = inferPetType(labels)

  const finishRaw = (mappedBreed) => {
    const raw = buildRawDebug({ results, mappedBreed: mappedBreed || '' })
    timing.push(`云函数总耗时: ${Date.now() - totalStart}ms`)
    raw.text += `\n—— 耗时 ——\n${timing.join('\n')}`
    raw.timing = timing.slice()
    console.log('[baidu raw]', raw.text)
    return raw
  }

  if (!inferred || inferred.petName !== 'cat') {
    const raw = finishRaw('')
    return {
      ok: false,
      code: 'NO_CAT',
      message: '找不到猫咪',
      breed: '',
      confidence: inferred ? inferred.score : 0,
      petType: inferred ? inferred.petName : '',
      provider: 'baidu',
      labels: raw.labels,
      rawDebug: raw,
      timing: raw.timing
    }
  }

  const mapped = pickBreedFromLabels(labels, 'cat')
  const confidence = mapped.confidence || inferred.score
  const raw = finishRaw(mapped.breed)

  if (confidence > 0 && confidence < CONFIDENCE_THRESHOLD && mapped.breed === UNKNOWN_LABEL) {
    return {
      ok: false,
      code: 'LOW_CONFIDENCE',
      message: '没看清，靠近一点再拍一张',
      breed: mapped.breed,
      confidence,
      petType: 'cat',
      provider: 'baidu',
      labels: raw.labels,
      rawDebug: raw,
      timing: raw.timing
    }
  }

  return {
    ok: true,
    breed: mapped.breed || '中华田园猫',
    confidence: confidence || 80,
    petType: 'cat',
    location: null,
    provider: 'baidu',
    labels: raw.labels,
    rawDebug: raw,
    timing: raw.timing,
    baiduTop: results.slice(0, 3).map((r) => ({ name: r.name, score: r.score }))
  }
}

module.exports = {
  recognizePet,
  provider: 'baidu'
}
