/**
 * 抠图编排（类型见 constants/matting-mode.js）
 *  - lite：端侧粗抠（洪水 + 椭圆兜底）
 *  - fast：云端百度
 *  - quality：本机 rembg 整图（不用腾讯框）
 */
const {
  makeCatSticker,
  makeLiteSticker,
  addWhiteBorderFromCutout,
  repairRembgCutout
} = require('../utils/cat-sticker')
const localRembg = require('../constants/matting-local')
const mattingMode = require('../constants/matting-mode')

const CLOUD_TIMEOUT_MS = 45000
const LOCAL_REMBG_TIMEOUT_MS = 180000
/** 裁切后再送抠图的最长边；猫块本身已小，无需整图 480 */
const CROP_MAX_SIDE = 640
/** 相对检测框外扩（基础）；DetectPet 常只框头，实际还会向下加大 */
const CROP_PAD_RATIO = 0.35

/**
 * DetectPet 经常只框猫头：方框 + 下沿偏上 → 裁切会把身体切掉。
 * 这种框直接跳过裁切，整图交给 rembg 更稳。
 */
function looksLikeHeadOnlyBox(sx, sy, sw, sh, srcW, srcH) {
  if (!srcW || !srcH || sw < 8 || sh < 8) return false
  const aspect = sh / Math.max(1, sw)
  const bottomReach = (sy + sh) / srcH
  const areaRatio = (sw * sh) / (srcW * srcH)
  const squarish = aspect >= 0.65 && aspect <= 1.45
  // 框下沿到不了画面约 72%，多半只框了头/胸
  if (squarish && bottomReach < 0.72) return true
  // 很小的方框也偏向头特写
  if (squarish && areaRatio < 0.14) return true
  return false
}

function getActiveMode() {
  if (mattingMode && typeof mattingMode.getMode === 'function') {
    return mattingMode.getMode()
  }
  return String((mattingMode && mattingMode.MODE) || 'baidu')
}

function isQualityMode() {
  return getActiveMode() === 'quality'
}

function isRembgOnlyMode() {
  return getActiveMode() === 'rembg'
}

function isLiteMode() {
  return getActiveMode() === 'lite'
}

function isBaiduMode() {
  return getActiveMode() === 'baidu'
}

function isTencentMode() {
  return getActiveMode() === 'tencent'
}

function withTimeout(promise, ms, code, message) {
  let timer = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message || 'timeout')
      err.code = code || 'TIMEOUT'
      reject(err)
    }, ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src, success: resolve, fail: reject })
  })
}

function loadCanvasImage(canvas, src) {
  return new Promise((resolve, reject) => {
    const img = canvas.createImage()
    const timer = setTimeout(() => reject(new Error('image load timeout')), 5000)
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

function canvasToTempJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      fileType: 'jpg',
      quality: quality == null ? 0.85 : quality,
      success: (res) => resolve(res.tempFilePath),
      fail: reject
    })
  })
}

function createWorkCanvas(width, height) {
  if (typeof wx.createOffscreenCanvas === 'function') {
    try {
      return wx.createOffscreenCanvas({ type: '2d', width, height })
    } catch (e) {
      /* fallthrough */
    }
  }
  return null
}

function uploadCloudFile(filePath, cloudPath) {
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (res) => resolve(res.fileID),
      fail: reject
    })
  })
}

function downloadCloudFile(fileID) {
  return new Promise((resolve, reject) => {
    wx.cloud.downloadFile({
      fileID,
      success: (res) => {
        if (res.tempFilePath) resolve(res.tempFilePath)
        else reject(new Error('download empty'))
      },
      fail: reject
    })
  })
}

async function prepareUploadJpeg(filePath, pageCanvas, compress = {}) {
  const maxSide = compress.maxSide || (isQualityMode() ? 480 : 960)
  const quality = compress.quality == null ? (isQualityMode() ? 0.75 : 0.9) : compress.quality
  try {
    const info = await getImageInfo(filePath)
    const srcW = info.width || 0
    const srcH = info.height || 0
    if (!srcW || !srcH) return filePath

    const scale = Math.min(1, maxSide / Math.max(srcW, srcH))
    const width = Math.max(1, Math.round(srcW * scale))
    const height = Math.max(1, Math.round(srcH * scale))

    let canvas = createWorkCanvas(width, height)
    if (!canvas && pageCanvas) {
      canvas = pageCanvas
      canvas.width = width
      canvas.height = height
    }
    if (!canvas) return filePath

    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return filePath

    const img = await loadCanvasImage(canvas, filePath)
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)
    return canvasToTempJpeg(canvas, quality)
  } catch (e) {
    console.warn('[cloud-matting] compress fail, use raw', e)
    return filePath
  }
}

