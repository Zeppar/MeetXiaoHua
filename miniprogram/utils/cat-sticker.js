/**
 * 猫咪贴纸：抠图 + 外描边白边（贴纸样式）
 * 拍照 / 上传图片后共用。
 *
 * 返回：
 * - { ok: true, cutoutPath }
 * - { ok: false, code: 'NO_CAT', message }
 * - { ok: false, code: 'MATTING_FAILED', message, cutoutPath? }
 */

const MAX_SIDE = 320
const STROKE_RATIO = 0.012
const MIN_STROKE = 3
const MAX_STROKE = 8
const COLOR_TOLERANCE = 42
const MIN_SUBJECT_RATIO = 0.02
const MAX_SUBJECT_RATIO = 0.96
const STICKER_HARD_TIMEOUT_MS = 12000

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: resolve,
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

function canvasToTempFile(canvas) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('canvas export timeout'))
    }, 5000)
    wx.canvasToTempFilePath({
      canvas,
      fileType: 'png',
      quality: 1,
      success: (res) => {
        clearTimeout(timer)
        resolve(res.tempFilePath)
      },
      fail: (err) => {
        clearTimeout(timer)
        reject(err)
      }
    })
  })
}

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0))
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

function colorDist(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2
  const dg = g1 - g2
  const db = b1 - b2
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

/** 从四边洪水填充标记背景 */
function markBackground(data, w, h, tolerance) {
  const n = w * h
  const bg = new Uint8Array(n)
  const visited = new Uint8Array(n)
  const queue = new Int32Array(n)
  let qh = 0
  let qt = 0

  const push = (x, y) => {
    const i = y * w + x
    if (visited[i]) return
    visited[i] = 1
    queue[qt++] = i
  }

  for (let x = 0; x < w; x++) {
    push(x, 0)
    push(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    push(0, y)
    push(w - 1, y)
  }

  while (qh < qt) {
    const i = queue[qh++]
    const o = i * 4
    const r0 = data[o]
    const g0 = data[o + 1]
    const b0 = data[o + 2]
    bg[i] = 1

    const x = i % w
    const y = (i / w) | 0
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1]
    ]
    for (let k = 0; k < 4; k++) {
      const nx = neighbors[k][0]
      const ny = neighbors[k][1]
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const ni = ny * w + nx
      if (visited[ni]) continue
      const no = ni * 4
      if (colorDist(r0, g0, b0, data[no], data[no + 1], data[no + 2]) <= tolerance) {
        visited[ni] = 1
        queue[qt++] = ni
      }
    }
  }
  return bg
}

function keepLargestComponent(mask, w, h) {
  const n = w * h
  const visited = new Uint8Array(n)
  const queue = new Int32Array(n)
  let bestStart = -1
  let bestSize = 0

  for (let i = 0; i < n; i++) {
    if (!mask[i] || visited[i]) continue
    let qh = 0
    let qt = 0
    queue[qt++] = i
    visited[i] = 1
    let size = 0
    while (qh < qt) {
      const cur = queue[qh++]
      size++
      const x = cur % w
      const y = (cur / w) | 0
      const neighbors = [
        cur - 1,
        cur + 1,
        cur - w,
        cur + w
      ]
      const valid = [
        x > 0,
        x < w - 1,
        y > 0,
        y < h - 1
      ]
      for (let k = 0; k < 4; k++) {
        if (!valid[k]) continue
        const ni = neighbors[k]
        if (!visited[ni] && mask[ni]) {
          visited[ni] = 1
          queue[qt++] = ni
        }
      }
    }
    if (size > bestSize) {
      bestSize = size
      bestStart = i
    }
  }

  const out = new Uint8Array(n)
  if (bestStart < 0) return { mask: out, size: 0, bbox: null }

  // 重跑最大连通域写入 out
  visited.fill(0)
  let qh = 0
  let qt = 0
  queue[qt++] = bestStart
  visited[bestStart] = 1
  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  let size = 0
  while (qh < qt) {
    const cur = queue[qh++]
    out[cur] = 1
    size++
    const x = cur % w
    const y = (cur / w) | 0
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    const neighbors = [cur - 1, cur + 1, cur - w, cur + w]
    const valid = [x > 0, x < w - 1, y > 0, y < h - 1]
    for (let k = 0; k < 4; k++) {
      if (!valid[k]) continue
      const ni = neighbors[k]
      if (!visited[ni] && mask[ni]) {
        visited[ni] = 1
        queue[qt++] = ni
      }
    }
  }
  return { mask: out, size, bbox: { minX, minY, maxX, maxY } }
}

