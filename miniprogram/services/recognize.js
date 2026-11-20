/**
 * 识别编排：云端（默认百度）只负责「是猫 + 品种」；抠图一律本机 rembg 整图
 */
const MAX_SIDE = 480
const JPEG_QUALITY = 0.65
const CLOUD_TIMEOUT_MS = 25000
// rembg 本机推理常超过 30s，识别成功后仍要抠图
const STICKER_TIMEOUT_MS = 180000

function nowMs() {
  return Date.now()
}

function logStep(tag, step, startedAt, extra) {
  const ms = nowMs() - startedAt
  if (extra !== undefined) {
    console.log(`[recognize timing] ${tag} | ${step}: ${ms}ms`, extra)
  } else {
    console.log(`[recognize timing] ${tag} | ${step}: ${ms}ms`)
  }
  return ms
}

function withTimeout(promise, ms, onTimeout) {
  let timer = null
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (typeof onTimeout === 'function') {
        try {
          resolve(onTimeout())
          return
        } catch (e) {
          reject(e)
          return
        }
      }
      const err = new Error('timeout')
      err.code = 'TIMEOUT'
      reject(err)
    }, ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function readFileBase64(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (res) => resolve(res.data),
      fail: reject
    })
  })
}

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: resolve,
      fail: reject
    })
  })
}

function canvasToTempJpeg(canvas) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      fileType: 'jpg',
      quality: JPEG_QUALITY,
      success: (res) => resolve(res.tempFilePath),
      fail: reject
    })
  })
}

function loadCanvasImage(canvas, src) {
  return new Promise((resolve, reject) => {
    const img = canvas.createImage()
    const timer = setTimeout(() => {
      reject(new Error('image load timeout'))
    }, 5000)
    img.onload = () => {
      clearTimeout(timer)
      resolve(img)
    }
    img.onerror = (e) => {
      clearTimeout(timer)
      reject(e || new Error('image load failed'))
    }
    img.src = src
  })
}

/** 压缩图片后再转 base64；失败则直接读原图 */
async function prepareCloudImage(filePath, pageCanvas) {
  try {
    const info = await getImageInfo(filePath)
    const srcW = info.width || 0
    const srcH = info.height || 0
    if (!srcW || !srcH) {
      const imageBase64 = await readFileBase64(filePath)
      return { imageBase64, imageWidth: 0, imageHeight: 0 }
    }

    const scale = Math.min(1, MAX_SIDE / Math.max(srcW, srcH))
    const width = Math.max(1, Math.round(srcW * scale))
    const height = Math.max(1, Math.round(srcH * scale))

    let canvas = null
    if (typeof wx.createOffscreenCanvas === 'function') {
      try {
        canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
      } catch (e) {
        canvas = null
      }
    }
    if (!canvas && pageCanvas) {
      canvas = pageCanvas
      canvas.width = width
      canvas.height = height
    }
    if (!canvas) {
      const imageBase64 = await readFileBase64(filePath)
      return { imageBase64, imageWidth: srcW, imageHeight: srcH }
    }

    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      const imageBase64 = await readFileBase64(filePath)
      return { imageBase64, imageWidth: srcW, imageHeight: srcH }
    }

    const img = await loadCanvasImage(canvas, filePath)
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)
    const tempPath = await canvasToTempJpeg(canvas)
    const imageBase64 = await readFileBase64(tempPath)
    return { imageBase64, imageWidth: width, imageHeight: height }
  } catch (e) {
    console.warn('[recognize] prepareCloudImage fallback raw', e)
    const imageBase64 = await readFileBase64(filePath)
    return { imageBase64, imageWidth: 0, imageHeight: 0 }
  }
}

async function callCloudRecognize({ imageBase64, imageWidth, imageHeight }) {
  const res = await wx.cloud.callFunction({
    name: 'api',
    data: {
      action: 'recognize',
      imageBase64,
      imageWidth,
      imageHeight
    }
  })
  const result = (res && res.result) || {}
  if (result.error) {
    const err = new Error(result.error)
    err.code = result.code || 'CLOUD_ERROR'
    err.rawDebug = result.rawDebug || null
    throw err
  }
  return result
}