/**
 * 按宠物检测框裁出猫块（坐标相对 detectWidth/Height，映射回原图）
 * @returns {Promise<{ path: string, cropped: boolean, box?: object }>}
 */
async function cropByPetLocation(filePath, pageCanvas, location, detectSize = {}) {
  if (!location || !filePath) return { path: filePath, cropped: false }

  const x = Number(location.X)
  const y = Number(location.Y)
  const bw = Number(location.Width)
  const bh = Number(location.Height)
  if (![x, y, bw, bh].every((n) => Number.isFinite(n)) || bw < 8 || bh < 8) {
    return { path: filePath, cropped: false }
  }

  try {
    const info = await getImageInfo(filePath)
    const srcW = info.width || 0
    const srcH = info.height || 0
    if (!srcW || !srcH) return { path: filePath, cropped: false }

    const detW = Number(detectSize.width) || srcW
    const detH = Number(detectSize.height) || srcH
    if (!detW || !detH) return { path: filePath, cropped: false }

    const sx = (x / detW) * srcW
    const sy = (y / detH) * srcH
    const sw = (bw / detW) * srcW
    const sh = (bh / detH) * srcH

    // 头框裁切会「扣没身体」：默认跳过，整图抠
    const allowHeadCrop = detectSize.allowHeadCrop === true
    if (!allowHeadCrop && looksLikeHeadOnlyBox(sx, sy, sw, sh, srcW, srcH)) {
      console.log('[cloud-matting] skip crop: head-like DetectPet box', {
        box: `${Math.round(sw)}x${Math.round(sh)}`,
        bottomReach: Number(((sy + sh) / srcH).toFixed(2))
      })
      return { path: filePath, cropped: false, skipped: 'head-like' }
    }

    const padRatio =
      Number.isFinite(Number(detectSize.padRatio)) && Number(detectSize.padRatio) > 0
        ? Number(detectSize.padRatio)
        : CROP_PAD_RATIO
    const base = Math.max(sw, sh) * padRatio
    // 猫身体多在框下方：下边多扩、左右次之、上边少扩（保留耳朵）
    const padX = base * 1.1
    const padTop = base * 0.7
    const padBottom = Math.max(base * 2.2, sh * 1.35)

    let left = Math.max(0, Math.floor(sx - padX))
    let top = Math.max(0, Math.floor(sy - padTop))
    let right = Math.min(srcW, Math.ceil(sx + sw + padX))
    let bottom = Math.min(srcH, Math.ceil(sy + sh + padBottom))
    const cropW = right - left
    const cropH = bottom - top
    if (cropW < 16 || cropH < 16) return { path: filePath, cropped: false }

    // 框已几乎满图时裁切收益很小，跳过
    if (cropW * cropH > srcW * srcH * 0.85) {
      return { path: filePath, cropped: false }
    }

    const scale = Math.min(1, CROP_MAX_SIDE / Math.max(cropW, cropH))
    const outW = Math.max(1, Math.round(cropW * scale))
    const outH = Math.max(1, Math.round(cropH * scale))

    let canvas = createWorkCanvas(outW, outH)
    if (!canvas && pageCanvas) {
      canvas = pageCanvas
      canvas.width = outW
      canvas.height = outH
    }
    if (!canvas) return { path: filePath, cropped: false }

    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d')
    if (!ctx) return { path: filePath, cropped: false }

    const img = await loadCanvasImage(canvas, filePath)
    ctx.clearRect(0, 0, outW, outH)
    ctx.drawImage(img, left, top, cropW, cropH, 0, 0, outW, outH)
    const path = await canvasToTempJpeg(canvas, 0.88)
    console.log('[cloud-matting] crop by location', {
      src: `${srcW}x${srcH}`,
      box: `${Math.round(sw)}x${Math.round(sh)}`,
      out: `${outW}x${outH}`
    })
    return {
      path,
      cropped: true,
      box: { left, top, cropW, cropH, outW, outH }
    }
  } catch (e) {
    console.warn('[cloud-matting] crop fail, use full image', e)
    return { path: filePath, cropped: false }
  }
}