/** 近似圆形外扩：多次 3x3 膨胀，比逐像素圆盘更快 */
function circularDilate(mask, w, h, radius) {
  let cur = mask
  const steps = Math.max(0, radius | 0)
  for (let s = 0; s < steps; s++) {
    const next = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = 0
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const ny = y + dy
          if (ny < 0 || ny >= h) continue
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            if (nx < 0 || nx >= w) continue
            if (cur[ny * w + nx]) {
              hit = 1
              break
            }
          }
        }
        next[y * w + x] = hit
      }
    }
    cur = next
  }
  return cur
}

function buildStickerFromMask(data, w, h, mask, bbox, softAlpha) {
  const strokeR = Math.min(
    MAX_STROKE,
    Math.max(MIN_STROKE, Math.round(Math.min(w, h) * STROKE_RATIO))
  )
  const pad = strokeR + 4
  const cw = bbox.maxX - bbox.minX + 1
  const ch = bbox.maxY - bbox.minY + 1
  const outW = cw + pad * 2
  const outH = ch + pad * 2

  const cropMask = new Uint8Array(outW * outH)
  for (let y = bbox.minY; y <= bbox.maxY; y++) {
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      if (!mask[y * w + x]) continue
      const ox = x - bbox.minX + pad
      const oy = y - bbox.minY + pad
      cropMask[oy * outW + ox] = 1
    }
  }

  const dilated = circularDilate(cropMask, outW, outH, strokeR)
  const out = new Uint8ClampedArray(outW * outH * 4)

  // 白边
  for (let i = 0; i < outW * outH; i++) {
    if (!dilated[i]) continue
    const o = i * 4
    out[o] = 255
    out[o + 1] = 255
    out[o + 2] = 255
    out[o + 3] = 255
  }

  // 主体叠在白边上（AI 抠图保留半透明边缘）
  for (let y = bbox.minY; y <= bbox.maxY; y++) {
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      const si = y * w + x
      if (!mask[si]) continue
      const ox = x - bbox.minX + pad
      const oy = y - bbox.minY + pad
      const o = (oy * outW + ox) * 4
      const src = si * 4
      out[o] = data[src]
      out[o + 1] = data[src + 1]
      out[o + 2] = data[src + 2]
      out[o + 3] = softAlpha ? data[src + 3] : 255
    }
  }

  return { code: 'OK', width: outW, height: outH, pixels: out }
}

function processPixels(imageData) {
  const { data, width: w, height: h } = imageData
  const bg = markBackground(data, w, h, COLOR_TOLERANCE)
  const subject = new Uint8Array(w * h)
  let subjectCount = 0
  for (let i = 0; i < w * h; i++) {
    if (!bg[i]) {
      subject[i] = 1
      subjectCount++
    }
  }

  const ratio = subjectCount / (w * h)
  // 颜色洪水填充抠图失败 ≠ 没有猫：复杂背景/猫贴边都会误判
  if (subjectCount === 0 || ratio < MIN_SUBJECT_RATIO || ratio > MAX_SUBJECT_RATIO) {
    return { code: 'MATTING_FAILED' }
  }

  const largest = keepLargestComponent(subject, w, h)
  if (!largest.size || largest.size / (w * h) < MIN_SUBJECT_RATIO) {
    return { code: 'MATTING_FAILED' }
  }

  return buildStickerFromMask(data, w, h, largest.mask, largest.bbox, false)
}

