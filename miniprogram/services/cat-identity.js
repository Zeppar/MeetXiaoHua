const { normalizePhotoIdentity } = require('../utils/photo-identity')
const { pickCardImage } = require('../utils/card-media')
const { cardDisplayName } = require('../utils/format')
const { getOpenId } = require('./local-store')
const api = require('./api')

const SIZE = 32
const CACHE_KEY = 'mxh_photo_identity_refs_v1'
const TIME_LIMIT_MS = 7500
const REFERENCE_BATCH = 8
const COS = Array.from({ length: 8 }, (_, frequency) => Array.from({ length: SIZE }, (_, x) =>
  Math.cos(Math.PI * (2 * x + 1) * frequency / (2 * SIZE))
))

function timed(task, ms, fallback = null) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    Promise.resolve().then(task).then((result) => {
      clearTimeout(timer)
      resolve(result)
    }, () => {
      clearTimeout(timer)
      resolve(fallback)
    })
  })
}

function imagePath(path) {
  if (!path) return Promise.resolve('')
  if (!path.startsWith('cloud://')) return Promise.resolve(path)
  return timed(() => new Promise((resolve, reject) => {
    wx.cloud.downloadFile({ fileID: path, success: (res) => resolve(res.tempFilePath), fail: reject })
  }), 2500, '')
}

function fileDigest(path) {
  if (!path) return Promise.resolve('')
  return timed(() => new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager()
    const options = {
      filePath: path,
      digestAlgorithm: 'sha1',
      success: ({ digest }) => resolve(digest && digest.length === 40 ? 'sha1:' + digest.toLowerCase() : ''),
      fail: reject
    }
    const fallback = () => typeof wx.getFileInfo === 'function' ? wx.getFileInfo(options) : reject()
    if (typeof fs.getFileInfo === 'function') fs.getFileInfo({ ...options, fail: fallback })
    else fallback()
  }), 2000, '')
}

function phash(pixels) {
  const rows = Array.from({ length: SIZE }, () => Array(8).fill(0))
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4
      const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
      for (let u = 0; u < 8; u++) rows[y][u] += gray * COS[u][x]
    }
  }
  const coefficients = []
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      if (u === 0 && v === 0) continue
      coefficients.push(rows.reduce((sum, row, y) => sum + row[u] * COS[v][y], 0))
    }
  }
  const sorted = coefficients.slice().sort((a, b) => a - b)
  // 纯色/极模糊照片不能提供可靠的图案特征。
  if (Math.max(...sorted.map(Math.abs)) < 320) return ''
  const median = sorted[31]
  const bits = [0, ...coefficients.map((v) => v > median ? 1 : 0)]
  let hash = ''
  for (let i = 0; i < bits.length; i += 4) {
    hash += (8 * bits[i] + 4 * bits[i + 1] + 2 * bits[i + 2] + bits[i + 3]).toString(16)
  }
  return hash
}

function colorSignature(pixels) {
  const sums = [0, 0, 0]
  const squares = [0, 0, 0]
  for (let i = 0; i < pixels.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      sums[channel] += pixels[i + channel]
      squares[channel] += pixels[i + channel] ** 2
    }
  }
  const count = pixels.length / 4
  const means = sums.map((sum) => sum / count)
  return [...means, ...squares.map((sum, i) => Math.sqrt(Math.max(0, sum / count - means[i] ** 2)))]
    .map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')
}

async function loadImage(canvas, path) {
  return timed(() => new Promise((resolve, reject) => {
    const img = canvas.createImage()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = path
  }), 2500)
}

function foregroundBounds(ctx, size) {
  const { data } = ctx.getImageData(0, 0, size, size)
  let left = size, top = size, right = -1, bottom = -1, count = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[(y * size + x) * 4 + 3] < 100) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
      count++
    }
  }
  if (count < size * size * 0.08 || count > size * size * 0.97) return null
  return [left, top, right - left + 1, bottom - top + 1]
}

