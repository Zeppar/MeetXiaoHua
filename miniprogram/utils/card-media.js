/**
 * 卡牌图片选取：优先云 fileID，避免临时路径过期后图鉴/小屋空白。
 * 开发者工具 Windows 下临时图常为 http://127.0.0.1:PORT/__tmp__/xxx.png
 */

function isEphemeralPath(p) {
  const s = String(p || '')
  if (!s) return true
  if (s.indexOf('cloud://') === 0) return false
  if (typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH) {
    if (s.indexOf(wx.env.USER_DATA_PATH) === 0) return false
  }
  if (s.indexOf('/assets/') === 0 || s.indexOf('assets/') === 0) return false
  // 开发者工具 / 真机临时文件
  if (s.indexOf('__tmp__') >= 0) return true
  if (s.indexOf('wxfile://') === 0) return true
  if (s.indexOf('http://tmp') === 0 || s.indexOf('https://tmp') === 0) return true
  if (s.indexOf('http://127.0.0.1') === 0 || s.indexOf('http://localhost') === 0) return true
  if (s.indexOf('/tmp/') >= 0 || s.indexOf('\\tmp\\') >= 0 || s.indexOf('tmp_') >= 0) return true
  if (/^https?:\/\//i.test(s) && s.indexOf('cloud') < 0) return true
  return false
}

function pickCardImage(card) {
  if (!card) return ''
  const cutoutFileId = card.cutoutFileId || ''
  const originalFileId = card.originalFileId || ''
  const cutoutPath = card.cutoutPath || ''
  const originalPath = card.originalPath || ''

  // 云 fileID 永远优先，避免 127.0.0.1/__tmp__ 过期报错
  if (cutoutFileId && String(cutoutFileId).indexOf('cloud://') === 0) return cutoutFileId
  if (cutoutPath && !isEphemeralPath(cutoutPath)) return cutoutPath
  if (cutoutFileId) return cutoutFileId
  if (originalFileId && String(originalFileId).indexOf('cloud://') === 0) return originalFileId
  if (originalPath && !isEphemeralPath(originalPath)) return originalPath
  if (originalFileId) return originalFileId
  // 当前会话临时路径可能还能亮一下；过期后由页面 binderror 兜底
  return cutoutPath || originalPath || card.displayImage || ''
}

function copyToUserData(srcPath) {
  const dest = `${wx.env.USER_DATA_PATH}/card_${Date.now()}_${Math.random().toString(16).slice(2)}.png`
  return new Promise((resolve) => {
    try {
      wx.getFileSystemManager().copyFile({
        srcPath,
        destPath: dest,
        success: () => resolve(dest),
        fail: () => resolve('')
      })
    } catch (e) {
      resolve('')
    }
  })
}

function downloadToUserData(url) {
  return new Promise((resolve) => {
    wx.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode === 200 && res.tempFilePath) {
          copyToUserData(res.tempFilePath).then((p) => resolve(p || res.tempFilePath))
        } else {
          resolve('')
        }
      },
      fail: () => resolve('')
    })
  })
}

/**
 * 把临时图落到 USER_DATA_PATH；失败则原样返回（调用方应再走云上传）。
 */
function persistLocalImage(filePath) {
  if (!filePath) return Promise.resolve('')
  const src = String(filePath)
  if (src.indexOf('cloud://') === 0) return Promise.resolve(src)
  if (typeof wx === 'undefined' || !wx.env || !wx.env.USER_DATA_PATH) return Promise.resolve(src)
  if (src.indexOf(wx.env.USER_DATA_PATH) === 0) return Promise.resolve(src)
  if (src.indexOf('/assets/') === 0) return Promise.resolve(src)

  // http://127.0.0.1:port/__tmp__/... 需先 download，copyFile 读不了
  if (/^https?:\/\//i.test(src)) {
    return downloadToUserData(src).then((p) => p || src)
  }

  return copyToUserData(src).then((p) => p || src)
}

/**
 * 清理卡牌上已失效的临时路径，避免 image 组件反复打 127.0.0.1 报错
 */
function sanitizeCardMedia(card) {
  if (!card) return card
  const next = { ...card }
  if (isEphemeralPath(next.cutoutPath)) {
    // 丢掉死链，展示走 cutoutFileId / originalFileId
    next.cutoutPath = ''
  }
  if (isEphemeralPath(next.originalPath)) {
    next.originalPath = ''
  }
  return next
}

module.exports = {
  isEphemeralPath,
  pickCardImage,
  persistLocalImage,
  sanitizeCardMedia
}
