/**
 * 腾讯云图像识别：DetectPet + DetectLabel
 * 密钥：TENCENT_SECRET_ID / TENCENT_SECRET_KEY
 */
const tencentcloud = require('tencentcloud-sdk-nodejs')
const { getRecognizeConfig } = require('../recognize-config')
const {
  UNKNOWN_LABEL,
  CONFIDENCE_THRESHOLD,
  pickBreedFromLabels,
  isCatName,
  isDogName
} = require('../breed-map')

const TiiaClient = tencentcloud.tiia.v20190529.Client

function getClient() {
  const { tencent } = getRecognizeConfig()
  const { secretId, secretKey, region } = tencent
  if (!secretId || !secretKey) {
    const err = new Error(
      '未配置腾讯云密钥：请填云函数环境变量，或本地 secrets.local.js 的 TENCENT_SECRET_ID / TENCENT_SECRET_KEY'
    )
    err.code = 'NO_TENCENT_KEY'
    throw err
  }
  return new TiiaClient({
    credential: { secretId, secretKey },
    region,
    profile: {
      httpProfile: { endpoint: 'tiia.tencentcloudapi.com' }
    }
  })
}

function normalizeBase64(input) {
  const raw = String(input || '')
  const idx = raw.indexOf('base64,')
  return idx >= 0 ? raw.slice(idx + 7) : raw
}

function inferPetFromLabels(labels) {
  const list = Array.isArray(labels) ? labels : []
  let bestCat = 0
  let bestDog = 0
  for (let i = 0; i < list.length; i++) {
    const name = String((list[i] && list[i].Name) || '')
    const conf = Number((list[i] && list[i].Confidence) || 0)
    if (isCatName(name)) bestCat = Math.max(bestCat, conf)
    if (isDogName(name)) bestDog = Math.max(bestDog, conf)
  }
  if (bestCat >= 60 && bestCat >= bestDog) {
    return { petName: 'cat', score: bestCat, source: 'DetectLabel' }
  }
  if (bestDog >= 60 && bestDog > bestCat) {
    return { petName: 'dog', score: bestDog, source: 'DetectLabel' }
  }
  return null
}

function buildRawDebug({ pets, labels, mappedBreed }) {
  const petLines = (pets || []).slice(0, 5).map((p, i) => {
    const loc = p.Location || {}
    return `${i + 1}. DetectPet: ${p.Name} ${Number(p.Score || 0).toFixed(1)}% 框(${loc.X},${loc.Y},${loc.Width}x${loc.Height})`
  })
  const labelLines = (labels || [])
    .slice()
    .sort((a, b) => (b.Confidence || 0) - (a.Confidence || 0))
    .slice(0, 15)
    .map((l, i) => `${i + 1}. DetectLabel: ${l.Name} ${Number(l.Confidence || 0).toFixed(1)}%`)
  const lines = [
    '—— 腾讯云原始结果 ——',
    ...petLines,
    ...(petLines.length ? [] : ['DetectPet: 无']),
    ...labelLines,
    ...(labelLines.length ? [] : ['DetectLabel: 无']),
    mappedBreed ? `我们映射品种: ${mappedBreed}` : ''
  ].filter(Boolean)
  return {
    text: lines.join('\n'),
    pets: (pets || []).slice(0, 5).map((p) => ({
      name: p.Name,
      score: p.Score,
      location: p.Location || null
    })),
    labels: (labels || []).slice(0, 15).map((l) => ({
      name: l.Name,
      confidence: l.Confidence
    }))
  }
}

function collectLabels(labelRes) {
  const bags = []
  if (!labelRes) return bags
  ;['Labels', 'CameraLabels', 'AlbumLabels', 'WebLabels'].forEach((key) => {
    if (Array.isArray(labelRes[key])) bags.push(...labelRes[key])
  })
  return bags
}