/** 有检测框则先裁猫，再压缩；无框则整图压缩 */
async function prepareMattingInput(filePath, pageCanvas, options = {}, compress = {}) {
  const timing = []
  let workPath = filePath
  let cropped = false

  if (options.location) {
    const t0 = Date.now()
    const crop = await cropByPetLocation(filePath, pageCanvas, options.location, {
      width: options.detectWidth,
      height: options.detectHeight
    })
    workPath = crop.path
    cropped = !!crop.cropped
    timing.push(`0.裁猫块: ${Date.now() - t0}ms${cropped ? '' : '(跳过)'}`)
  }

  const t1 = Date.now()
  // 已裁切时最长边已受 CROP_MAX_SIDE 限制，压缩可略松
  const maxSide = compress.maxSide || (cropped ? CROP_MAX_SIDE : isQualityMode() ? 480 : 960)
  const quality =
    compress.quality == null ? (isQualityMode() ? 0.8 : 0.9) : compress.quality
  const jpgPath = await prepareUploadJpeg(workPath, pageCanvas, { maxSide, quality })
  timing.push(`1.压缩图片: ${Date.now() - t1}ms`)

  return { jpgPath, cropped, timing }
}

function downloadHttpFile(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      timeout: LOCAL_REMBG_TIMEOUT_MS,
      success: (res) => {
        if (res.statusCode >= 400 || !res.tempFilePath) {
          reject(new Error(`download HTTP ${res.statusCode || 0}`))
          return
        }
        resolve(res.tempFilePath)
      },
      fail: reject
    })
  })
}

// 健康检查结果缓存：连续拍照时不必每张都多一次往返；上传失败会清掉缓存
const HEALTH_TTL_MS = 60000
let _healthOkAt = 0

function pingLocalRembg() {
  if (Date.now() - _healthOkAt < HEALTH_TTL_MS) return Promise.resolve(true)
  const base = String(localRembg.BASE_URL || 'http://127.0.0.1:7001').replace(/\/$/, '')
  return new Promise((resolve) => {
    wx.request({
      url: `${base}/health`,
      method: 'GET',
      timeout: 2500,
      success: (res) => {
        const ok = !!(res && res.statusCode === 200 && res.data && res.data.ok)
        _healthOkAt = ok ? Date.now() : 0
        resolve(ok)
      },
      fail: () => {
        _healthOkAt = 0
        resolve(false)
      }
    })
  })
}

/**
 * @param {{ model?: string, noFallback?: boolean }} [opts]
 *   noFallback：让服务端只跑快模型，没把握时返回 uncertain 而不是原地等精细模型
 */