async function runSticker(filePath, canvas) {
  const { makeStickerWithCloudMatting } = require('./cloud-matting')
  try {
    const sticker = await withTimeout(
      makeStickerWithCloudMatting(filePath, {
        canvas,
        // 腾讯框不可靠（常只框头），识别成功后强制整图 rembg
        forceRembgFull: true,
        location: null,
        detectWidth: 0,
        detectHeight: 0
      }),
      STICKER_TIMEOUT_MS,
      () => ({ ok: false, code: 'MATTING_FAILED', message: '抠图超时', cutoutPath: filePath })
    )
    if (sticker && sticker.ok && sticker.cutoutPath) {
      return {
        cutoutPath: sticker.cutoutPath,
        mattingFailed: false,
        mattingProvider: sticker.provider || '',
        cropped: false
      }
    }
  } catch (e) {
    console.warn('[recognize] sticker fail', e)
  }
  return { cutoutPath: filePath, mattingFailed: true }
}

function failResult(code, message, extra = {}) {
  return {
    ok: false,
    code,
    message,
    breed: '',
    confidence: 0,
    mattingFailed: true,
    cutoutPath: extra.cutoutPath || '',
    originalPath: extra.originalPath || '',
    provider: extra.provider || 'tencent',
    rawDebug: extra.rawDebug || null,
    ...extra
  }
}

/**
 * @param {{ filePath?: string, canvas?: any, useCloud?: boolean }} payload
 */
function appendTimingToRaw(rawDebug, timingLines) {
  const text = (rawDebug && rawDebug.text) || ''
  const timingBlock = ['—— 耗时 ——', ...timingLines].join('\n')
  return {
    ...(rawDebug || {}),
    text: text ? `${text}\n${timingBlock}` : timingBlock,
    timing: timingLines
  }
}

