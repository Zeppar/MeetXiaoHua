/**
 * 海报 / 分享图：用页面上的 2d canvas 画「手帐纸 + 白边贴纸 + 邮戳」，导出临时图片
 * 颜色与 app.wxss 的手帐设计变量一致（canvas 里读不到 CSS 变量，只能写死）
 */
const C = {
  paper: '#fbf7f0',
  dot: 'rgba(120, 95, 70, 0.10)',
  card: '#fffdf9',
  line: 'rgba(120, 95, 70, 0.16)',
  ink: '#2b2622',
  text2: '#6b6158',
  muted: '#7a6e63',
  orangeInk: '#b8551f',
  tape: 'rgba(240, 138, 75, 0.35)',
  tapeSky: 'rgba(141, 184, 232, 0.45)',
  blushInk: '#b8506a',
  blushSoft: '#fdebef'
}

const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif'

/** cloud:// 先下载成本地临时文件，canvas 才能画 */
function localImagePath(path) {
  if (!path) return Promise.resolve('')
  if (!/^cloud:\/\//.test(path)) return Promise.resolve(path)
  return new Promise((resolve) => {
    wx.cloud.downloadFile({
      fileID: path,
      success: (res) => resolve(res.tempFilePath || ''),
      fail: () => resolve('')
    })
  })
}

/** 云函数返回的小程序码 base64 → 本地文件 */
function writeBase64Png(base64) {
  return new Promise((resolve) => {
    if (!base64) {
      resolve('')
      return
    }
    const filePath = `${wx.env.USER_DATA_PATH}/share_qr_${Date.now()}.png`
    wx.getFileSystemManager().writeFile({
      filePath,
      data: base64,
      encoding: 'base64',
      success: () => resolve(filePath),
      fail: () => resolve('')
    })
  })
}

function loadImage(canvas, path) {
  return new Promise((resolve) => {
    if (!path) {
      resolve(null)
      return
    }
    const img = canvas.createImage()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = path
  })
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function paperBackground(ctx, w, h) {
  ctx.fillStyle = C.paper
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = C.dot
  for (let y = 16; y < h; y += 32) {
    for (let x = 16; x < w; x += 32) {
      ctx.beginPath()
      ctx.arc(x, y, 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

function tape(ctx, cx, cy, w, h, angle, color) {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(angle)
  ctx.fillStyle = color
  ctx.fillRect(-w / 2, -h / 2, w, h)
  ctx.restore()
}

/** 贴纸按比例放进方框，带一点倾斜和落影 */
function drawSticker(ctx, img, box, tilt = -0.05) {
  if (!img || !img.width || !img.height) return
  const ratio = Math.min(box.w / img.width, box.h / img.height)
  const w = img.width * ratio
  const h = img.height * ratio
  ctx.save()
  ctx.translate(box.x + box.w / 2, box.y + box.h / 2)
  ctx.rotate(tilt)
  ctx.shadowColor = 'rgba(80, 50, 20, 0.22)'
  ctx.shadowBlur = 16
  ctx.shadowOffsetY = 8
  ctx.drawImage(img, -w / 2, -h / 2, w, h)
  ctx.restore()
}

function stamp(ctx, cx, cy, r, top, bottom) {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(-0.12)
  ctx.strokeStyle = C.orangeInk
  ctx.lineWidth = 3
  ctx.setLineDash([6, 5])
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = C.orangeInk
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `500 22px ${FONT}`
  ctx.fillText(top, 0, -16)
  ctx.font = `700 28px ${FONT}`
  ctx.fillText(bottom, 0, 18)
  ctx.restore()
}

function exportCanvas(canvas, fileType = 'png') {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      fileType,
      quality: 0.92,
      success: (res) => resolve(res.tempFilePath),
      fail: reject
    })
  })
}

/**
 * 海报 750 × 1200：贴纸、名字、第 N 次遇见、日期邮戳、小程序码
 * opts: { image, name, line, sub, dateLabel, qrPath }
 */
async function drawPoster(canvas, opts = {}) {
  const W = 750
  const H = 1200
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  const [sticker, qr] = await Promise.all([
    localImagePath(opts.image).then((p) => loadImage(canvas, p)),
    loadImage(canvas, opts.qrPath)
  ])

  paperBackground(ctx, W, H)

  // 卡片纸
  ctx.save()
  ctx.shadowColor = 'rgba(90, 60, 30, 0.10)'
  ctx.shadowBlur = 30
  ctx.shadowOffsetY = 12
  roundRect(ctx, 60, 90, 630, 820, 28)
  ctx.fillStyle = C.card
  ctx.fill()
  ctx.restore()
  roundRect(ctx, 60, 90, 630, 820, 28)
  ctx.strokeStyle = C.line
  ctx.lineWidth = 2
  ctx.stroke()
  tape(ctx, 150, 92, 150, 36, -0.12, C.tape)
  tape(ctx, 610, 96, 120, 32, 0.15, C.tapeSky)

  drawSticker(ctx, sticker, { x: 135, y: 160, w: 480, h: 480 })
  if (opts.dateLabel) stamp(ctx, 590, 200, 62, '遇见', opts.dateLabel)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = C.ink
  ctx.font = `900 52px ${FONT}`
  ctx.fillText(String(opts.name || '一只小猫').slice(0, 12), W / 2, 730)
  if (opts.line) {
    ctx.font = `700 30px ${FONT}`
    const textW = ctx.measureText(opts.line).width
    roundRect(ctx, (W - textW) / 2 - 22, 762, textW + 44, 50, 25)
    ctx.fillStyle = C.blushSoft
    ctx.fill()
    ctx.fillStyle = C.blushInk
    ctx.fillText(opts.line, W / 2, 798)
  }
  if (opts.sub) {
    ctx.fillStyle = C.muted
    ctx.font = `500 26px ${FONT}`
    ctx.fillText(String(opts.sub).slice(0, 24), W / 2, 862)
  }

  // 底部：小程序码 + 引导语
  ctx.textAlign = 'left'
  if (qr) {
    roundRect(ctx, 70, 950, 200, 200, 20)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.drawImage(qr, 80, 960, 180, 180)
    ctx.fillStyle = C.ink
    ctx.font = `700 34px ${FONT}`
    ctx.fillText('扫码看看这只猫', 300, 1030)
    ctx.fillStyle = C.text2
    ctx.font = `500 26px ${FONT}`
    ctx.fillText('遇见小花猫 · 猫咪相遇手帐', 300, 1080)
  } else {
    ctx.textAlign = 'center'
    ctx.fillStyle = C.ink
    ctx.font = `700 32px ${FONT}`
    ctx.fillText('微信搜索「遇见小花猫」', W / 2, 1040)
    ctx.fillStyle = C.text2
    ctx.font = `500 26px ${FONT}`
    ctx.fillText('拍下街角的猫，收进你的手帐', W / 2, 1090)
  }

  return exportCanvas(canvas, 'jpg')
}

/** 分享卡片封面 5:4（500 × 400）：手帐纸 + 贴纸，标题由微信卡片自己显示 */
async function drawShareCover(canvas, opts = {}) {
  const W = 500
  const H = 400
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  const sticker = await localImagePath(opts.image).then((p) => loadImage(canvas, p))
  if (!sticker) return ''
  paperBackground(ctx, W, H)
  tape(ctx, 110, 34, 130, 30, -0.12, C.tape)
  drawSticker(ctx, sticker, { x: 90, y: 40, w: 320, h: 320 }, -0.04)
  if (opts.badge) {
    ctx.font = `700 24px ${FONT}`
    const textW = ctx.measureText(opts.badge).width
    roundRect(ctx, W - textW - 56, H - 64, textW + 36, 44, 22)
    ctx.fillStyle = C.blushSoft
    ctx.fill()
    ctx.fillStyle = C.blushInk
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(opts.badge, W - textW - 38, H - 42)
  }
  return exportCanvas(canvas, 'jpg')
}

module.exports = { drawPoster, drawShareCover, writeBase64Png }
