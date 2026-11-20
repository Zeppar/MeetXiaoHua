function pad(n) {
  return n < 10 ? `0${n}` : `${n}`
}

/** 格式：2026年11月5日 14:30 */
function formatDateTime(input) {
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDateShort(input) {
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`
}

function clampText(text, max) {
  const s = (text || '').trim()
  if (s.length <= max) return s
  return s.slice(0, max)
}

/** 展示名：自定义名字优先，否则用识别品种 */
// 品种的占位值：不能拿来当猫的名字（否则会出现「喵，我是待识别」）
const PLACEHOLDER_BREEDS = ['待识别', '识别中…', '未知小动物']

function isPlaceholderBreed(breed) {
  const b = String(breed || '').trim()
  return !b || PLACEHOLDER_BREEDS.indexOf(b) >= 0
}

function cardDisplayName(card) {
  if (!card) return ''
  const custom = (card.name || '').trim()
  if (custom) return custom
  return isPlaceholderBreed(card.breed) ? '小猫' : card.breed
}

module.exports = {
  formatDateTime,
  formatDateShort,
  clampText,
  cardDisplayName,
  isPlaceholderBreed
}
