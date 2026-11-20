/**
 * 抠图类型（拍照页切换，写入本地缓存）
 * - lite：端侧粗抠
 * - baidu：单独百度智能抠图
 * - tencent：单独腾讯人像分割（需控制台开通人体分析；未开通会报 NotExist）
 * - rembg：只用本机 rembg（整图、不框猫）
 * - quality：整图 rembg（失败可回退百度）；开识别时腾讯只出品种
 */
const STORAGE_KEY = 'matting_mode_v1'

const OPTIONS = [
  {
    id: 'lite',
    label: '极速',
    desc: '本地粗抠',
    recognizing: '极速抠图中…'
  },
  {
    id: 'baidu',
    label: '百度',
    desc: '单独百度抠图',
    recognizing: '百度抠图中…'
  },
  {
    id: 'tencent',
    label: '腾讯',
    desc: '需开通人体分析',
    recognizing: '腾讯抠图中…'
  },
  {
    id: 'rembg',
    label: 'rembg',
    desc: '整图 rembg',
    recognizing: '本机 rembg 抠图中…'
  },
  {
    id: 'quality',
    label: '精抠',
    desc: '整图rembg',
    recognizing: '精抠中（整图 rembg）…'
  }
]

const DEFAULT_MODE = 'rembg'
/** 可用 u2net / u2net_animal / u2netp；animal 更贴猫但首次要下权重 */
/** 与 matting-local.MODEL 对齐；animal 对猫更稳 */
const QUALITY_MODEL = 'u2net_animal'

function normalizeMode(v) {
  const s = String(v || '').trim().toLowerCase()
  if (s === 'lite' || s === 'baidu' || s === 'tencent' || s === 'rembg' || s === 'quality') {
    return s
  }
  // 兼容旧配置
  if (s === 'fast' || s === 'cloud') return 'baidu'
  if (s === 'local' || s === 'coarse') return 'lite'
  return DEFAULT_MODE
}

function getMode() {
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      const saved = wx.getStorageSync(STORAGE_KEY)
      if (saved) return normalizeMode(saved)
    }
  } catch (e) {
    /* ignore */
  }
  return normalizeMode(module.exports.MODE)
}

function setMode(mode) {
  const next = normalizeMode(mode)
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) {
      wx.setStorageSync(STORAGE_KEY, next)
    }
  } catch (e) {
    /* ignore */
  }
  module.exports.MODE = next
  return next
}

function getOption(mode) {
  const id = normalizeMode(mode || getMode())
  return OPTIONS.find((o) => o.id === id) || OPTIONS[0]
}

/** 云端单独厂商模式 */
function isCloudVendorMode(mode) {
  const id = normalizeMode(mode || getMode())
  return id === 'baidu' || id === 'tencent'
}

module.exports = {
  MODE: DEFAULT_MODE,
  DEFAULT_MODE,
  QUALITY_MODEL,
  STORAGE_KEY,
  OPTIONS,
  normalizeMode,
  getMode,
  setMode,
  getOption,
  isCloudVendorMode
}