function uploadToLocalRembg(filePath, opts = {}) {
  const base = String(localRembg.BASE_URL || 'http://127.0.0.1:7001').replace(/\/$/, '')
  const modelName =
    opts.model ||
    (mattingMode && mattingMode.QUALITY_MODEL) ||
    (localRembg && localRembg.MODEL) ||
    'u2net'
  const model = encodeURIComponent(modelName)
  let url = `${base}/api/remove?model=${model}`
  if (opts.noFallback) url += '&fallback=0'
  if (!opts.model && localRembg && localRembg.ALPHA) url += '&a=true&af=200&ab=15&ae=4'
  // 新服务 scripts/rembg-server.py 支持服务端加白边；旧 Node 代理会忽略这个参数
  if (!(localRembg && localRembg.WHITE_BORDER === false)) url += '&border=1'
  const started = Date.now()
  console.log('[cloud-matting] upload local rembg', url, 'src=', filePath)

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url,
      filePath,
      name: 'file',
      timeout: LOCAL_REMBG_TIMEOUT_MS,
      success: async (res) => {
        try {
          const roundTripMs = Date.now() - started
          if (res.statusCode >= 400) {
            reject(new Error(`rembg HTTP ${res.statusCode}: ${String(res.data || '').slice(0, 160)}`))
            return
          }
          let parsed = null
          try {
            parsed = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
          } catch (e) {
            reject(new Error(`rembg 代理返回非 JSON：${String(res.data || '').slice(0, 120)}`))
            return
          }
          if (!parsed || !parsed.ok) {
            reject(new Error((parsed && parsed.message) || 'rembg 代理失败'))
            return
          }

          // proxy 返回 upstreamMs=纯 rembg 推理；roundTrip−upstream≈上传+下载/落盘
          const rembgMs = Math.max(0, Number(parsed.upstreamMs) || 0)
          const transferMs = Math.max(0, roundTripMs - rembgMs)
          console.log(
            '[cloud-matting] 2a.上传往返:',
            transferMs,
            'ms | 2b.rembg推理:',
            rembgMs,
            'ms | roundTrip:',
            roundTripMs,
            'ms'
          )

          let outFile = ''
          let downloadMs = 0
          // 优先 base64 落盘（本地路径，后续加白边更稳）；否则再下载 url
          if (parsed.imageBase64) {
            const tWrite = Date.now()
            const outPath = `${wx.env.USER_DATA_PATH}/rembg_${Date.now()}.png`
            await new Promise((resOk, rej) => {
              wx.getFileSystemManager().writeFile({
                filePath: outPath,
                data: parsed.imageBase64,
                encoding: 'base64',
                success: () => resOk(),
                fail: rej
              })
            })
            downloadMs = Date.now() - tWrite
            outFile = outPath
            console.log('[cloud-matting] 2c.落盘(base64):', downloadMs, 'ms')
          } else if (parsed.url) {
            const tDl = Date.now()
            const localPath = await downloadHttpFile(parsed.url)
            const outPath = `${wx.env.USER_DATA_PATH}/rembg_${Date.now()}.png`
            await new Promise((resOk) => {
              wx.getFileSystemManager().copyFile({
                srcPath: localPath,
                destPath: outPath,
                success: () => resOk(),
                fail: () => resOk()
              })
            })
            outFile = await new Promise((resOk) => {
              wx.getFileSystemManager().access({
                path: outPath,
                success: () => resOk(outPath),
                fail: () => resOk(localPath)
              })
            })
            downloadMs = Date.now() - tDl
            console.log('[cloud-matting] 2c.下载结果:', downloadMs, 'ms', outFile)
          } else {
            reject(new Error('rembg 未返回 url/imageBase64'))
            return
          }

          resolve({
            path: outFile,
            bordered: !!parsed.bordered,
            uncertain: !!parsed.uncertain,
            refineModel: parsed.refineModel || '',
            uploadMs: transferMs,
            rembgMs,
            downloadMs,
            roundTripMs
          })
        } catch (e) {
          reject(e)
        }
      },
      fail: (err) => {
        console.warn('[cloud-matting] rembg upload fail', err)
        _healthOkAt = 0
        const msg =
          (err && (err.errMsg || err.message)) ||
          '无法连接本机 rembg（请启动 7000 + 7001 代理）'
        const e = new Error(msg)
        e.code = 'REMBG_UNREACHABLE'
        reject(e)
      }
    })
  })
}

async function callCloudMatting(fileID, provider) {
  const res = await wx.cloud.callFunction({
    name: 'api',
    data: {
      action: 'matting',
      fileID,
      provider: provider || ''
    }
  })
  return (res && res.result) || {}
}

