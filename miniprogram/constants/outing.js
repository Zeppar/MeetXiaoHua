/**
 * 猫猫出门 · 规则与文案
 * 调试按钮可手动推进阶段，正常计时始终使用真实小时
 */
const DEBUG_FAST = true
const HOUR_MS = 60 * 60 * 1000

const BEHAVIORS = [
  '它在你门口打了个滚。',
  '它盯着你的猫看了很久。',
  '它在你家窗台上睡了一觉。',
  '它绕着你的猫窝转了三圈。',
  '它在你家门口坐了一会儿，好像在等谁。',
  '它把你的猫粮碗闻了闻，又走开了。',
  '它在你家地板上踩了几个梅花印。',
  '它对着你的猫眨了眨眼。'
]

const COPY = {
  outHint: '它出门散步了，可能晚点回来。',
  outVisiting: '它正在拜访别的小屋…',
  outTap: '它还在外面呢，再等等吧。',
  visitorHere: '有小猫来串门啦',
  visitorTap: '点点它，打个招呼',
  reportTitle: '它回来了',
  // 品种还没认出来时别把「待识别」当名字
  reportDistance: (breed, distLabel) =>
    `你的${(['待识别', '识别中…', '未知小动物'].indexOf(breed) >= 0 ? '' : breed) || '小猫'}去了一趟「${distLabel}」`,
  reportPet: '有人摸了摸它。',
  reportFed: '有人给了它一颗猫粮。',
  reportIdle: '它在那里待了一会儿。',
  historyEmpty: '它还没有出过门，再等等吧。',
  visitorDist: (distLabel) => `来自 ${distLabel}`,
  toastPet: '你摸了摸它',
  toastFed: '你给了它一颗猫粮',
  leftPaw: '有一只猫来过，但已经走了。',
  leftTitle: '有猫来过',
  leftBody: (distLabel, breed) => `一只来自 ${distLabel}的${breed}来过你的小屋。`,
  btnPet: '摸摸它',
  btnFed: '给它一颗猫粮',
  btnPetted: '已摸过',
  btnFedDone: '已送过',
  btnOk: '知道了',
  farHouse: '远方的小屋',
  kmHouse: (km) => `${km} 千米外的小屋`,
  settingsOut: '允许我的猫出门散步',
  settingsVisit: '允许别人的猫来我的小屋串门',
  settingsDist: '在猫猫串门时显示大致距离',
  settingsDistTip: '距离为千米级模糊位置，不会显示精确坐标',
  historyEntry: (n) => `🐾 出门记录（${n}）`,
  historyTitle: '它的出门记录'
}

function randBetween(minH, maxH) {
  const min = minH * HOUR_MS
  const max = maxH * HOUR_MS
  return Math.floor(min + Math.random() * (max - min + 1))
}

function pickBehavior(lastIndex) {
  if (BEHAVIORS.length <= 1) return { index: 0, text: BEHAVIORS[0] }
  let index = Math.floor(Math.random() * BEHAVIORS.length)
  if (index === lastIndex) {
    index = (index + 1) % BEHAVIORS.length
  }
  return { index, text: BEHAVIORS[index] }
}

function formatDistanceLabel(km, showDistance) {
  if (!showDistance) return COPY.farHouse
  const v = Math.max(0.1, Number(km) || 0.1)
  return COPY.kmHouse(v.toFixed(1))
}

function randomDistanceKm() {
  // 0.5 ~ 8.0 km
  return Math.round((0.5 + Math.random() * 7.5) * 10) / 10
}

/** 根据双方模糊坐标估算千米距离；缺失则随机 */
function estimateDistanceKm(geoA, geoB) {
  if (!geoA || !geoB || typeof geoA.lat !== 'number' || typeof geoB.lat !== 'number') {
    return randomDistanceKm()
  }
  const toRad = (d) => (d * Math.PI) / 180
  const R = 6371
  const dLat = toRad(geoB.lat - geoA.lat)
  const dLng = toRad(geoB.lng - geoA.lng)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(geoA.lat)) * Math.cos(toRad(geoB.lat)) * Math.sin(dLng / 2) ** 2
  const km = 2 * R * Math.asin(Math.sqrt(a))
  const blurred = Math.round(Math.max(0.1, km) * 10) / 10
  return blurred
}

module.exports = {
  DEBUG_FAST,
  HOUR_MS,
  BEHAVIORS,
  COPY,
  randBetween,
  pickBehavior,
  formatDistanceLabel,
  randomDistanceKm,
  estimateDistanceKm,
  DURATIONS: {
    homeMin: 6,
    homeMax: 12,
    travelMin: 2,
    travelMax: 6,
    visitMin: 2,
    visitMax: 6
  }
}