function canvasJpeg(canvas, page) {
  return timed(() => new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas, fileType: 'jpg', quality: 0.8,
      success: (res) => {
        wx.getFileSystemManager().readFile({
          filePath: res.tempFilePath, encoding: 'base64',
          success: ({ data }) => resolve(data), fail: reject
        })
      },
      fail: reject
    }, page)
  }), 1200, '')
}

async function renderPhoto(path, { foreground, canvas, page, embed, isCurrent }) {
  if (!path || !canvas) return {}
  const img = await loadImage(canvas, path)
  if (!img || !img.width || !img.height || isCurrent && !isCurrent()) return {}
  const size = 224
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, size, size)
  ctx.drawImage(img, 0, 0, size, size)
  const bounds = foreground ? foregroundBounds(ctx, size) : null
  if (foreground && !bounds) return {}
  const crop = bounds
    ? [bounds[0] * img.width / size, bounds[1] * img.height / size, bounds[2] * img.width / size, bounds[3] * img.height / size]
    : [0, 0, img.width, img.height]
  const paint = (side, square) => {
    ctx.fillStyle = '#a0a0a0'
    ctx.fillRect(0, 0, side, side)
    const ratio = Math.min(side / crop[2], side / crop[3])
    const width = square ? side : crop[2] * ratio
    const height = square ? side : crop[3] * ratio
    ctx.drawImage(img, ...crop, (side - width) / 2, (side - height) / 2, width, height)
  }
  paint(SIZE, true)
  const pixels = ctx.getImageData(0, 0, SIZE, SIZE).data
  const hash = phash(pixels)
  const color = colorSignature(pixels)
  let imageBase64 = ''
  if (embed && hash) {
    paint(size, false)
    imageBase64 = await canvasJpeg(canvas, page)
  }
  return { hash, color, imageBase64 }
}

function canvasFor(fallback) {
  try {
    if (typeof wx.createOffscreenCanvas === 'function') {
      return wx.createOffscreenCanvas({ type: '2d', width: 224, height: 224 })
    }
  } catch (e) {
    // 旧版微信使用拍照页专用 canvas。
  }
  return fallback
}

async function preparePhoto(paths, options) {
  const [original, cutout] = await Promise.all([imagePath(paths.original), imagePath(paths.cutout)])
  const digestPromise = fileDigest(original)
  const embed = api.canEmbedCatPhoto()
  // 导出 JPEG 用页面画布，兼容无法导出离屏画布的微信版本。
  const canvas = embed && options.canvas ? options.canvas : canvasFor(options.canvas)
  const render = (path, foreground, embed) => renderPhoto(path, { ...options, canvas, foreground, embed }).catch(() => ({}))
  const subject = await render(cutout, true, embed)
  const whole = await render(original, false, embed && !subject.imageBase64)
  const digest = await digestPromise
  const imageBase64 = subject.imageBase64 || whole.imageBase64
  const current = !options.isCurrent || options.isCurrent()
  const embedding = imageBase64 && current ? await timed(() => api.embedCatPhoto(imageBase64), 3500, '') : ''
  return normalizePhotoIdentity({
    digest, photo: whole.hash, foreground: subject.hash, color: subject.color || whole.color, embedding
  })
}

function hashDistance(a, b) {
  if (!a || !b) return Infinity
  const bits = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]
  return Array.from(a).reduce((sum, char, i) => sum + bits[parseInt(char, 16) ^ parseInt(b[i], 16)], 0)
}

function colorDistance(a, b) {
  if (!a || !b) return Infinity
  let distance = 0
  for (let i = 0; i < a.length; i += 2) {
    distance += Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16))
  }
  return distance / 6
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, n1 = 0, n2 = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    n1 += a[i] ** 2
    n2 += b[i] ** 2
  }
  return n1 && n2 ? dot / Math.sqrt(n1 * n2) : 0
}

function embeddingVector(identity) {
  if (!identity.embedding) return null
  try {
    return new Int8Array(wx.base64ToArrayBuffer(identity.embedding))
  } catch (e) {
    return null
  }
}