async function finishWithWhiteBorder(cutPng, provider, canvas, timing, forceBorder) {
  const wantBorder =
    forceBorder === true ||
    (provider !== 'rembg-local' && forceBorder !== false) ||
    (provider === 'rembg-local' && !(localRembg && localRembg.WHITE_BORDER === false))

  if (!wantBorder) {
    return {
      ok: true,
      cutoutPath: cutPng,
      mattingFailed: false,
      provider: provider || 'cloud',
      hint: provider === 'rembg-local' ? '本机 rembg 抠图（未加白边）' : '',
      timing: timing || []
    }
  }

  let borderSrc = cutPng
  if (provider === 'rembg-local') {
    try {
      // 多区域时只留主区域（带猫脸的最大块），丢掉悬浮碎脚
      borderSrc = await withTimeout(
        repairRembgCutout(cutPng, {
          canvas,
          maxSide: 640
        }),
        3000,
        'TIMEOUT',
        '主区域清理超时'
      )
    } catch (e) {
      console.warn('[cloud-matting] repair rembg skip', e)
      borderSrc = cutPng
    }
  }

  console.log('[cloud-matting] add white border…', provider)
  let stroked = null
  try {
    stroked = await withTimeout(
      addWhiteBorderFromCutout(borderSrc, {
        canvas,
        maxSide: 480,
        fast: true
      }),
      8000,
      'TIMEOUT',
      '加白边超时'
    )
  } catch (e) {
    console.warn('[cloud-matting] white border timeout, use raw cutout', e)
    return {
      ok: true,
      cutoutPath: borderSrc || cutPng,
      mattingFailed: false,
      provider: provider || 'cloud',
      hint: '已抠图（白边超时已跳过）',
      timing: timing || []
    }
  }
  console.log(
    '[cloud-matting] white border done',
    !!(stroked && stroked.ok),
    stroked && stroked.skippedBorder ? 'raw-alpha' : ''
  )
  if (stroked && stroked.ok && stroked.cutoutPath) {
    return {
      ok: true,
      cutoutPath: stroked.cutoutPath,
      mattingFailed: false,
      provider: provider || 'cloud',
      hint: stroked.skippedBorder
        ? 'rembg 已抠图（透明通道异常，未加白边）'
        : '',
      timing: timing || []
    }
  }
  // 白边失败时仍返回 rembg 原透明图，避免被当成「抠失败用原图」
  return {
    ok: true,
    cutoutPath: cutPng,
    mattingFailed: false,
    provider: provider || 'cloud',
    hint: '已抠图，白边未完成（已用透明底）',
    timing: timing || []
  }
}

async function resolveCutoutPath(cloudRes, canvas) {
  let cutPng = ''
  if (cloudRes.fileID) {
    cutPng = await downloadCloudFile(cloudRes.fileID)
  } else if (cloudRes.imageBase64) {
    cutPng = await new Promise((resolve, reject) => {
      const filePath = `${wx.env.USER_DATA_PATH}/matting_${Date.now()}.png`
      wx.getFileSystemManager().writeFile({
        filePath,
        data: cloudRes.imageBase64,
        encoding: 'base64',
        success: () => resolve(filePath),
        fail: reject
      })
    })
  }
  if (!cutPng) return null
  if (cloudRes.bordered) {
    // 自建 rembg-server 已在服务端加好白边
    return { ok: true, cutoutPath: cutPng, mattingFailed: false, provider: cloudRes.provider || 'cloud', hint: '', timing: cloudRes.timing || [] }
  }
  return finishWithWhiteBorder(cutPng, cloudRes.provider, canvas, cloudRes.timing)
}

async function tryLiteMatting(filePath, options = {}) {
  const totalStart = Date.now()
  const timing = []
  let workPath = filePath
  let cropped = false

  // 有框就先裁：外扩要够大，否则猫贴边会导致洪水填充整图失败
  if (options.location) {
    const t0 = Date.now()
    const crop = await cropByPetLocation(filePath, options.canvas, options.location, {
      width: options.detectWidth,
      height: options.detectHeight,
      padRatio: 0.38
    })
    workPath = crop.path
    cropped = !!crop.cropped
    timing.push(`0.裁猫块: ${Date.now() - t0}ms${cropped ? '' : '(跳过)'}`)
  }

  const t1 = Date.now()
  const lite = await makeLiteSticker(workPath, {
    canvas: options.canvas,
    maxSide: cropped ? 360 : 300,
    cropped
  })
  timing.push(`1.本地粗抠: ${Date.now() - t1}ms`)
  timing.push(`总耗时: ${Date.now() - totalStart}ms`)
  console.log('[cloud-matting lite timing]\n' + timing.join('\n'))
  if (lite && !lite.ok) {
    console.warn('[cloud-matting] lite fail detail', lite.code, lite.message)
  }

  if (lite && lite.ok) {
    return {
      ...lite,
      provider: 'lite',
      cropped,
      timing,
      hint: lite.hint || `极速粗抠 ${Date.now() - totalStart}ms`
    }
  }
  return lite
}

