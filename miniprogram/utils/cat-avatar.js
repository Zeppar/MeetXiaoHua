/**
 * 小屋分身（卡通模式）：用小屋插画猫 assets/art/cat-sit.svg 当模板，按真猫毛色重新上色。
 * 画风和小屋一致，毛色像「那一只」。和 scripts/cat_avatar.py 的规则保持一致。
 * 图鉴、详情、记忆、分享里永远用真猫贴纸；只有小屋按用户选的模式显示。
 */

// 与 assets/art/cat-sit.svg 相同；改插画时两边一起改
const TEMPLATE = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 140\" fill=\"none\" stroke=\"#2b2622\" stroke-width=\"3.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M86 122 C112 122 118 92 100 84\" stroke=\"#2b2622\" stroke-width=\"12\"/>\n  <path d=\"M86 122 C112 122 118 92 100 84\" stroke=\"#f08a4b\" stroke-width=\"6\"/>\n  <path d=\"M28 132 C24 98 38 76 60 76 C82 76 96 98 92 132 Z\" fill=\"#f08a4b\"/>\n  <path d=\"M44 132 C42 108 50 94 60 94 C70 94 78 108 76 132 Z\" fill=\"#ffe9d2\" stroke=\"none\"/>\n  <path d=\"M33 96 l9 4 M31 108 l9 3 M87 96 l-9 4 M89 108 l-9 3\" stroke=\"#c95f2a\" stroke-width=\"3\"/>\n  <ellipse cx=\"46\" cy=\"131\" rx=\"9\" ry=\"6\" fill=\"#ffe9d2\"/>\n  <ellipse cx=\"74\" cy=\"131\" rx=\"9\" ry=\"6\" fill=\"#ffe9d2\"/>\n  <path d=\"M34 50 L30 18 L54 36 Z\" fill=\"#f08a4b\"/>\n  <path d=\"M86 50 L90 18 L66 36 Z\" fill=\"#f08a4b\"/>\n  <path d=\"M36 44 L34 26 L47 37 Z M84 44 L86 26 L73 37 Z\" fill=\"#f2a7b5\" stroke=\"none\"/>\n  <ellipse cx=\"60\" cy=\"58\" rx=\"32\" ry=\"27\" fill=\"#f08a4b\"/>\n  <path d=\"M60 32 v9 M52 34 l2 7 M68 34 l-2 7\" stroke=\"#c95f2a\" stroke-width=\"3\"/>\n  <ellipse cx=\"60\" cy=\"68\" rx=\"18\" ry=\"13\" fill=\"#ffe9d2\" stroke=\"none\"/>\n  <path d=\"M45 58 q4 -5 8 0 M67 58 q4 -5 8 0\"/>\n  <path d=\"M57 65 h6 l-3 3.4 z\" fill=\"#e0607e\" stroke-width=\"2.2\"/>\n  <path d=\"M60 68.4 q-3 4 -7 2 M60 68.4 q3 4 7 2\" stroke-width=\"2.4\"/>\n  <path d=\"M36 66 l-12 -2 M36 71 l-12 2 M84 66 l12 -2 M84 71 l12 2\" stroke-width=\"2\"/>\n  <circle cx=\"42\" cy=\"68\" r=\"4.5\" fill=\"#f2a7b5\" stroke=\"none\" opacity=\"0.8\"/>\n  <circle cx=\"78\" cy=\"68\" r=\"4.5\" fill=\"#f2a7b5\" stroke=\"none\" opacity=\"0.8\"/>\n</svg>"

const BODY = '#f08a4b'
const BELLY = '#ffe9d2'
const STRIPE = '#c95f2a'
const HEX = /^#[0-9a-f]{6}$/
const PATTERNS = ['tabby', 'solid', 'solid-dark', 'tabby+white', 'solid+white', 'solid-dark+white']

/** 小屋显示模式：cartoon 卡通分身（默认）/ photo 真猫贴纸 */
const ROOM_STYLES = ['cartoon', 'photo']
function normalizeRoomStyle(v) {
  return ROOM_STYLES.indexOf(v) >= 0 ? v : 'cartoon'
}

function normalizeCoat(raw) {
  if (!raw || typeof raw !== 'object') return null
  const body = String(raw.body || '').toLowerCase()
  const belly = String(raw.belly || '').toLowerCase()
  const stripe = String(raw.stripe || '').toLowerCase()
  if (!HEX.test(body) || !HEX.test(belly) || !HEX.test(stripe)) return null
  return { body, belly, stripe, pattern: PATTERNS.indexOf(raw.pattern) >= 0 ? raw.pattern : 'solid' }
}

function avatarSvg(coat) {
  const c = normalizeCoat(coat)
  if (!c) return ''
  return TEMPLATE.split(BODY).join(c.body).split(BELLY).join(c.belly).split(STRIPE).join(c.stripe)
}