/** AI 抠图（透明 PNG）→ 外描边白边贴纸 */
function processAlphaPixels(imageData) {
  const { data, width: w, height: h } = imageData
  const subject = new Uint8Array(w * h)
  let subjectCount = 0
  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (data[i * 4 + 3] < 24) continue
      subject[i] = 1
      subjectCount++
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  if (!subjectCount || subjectCount / (w * h) < 0.005) {
    return { code: 'MATTING_FAILED' }
  }

  return buildStickerFromMask(
    data,
    w,
    h,
    subject,
    { minX, minY, maxX, maxY },
    true
  )
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

async function renderStickerFromPath(filePath, options = {}, processor) {
  let info
  try {
    info = await getImageInfo(filePath)
  } catch (e) {
    return { ok: false, code: 'MATTING_FAILED', message: '图片读取失败', cutoutPath: filePath }
  }

  const srcW = info.width || 0
  const srcH = info.height || 0
  if (!srcW || !srcH) {
    return { ok: false, code: 'MATTING_FAILED', message: '图片读取失败', cutoutPath: filePath }
  }

  const maxSide = options.maxSide || MAX_SIDE
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH))
  const width = Math.max(1, Math.round(srcW * scale))
  const height = Math.max(1, Math.round(srcH * scale))

  let canvas = createWorkCanvas(width, height)
  if (!canvas && options.canvas) {
    canvas = options.canvas
    canvas.width = width
    canvas.height = height
  }
  if (!canvas) {
    return { ok: false, code: 'MATTING_FAILED', message: '当前环境不支持抠图', cutoutPath: filePath }
  }

  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return { ok: false, code: 'MATTING_FAILED', message: '当前环境不支持抠图', cutoutPath: filePath }
  }

  const img = await loadCanvasImage(canvas, filePath)
  await yieldToUi()
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)
  const imageData = ctx.getImageData(0, 0, width, height)

  await yieldToUi()
  const processed = processor(imageData)
  await yieldToUi()

  if (processed.code === 'MATTING_FAILED' || processed.code === 'NO_CAT') {
    return { ok: false, code: 'MATTING_FAILED', message: '背景没抠干净', cutoutPath: filePath }
  }

  let outCanvas = createWorkCanvas(processed.width, processed.height)
  if (!outCanvas) {
    canvas.width = processed.width
    canvas.height = processed.height
    outCanvas = canvas
  } else {
    outCanvas.width = processed.width
    outCanvas.height = processed.height
  }
  const outCtx = outCanvas.getContext('2d')
  const outData = outCtx.createImageData(processed.width, processed.height)
  outData.data.set(processed.pixels)
  outCtx.putImageData(outData, 0, 0)

  const cutoutPath = await canvasToTempFile(outCanvas)
  return { ok: true, cutoutPath, mattingFailed: false }
}

async function makeCatStickerInner(filePath, options = {}) {
  return renderStickerFromPath(filePath, options, processPixels)
}

/** 采样四边颜色，用于把「像背景」的像素剔掉（比纯椭圆靠谱） */
function sampleBorderColors(data, w, h, step) {
  const samples = []
  const s = Math.max(1, step || 2)
  for (let x = 0; x < w; x += s) {
    const t = x * 4
    const b = ((h - 1) * w + x) * 4
    samples.push([data[t], data[t + 1], data[t + 2]])
    samples.push([data[b], data[b + 1], data[b + 2]])
  }
  for (let y = 0; y < h; y += s) {
    const l = y * w * 4
    const r = (y * w + w - 1) * 4
    samples.push([data[l], data[l + 1], data[l + 2]])
    samples.push([data[r], data[r + 1], data[r + 2]])
  }
  return samples
}

function nearAnyBorderColor(r, g, b, samples, tol) {
  for (let i = 0; i < samples.length; i++) {
    const c = samples[i]
    if (colorDist(r, g, b, c[0], c[1], c[2]) <= tol) return true
  }
  return false
}

function maskFromBg(bg, w, h) {
  const subject = new Uint8Array(w * h)
  let subjectCount = 0
  for (let i = 0; i < w * h; i++) {
    if (!bg[i]) {
      subject[i] = 1
      subjectCount++
    }
  }
  const ratio = subjectCount / (w * h)
  if (subjectCount === 0 || ratio < MIN_SUBJECT_RATIO || ratio > MAX_SUBJECT_RATIO) {
    return null
  }
  const largest = keepLargestComponent(subject, w, h)
  if (!largest.size || largest.size / (w * h) < MIN_SUBJECT_RATIO) return null
  return largest
}

/**
 * 已裁猫块：猫常贴边，洪水会误判失败。
 * 策略：保留中心主体，只在外圈按边框色做软透明。
 */