async function tryLocalRembg(filePath, options = {}) {
  // forceRembgFull：识别流程强制走 rembg，不受当前 mode 限制
  if (!options.forceRembgFull && !isQualityMode() && !isRembgOnlyMode()) return null
  const totalStart = Date.now()
  const modelName =
    (mattingMode && mattingMode.QUALITY_MODEL) || (localRembg && localRembg.MODEL) || 'u2net'

  // 一律整图：不用腾讯 DetectPet 框（头框会切掉身体）
  const rembgOpts = { ...options, location: null, detectWidth: 0, detectHeight: 0 }

  const alive = await pingLocalRembg()
  if (!alive) {
    console.warn('[cloud-matting] rembg proxy not reachable', localRembg.BASE_URL)
    return {
      ok: false,
      code: 'REMBG_UNREACHABLE',
      message: '本机 rembg 未启动（需 7000 服务 + 7001 代理）',
      provider: 'rembg-local'
    }
  }

  // 640：略提高分辨率，减轻脚/身体被模型切碎
  const prepared = await prepareMattingInput(filePath, rembgOpts.canvas, rembgOpts, {
    maxSide: 640,
    quality: 0.9
  })
  const timing = prepared.timing.slice()
  timing.push(`0.health: ok`)
  timing.push(`0.裁猫块: 跳过(整图rembg)`)

  console.log(
    '[cloud-matting] local rembg →',
    localRembg.BASE_URL,
    modelName,
    '(full, no DetectPet crop)',
    'jpg=',
    prepared.jpgPath
  )
  const t2 = Date.now()
  const rembgRes = await withTimeout(
    // 只跑快模型：没把握时服务端返回 uncertain，由页面先展示、后台再精修（不让用户干等）
    uploadToLocalRembg(prepared.jpgPath, { noFallback: true }),
    LOCAL_REMBG_TIMEOUT_MS,
    'TIMEOUT',
    '本机 rembg 超时'
  )
  const cutPng = rembgRes && rembgRes.path
  const uploadMs = (rembgRes && rembgRes.uploadMs) || 0
  const rembgMs = (rembgRes && rembgRes.rembgMs) || 0
  const downloadMs = (rembgRes && rembgRes.downloadMs) || 0
  timing.push(`2a.上传: ${uploadMs}ms`)
  timing.push(`2b.rembg推理: ${rembgMs || Date.now() - t2 - uploadMs - downloadMs}ms`)
  if (downloadMs > 0) timing.push(`2c.落盘/下载: ${downloadMs}ms`)
  console.log('[cloud-matting] rembg raw path', cutPng)

  // 防止误把原图路径当结果
  if (!cutPng || cutPng === filePath || cutPng === prepared.jpgPath) {
    return {
      ok: false,
      code: 'MATTING_FAILED',
      message: 'rembg 未返回新文件',
      provider: 'rembg-local',
      timing
    }
  }

  const t3 = Date.now()
  let result = null
  if (rembgRes && rembgRes.bordered) {
    // scripts/rembg-server.py 已在服务端做完主区域清理 + 白边，端上不再跑 canvas
    result = { ok: true, cutoutPath: cutPng, mattingFailed: false, provider: 'rembg-local', hint: '' }
    timing.push('3.加白边: 服务端已完成')
  } else try {
    result = await finishWithWhiteBorder(cutPng, 'rembg-local', rembgOpts.canvas, timing)
  } catch (e) {
    console.warn('[cloud-matting] white border throw, keep raw rembg', e)
    result = {
      ok: true,
      cutoutPath: cutPng,
      mattingFailed: false,
      provider: 'rembg-local',
      hint: '已抠图，白边异常已跳过'
    }
  }
  if (!(rembgRes && rembgRes.bordered)) timing.push(`3.加白边: ${Date.now() - t3}ms`)
  timing.push(`总耗时: ${Date.now() - totalStart}ms`)
  console.log('[cloud-matting timing]\n' + timing.join('\n'))

  return {
    ...result,
    ok: true,
    cutoutPath: (result && result.cutoutPath) || cutPng,
    provider: 'rembg-local',
    timing,
    cropped: prepared.cropped,
    // 快模型没把握（常见：只抠出猫头）→ 交给页面后台精修，不让用户干等
    needsRefine: !!(rembgRes && rembgRes.uncertain && rembgRes.refineModel),
    refine:
      rembgRes && rembgRes.uncertain && rembgRes.refineModel
        ? () => refineLocalRembg(prepared.jpgPath, rembgRes.refineModel)
        : null,
    hint:
      (result && result.hint) ||
      (options.forceRembgFull
        ? `识别后整图 rembg，总 ${Date.now() - totalStart}ms`
        : `本机 rembg 整图，总 ${Date.now() - totalStart}ms`)
  }
}

