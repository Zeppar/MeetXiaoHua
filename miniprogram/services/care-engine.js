/**
 * 小屋弱状态：心情 / 干净 / 精力
 * 离线慢掉，互动补一补；不做繁殖/猫展。
 */

const DEFAULT_CARE = {
  mood: 78,
  clean: 72,
  energy: 70,
  updatedAt: 0
}

/** 每小时衰减量（百分制） */
const DECAY_PER_HOUR = {
  mood: 1.4,
  clean: 0.9,
  energy: 1.1
}

const ACTIONS = {
  pet: {
    label: '摸头',
    icon: '🤚',
    delta: { mood: 9, clean: 2, energy: -1 },
    toast: '呼噜呼噜～'
  },
  feed: {
    label: '喂食',
    icon: '🐟',
    delta: { mood: 7, clean: -3, energy: 11 },
    toast: '吃得香香的'
  },
  play: {
    label: '玩耍',
    icon: '🧶',
    delta: { mood: 12, clean: -7, energy: -15 },
    toast: '玩得好开心！'
  },
  sleep: {
    label: '哄睡',
    icon: '🌙',
    delta: { mood: 4, clean: 5, energy: 18 },
    toast: '睡着了…zZZ'
  }
}

const ACTION_LIST = ['pet', 'feed', 'play', 'sleep'].map((id) => ({
  id,
  ...ACTIONS[id]
}))

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)))
}

function normalizeCare(raw) {
  const base = Object.assign({}, DEFAULT_CARE, raw || {})
  return {
    mood: clamp(base.mood),
    clean: clamp(base.clean),
    energy: clamp(base.energy),
    updatedAt: Number(base.updatedAt) || 0
  }
}

/** 按离线时长衰减 */
function applyDecay(care, now = Date.now()) {
  const c = normalizeCare(care)
  if (!c.updatedAt) {
    c.updatedAt = now
    return c
  }
  const hours = Math.max(0, (now - c.updatedAt) / (60 * 60 * 1000))
  if (hours < 0.02) return c
  return {
    mood: clamp(c.mood - DECAY_PER_HOUR.mood * hours),
    clean: clamp(c.clean - DECAY_PER_HOUR.clean * hours),
    energy: clamp(c.energy - DECAY_PER_HOUR.energy * hours),
    updatedAt: now
  }
}

function applyAction(care, actionId, now = Date.now()) {
  const def = ACTIONS[actionId]
  if (!def) return { care: applyDecay(care, now), toast: '' }
  const c = applyDecay(care, now)
  const next = {
    mood: clamp(c.mood + (def.delta.mood || 0)),
    clean: clamp(c.clean + (def.delta.clean || 0)),
    energy: clamp(c.energy + (def.delta.energy || 0)),
    updatedAt: now
  }
  return { care: next, toast: def.toast }
}

/** 回家小补：出门回来心情/精力略回升 */
function applyHomecomingBonus(care, now = Date.now()) {
  const c = applyDecay(care, now)
  return {
    mood: clamp(c.mood + 6),
    clean: clamp(c.clean - 2),
    energy: clamp(c.energy + 8),
    updatedAt: now
  }
}

function toBars(care) {
  const c = normalizeCare(care)
  return [
    { key: 'mood', label: '心情', value: c.mood, color: '#f0a050' },
    { key: 'clean', label: '干净', value: c.clean, color: '#5ec8e8' },
    { key: 'energy', label: '精力', value: c.energy, color: '#2fd074' }
  ]
}

/** 亲密度：挂在每只猫卡上，互动慢慢涨，不随护理衰减 */
const INTIMACY_GAIN = {
  pet: 3,
  feed: 4,
  play: 5,
  sleep: 2
}
const DAILY_INTIMACY_CAP = 28

function dayKey(now = Date.now()) {
  const d = new Date(now)
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${d.getFullYear()}-${m < 10 ? '0' + m : m}-${day < 10 ? '0' + day : day}`
}

function normalizeIntimacy(n) {
  return clamp(Number(n) || 0)
}

function intimacyLabel(n) {
  const v = normalizeIntimacy(n)
  if (v >= 80) return '家人'
  if (v >= 55) return '信赖'
  if (v >= 30) return '熟悉'
  if (v >= 10) return '认识'
  return '初识'
}

function intimacyView(cardOrValue) {
  const value =
    cardOrValue && typeof cardOrValue === 'object'
      ? normalizeIntimacy(cardOrValue.intimacy)
      : normalizeIntimacy(cardOrValue)
  return {
    value,
    label: intimacyLabel(value),
    text: `${intimacyLabel(value)} ${value}`
  }
}

/**
 * 对展示猫互动后涨亲密度（有每日软上限）
 * @returns {{ intimacy:number, intimacyDay:string, intimacyGainedToday:number, gained:number }}
 */
function applyIntimacyGain(card, actionId, now = Date.now()) {
  const gainRaw = INTIMACY_GAIN[actionId] || 0
  const today = dayKey(now)
  let intimacy = normalizeIntimacy(card && card.intimacy)
  let day = (card && card.intimacyDay) || ''
  let gainedToday = Number(card && card.intimacyGainedToday) || 0
  if (day !== today) {
    day = today
    gainedToday = 0
  }
  if (!gainRaw || gainedToday >= DAILY_INTIMACY_CAP) {
    return {
      intimacy,
      intimacyDay: day,
      intimacyGainedToday: gainedToday,
      gained: 0
    }
  }
  const room = Math.max(0, DAILY_INTIMACY_CAP - gainedToday)
  const gained = Math.min(gainRaw, room, 100 - intimacy)
  intimacy = normalizeIntimacy(intimacy + gained)
  gainedToday += gained
  return {
    intimacy,
    intimacyDay: day,
    intimacyGainedToday: gainedToday,
    gained
  }
}

module.exports = {
  DEFAULT_CARE,
  ACTIONS,
  ACTION_LIST,
  INTIMACY_GAIN,
  DAILY_INTIMACY_CAP,
  normalizeCare,
  applyDecay,
  applyAction,
  applyHomecomingBonus,
  toBars,
  normalizeIntimacy,
  intimacyLabel,
  intimacyView,
  applyIntimacyGain
}