const _uriCache = {}
/** 生成可直接给 <image src> 用的 data URI（模板是纯 ASCII，可直接转 base64） */
function avatarUri(coat) {
  const svg = avatarSvg(coat)
  if (!svg) return ''
  if (_uriCache[svg]) return _uriCache[svg]
  const bytes = new Uint8Array(svg.length)
  for (let i = 0; i < svg.length; i++) bytes[i] = svg.charCodeAt(i) & 0xff
  const uri = 'data:image/svg+xml;base64,' + wx.arrayBufferToBase64(bytes.buffer)
  _uriCache[svg] = uri
  return uri
}

// ---------- 从真猫贴纸里读毛色 ----------

function hex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}

function lum(rgb) {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
}

function rgbToHls(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, l, 0]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, l, s]
}

function hlsToRgb(h, l, s) {
  if (!s) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}

/** 往插画色靠：略提饱和度，可整体提亮 */
function tune(rgb, sat = 1.15, light = 0) {
  const [h, l0, s0] = rgbToHls(rgb[0], rgb[1], rgb[2])
  const s = Math.min(1, s0 * sat)
  const l = Math.min(0.96, l0 + light * (1 - l0))
  return hlsToRgb(h, l, s)
}

/** 简单 k-means：初始中心按亮度分位取，保证深 / 中 / 浅都有 */
function kmeans(pixels, k = 5, rounds = 8) {
  const sorted = pixels.slice().sort((a, b) => lum(a) - lum(b))
  let centers = Array.from({ length: k }, (_, i) => sorted[Math.floor(((i + 0.5) / k) * sorted.length)].slice())
  let assign = new Array(pixels.length).fill(0)
  for (let r = 0; r < rounds; r++) {
    const sums = centers.map(() => [0, 0, 0, 0])
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i]
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < k; c++) {
        const d = (p[0] - centers[c][0]) ** 2 + (p[1] - centers[c][1]) ** 2 + (p[2] - centers[c][2]) ** 2
        if (d < bestD) { bestD = d; best = c }
      }
      assign[i] = best
      const s = sums[best]
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++
    }
    centers = centers.map((c, i) => (sums[i][3] ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] : c))
  }
  const counts = new Array(k).fill(0)
  assign.forEach((a) => counts[a]++)
  return centers.map((rgb, i) => ({ rgb, share: counts[i] / pixels.length, lum: lum(rgb) }))
}

/** RGBA 像素数组 → 毛色；规则与 scripts/cat_avatar.py 一致 */
function coatFromPixels(data) {
  const pixels = []
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 200) pixels.push([data[i], data[i + 1], data[i + 2]])
  }
  if (pixels.length < 50) return null
  const clusters = kmeans(pixels).filter((c) => c.share > 0.03).sort((a, b) => a.lum - b.lum)
  if (!clusters.length) return null
  const dark = clusters[0]
  const light = clusters[clusters.length - 1]
  const body = clusters.reduce((a, b) => (b.share > a.share ? b : a))
  let base
  let stripe
  let pattern
  if (body.lum < 75) {
    base = tune(body.rgb, 1.0, 0.12)
    stripe = base.map((v) => v * 0.7)
    pattern = 'solid-dark'
  } else if (dark.lum < body.lum - 30 && dark.share > 0.06) {
    base = tune(body.rgb, 1.15, 0.08)
    stripe = tune(dark.rgb, 1.1)
    pattern = 'tabby'
  } else {
    base = tune(body.rgb, 1.15, 0.08)
    stripe = base.map((v) => v * 0.85)
    pattern = 'solid'
  }
  let belly
  if (light.lum > 175 && light.share > 0.08 && light !== body) {
    belly = tune(light.rgb, 0.9, 0.15)
    pattern += '+white'
  } else {
    belly = tune(base, 0.7, 0.55)
  }
  return { body: hex(base), belly: hex(belly), stripe: hex(stripe), pattern }
}

function localPath(path) {
  if (!path) return Promise.resolve('')
  if (!/^cloud:\/\//.test(path)) return Promise.resolve(path)
  return new Promise((resolve) => {
    wx.cloud.downloadFile({ fileID: path, success: (r) => resolve(r.tempFilePath || ''), fail: () => resolve('') })
  })
}

/** 从猫卡的贴纸图读毛色（离屏 canvas 64×64 取样，几十毫秒） */
async function extractCoat(imagePath) {
  if (typeof wx.createOffscreenCanvas !== 'function') return null
  const path = await localPath(imagePath)
  if (!path) return null
  const size = 64
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: size, height: size })
  const ctx = canvas.getContext('2d')
  const img = await new Promise((resolve) => {
    const im = canvas.createImage()
    im.onload = () => resolve(im)
    im.onerror = () => resolve(null)
    im.src = path
  })
  if (!img || !img.width) return null
  const ratio = Math.min(size / img.width, size / img.height)
  const w = img.width * ratio
  const h = img.height * ratio
  ctx.clearRect(0, 0, size, size)
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
  return coatFromPixels(ctx.getImageData(0, 0, size, size).data)
}

module.exports = {
  ROOM_STYLES,
  normalizeRoomStyle,
  normalizeCoat,
  avatarSvg,
  avatarUri,
  coatFromPixels,
  extractCoat
}