function matchPhoto(identity, reference, vector) {
  if (identity.digest && reference.digest === identity.digest) return { exact: true, score: 2 }
  const similarity = cosine(vector, embeddingVector(reference))
  const foreground = hashDistance(identity.foreground, reference.foreground)
  const whole = hashDistance(identity.photo, reference.photo)
  const color = colorDistance(identity.color, reference.color)
  if (similarity >= 0.8) return { exact: false, score: similarity }
  if ((whole <= 6 && color <= 20) || (foreground <= 12 && color <= 20)) {
    return { exact: false, score: 0.95 - Math.min(whole, foreground) / 64 }
  }
  return null
}

function rankMatches(identity, cards, legacy = {}) {
  if (!identity) return []
  const vector = embeddingVector(identity)
  const matches = []
  for (const card of cards) {
    const refs = [...(Array.isArray(card.photoIdentities) ? card.photoIdentities : []), legacy[card._id]]
    let best = null
    for (const ref of refs) {
      const reference = normalizePhotoIdentity(ref)
      if (!reference) continue
      const match = matchPhoto(identity, reference, vector)
      if (match && (!best || match.score > best.score)) best = match
    }
    if (best) matches.push({ ...best, id: card._id, name: cardDisplayName(card), image: pickCardImage(card) })
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, 3)
}

function cachedReferences() {
  try {
    const stored = wx.getStorageSync(CACHE_KEY)
    return stored && stored.owner === getOpenId() ? stored.entries || {} : {}
  } catch (e) {
    return {}
  }
}

function referencePaths(card) {
  const original = card.originalFileId || card.originalPath || ''
  const cutout = !card.mattingFailed && (card.cutoutFileId || card.cutoutPath) || ''
  return { original, cutout: original === cutout ? '' : cutout }
}

function sourceKey(paths) {
  return paths.original + '|' + paths.cutout
}

async function findCatMatches(paths, options = {}) {
  const started = Date.now()
  const owner = getOpenId()
  const [identity, listed] = await Promise.all([
    timed(() => preparePhoto(paths, options), TIME_LIMIT_MS),
    timed(() => api.listCards({}), TIME_LIMIT_MS, { cards: [] })
  ])
  if (!identity || options.isCurrent && !options.isCurrent()) return { identity, matches: [] }
  const cards = (listed.cards || []).filter((card) => card && card._id)
  const entries = cachedReferences()
  const legacy = {}
  const pending = []
  for (const card of cards) {
    const paths = referencePaths(card)
    const old = entries[card._id]
    const cached = old && old.source === sourceKey(paths) && old.identity
    if (cached) legacy[card._id] = cached
    const references = Array.isArray(card.photoIdentities) ? card.photoIdentities : []
    const needsReference = !cached && !references.length
    const needsEmbedding = identity.embedding && !(cached && cached.embedding) && !references.some((ref) => ref && ref.embedding)
    if ((needsReference || needsEmbedding) && (paths.original || paths.cutout)) {
      pending.push({ id: card._id, paths })
    }
  }
  const initial = rankMatches(identity, cards, legacy)
  if (initial.some((match) => match.exact)) return { identity, matches: initial }

  // 每次只补算一批旧卡，已完成的结果缓存在当前用户设备。
  for (const candidate of pending.slice(0, REFERENCE_BATCH)) {
    const remaining = TIME_LIMIT_MS - (Date.now() - started)
    if (remaining <= 0 || options.isCurrent && !options.isCurrent()) break
    const reference = await timed(() => preparePhoto(candidate.paths, options), remaining)
    if (!reference || options.isCurrent && !options.isCurrent()) continue
    legacy[candidate.id] = reference
    entries[candidate.id] = { source: sourceKey(candidate.paths), identity: reference }
    if (identity.digest && reference.digest === identity.digest) break
  }
  if (pending.length && getOpenId() === owner && (!options.isCurrent || options.isCurrent())) {
    try {
      const known = cards.map((card) => card._id).filter((id) => entries[id]).slice(0, 100)
      wx.setStorageSync(CACHE_KEY, { owner, entries: Object.fromEntries(known.map((id) => [id, entries[id]])) })
    } catch (e) {
      // 当前会话仍可照常比对。
    }
  }
  return { identity, matches: rankMatches(identity, cards, legacy) }
}

module.exports = { findCatMatches, rankMatches }