function assessBodyCompleteness(location, imgW, imgH, labels) {
  const w0 = Number(imgW) || 0
  const h0 = Number(imgH) || 0
  if (!location || !w0 || !h0) {
    return { ok: true, reason: 'skip' }
  }

  const x = Math.max(0, Number(location.X) || 0)
  const y = Math.max(0, Number(location.Y) || 0)
  const bw = Math.max(1, Number(location.Width) || 0)
  const bh = Math.max(1, Number(location.Height) || 0)

  const aspect = bh / bw
  const areaRatio = (bw * bh) / (w0 * h0)
  const fillW = bw / w0
  const fillH = bh / h0
  const topGap = y / h0
  const bottomGap = Math.max(0, (h0 - y - bh) / h0)
  const leftGap = x / w0
  const rightGap = Math.max(0, (w0 - x - bw) / w0)

  const squarish = aspect >= 0.72 && aspect <= 1.28
  const bigCloseUp = areaRatio >= 0.28 && (fillW >= 0.48 || fillH >= 0.48)
  const clippedBottom = bottomGap <= 0.025
  const clippedTop = topGap <= 0.025
  const clippedSides = leftGap <= 0.025 && rightGap <= 0.025

  const labelText = (labels || [])
    .map((l) => String((l && l.Name) || ''))
    .join(',')
  const faceHint = /猫脸|狗脸|面部|特写|头像|脸部|脸/.test(labelText)
  const bodyHint = /全身|躯干|站立|坐着|侧卧|奔跑/.test(labelText)

  if (faceHint && squarish && !bodyHint) {
    return {
      ok: false,
      code: 'HEAD_ONLY',
      message: '请拍到猫咪的身体，不要只拍头',
      meta: { aspect, areaRatio, fillW, fillH, faceHint: true }
    }
  }

  if (
    squarish &&
    bigCloseUp &&
    (clippedSides || (clippedTop && clippedBottom) || (clippedBottom && fillH >= 0.55))
  ) {
    return {
      ok: false,
      code: 'HEAD_ONLY',
      message: '请拍到猫咪的身体，不要只拍头',
      meta: { aspect, areaRatio, fillW, fillH, bigCloseUp: true }
    }
  }

  if (areaRatio < 0.045 && fillH < 0.22) {
    return {
      ok: false,
      code: 'TOO_FAR',
      message: '离近一点，把猫咪身体拍完整',
      meta: { aspect, areaRatio, fillH }
    }
  }

  return {
    ok: true,
    meta: { aspect, areaRatio, fillW, fillH, topGap, bottomGap }
  }
}

