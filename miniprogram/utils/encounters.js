/**
 * 熟面孔：每只猫的「遇见次数 / 认识天数 / 地盘」
 * 第一次遇见 = 建卡；之后在拍照页确认「是它」= 再遇见一次（encounterCount +1）
 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 真实再遇见一次，小屋亲密度涨这么多（小屋里的日常互动涨得少） */
const ENCOUNTER_INTIMACY = 15

function encounterCountOf(card) {
  const n = Number(card && card.encounterCount)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
}

function lastSeenOf(card) {
  return Number(card && card.lastSeenAt) || Number(card && card.shotAt) || 0
}

function knownDaysOf(card, now = Date.now()) {
  const since = Number(card && card.shotAt)
  if (!since) return 0
  return Math.max(1, Math.floor((now - since) / DAY_MS) + 1)
}

/** 它的地盘：相遇地点文字，没填就空 */
function territoryOf(card) {
  const place = String((card && card.placeText) || '').trim()
  return place === '已记录当前位置' ? '' : place
}

function encounterSummary(cards, now = Date.now()) {
  const list = (cards || []).filter(Boolean)
  let encounterTotal = 0
  let regulars = 0
  let longestDays = 0
  list.forEach((card) => {
    const n = encounterCountOf(card)
    encounterTotal += n
    if (n >= 2) regulars += 1
    longestDays = Math.max(longestDays, knownDaysOf(card, now))
  })
  return { catCount: list.length, encounterTotal, regulars, longestDays }
}

/** 云端和本地各自记了遇见次数：取大的，避免一侧失败时丢计数 */
function mergeEncounterFields(cloudCard, localCard) {
  const count = Math.max(encounterCountOf(cloudCard), encounterCountOf(localCard))
  const seen = Math.max(Number(cloudCard && cloudCard.lastSeenAt) || 0, Number(localCard && localCard.lastSeenAt) || 0)
  return seen ? { encounterCount: count, lastSeenAt: seen } : { encounterCount: count }
}

module.exports = {
  ENCOUNTER_INTIMACY,
  encounterCountOf,
  lastSeenOf,
  knownDaysOf,
  territoryOf,
  encounterSummary,
  mergeEncounterFields
}
