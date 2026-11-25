/**
 * 新手路径：首屏只拍猫；小屋等有 2 只猫再解锁
 * 解锁后记在本地，之后猫变少（送去流浪）也不会再锁回去
 */
const cache = require('../services/storage-cache')

const ROOM_UNLOCK_CATS = 2
const KEY_ROOM_UNLOCKED = 'mxh_room_unlocked'
const KEY_ROOM_CELEBRATED = 'mxh_room_unlock_celebrated'

function readFlag(key) {
  try {
    return !!wx.getStorageSync(key)
  } catch (e) {
    return false
  }
}

function writeFlag(key) {
  try {
    wx.setStorageSync(key, 1)
  } catch (e) {
    /* 写不进就下次再算 */
  }
}

function cachedCardCount() {
  const cards = cache.getCachedCards()
  return Array.isArray(cards) ? cards.length : 0
}

/** 传入当前猫数时顺便记住「已解锁」；不传就用缓存里的猫数 */
function isRoomUnlocked(cardCount) {
  if (readFlag(KEY_ROOM_UNLOCKED)) return true
  const count = typeof cardCount === 'number' ? cardCount : cachedCardCount()
  if (count >= ROOM_UNLOCK_CATS) {
    writeFlag(KEY_ROOM_UNLOCKED)
    return true
  }
  return false
}

/** 刚解锁、还没庆祝过：返回 true 并记下，只庆祝一次 */
function takeUnlockCelebration(cardCount) {
  if (!isRoomUnlocked(cardCount) || readFlag(KEY_ROOM_CELEBRATED)) return false
  writeFlag(KEY_ROOM_CELEBRATED)
  return true
}

/** 老用户（解锁前就有很多猫）不需要庆祝：直接标记 */
function skipUnlockCelebration() {
  writeFlag(KEY_ROOM_CELEBRATED)
}

module.exports = {
  ROOM_UNLOCK_CATS,
  isRoomUnlocked,
  takeUnlockCelebration,
  skipUnlockCelebration,
  cachedCardCount
}