async function recognize(payload = {}) {
  const filePath = payload.filePath || ''
  const canvas = payload.canvas
  const useCloud = payload.useCloud === true
  const totalStart = nowMs()
  const timing = []

  console.log('[recognize timing] start', { useCloud: !!useCloud, hasCloud: !!wx.cloud })

  if (!filePath) {
    return failResult('NO_CAT', '找不到猫咪')
  }

  if (!useCloud || !wx.cloud) {
    timing.push(`总耗时: ${nowMs() - totalStart}ms`)
    return failResult('NO_CLOUD', '云开发未就绪，无法识别', {
      provider: 'none',
      originalPath: filePath,
      cutoutPath: filePath,
      rawDebug: appendTimingToRaw(
        { text: '未调用腾讯云：cloudReady/useCloud 为 false' },
        timing
      )
    })
  }

  // 腾讯识别与 rembg 并行：墙钟≈max(识别,抠图)，不再串行相加
  let cloudResult = null
  let sticker = { cutoutPath: filePath, mattingFailed: true }
  try {
    const prepareStart = nowMs()
    const prepared = await withTimeout(prepareCloudImage(filePath, canvas), 6000, () => {
      const err = new Error('图片准备超时')
      err.code = 'TIMEOUT'
      throw err
    })
    const prepareMs = logStep('client', '1.压缩转base64', prepareStart, {
      w: prepared.imageWidth,
      h: prepared.imageHeight,
      b64Len: (prepared.imageBase64 && prepared.imageBase64.length) || 0
    })
    timing.push(`1.压缩转base64: ${prepareMs}ms`)

    const cloudStart = nowMs()
    const stickerStart = nowMs()
    const cloudPromise = withTimeout(callCloudRecognize(prepared), CLOUD_TIMEOUT_MS, () => {
      const err = new Error('腾讯云识别超时')
      err.code = 'TIMEOUT'
      throw err
    }).then((res) => {
      const cloudMs = logStep('client', '2.云函数+腾讯识别', cloudStart, {
        ok: !!(res && res.ok),
        code: res && res.code,
        breed: res && res.breed
      })
      timing.push(`2.云函数+腾讯识别: ${cloudMs}ms`)
      if (res && res.timing) timing.push(...res.timing.map((t) => `  ${t}`))
      return res
    })

    const stickerPromise = runSticker(filePath, canvas).then((res) => {
      const stickerMs = logStep('client', '3.整图rembg(并行)', stickerStart, {
        mattingFailed: res && res.mattingFailed
      })
      timing.push(`3.整图rembg(并行): ${stickerMs}ms`)
      return res
    })

    const [cloudSettled, stickerSettled] = await Promise.allSettled([cloudPromise, stickerPromise])

    if (cloudSettled.status === 'fulfilled') {
      cloudResult = cloudSettled.value
    } else {
      const e = cloudSettled.reason || {}
      console.warn('[recognize] tencent cloud fail', e)
      const code = e.code || 'TENCENT_ERROR'
      // 识别挂了仍可用 rembg 结果；只有密钥类错误才整单失败
      if (code === 'NO_TENCENT_KEY' || code === 'NO_BAIDU_KEY') {
        timing.push(`失败总耗时: ${nowMs() - totalStart}ms`)
        return failResult(code, e.message || '未配置识别密钥', {
          originalPath: filePath,
          cutoutPath: filePath,
          rawDebug: appendTimingToRaw(
            e.rawDebug || { text: `识别失败\ncode: ${code}\nmessage: ${e.message || ''}` },
            timing
          )
        })
      }
      timing.push(`2.腾讯识别失败(继续用rembg): ${e.message || code}`)
    }

    if (stickerSettled.status === 'fulfilled') {
      sticker = stickerSettled.value || sticker
    } else {
      console.warn('[recognize] rembg parallel fail', stickerSettled.reason)
      timing.push(`3.整图rembg失败: ${(stickerSettled.reason && stickerSettled.reason.message) || ''}`)
    }
  } catch (e) {
    const failMs = logStep('client', '失败结束', totalStart, e && e.message)
    timing.push(`失败总耗时: ${failMs}ms`)
    console.warn('[recognize] prepare/parallel fail', e)
    const code = (e && e.code) || 'TENCENT_ERROR'
    return failResult(
      code,
      code === 'TIMEOUT' ? '处理超时，请重试' : (e && e.message) || '识别失败',
      {
        originalPath: filePath,
        cutoutPath: filePath,
        rawDebug: appendTimingToRaw(
          (e && e.rawDebug) || { text: `失败\ncode: ${code}\nmessage: ${(e && e.message) || ''}` },
          timing
        )
      }
    )
  }

  if (cloudResult && cloudResult.rawDebug) {
    console.log('[recognize raw]', cloudResult.rawDebug.text)
  }

  // 明确非猫：丢弃 rembg 结果
  if (cloudResult && cloudResult.ok === false) {
    const code = cloudResult.code || 'NO_CAT'
    const petType = String(cloudResult.petType || '')
    if (petType && petType !== 'cat') {
      const totalMs = logStep('client', '非猫结束', totalStart)
      timing.push(`总耗时: ${totalMs}ms`)
      return {
        ...failResult(code, cloudResult.message || '找不到猫咪', {
          originalPath: filePath,
          cutoutPath: filePath,
          provider: cloudResult.provider || 'tencent',
          rawDebug: appendTimingToRaw(cloudResult.rawDebug || null, timing),
          petType: cloudResult.petType,
          labels: cloudResult.labels || []
        })
      }
    }
    timing.push(`2b.识别未完整通过 (${code})，已用并行 rembg`)
  }

  const recognized = !!(cloudResult && cloudResult.ok)
  const breed = recognized
    ? cloudResult.breed
    : cloudResult && cloudResult.breed
      ? cloudResult.breed
      : '待识别'
  const confidence = recognized
    ? cloudResult.confidence || 0
    : Number(cloudResult && cloudResult.confidence) || 0
  const totalMs = logStep('client', '全部完成', totalStart, { breed, confidence })
  timing.push(`总耗时: ${totalMs}ms`)

  return {
    ok: true,
    breed,
    confidence,
    hint: recognized
      ? '腾讯识别∥rembg整图（并行）'
      : '未识别到品种，已 rembg 整图抠',
    petType: (cloudResult && cloudResult.petType) || '',
    location: null,
    provider: 'tencent+rembg',
    labels: (cloudResult && cloudResult.labels) || [],
    rawDebug: appendTimingToRaw((cloudResult && cloudResult.rawDebug) || null, timing),
    timing,
    mattingFailed: !!(sticker && sticker.mattingFailed),
    cutoutPath: (sticker && sticker.cutoutPath) || filePath,
    originalPath: filePath,
    mock: false
  }
}