async function recognizePet(input = {}) {
  const totalStart = Date.now()
  const timing = []
  const imageBase64 = normalizeBase64(input.imageBase64)
  const imageUrl = input.imageUrl || ''
  console.log('[tencent timing] start', {
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
      provider: 'tencent',
      timing: [`云函数总耗时: ${Date.now() - totalStart}ms`]
    }
  }

  const clientStart = Date.now()
  const client = getClient()
  timing.push(`初始化TIAA客户端: ${Date.now() - clientStart}ms`)

  const payload = imageUrl ? { ImageUrl: imageUrl } : { ImageBase64: imageBase64 }

  const petStart = Date.now()
  const labelStart = Date.now()
  const petPromise = client.DetectPet(payload).then((res) => {
    timing.push(`DetectPet: ${Date.now() - petStart}ms`)
    return res
  })
  const labelPromise = client
    .DetectLabel({
      ...payload,
      Scenes: ['CAMERA', 'ALBUM']
    })
    .then((res) => {
      timing.push(`DetectLabel: ${Date.now() - labelStart}ms`)
      return res
    })

  const parallelStart = Date.now()
  const [petSettled, labelSettled] = await Promise.allSettled([petPromise, labelPromise])
  timing.push(`DetectPet+DetectLabel并行墙钟: ${Date.now() - parallelStart}ms`)

  let petRes = null
  let labels = []
  let petError = ''
  let labelError = ''

  if (petSettled.status === 'fulfilled') {
    petRes = petSettled.value
  } else {
    const e = petSettled.reason || {}
    petError = `${e.code || e.Code || ''} ${e.message || e.Message || String(e)}`.trim()
    if (!timing.some((t) => t.indexOf('DetectPet:') === 0)) {
      timing.push(`DetectPet失败: ${Date.now() - petStart}ms`)
    }
    if (
      String(e.code || e.Code || '') === 'NO_TENCENT_KEY' ||
      petError.indexOf('未配置腾讯云密钥') >= 0
    ) {
      const err = new Error(petError || '未配置腾讯云密钥')
      err.code = 'NO_TENCENT_KEY'
      throw err
    }
  }

  if (labelSettled.status === 'fulfilled') {
    labels = collectLabels(labelSettled.value)
  } else {
    const e = labelSettled.reason || {}
    labelError = `${e.code || e.Code || ''} ${e.message || e.Message || String(e)}`.trim()
    if (!timing.some((t) => t.indexOf('DetectLabel:') === 0)) {
      timing.push(`DetectLabel失败: ${Date.now() - labelStart}ms`)
    }
  }

  const pets = (petRes && petRes.Pets) || []
  let petName = ''
  let petScore = 0
  let location = null
  let petSource = 'DetectPet'

  if (pets.length) {
    pets.sort((a, b) => (b.Score || 0) - (a.Score || 0))
    const top = pets[0]
    petName = String(top.Name || '').toLowerCase()
    petScore = Math.max(0, Math.min(100, Number(top.Score) || 0))
    location = top.Location || null
  } else {
    const inferred = inferPetFromLabels(labels)
    if (inferred && inferred.petName === 'cat') {
      petName = 'cat'
      petScore = inferred.score
      location = null
      petSource = 'DetectLabel'
      timing.push(`DetectPet未检出，改用DetectLabel兜底猫 ${inferred.score}%`)
    }
  }

  const rawBase = (mappedBreed) => {
    const raw = buildRawDebug({ pets, labels, mappedBreed: mappedBreed || '' })
    const extra = []
    if (petError) extra.push(`DetectPet 错误: ${petError}`)
    if (labelError) extra.push(`DetectLabel 错误: ${labelError}`)
    if (petSource === 'DetectLabel') {
      extra.push('判定来源: DetectLabel 兜底（DetectPet 未检出）')
    }
    timing.push(`云函数总耗时: ${Date.now() - totalStart}ms`)
    extra.push('—— 耗时 ——', ...timing)
    raw.text = `${raw.text}\n${extra.join('\n')}`
    raw.timing = timing.slice()
    console.log('[tencent raw]', raw.text)
    return raw
  }

  if (!petName) {
    const raw = rawBase('')
    return {
      ok: false,
      code: 'NO_CAT',
      message: '找不到猫咪',
      breed: '',
      confidence: 0,
      provider: 'tencent',
      labels: raw.labels,
      rawDebug: raw,
      timing: raw.timing
    }
  }

  if (petName !== 'cat') {
    const raw = rawBase('')
    return {
      ok: false,
      code: 'NO_CAT',
      message: '找不到猫咪',
      breed: '',
      confidence: petScore,
      petType: petName,
      location,
      provider: 'tencent',
      labels: raw.labels,
      rawDebug: raw,
      timing: raw.timing
    }
  }

  const completeness = assessBodyCompleteness(
    location,
    input.imageWidth,
    input.imageHeight,
    labels
  )
  if (!completeness.ok) {
    const raw = rawBase('')
    return {
      ok: false,
      code: completeness.code || 'HEAD_ONLY',
      message: completeness.message || '请拍到猫咪的身体，不要只拍头',
      breed: '',
      confidence: petScore,
      petType: petName,
      location,
      completeness: completeness.meta || null,
      provider: 'tencent',
      labels: raw.labels,
      rawDebug: raw,
      timing: raw.timing
    }
  }

  const mapped = pickBreedFromLabels(labels, petName)
  const confidence = mapped.confidence || petScore
  const raw = rawBase(mapped.breed)
  if (confidence > 0 && confidence < CONFIDENCE_THRESHOLD && mapped.breed === UNKNOWN_LABEL) {
    return {
      ok: false,
      code: 'LOW_CONFIDENCE',
      message: '没看清，靠近一点再拍一张',
      breed: mapped.breed,
      confidence,
      petType: petName,
      location,
      provider: 'tencent',
      labels: raw.labels,
      rawDebug: raw,
      timing: raw.timing
    }
  }

  return {
    ok: true,
    breed: mapped.breed || '中华田园猫',
    confidence: confidence || petScore || 80,
    petType: petName,
    location,
    completeness: completeness.meta || null,
    provider: 'tencent',
    labels: raw.labels,
    rawDebug: raw,
    timing: raw.timing
  }
}

module.exports = {
  recognizePet,
  provider: 'tencent'
}
