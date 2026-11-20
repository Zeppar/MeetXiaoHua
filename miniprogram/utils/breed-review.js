/** 品种修改审核规则 */
const PENDING_LABELS = ['待识别', '识别中…', '未知小动物', '']

function isValidRecognizedBreed(breed) {
  const b = String(breed || '').trim()
  return !!b && PENDING_LABELS.indexOf(b) < 0
}

function normalizeRecognizedBreed(breed) {
  const b = String(breed || '').trim()
  return isValidRecognizedBreed(b) ? b : ''
}

/**
 * 是否允许不经审核直接改品种
 * —— 一律否：含改回当初识别结果，都要提交审核
 */
function canDirectSetBreed(/* card, targetBreed */) {
  return false
}

function ensureRecognizedBreedField(card) {
  if (!card) return card
  if (card.recognizedBreed !== undefined && card.recognizedBreed !== null) {
    return card
  }
  // 旧卡迁移：若当前品种像识别结果，记为 recognizedBreed；否则空（只能审核改）
  const guess = normalizeRecognizedBreed(card.breed)
  return { ...card, recognizedBreed: guess }
}

module.exports = {
  PENDING_LABELS,
  isValidRecognizedBreed,
  normalizeRecognizedBreed,
  canDirectSetBreed,
  ensureRecognizedBreedField
}