/**
 * 只取宠物框，不抠图。用于贴纸模式：DetectPet → location → 裁猫再 rembg
 */
async function detectPetBox(payload = {}) {
  const filePath = payload.filePath || ''
  const canvas = payload.canvas
  if (!filePath || !wx.cloud) {
    return { ok: false, location: null, detectWidth: 0, detectHeight: 0 }
  }
  try {
    const prepared = await withTimeout(prepareCloudImage(filePath, canvas), 6000, () => {
      const err = new Error('图片准备超时')
      err.code = 'TIMEOUT'
      throw err
    })
    const cloudResult = await withTimeout(callCloudRecognize(prepared), CLOUD_TIMEOUT_MS, () => {
      const err = new Error('腾讯云识别超时')
      err.code = 'TIMEOUT'
      throw err
    })
    const location = (cloudResult && cloudResult.location) || null
    // 有框且判定为猫即可裁切（含 HEAD_ONLY 等业务失败，贴纸模式仍可精抠）
    const isCat =
      !!(cloudResult && cloudResult.ok) ||
      String((cloudResult && cloudResult.petType) || '') === 'cat'
    return {
      ok: !!(location && isCat),
      location: location && isCat ? location : null,
      detectWidth: prepared.imageWidth || 0,
      detectHeight: prepared.imageHeight || 0,
      code: cloudResult && cloudResult.code,
      message: cloudResult && cloudResult.message
    }
  } catch (e) {
    console.warn('[recognize] detectPetBox fail', e)
    return {
      ok: false,
      location: null,
      detectWidth: 0,
      detectHeight: 0,
      code: (e && e.code) || 'DETECT_ERROR',
      message: (e && e.message) || '检测失败'
    }
  }
}

/**
 * 只跑腾讯品种识别（不含 rembg），供拍照页与抠图并行、先出预览。
 */
async function recognizeBreedOnly(payload = {}) {
  const filePath = payload.filePath || ''
  const canvas = payload.canvas
  const useCloud = payload.useCloud === true
  if (!filePath) {
    return failResult('NO_CAT', '找不到猫咪')
  }
  if (!useCloud || !wx.cloud) {
    return failResult('NO_CLOUD', '云开发未就绪，无法识别', { provider: 'none' })
  }
  try {
    const prepared = await withTimeout(prepareCloudImage(filePath, canvas), 6000, () => {
      const err = new Error('图片准备超时')
      err.code = 'TIMEOUT'
      throw err
    })
    return await withTimeout(callCloudRecognize(prepared), CLOUD_TIMEOUT_MS, () => {
      const err = new Error('腾讯云识别超时')
      err.code = 'TIMEOUT'
      throw err
    })
  } catch (e) {
    return failResult((e && e.code) || 'TENCENT_ERROR', (e && e.message) || '云识别失败', {
      provider: 'tencent',
      rawDebug: (e && e.rawDebug) || null
    })
  }
}

module.exports = {
  recognize,
  recognizeBreedOnly,
  detectPetBox
}