/**
 * 后台精修：用精细模型（BiRefNet）重抠同一张已压缩的图，CPU 上约 10s。
 * 结果已由服务端加好白边；服务端没加时这里补白边。
 */
async function refineLocalRembg(jpgPath, refineModel) {
  const started = Date.now()
  try {
    const res = await withTimeout(
      uploadToLocalRembg(jpgPath, { model: refineModel }),
      LOCAL_REMBG_TIMEOUT_MS,
      'TIMEOUT',
      '精细抠图超时'
    )
    if (!res || !res.path) return { ok: false, message: '精细抠图未返回结果' }
    let cutoutPath = res.path
    if (!res.bordered) {
      const done = await finishWithWhiteBorder(res.path, 'rembg-local', null, [])
      cutoutPath = (done && done.cutoutPath) || res.path
    }
    const ms = Date.now() - started
    console.log('[cloud-matting] refine done', refineModel, ms, 'ms')
    return { ok: true, cutoutPath, ms, model: refineModel }
  } catch (e) {
    console.warn('[cloud-matting] refine fail', e)
    return { ok: false, message: (e && e.message) || '精细抠图失败' }
  }
}

async function tryCloudVendorMatting(filePath, options = {}, provider = 'baidu') {
  const totalStart = Date.now()
  const app = typeof getApp === 'function' ? getApp() : null
  const cloudReady = !!(app && app.globalData && app.globalData.cloudReady)
  if (!cloudReady) {
    return {
      ok: false,
      code: 'NO_CLOUD',
      message: '云开发未就绪',
      provider,
      timing: [`总耗时: ${Date.now() - totalStart}ms`]
    }
  }

  const label = provider === 'tencent' ? '腾讯' : '百度'
  const prepared = await prepareMattingInput(filePath, options.canvas, options, {
    maxSide: options.location ? CROP_MAX_SIDE : 960,
    quality: 0.9
  })
  const timing = (prepared.timing || []).slice()

  const tUp = Date.now()
  const cloudPath = `matting-src/${Date.now()}_${Math.random().toString(16).slice(2)}.jpg`
  const srcFileID = await uploadCloudFile(prepared.jpgPath, cloudPath)
  timing.push(`2.上传云存储: ${Date.now() - tUp}ms`)

  const tCall = Date.now()
  const cloudRes = await withTimeout(
    callCloudMatting(srcFileID, provider),
    CLOUD_TIMEOUT_MS,
    'TIMEOUT',
    `${label}抠图超时`
  )
  timing.push(`3.${label}抠图: ${Date.now() - tCall}ms`)
  if (cloudRes && cloudRes.timing && cloudRes.timing.length) {
    timing.push(...cloudRes.timing.map((t) => `  ${t}`))
  }

  if (cloudRes && cloudRes.ok && (cloudRes.fileID || cloudRes.imageBase64)) {
    const tBorder = Date.now()
    const done = await resolveCutoutPath(cloudRes, options.canvas)
    timing.push(`4.下载+白边: ${Date.now() - tBorder}ms`)
    timing.push(`总耗时: ${Date.now() - totalStart}ms`)
    console.log('[cloud-matting vendor timing]\n' + timing.join('\n'))
    if (done) {
      return {
        ...done,
        provider: cloudRes.provider || provider,
        cropped: prepared.cropped,
        timing,
        hint: done.hint || `${label}抠图`
      }
    }
  }

  timing.push(`总耗时: ${Date.now() - totalStart}ms`)
  console.warn('[cloud-matting] cloud vendor fail', provider, cloudRes)
  return {
    ok: false,
    code: (cloudRes && cloudRes.code) || 'MATTING_FAILED',
    message: (cloudRes && cloudRes.message) || `${label}抠图失败`,
    provider: (cloudRes && cloudRes.provider) || provider,
    timing
  }
}