function processLiteCroppedPixels(imageData) {
  const { data, width: w, height: h } = imageData
  const samples = sampleBorderColors(data, w, h, 2)
  const band = Math.max(6, Math.round(Math.min(w, h) * 0.14))
  const chromaTol = 34
  const mask = new Uint8Array(w * h)
  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  let kept = 0

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const o = i * 4
      const edgeDist = Math.min(x, y, w - 1 - x, h - 1 - y)

      if (edgeDist >= band) {
        mask[i] = 1
        kept++
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        continue
      }

      // 外圈：像背景的去掉，其余半透明过渡
      if (nearAnyBorderColor(data[o], data[o + 1], data[o + 2], samples, chromaTol)) {
        continue
      }
      const a = Math.max(32, Math.round(255 * (edgeDist / band)))
      data[o + 3] = a
      mask[i] = 1
      kept++
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  if (!kept) return { code: 'MATTING_FAILED' }
  return buildStickerFromMask(data, w, h, mask, { minX, minY, maxX, maxY }, true)
}

/** 保底剪影：保证极速模式总能出贴纸（不依赖洪水成功） */
function processLiteSoftOval(imageData) {
  const { data, width: w, height: h } = imageData
  const cx = (w - 1) * 0.5
  const cy = (h - 1) * 0.5
  const rx = Math.max(8, w * 0.44)
  const ry = Math.max(8, h * 0.47)
  const feather = Math.max(5, Math.min(w, h) * 0.1)
  const mask = new Uint8Array(w * h)
  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  let kept = 0

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / rx
      const ny = (y - cy) / ry
      const d = Math.sqrt(nx * nx + ny * ny)
      if (d > 1 + feather / Math.min(rx, ry)) continue
      const i = y * w + x
      const src = i * 4
      let a = 255
      if (d > 1) {
        const t = (d - 1) / (feather / Math.min(rx, ry))
        a = Math.max(0, Math.round(255 * (1 - t)))
      }
      if (a < 20) continue
      data[src + 3] = a
      mask[i] = 1
      kept++
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  if (!kept) return { code: 'MATTING_FAILED' }
  return buildStickerFromMask(data, w, h, mask, { minX, minY, maxX, maxY }, true)
}

/**
 * 极速粗抠（无 ML）
 * - 未裁切：多阈值洪水 → 边框色差 → 软椭圆保底
 * - 已裁切：外圈去背景（猫贴边时洪水会失败）→ 软椭圆保底
 */
function processLitePixels(imageData, options = {}) {
  const { data, width: w, height: h } = imageData

  if (options.cropped) {
    const cropped = processLiteCroppedPixels(imageData)
    if (cropped && cropped.code === 'OK') return cropped
    return processLiteSoftOval(imageData)
  }

  const tolerances = [34, 42, 52]
  for (let t = 0; t < tolerances.length; t++) {
    const bg = markBackground(data, w, h, tolerances[t])
    const largest = maskFromBg(bg, w, h)
    if (largest) {
      return buildStickerFromMask(data, w, h, largest.mask, largest.bbox, false)
    }
  }

  const samples = sampleBorderColors(data, w, h, 3)
  const subject = new Uint8Array(w * h)
  let count = 0
  const chromaTol = 38
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    if (nearAnyBorderColor(data[o], data[o + 1], data[o + 2], samples, chromaTol)) continue
    subject[i] = 1
    count++
  }
  if (count / (w * h) >= MIN_SUBJECT_RATIO && count / (w * h) <= 0.92) {
    const largest = keepLargestComponent(subject, w, h)
    if (largest && largest.size / (w * h) >= MIN_SUBJECT_RATIO) {
      return buildStickerFromMask(data, w, h, largest.mask, largest.bbox, false)
    }
  }

  return processLiteSoftOval(imageData)
}

/**
 * 端侧极速贴纸（粗分割 / 简单抠边）
 */
