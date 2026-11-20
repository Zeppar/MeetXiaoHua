const KEYS = {
  cards: 'mxh_cache_cards',
  user: 'mxh_cache_user',
  privacy: 'mxh_privacy_agreed',
  longPressHint: 'mxh_longpress_hint_shown',
  cardNames: 'mxh_card_names'
}

function set(key, value) {
  // 异步写缓存，避免进页时同步 setStorage 卡住跳转动画
  try {
    wx.setStorage({
      key,
      data: value,
      fail: (e) => console.warn('cache set fail', key, e)
    })
  } catch (e) {
    console.warn('cache set fail', key, e)
  }
}

function setSync(key, value) {
  try {
    wx.setStorageSync(key, value)
  } catch (e) {
    console.warn('cache setSync fail', key, e)
  }
}

function get(key, fallback = null) {
  try {
    const v = wx.getStorageSync(key)
    return v === '' || v === undefined ? fallback : v
  } catch (e) {
    return fallback
  }
}

function cacheCards(cards) {
  set(KEYS.cards, cards || [])
}

function getCachedCards() {
  return get(KEYS.cards, [])
}

function cacheUser(user) {
  set(KEYS.user, user || null)
}

function getCachedUser() {
  return get(KEYS.user, null)
}

function isPrivacyAgreed() {
  return !!get(KEYS.privacy, false)
}

function setPrivacyAgreed() {
  setSync(KEYS.privacy, true)
}

function isLongPressHintShown() {
  return !!get(KEYS.longPressHint, false)
}

function setLongPressHintShown() {
  setSync(KEYS.longPressHint, true)
}

/** 猫的自定义名字（与品种分类分离，切换筛选不丢失） */
function getCardNames() {
  const map = get(KEYS.cardNames, {})
  return map && typeof map === 'object' ? map : {}
}

function setCardName(cardId, name) {
  if (!cardId) return
  const map = getCardNames()
  map[cardId] = (name || '').trim()
  setSync(KEYS.cardNames, map)
}

function getCardName(cardId, fallback = '') {
  if (!cardId) return fallback
  const map = getCardNames()
  if (Object.prototype.hasOwnProperty.call(map, cardId)) return map[cardId] || ''
  return fallback
}

module.exports = {
  KEYS,
  cacheCards,
  getCachedCards,
  cacheUser,
  getCachedUser,
  isPrivacyAgreed,
  setPrivacyAgreed,
  isLongPressHintShown,
  setLongPressHintShown,
  getCardNames,
  setCardName,
  getCardName
}