async function makeStickerWithCloudMatting(filePath, options = {}) {
  if (!filePath) {
    return { ok: false, code: 'MATTING_FAILED', message: '图片读取失败' }
  }

  // 识别流程指定：忽略 mode / 检测框，整图 rembg
  if (options.forceRembgFull) {
    console.log('[cloud-matting] mode = force-rembg-full')
    try {
      const rembg = await tryLocalRembg(filePath, { ...options, forceRembgFull: true })
      if (rembg && rembg.ok) return rembg
      return (
        rembg || {
          ok: false,
          code: 'MATTING_FAILED',
          message: '本机 rembg 失败（请确认 7001 代理在跑）',
          provider: 'rembg-local'
        }
      )
    } catch (e) {
      console.warn('[cloud-matting] force rembg fail', e)
      return {
        ok: false,
        code: (e && e.code) || 'MATTING_FAILED',
        message: (e && e.message) || '本机 rembg 失败',
        provider: 'rembg-local'
      }
    }
  }

  const mode = getActiveMode()
  console.log('[cloud-matting] mode =', mode)

  // 1) 极速：纯本地粗抠
  if (isLiteMode()) {
    try {
      const lite = await tryLiteMatting(filePath, options)
      if (lite && lite.ok) return lite
    } catch (e) {
      console.warn('[cloud-matting] lite fail', e)
    }
    const local = await makeCatSticker(filePath, options)
    if (local && local.ok) return { ...local, provider: 'local' }
    return local
  }

  // 2) 单独百度 / 单独腾讯：不互相回退，方便对比
  if (isBaiduMode() || isTencentMode()) {
    const provider = isTencentMode() ? 'tencent' : 'baidu'
    try {
      return await tryCloudVendorMatting(filePath, options, provider)
    } catch (e) {
      console.warn('[cloud-matting] vendor error', provider, e)
      return {
        ok: false,
        code: (e && e.code) || 'MATTING_FAILED',
        message: (e && e.message) || '云端抠图失败',
        provider
      }
    }
  }

  // 3) 仅 rembg：不框猫、不回退百度/腾讯
  if (isRembgOnlyMode()) {
    try {
      const rembg = await tryLocalRembg(filePath, options)
      if (rembg && rembg.ok) return rembg
      return (
        rembg || {
          ok: false,
          code: 'MATTING_FAILED',
          message: '本机 rembg 失败（请确认 7001 代理在跑）',
          provider: 'rembg-local'
        }
      )
    } catch (e) {
      console.warn('[cloud-matting] rembg-only fail', e)
      return {
        ok: false,
        code: (e && e.code) || 'MATTING_FAILED',
        message: (e && e.message) || '本机 rembg 失败',
        provider: 'rembg-local'
      }
    }
  }

  // 4) 精抠：整图 rembg（不再用腾讯框裁切；失败可落到百度）
  if (isQualityMode()) {
    try {
      const rembg = await tryLocalRembg(filePath, { ...options, location: null })
      if (rembg && rembg.ok) return rembg
    } catch (e) {
      console.warn('[cloud-matting] local rembg fail, fallback', e)
    }
    try {
      const baidu = await tryCloudVendorMatting(filePath, options, 'baidu')
      if (baidu && baidu.ok) return baidu
    } catch (e) {
      console.warn('[cloud-matting] baidu fallback fail', e)
    }
  }

  // 4) 洪水 / 粗抠兜底
  try {
    const lite = await tryLiteMatting(filePath, options)
    if (lite && lite.ok) return lite
  } catch (e) {
    /* ignore */
  }
  const local = await makeCatSticker(filePath, options)
  if (local && local.ok) {
    return { ...local, provider: 'local' }
  }
  return local
}

module.exports = {
  makeStickerWithCloudMatting,
  getActiveMode
}
