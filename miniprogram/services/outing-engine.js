/**
 * 出门状态机纯逻辑（本地与云函数共用同一套规则思想）
 * 状态：home → out → visiting → returned(home + unreadReport)
 */
const {
  DURATIONS,
  randBetween,
  pickBehavior,
  randomDistanceKm,
  formatDistanceLabel,
  COPY
} = require('../constants/outing')

function defaultSettings() {
  return {
    allowMyCatOut: true,
    allowVisitors: true,
    showDistance: true
  }
}

function defaultOuting() {
  return {
    status: 'idle', // idle | home | out | visiting
    cardId: '',
    homeSince: 0,
    homeDuration: 0,
    leftAt: 0,
    travelDuration: 0,
    visitArriveAt: 0,
    visitDuration: 0,
    visitId: '',
    hostKey: '',
    distanceKm: 0,
    behaviorIndex: -1,
    behaviorText: '',
    lastBehaviorIndex: -1,
    pet: false,
    fed: false,
    unreadReport: null,
    lastAutoReportDay: ''
  }
}

function ensureUserOutingFields(user) {
  if (!user.settings) user.settings = defaultSettings()
  ;['allowMyCatOut', 'allowVisitors', 'showDistance'].forEach((k) => {
    if (user.settings[k] === undefined) user.settings[k] = true
  })
  if (!user.outing) user.outing = defaultOuting()
  if (!user.fedDate) user.fedDate = ''
  return user
}

function todayKey(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function buildReport(outing, breed, showDistance) {
  const distLabel = formatDistanceLabel(outing.distanceKm, showDistance)
  let interactLine = COPY.reportIdle
  if (outing.pet && outing.fed) interactLine = `${COPY.reportPet}${COPY.reportFed}`
  else if (outing.pet) interactLine = COPY.reportPet
  else if (outing.fed) interactLine = COPY.reportFed

  return {
    title: COPY.reportTitle,
    distanceLine: COPY.reportDistance(breed || '小猫', distLabel),
    behaviorLine: outing.behaviorText || '',
    interactLine,
    createdAt: Date.now()
  }
}

/**
 * 推进主人侧出门状态
 * @returns {{ changed: boolean, events: string[] }}
 */
function tickOwnerOuting(ctx) {
  const {
    user,
    now = Date.now(),
    getDisplayCard,
    createVisitToHost,
    onReturnHome
  } = ctx
  ensureUserOutingFields(user)
  const events = []
  let changed = false
  const settings = user.settings
  const outing = user.outing
  const displayCard = getDisplayCard()

  // 无展示猫或关闭出门：清空行程（保留未读报告）
  if (!displayCard || !settings.allowMyCatOut) {
    if (outing.status === 'out' || outing.status === 'visiting' || outing.status === 'home') {
      // 若正在外出，中止但不生成报告
      if (outing.status === 'out' || outing.status === 'visiting') {
        Object.assign(outing, {
          status: 'idle',
          cardId: '',
          visitId: '',
          hostKey: ''
        })
        changed = true
        events.push('abort_out')
      } else if (outing.status === 'home' && outing.cardId !== (displayCard && displayCard._id)) {
        outing.status = 'idle'
        outing.cardId = ''
        changed = true
      }
    }
    if (!displayCard) return { changed, events }
    if (!settings.allowMyCatOut) return { changed, events }
  }

  const cardId = displayCard._id

  // 展示位切换：重新开始在家计时
  if (outing.cardId && outing.cardId !== cardId && (outing.status === 'home' || outing.status === 'idle')) {
    outing.cardId = cardId
    outing.status = 'home'
    outing.homeSince = now
    outing.homeDuration = randBetween(DURATIONS.homeMin, DURATIONS.homeMax)
    changed = true
    events.push('reset_home_switch')
  }

  // 启动在家
  if (outing.status === 'idle' || !outing.cardId) {
    outing.status = 'home'
    outing.cardId = cardId
    outing.homeSince = now
    outing.homeDuration = randBetween(DURATIONS.homeMin, DURATIONS.homeMax)
    changed = true
    events.push('start_home')
  }

  // home → out
  if (outing.status === 'home' && now - outing.homeSince >= outing.homeDuration) {
    outing.status = 'out'
    outing.leftAt = now
    outing.travelDuration = randBetween(DURATIONS.travelMin, DURATIONS.travelMax)
    outing.pet = false
    outing.fed = false
    outing.visitId = ''
    outing.hostKey = ''
    changed = true
    events.push('leave_home')
  }

  // out → visiting
  if (outing.status === 'out' && now - outing.leftAt >= outing.travelDuration) {
    const picked = pickBehavior(outing.lastBehaviorIndex)
    outing.behaviorIndex = picked.index
    outing.behaviorText = picked.text
    outing.lastBehaviorIndex = picked.index
    outing.distanceKm = randomDistanceKm()
    outing.visitArriveAt = now
    outing.visitDuration = randBetween(DURATIONS.visitMin, DURATIONS.visitMax)
    outing.status = 'visiting'

    const visit = createVisitToHost({
      guestCard: displayCard,
      ownerOpenId: user._openid,
      behaviorText: outing.behaviorText,
      distanceKm: outing.distanceKm,
      arriveAt: now,
      leaveAt: now + outing.visitDuration
    })
    outing.visitId = visit && visit._id
    outing.hostKey = visit && visit.hostKey
    changed = true
    events.push('arrive_visit')
  }

  // visiting → return home + report
  if (outing.status === 'visiting' && now - outing.visitArriveAt >= outing.visitDuration) {
    const report = buildReport(outing, displayCard.breed, settings.showDistance)
    outing.unreadReport = report
    if (onReturnHome) {
      onReturnHome({
        cardId: outing.cardId,
        distanceKm: outing.distanceKm,
        behaviorText: outing.behaviorText,
        pet: outing.pet,
        fed: outing.fed,
        returnedAt: now,
        leftAt: outing.leftAt
      })
    }
    outing.status = 'home'
    outing.homeSince = now
    outing.homeDuration = randBetween(DURATIONS.homeMin, DURATIONS.homeMax)
    outing.visitId = ''
    outing.hostKey = ''
    changed = true
    events.push('return_home')
  }

  return { changed, events }
}

function applyOwnerInteractionFromVisit(user, visit) {
  ensureUserOutingFields(user)
  if (!user.outing || user.outing.visitId !== visit._id) return
  if (visit.petByHost) user.outing.pet = true
  if (visit.fedByHost) user.outing.fed = true
}

function shouldAutoShowReport(user, now = Date.now()) {
  ensureUserOutingFields(user)
  if (!user.outing.unreadReport) return false
  const day = todayKey(now)
  if (user.outing.lastAutoReportDay === day) return false
  return true
}

function markReportShown(user, { auto = false } = {}) {
  ensureUserOutingFields(user)
  user.outing.unreadReport = null
  if (auto) user.outing.lastAutoReportDay = todayKey()
}

module.exports = {
  defaultSettings,
  defaultOuting,
  ensureUserOutingFields,
  todayKey,
  buildReport,
  tickOwnerOuting,
  applyOwnerInteractionFromVisit,
  shouldAutoShowReport,
  markReportShown,
  COPY,
  formatDistanceLabel
}