async function makeLiteSticker(filePath, options = {}) {
  if (!filePath) {
    return { ok: false, code: 'MATTING_FAILED', message: '图片读取失败' }
  }
  try {
    const started = Date.now()
    const result = await withTimeout(
      renderStickerFromPath(
        filePath,
        { ...options, maxSide: options.maxSide || 300 },
        (imageData) => processLitePixels(imageData, options)
      ),
      options.timeoutMs || 8000,
      'TIMEOUT',
      '极速抠图超时'
    )
    if (result && result.ok) {
      return {
        ...result,
        provider: 'lite',
        hint: `极速本地粗抠 ${Date.now() - started}ms`
      }
    }
    return result
  } catch (e) {
    console.warn('[cat-sticker] lite', e)
    return {
      ok: false,
      code: (e && e.code) === 'TIMEOUT' ? 'TIMEOUT' : 'MATTING_FAILED',
      message: (e && e.message) || '极速抠图失败',
      cutoutPath: filePath,
      provider: 'lite'
    }
  }
}

/**
 * 快速白边：用合成模式做白剪影，避免 getImageData 在微信里弄丢 alpha
 * （旧逻辑：读像素 alpha → 整图变不透明 → 白边变成「整张矩形」，看起来像切不出来）
 */
async function addWhiteBorderFast(filePath, options = {}) {
  let info
  try {
    info = await getImageInfo(filePath)
  } catch (e) {
    return { ok: false, code: 'MATTING_FAILED', message: '图片读取失败', cutoutPath: filePath }
  }

  const srcW = info.width || 0
  const srcH = info.height || 0
  if (!srcW || !srcH) {
    return { ok: false, code: 'MATTING_FAILED', message: '图片读取失败', cutoutPath: filePath }
  }

  const maxSide = options.maxSide || 420
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH))
  const width = Math.max(1, Math.round(srcW * scale))
  const height = Math.max(1, Math.round(srcH * scale))
  const strokeR = Math.min(
    MAX_STROKE,
    Math.max(MIN_STROKE, Math.round(Math.min(width, height) * STROKE_RATIO))
  )
  const pad = strokeR + 2
  const outW = width + pad * 2
  const outH = height + pad * 2

  let canvas = createWorkCanvas(Math.max(outW, width), Math.max(outH, height))
  if (!canvas && options.canvas) canvas = options.canvas
  if (!canvas) {
    return { ok: false, code: 'MATTING_FAILED', message: '当前环境不支持加白边', cutoutPath: filePath }
  }

  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return { ok: false, code: 'MATTING_FAILED', message: '当前环境不支持加白边', cutoutPath: filePath }
  }

  try {
    const img = await loadCanvasImage(canvas, filePath)
    await yieldToUi()
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)

    // 抽样检查透明通道：若几乎全不透明，说明 alpha 丢失或未真正抠图
    let transparent = 0
    let opaque = 0
    try {
      const probe = ctx.getImageData(0, 0, width, height)
      const px = probe.data
      const step = Math.max(4, Math.floor((width * height) / 8000) * 4)
      for (let i = 3; i < px.length; i += step) {
        if (px[i] < 24) transparent++
        else opaque++
      }
    } catch (e) {
      console.warn('[cat-sticker] alpha probe fail', e)
    }
    const totalProbe = transparent + opaque
    const transparentRatio = totalProbe ? transparent / totalProbe : 0
    console.log('[cat-sticker] alpha probe', {
      transparentRatio: Number(transparentRatio.toFixed(3)),
      w: width,
      h: height
    })
    if (totalProbe && transparentRatio < 0.02) {
      // 没有有效透明边 → 强行加白边只会变成「整图矩形框」
      return {
        ok: false,
        code: 'NO_ALPHA',
        message: '抠图结果无透明通道，跳过白边',
        cutoutPath: filePath
      }
    }

    // 用 source-in 生成白剪影，比逐像素改 RGB 更稳地保留形状
    ctx.globalCompositeOperation = 'source-in'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.globalCompositeOperation = 'source-over'
    await yieldToUi()

    const silhouettePath = await canvasToTempFile(canvas)
    const silhouette = await loadCanvasImage(canvas, silhouettePath)

    canvas.width = outW
    canvas.height = outH
    ctx.clearRect(0, 0, outW, outH)

    for (let dy = -strokeR; dy <= strokeR; dy++) {
      for (let dx = -strokeR; dx <= strokeR; dx++) {
        if (dx * dx + dy * dy > strokeR * strokeR) continue
        ctx.drawImage(silhouette, pad + dx, pad + dy, width, height)
      }
    }
    await yieldToUi()

    const subject = await loadCanvasImage(canvas, filePath)
    ctx.drawImage(subject, pad, pad, width, height)

    const cutoutPath = await canvasToTempFile(canvas)
    return { ok: true, cutoutPath, mattingFailed: false }
  } catch (e) {
    console.warn('[cat-sticker] addWhiteBorderFast fail', e)
    return {
      ok: false,
      code: 'MATTING_FAILED',
      message: (e && e.message) || '加白边失败',
      cutoutPath: filePath
    }
  }
}

