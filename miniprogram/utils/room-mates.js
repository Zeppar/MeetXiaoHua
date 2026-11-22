/** 小屋同住：最多 3 只，地位相同 */
const ROOM_CAPACITY = 3
const ROOM_MATE_LIMIT = ROOM_CAPACITY - 1

function normalizeRoomIds(ids) {
  const list = Array.isArray(ids) ? ids : []
  const out = []
  const seen = {}
  list.forEach((id) => {
    const s = String(id || '')
    if (!s || seen[s]) return
    seen[s] = true
    out.push(s)
  })
  return out.slice(0, ROOM_CAPACITY)
}

/** 从完整列表里去掉 focus（兼容旧字段：displayCardId + roomMateIds） */
function normalizeMateIds(ids, focusId) {
  const focus = focusId || ''
  return normalizeRoomIds(ids).filter((id) => id !== focus).slice(0, ROOM_MATE_LIMIT)
}

function roomOccupancy(user) {
  const focus = (user && user.displayCardId) || ''
  const mates = normalizeMateIds(user && user.roomMateIds, focus)
  const ids = normalizeRoomIds(focus ? [focus, ...mates] : mates)
  return {
    /** 出门/护理引擎用的焦点猫，UI 不区分 */
    focus: ids[0] || '',
    main: ids[0] || '',
    mates: ids.slice(1),
    ids,
    count: ids.length,
    capacity: ROOM_CAPACITY,
    full: ids.length >= ROOM_CAPACITY,
    isInRoom(cardId) {
      return !!(cardId && ids.indexOf(cardId) >= 0)
    },
    /** @deprecated 三只平等，恒为 false */
    isMain() {
      return false
    }
  }
}

function resolveHomeCards(user, cards, outingCardId, preferredCard) {
  const byId = new Map((cards || []).filter(Boolean).map((card) => [card._id, card]))
  if (preferredCard && preferredCard._id) byId.set(preferredCard._id, preferredCard)
  const homeCards = roomOccupancy(user).ids
    .filter((id) => id !== outingCardId)
    .map((id) => byId.get(id))
    .filter(Boolean)
  const displayCard = homeCards.find((card) => preferredCard && card._id === preferredCard._id) || homeCards[0] || null
  return {
    displayCard,
    mateIds: displayCard ? homeCards.filter((card) => card !== displayCard).map((card) => card._id) : []
  }
}

module.exports = {
  ROOM_CAPACITY,
  ROOM_MATE_LIMIT,
  normalizeRoomIds,
  normalizeMateIds,
  roomOccupancy,
  resolveHomeCards
}