/** 连通域标记（4 连通），返回 { labels, count, areas, boxes } */
function labelConnectedComponents(mask, w, h) {
  const labels = new Int32Array(w * h)
  const areas = [0]
  const boxes = [null]
  let count = 0
  const qx = new Int32Array(w * h)
  const qy = new Int32Array(w * h)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!mask[i] || labels[i]) continue
      count += 1
      let area = 0
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      let qh = 0
      let qt = 0
      qx[qt] = x
      qy[qt] = y
      qt++
      labels[i] = count
      while (qh < qt) {
        const cx = qx[qh]
        const cy = qy[qh]
        qh++
        area++
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        const nbs = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1]
        ]
        for (let k = 0; k < 4; k++) {
          const nx = nbs[k][0]
          const ny = nbs[k][1]
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const ni = ny * w + nx
          if (!mask[ni] || labels[ni]) continue
          labels[ni] = count
          qx[qt] = nx
          qy[qt] = ny
          qt++
        }
      }
      areas.push(area)
      boxes.push({ minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 })
    }
  }
  return { labels, count, areas, boxes }
}

/**
 * 只留带猫脸的主连通域，清掉碎点/悬浮块，并裁到主区域包围盒，
 * 避免加白边时把残渣描成小白点。
 */
async function repairRembgCutout(filePath, options = {}) {
  if (!filePath) return filePath

  let info
  try {
    info = await getImageInfo(filePath)
  } catch (e) {
    return filePath
  }
  const srcW = info.width || 0
  const srcH = info.height || 0
  if (!srcW || !srcH) return filePath

  const maxSide = options.maxSide || 640
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH))
  const width = Math.max(1, Math.round(srcW * scale))
  const height = Math.max(1, Math.round(srcH * scale))

  let canvas = createWorkCanvas(width, height)
  if (!canvas && options.canvas) canvas = options.canvas
  if (!canvas) return filePath

  try {
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return filePath
    const img = await loadCanvasImage(canvas, filePath)
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)
    const imageData = ctx.getImageData(0, 0, width, height)
    const data = imageData.data

    // 阈值放低，半透明残渣也算进连通域，才能被清掉
    const rawMask = new Uint8Array(width * height)
    for (let i = 0; i < width * height; i++) rawMask[i] = data[i * 4 + 3] > 8 ? 1 : 0

    const { labels, count, areas, boxes } = labelConnectedComponents(rawMask, width, height)
    if (count < 1) return filePath

    // 主区域 = 面积最大；若最大块贴底且很矮，改选更靠上的次大块（脸）
    let mainId = 1
    for (let id = 2; id <= count; id++) {
      if (areas[id] > areas[mainId]) mainId = id
    }
    let mainBox = boxes[mainId]
    const mainH = mainBox.maxY - mainBox.minY + 1
    if (mainBox.minY > height * 0.55 && mainH < height * 0.35) {
      let altId = 0
      for (let id = 1; id <= count; id++) {
        if (id === mainId) continue
        const b = boxes[id]
        if (!b || b.cy >= mainBox.cy) continue
        if (!altId || areas[id] > areas[altId]) altId = id
      }
      if (altId && areas[altId] >= areas[mainId] * 0.35) {
        mainId = altId
        mainBox = boxes[mainId]
      }
    }

    // 非主区域全部清空（含 RGB，避免白边吃到脏像素）
    let dropped = 0
    for (let i = 0; i < width * height; i++) {
      const id = labels[i]
      const o = i * 4
      if (id === mainId) continue
      if (data[o + 3] === 0 && !id) continue
      data[o] = 0
      data[o + 1] = 0
      data[o + 2] = 0
      data[o + 3] = 0
      if (id) dropped++
    }

    // 主区域外再扫一遍：任何残留 alpha 一律清零
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (
          x >= mainBox.minX &&
          x <= mainBox.maxX &&
          y >= mainBox.minY &&
          y <= mainBox.maxY
        ) {
          continue
        }
        const o = (y * width + x) * 4
        if (data[o + 3] === 0) continue
        data[o] = 0
        data[o + 1] = 0
        data[o + 2] = 0
        data[o + 3] = 0
        dropped++
      }
    }

    ctx.putImageData(imageData, 0, 0)

    // 裁到主区域包围盒，残渣即使漏网也进不了最终贴纸
    const pad = Math.max(2, Math.round(Math.min(width, height) * 0.01))
    const left = Math.max(0, mainBox.minX - pad)
    const top = Math.max(0, mainBox.minY - pad)
    const right = Math.min(width, mainBox.maxX + pad + 1)
    const bottom = Math.min(height, mainBox.maxY + pad + 1)
    const cropW = Math.max(1, right - left)
    const cropH = Math.max(1, bottom - top)

    const cropped = ctx.getImageData(left, top, cropW, cropH)
    canvas.width = cropW
    canvas.height = cropH
    ctx.putImageData(cropped, 0, 0)

    const outPath = await canvasToTempFile(canvas)
    console.log('[cat-sticker] keep main region only', {
      components: count,
      mainId,
      mainArea: areas[mainId],
      dropped,
      crop: `${cropW}x${cropH}`,
      width,
      height
    })
    return outPath || filePath
  } catch (e) {
    console.warn('[cat-sticker] repairRembgCutout fail', e)
    return filePath
  }
}

async function expandFeetOnCutout(filePath, options = {}) {
  return repairRembgCutout(filePath, options)
}

/**
 * 对已抠好的透明 PNG 加白边贴纸
 */
async function addWhiteBorderFromCutout(filePath, options = {}) {
  if (!filePath) {
    return { ok: false, code: 'MATTING_FAILED', message: '图片读取失败' }
  }
  try {
    // 优先走快速路径（AI 抠图结果）
    if (options.fast !== false) {
      const fast = await withTimeout(
        addWhiteBorderFast(filePath, options),
        STICKER_HARD_TIMEOUT_MS,
        'TIMEOUT',
        '加白边超时'
      )
      // 无 alpha 时直接退回原透明图，避免「切不出来」的假白边矩形
      if (fast && fast.code === 'NO_ALPHA') {
        return { ok: true, cutoutPath: filePath, mattingFailed: false, skippedBorder: true }
      }
      return fast
    }
    return await withTimeout(
      renderStickerFromPath(
        filePath,
        { ...options, maxSide: options.maxSide || 420 },
        processAlphaPixels
      ),
      STICKER_HARD_TIMEOUT_MS,
      'TIMEOUT',
      '加白边超时'
    )
  } catch (e) {
    console.warn('[cat-sticker] white border', e)
    return {
      ok: false,
      code: (e && e.code) === 'TIMEOUT' ? 'TIMEOUT' : 'MATTING_FAILED',
      message: (e && e.message) || '加白边失败',
      cutoutPath: filePath
    }
  }
}

/**
 * @param {string} filePath 本地临时路径
 * @param {{ canvas?: any }} [options] 可传入页面上的 type=2d canvas 节点作兜底
 */
async function makeCatSticker(filePath, options = {}) {
  if (!filePath) {
    return { ok: false, code: 'MATTING_FAILED', message: '图片读取失败' }
  }

  try {
    return await withTimeout(
      makeCatStickerInner(filePath, options),
      STICKER_HARD_TIMEOUT_MS,
      'TIMEOUT',
      '抠图超时'
    )
  } catch (e) {
    console.warn('[cat-sticker]', e)
    const code = (e && e.code) || 'MATTING_FAILED'
    return {
      ok: false,
      code: code === 'TIMEOUT' ? 'TIMEOUT' : 'MATTING_FAILED',
      message: (e && e.message) || '抠图失败',
      cutoutPath: filePath
    }
  }
}

module.exports = {
  makeCatSticker,
  makeLiteSticker,
  addWhiteBorderFromCutout,
  expandFeetOnCutout,
  repairRembgCutout
}
