const api = require('../../services/api')
const cache = require('../../services/storage-cache')
const copy = require('../../constants/copy')
const { BACKGROUNDS, isUnlocked, getUnlockNeed } = require('../../constants/backgrounds')
const { COPY: outingCopy, DEBUG_FAST } = require('../../constants/outing')
const { mergeLayout, serializeLayout } = require('../../constants/furniture')
const { ACTION_LIST, toBars, DEFAULT_CARE, intimacyView } = require('../../services/care-engine')
const { cardDisplayName } = require('../../utils/format')
const { pickCardImage } = require('../../utils/card-media')
const { formatOutingPostcard } = require('../../utils/outing-postcard')
const { encounterSummary } = require('../../utils/encounters')
const { blurCoordinate, getCurrentPosition } = require('../../utils/geo-blur')
const nav = require('../../utils/navigate')
const pageLoad = require('../../utils/page-load')

const DEBUG_MOCK_CAT = {
  _id: 'debug_room_cat',
  breed: '中华田园猫',
  name: '小花',
  cutoutPath: '/assets/illus/cat-cutout-border.png',
  originalPath: '/assets/illus/mascot.jpg',
  memoryCount: 2
}

const { normalizeMateIds, resolveHomeCards, roomOccupancy, ROOM_CAPACITY } = require('../../utils/room-mates')

const MATE_SLOTS = [
  { x: 18, y: 58, facingLeft: false, scale: 0.9 },
  { x: 78, y: 56, facingLeft: true, scale: 0.9 }
]

function sceneGradient(bgId, backgrounds) {
  const hit = (backgrounds || []).find((b) => b.id === bgId) || BACKGROUNDS[0]
  const colors = (hit && hit.colors) || ['#f3e6d4', '#e8d4bc', '#d9b896']
  return `linear-gradient(180deg, ${colors[0]} 0%, ${colors[1] || colors[0]} 56%, ${colors[2] || colors[1] || colors[0]} 100%)`
}

/** 状态摘要：取最低一项，供收起态 chip 展示 */
function careHintFromBars(bars) {
  const list = bars || []
  if (!list.length) return { key: '', label: '状态', value: 0, color: '#2fd074' }
  let worst = list[0]
  list.forEach((b) => {
    if ((Number(b.value) || 0) < (Number(worst.value) || 0)) worst = b
  })
  return {
    key: worst.key || '',
    label: worst.label || '状态',
    value: Math.round(Number(worst.value) || 0),
    color: worst.color || '#2fd074'
  }
}

/** 小屋随机小事件：替代原来的四条护理属性，只图一乐，不影响数值 */
const ROOM_EVENTS = [
  '它在窗台上晒了一会儿太阳。',
  '它把小毛球拨到了沙发底下。',
  '它打了个大大的哈欠。',
  '它盯着窗外的小鸟看了好久。',
  '它把自己团成了一个圆。',
  '它在猫窝里踩了半天奶。',
  '它舔了舔爪子，又洗了把脸。',
  '它在地毯上打了个滚。'
]

function pickRoomEvent(cardId) {
  if (!cardId) return ''
  // 同一只猫一个小时内说同一件事，避免每次刷新都换
  const hour = Math.floor(Date.now() / 3600000)
  let h = hour
  for (let i = 0; i < cardId.length; i++) h = (h * 31 + cardId.charCodeAt(i)) % 100003
  return ROOM_EVENTS[h % ROOM_EVENTS.length]
}

Page({
  data: {
    changeBg: copy.buttons.changeBg,
    decorLabel: copy.buttons.decor,
    decorDone: copy.buttons.decorDone,
    currentBgId: 'default',
    sceneBg: sceneGradient('default'),
    displayImage: '',
    displayBreed: '',
    displayCardId: '',
    memoryCount: 0,
    showBgPanel: false,
    backgrounds: [],
    myCatStatus: 'none',
    outingPhase: 'none',
    unreadBadge: 0,
    visitor: null,
    leftTrace: null,
    outHint: outingCopy.outHint,
    leftPawText: outingCopy.leftPaw,
    btnPet: outingCopy.btnPet,
    btnFed: outingCopy.btnFed,
    btnPetted: outingCopy.btnPetted,
    btnFedDone: outingCopy.btnFedDone,
    btnOk: outingCopy.btnOk,
    leftTitle: outingCopy.leftTitle,
    showReport: false,
    report: null,
    reportAuto: false,
    showLeftModal: false,
    leftBody: '',
    leftBehavior: '',
    debugFast: DEBUG_FAST,
    debugForceHasCat: null,
    debugLabel: 'DEBUG 真实',
    showDebugUi: false,
    pageLoading: false,
    loadingText: copy.tips.pageLoading,
    ready: false,
    hasDisplay: false,
    statusBar: 20,
    navHeight: 32,
    navBarHeight: 64,
    navPad: 64,
    debugTop: 48,
    careBars: toBars(DEFAULT_CARE),
    careHint: careHintFromBars(toBars(DEFAULT_CARE)),
    intimacyText: '',
    intimacyValue: 0,
    showCareDetail: false,
    furniture: [],
    decorMode: false,
    dragId: '',
    showRing: false,
    showVisitorMenu: false,
    /** true：用户主动切到照顾面板，暂时不让明信片 / 来访占底部 */
    careFocus: false,
    ringActions: ACTION_LIST,
    catX: 38,
    catY: 52,
    catFacingLeft: false,
    catMoving: false,
    catMoveMs: 0,
    roomMates: [],
    roomMateHint: '',
    /** 当前互动目标（点哪只就是哪只，不必整页刷新换位） */
    careCardId: '',
    catAway: false,
    awayCatName: '',
    awayCatImage: '',
    outingCardId: ''
  },

  _furnStart: null,
  _furnDirty: false,
  _sceneRect: null,
  _catAiTimer: null,
  _catAiAlive: false,

  onLoad(query) {
    // 好友分享的「来我家串门」邀请：进页后接待它
    this._pendingInvite = (query && query.invite) || ''
    try {
      const win = (wx.getWindowInfo && wx.getWindowInfo()) || {}
      const menu = wx.getMenuButtonBoundingClientRect()
      const statusBar = win.statusBarHeight || 20
      const navHeight = menu.height || 32
      const navBarHeight = (menu.bottom || statusBar + navHeight) + 8
      const navPad = navBarHeight + 8
      const debugTop = menu.top || statusBar + 6
      this.setData({ statusBar, navHeight, navBarHeight, navPad, debugTop })
    } catch (e) {
      /* keep defaults */
    }
  },

  onUnload() {
    this.__mxhUnloaded = true
    this._stopCatAi()
    if (this._furnDirty) this._persistFurniture()
  },

  onHide() {
    this._stopCatAi()
    if (this._furnDirty) this._persistFurniture()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    if (this.data.debugForceHasCat === false) {
      this.setData({ debugForceHasCat: null, debugLabel: this.debugLabelOf(null) })
    }
    this.refresh()
    if (this._pendingInvite) this._acceptInvite()
  },

  async _acceptInvite() {
    const inviteId = this._pendingInvite
    this._pendingInvite = ''
    try {
      const res = await api.acceptVisitInvite(inviteId)
      if (res && res.toast) wx.showToast({ title: res.toast, icon: 'none' })
      this.refresh()
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '没接到好友的猫', icon: 'none' })
    }
  },

  /** 分享明信片 / 邀请好友来看小屋 */
  onShareAppMessage(e) {
    const kind = e && e.target && e.target.dataset && e.target.dataset.kind
    const report = this.data.report
    if (kind === 'postcard' && report) {
      return {
        title: report.distanceLine || '我的猫出门回来，带回一张明信片',
        path: '/pages/home/home'
      }
    }
    return { title: '来看看我的猫咪小屋', path: '/pages/home/home' }
  },

  _stopCatAi() {
    this._catAiAlive = false
    if (this._catAiTimer) {
      clearTimeout(this._catAiTimer)
      this._catAiTimer = null
    }
    ;(this._mateAiTimers || []).forEach((t) => {
      if (t) clearTimeout(t)
    })
    this._mateAiTimers = []
    const patch = {}
    if (this.data.catMoving) {
      patch.catMoving = false
      patch.catMoveMs = 0
    }
    const mates = this.data.roomMates || []
    if (mates.some((m) => m && m.moving)) {
      patch.roomMates = mates.map((m) => ({
        ...m,
        moving: false,
        moveMs: 0
      }))
    }
    if (Object.keys(patch).length) this.setData(patch)
  },

  _syncCatAi() {
    const canRoam =
      !!this.data.hasDisplay &&
      this.data.myCatStatus !== 'away' &&
      !this.data.decorMode &&
      !this.__mxhUnloaded
    if (!canRoam) {
      this._stopCatAi()
      return
    }
    if (this._catAiAlive) return
    this._catAiAlive = true
    this._mateAiTimers = []
    this._scheduleCatAi(500 + Math.random() * 800)
    const mates = this.data.roomMates || []
    mates.forEach((_, index) => {
      this._scheduleMateAi(index, 300 + index * 650 + Math.random() * 900)
    })
  },

  _scheduleCatAi(delay) {
    if (!this._catAiAlive || this.__mxhUnloaded) return
    if (this._catAiTimer) clearTimeout(this._catAiTimer)
    const wait = delay != null ? delay : 1400 + Math.random() * 2800
    this._catAiTimer = setTimeout(() => this._catAiStep(), wait)
  },

  _scheduleMateAi(index, delay) {
    if (!this._catAiAlive || this.__mxhUnloaded) return
    if (!this._mateAiTimers) this._mateAiTimers = []
    if (this._mateAiTimers[index]) clearTimeout(this._mateAiTimers[index])
    const wait = delay != null ? delay : 1200 + Math.random() * 2400
    this._mateAiTimers[index] = setTimeout(() => this._mateAiStep(index), wait)
  },

  _pickWalkTarget(fromX, fromY, zone) {
    let targetX = zone.xMin + Math.random() * (zone.xMax - zone.xMin)
    let targetY = zone.yMin + Math.random() * (zone.yMax - zone.yMin)
    if (Math.abs(targetX - fromX) < 7) {
      targetX = fromX + (Math.random() < 0.5 ? -12 : 12)
      targetX = Math.max(zone.xMin, Math.min(zone.xMax, targetX))
    }
    const dist = Math.abs(targetX - fromX) + Math.abs(targetY - fromY) * 0.8
    const duration = Math.round(Math.min(4600, Math.max(1500, dist * 85)))
    return {
      x: Math.round(targetX * 10) / 10,
      y: Math.round(targetY * 10) / 10,
      facingLeft: targetX < fromX,
      duration
    }
  },

  _catAiStep() {
    this._catAiTimer = null
    if (!this._catAiAlive || this.__mxhUnloaded) return

    if (
      !this.data.hasDisplay ||
      this.data.myCatStatus === 'away' ||
      this.data.decorMode
    ) {
      this._stopCatAi()
      return
    }

    if (Math.random() < 0.22) {
      this.setData({ catMoving: false, catMoveMs: 0 })
      this._scheduleCatAi(1800 + Math.random() * 2200)
      return
    }

    const fromX = Number(this.data.catX) || 38
    const fromY = Number(this.data.catY) || 52
    const walk = this._pickWalkTarget(fromX, fromY, {
      xMin: 24,
      xMax: 70,
      yMin: 46,
      yMax: 56
    })

    this.setData({
      catFacingLeft: walk.facingLeft,
      catMoving: true,
      catMoveMs: walk.duration,
      catX: walk.x,
      catY: walk.y
    })

    this._catAiTimer = setTimeout(() => {
      this._catAiTimer = null
      if (!this._catAiAlive || this.__mxhUnloaded) return
      this.setData({ catMoving: false, catMoveMs: 0 })
      this._scheduleCatAi(800 + Math.random() * 2000)
    }, walk.duration + 60)
  },

  _mateAiStep(index) {
    if (this._mateAiTimers) this._mateAiTimers[index] = null
    if (!this._catAiAlive || this.__mxhUnloaded) return

    if (
      !this.data.hasDisplay ||
      this.data.myCatStatus === 'away' ||
      this.data.decorMode
    ) {
      return
    }

    const mates = (this.data.roomMates || []).slice()
    const mate = mates[index]
    if (!mate) return

    if (Math.random() < 0.26) {
      mates[index] = { ...mate, moving: false, moveMs: 0 }
      this.setData({ roomMates: mates })
      this._scheduleMateAi(index, 1600 + Math.random() * 2400)
      return
    }

    // 左右分区，减少三只叠在一起
    const zones = [
      { xMin: 12, xMax: 40, yMin: 52, yMax: 64 },
      { xMin: 58, xMax: 86, yMin: 50, yMax: 63 }
    ]
    const zone = zones[index] || zones[0]
    const walk = this._pickWalkTarget(Number(mate.x) || zone.xMin + 8, Number(mate.y) || 58, zone)

    mates[index] = {
      ...mate,
      x: walk.x,
      y: walk.y,
      facingLeft: walk.facingLeft,
      moving: true,
      moveMs: walk.duration
    }
    this.setData({ roomMates: mates })

    this._mateAiTimers[index] = setTimeout(() => {
      if (this._mateAiTimers) this._mateAiTimers[index] = null
      if (!this._catAiAlive || this.__mxhUnloaded) return
      const list = (this.data.roomMates || []).slice()
      if (!list[index]) return
      list[index] = { ...list[index], moving: false, moveMs: 0 }
      this.setData({ roomMates: list })
      this._scheduleMateAi(index, 700 + Math.random() * 2000)
    }, walk.duration + 60)
  },


  noop() {},

  onPetImgError() {
    // 临时抠图路径失效时清空，避免 127.0.0.1/__tmp__ 刷屏
    if (this.data.displayImage) this.setData({ displayImage: '' })
  },

  debugLabelOf(force) {
    if (force === true) return 'DEBUG 有猫'
    if (force === false) return 'DEBUG 无猫'
    return 'DEBUG 真实'
  },

  refresh() {
    return pageLoad.run(this, () => this._refreshInner())
  },

  applyDisplayCard(displayCard) {
    if (!displayCard) {
      return {
        displayImage: '',
        displayBreed: '',
        displayCardId: '',
        memoryCount: 0,
        intimacyText: '',
        intimacyValue: 0,
        hasDisplay: false
      }
    }
    const bond = intimacyView(displayCard)
    return {
      displayImage: pickCardImage(displayCard),
      displayBreed: cardDisplayName({
        ...displayCard,
        name: cache.getCardName(displayCard._id, displayCard.name || '')
      }),
      displayCardId: displayCard._id,
      memoryCount: displayCard.memoryCount || 0,
      intimacyText: bond.text,
      intimacyValue: bond.value,
      hasDisplay: true
    }
  },

  /** 小屋其余同住猫（与焦点猫地位相同，最多另 2 只） */
  buildRoomMates(cards, displayCard, mateIds) {
    if (!displayCard) return { roomMates: [], roomMateHint: '' }
    const mainId = displayCard._id
    const ids = normalizeMateIds(mateIds, mainId)
    const byId = {}
    ;(cards || []).forEach((c) => {
      if (c && c._id) byId[c._id] = c
    })
    const mates = []
    ids.forEach((id, i) => {
      const src = byId[id]
      if (!src) return
      const slot = MATE_SLOTS[i] || MATE_SLOTS[MATE_SLOTS.length - 1]
      const named = {
        ...src,
        name: cache.getCardName(src._id, src.name || '')
      }
      mates.push({
        id: src._id,
        image: pickCardImage(src) || '',
        name: cardDisplayName(named),
        preview: false,
        x: slot.x,
        y: slot.y,
        facingLeft: slot.facingLeft,
        scale: slot.scale,
        moving: false,
        moveMs: 0
      })
    })
    const count = 1 + mates.length
    return {
      roomMates: mates,
      roomMateHint: count > 1 ? `小屋 ${count}/${ROOM_CAPACITY} · 点哪只就和哪只玩` : ''
    }
  },

  /** 外出猫不进场景；其余猫照常展示 */
  buildHomeScene(cards, user, outingCardId, preferredDisplay) {
    const { displayCard, mateIds } = resolveHomeCards(user, cards, outingCardId, preferredDisplay)
    const matePatch = this.buildRoomMates(cards || [], displayCard, mateIds)
    if (displayCard && outingCardId) {
      const homeCount = 1 + matePatch.roomMates.length
      matePatch.roomMateHint =
        homeCount > 1
          ? `小屋 ${homeCount}/${ROOM_CAPACITY} · 有小猫外出中`
          : homeCount === 1
            ? '有小猫外出中'
            : ''
    }
    return {
      displayCard,
      ...this.applyDisplayCard(displayCard),
      ...matePatch
    }
  },

  onAwayTap() {
    wx.showToast({ title: outingCopy.outTap, icon: 'none' })
  },


  outHintOf(phase) {
    if (phase === 'visiting') return outingCopy.outVisiting
    return outingCopy.outHint
  },

  async _refreshInner() {
    const force = this.data.debugForceHasCat
    const [{ cards }, room] = await Promise.all([api.listCards({}), api.getRoomState()])
    const user = room.user || {}
    // 背景按「一共遇见几次」解锁：真实再遇见同一只猫也算
    const encounterTotal = encounterSummary(cards || []).encounterTotal
    const currentBgId = user.roomBackgroundId || 'default'
    const backgrounds = BACKGROUNDS.map((b) => {
      const unlocked = isUnlocked(b, encounterTotal)
      const need = getUnlockNeed(b, encounterTotal)
      return {
        ...b,
        unlocked,
        need,
        lockText: unlocked
          ? ''
          : copy.tips.unlockBgProgress
            ? copy.tips.unlockBgProgress(encounterTotal, b.unlockEncounters)
            : copy.tips.unlockBg(need),
        preview: `linear-gradient(160deg, ${b.colors.join(',')})`
      }
    })
    const sceneBg = sceneGradient(currentBgId, backgrounds)
    const furniture = mergeLayout(room.furniture || user.roomFurniture)
    const careBars = room.careBars || toBars(room.care || user.care || DEFAULT_CARE)
    const careHint = careHintFromBars(careBars)

    if (force === false) {
      this.setData(
        {
          currentBgId,
          backgrounds,
          sceneBg,
          furniture,
          careBars,
          careHint,
          ...this.applyDisplayCard(null),
          roomMates: [],
          roomMateHint: '',
          myCatStatus: 'none',
          outingPhase: 'none',
          catAway: false,
          awayCatName: '',
          awayCatImage: '',
          outingCardId: '',
          unreadBadge: 0,
          visitor: null,
          leftTrace: null,
          showRing: false,
          showVisitorMenu: false,
          showCareDetail: false,
          debugLabel: this.debugLabelOf(force),
          ready: true
        },
        () => this._syncCatAi()
      )
      return
    }

    if (force === true) {
      let displayCard = room.displayCard
      if (!displayCard) {
        const withCutout = (cards || []).find((c) => c.cutoutPath)
        displayCard = withCutout || DEBUG_MOCK_CAT
      }
      const mateIds =
        (room.user && room.user.roomMateIds) ||
        (user && user.roomMateIds) ||
        []
      const matePatch = this.buildRoomMates(cards || [displayCard], displayCard, mateIds)
      this.setData(
        {
          currentBgId,
          backgrounds,
          sceneBg,
          furniture,
          careBars,
          careHint,
          ...this.applyDisplayCard(displayCard),
          ...matePatch,
          myCatStatus: 'home',
          outingPhase: 'home',
          outHint: this.outHintOf('home'),
          catAway: false,
          awayCatName: '',
          awayCatImage: '',
          outingCardId: '',
          unreadBadge: 0,
          visitor: null,
          leftTrace: null,
          showRing: false,
          showVisitorMenu: false,
          showCareDetail: false,
          debugLabel: this.debugLabelOf(force),
          ready: true
        },
        () => this._syncCatAi()
      )
      return
    }

    let preferredDisplay = room.displayCard
    if (!preferredDisplay) {
      const id = (room.user && room.user.displayCardId) || ''
      preferredDisplay = id ? (cards || []).find((c) => c._id === id) || null : null
    }
    // 有猫却没展示位：自动用第一只，避免小屋被刷空
    if (!preferredDisplay && !roomOccupancy(user).count && (cards || []).length) {
      preferredDisplay = cards[0]
      try {
        await api.updateProfile({ displayCardId: preferredDisplay._id })
        user.displayCardId = preferredDisplay._id
      } catch (e) {
        console.warn('[room] auto set displayCard', e)
      }
    }

    const outingCardId =
      room.outingCardId ||
      (room.myCatStatus === 'away'
        ? (user.outing && user.outing.cardId) ||
          (preferredDisplay && preferredDisplay._id) ||
          ''
        : '')
    const homeScene = this.buildHomeScene(cards || [], user, outingCardId, preferredDisplay)
    const catAway = !!outingCardId
    const awayCard =
      (outingCardId && (cards || []).find((c) => c && c._id === outingCardId)) || null
    const awayCatName =
      room.outingCatName ||
      (awayCard
        ? cardDisplayName({
            ...awayCard,
            name: cache.getCardName(outingCardId, awayCard.name || '')
          })
        : outingCardId
          ? cardDisplayName({
              name: cache.getCardName(outingCardId, ''),
              breed: '小猫'
            })
          : '')
    const awayCatImage = awayCard ? pickCardImage(awayCard) || '' : ''
    // 场景里还有猫 → 可互动；仅外出标识单独展示
    const myCatStatus = homeScene.hasDisplay
      ? 'home'
      : catAway
        ? 'away'
        : preferredDisplay
          ? 'home'
          : room.myCatStatus || 'none'
    const outingPhase =
      room.outingPhase || (catAway ? 'out' : myCatStatus === 'home' ? 'home' : 'none')

    const patch = {
      currentBgId,
      backgrounds,
      sceneBg,
      furniture,
      careBars,
      careHint,
      ...homeScene,
      myCatStatus,
      outingPhase,
      outHint: this.outHintOf(outingPhase),
      catAway,
      awayCatName: awayCatName || '小猫',
      awayCatImage,
      outingCardId,
      unreadBadge: room.unreadBadge || 0,
      visitor: room.visitor,
      leftTrace: room.leftTrace,
      debugLabel: this.debugLabelOf(force),
      ready: true
    }

    patch.roomEvent = pickRoomEvent(patch.displayCardId || '')

    // 来了新访客或新明信片时，底部面板重新让它当主角
    const focusKey = `${room.unreadBadge ? 'r' : ''}|${(room.visitor && room.visitor.id) || ''}`
    if (focusKey !== this._focusKey) {
      this._focusKey = focusKey
      patch.careFocus = false
    }

    if (room.autoShowReport && room.unreadReport && !this.data.showReport) {
      patch.showReport = true
      patch.report = { ...room.unreadReport, postcard: formatOutingPostcard(room.unreadReport) }
      patch.reportAuto = true
    } else if (!this.data.showReport) {
      patch.report = room.unreadReport && { ...room.unreadReport, postcard: formatOutingPostcard(room.unreadReport) }
    }

    this.setData(patch, () => this._syncCatAi())
  },

  onToggleDebugUi() {
    const next = !this.data.showDebugUi
    this.setData({ showDebugUi: next })
    if (next) wx.showToast({ title: '已打开调试', icon: 'none' })
  },

  onToggleDebug() {
    const cur = this.data.debugForceHasCat
    let next = null
    if (cur === null) next = true
    else if (cur === true) next = false
    else next = null

    this.setData(
      {
        debugForceHasCat: next,
        debugLabel: this.debugLabelOf(next)
      },
      () => this.refresh()
    )
  },

  onGoAlbum() {
    nav.switchTab(this, '/pages/album/album')
  },

  onToggleCareDetail() {
    this.setData({ showCareDetail: !this.data.showCareDetail })
  },

  /** 底部面板：从明信片 / 来访切到照顾 */
  onFocusCare() {
    this.setData({ careFocus: true })
  },

  /** 底部面板：从照顾切回明信片 / 来访 */
  onFocusEvent() {
    this.setData({ careFocus: false, showRing: false, showCareDetail: false })
  },

  onSceneTap() {
    if (this.data.decorMode) return
    if (this.data.showRing || this.data.showVisitorMenu || this.data.showCareDetail) {
      this.setData({ showRing: false, showVisitorMenu: false, showCareDetail: false })
    }
  },

  onPet() {
    if (this.data.decorMode) return
    if (!this.data.hasDisplay || !this.data.displayCardId) {
      if (this.data.catAway) {
        wx.showToast({ title: outingCopy.outTap, icon: 'none' })
        return
      }
      wx.showToast({ title: copy.tips.noDisplayCat, icon: 'none' })
      return
    }
    const open = !this.data.showRing || this.data.careCardId !== this.data.displayCardId
    this.setData({
      careCardId: this.data.displayCardId,
      showRing: open,
      showVisitorMenu: false,
      showCareDetail: false
    })
  },

  onMateTap(e) {
    if (this.data.decorMode) return
    const id = e.currentTarget.dataset.id
    if (!id) return
    if (this.data.outingCardId && id === this.data.outingCardId) {
      wx.showToast({ title: outingCopy.outTap, icon: 'none' })
      return
    }
    // 本地立刻打开互动，不 refresh / 不换位，避免闪一下
    const open = !this.data.showRing || this.data.careCardId !== id
    this.setData({
      careCardId: id,
      showRing: open,
      showVisitorMenu: false,
      showCareDetail: false
    })
  },

  async onCareAction(e) {
    const action = e.currentTarget.dataset.action
    if (!action) return
    const cardId = this.data.careCardId || this.data.displayCardId
    try {
      const res = await api.careCat({ action, cardId })
      const careBars = res.careBars || toBars(res.care)
      const bond = res.intimacy || intimacyView(res.intimacyPatch)
      const patch = {
        careBars,
        careHint: careHintFromBars(careBars),
        showRing: false
      }
      // 只在护理的是当前画面焦点猫时更新头顶亲密度文案
      if (bond && bond.text && (!cardId || cardId === this.data.displayCardId)) {
        patch.intimacyText = bond.text
        patch.intimacyValue = bond.value
      }
      this.setData(patch)
      if (res.toast) wx.showToast({ title: res.toast, icon: 'none' })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '稍后再试', icon: 'none' })
    }
  },

  onCloseVisitorMenu() {
    this.setData({ showVisitorMenu: false })
  },

  onOpenProfile() {
    const id = this.data.careCardId || this.data.displayCardId
    this.setData({ showRing: false })
    if (!id) return
    if (String(id).indexOf('debug_') === 0) {
      wx.showToast({ title: '调试猫，无详情', icon: 'none' })
      return
    }
    nav.navigateTo(this, `/pages/card-detail/card-detail?id=${id}`)
  },

  onVisitorTap() {
    if (this.data.decorMode || !this.data.visitor) return
    this.setData({
      showVisitorMenu: !this.data.showVisitorMenu,
      showRing: false
    })
  },

  onOpenReport() {
    if (!this.data.report && !this.data.unreadBadge) return
    api.getRoomState().then((room) => {
      if (!room.unreadReport) {
        this.refresh()
        return
      }
      this.setData({
        showReport: true,
        report: { ...room.unreadReport, postcard: formatOutingPostcard(room.unreadReport) },
        reportAuto: false
      })
    })
  },

  async onDismissReport() {
    const auto = !!this.data.reportAuto
    await api.dismissReport({ auto })
    this.setData({ showReport: false, report: null, reportAuto: false, unreadBadge: 0 })
    this.refresh()
  },

  onLeftTrace() {
    const t = this.data.leftTrace
    if (!t) return
    this.setData({
      showLeftModal: true,
      leftBody: outingCopy.leftBody(t.distanceLabel, t.breed),
      leftBehavior: t.behaviorText || ''
    })
  },

  async onDismissLeft() {
    const id = this.data.leftTrace && this.data.leftTrace.id
    if (id) await api.dismissLeftTrace({ visitId: id })
    this.setData({ showLeftModal: false, leftTrace: null })
    this.refresh()
  },

  async onInteract(e) {
    const action = e.currentTarget.dataset.action
    const visitor = this.data.visitor
    if (!visitor || this._visitorBusy) return
    this._visitorBusy = true
    try {
      const res = await api.interactVisitor({ visitId: visitor.id, action, source: visitor.source })
      if (!this.data.visitor || this.data.visitor.id !== visitor.id) return
      const next = { ...this.data.visitor }
      if (action === 'pet') next.petByHost = true
      if (action === 'feed') next.fedByHost = true
      this.setData({ visitor: next })
      if (res && res.toast) wx.showToast({ title: res.toast, icon: 'none' })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '稍后再试', icon: 'none' })
    } finally {
      this._visitorBusy = false
    }
  },

  onAdoptVisitor() {
    const visitor = this.data.visitor
    if (!visitor || !visitor.canAdopt || this._visitorBusy) return
    wx.showModal({
      title: '收下它的卡片？',
      content: '收下后这张卡片会进入你的图鉴，原来的主人那边会显示「卡片已被收下」。会尝试记下地点，不开定位也能收下。',
      confirmText: '收下',
      success: async (res) => {
        if (!res.confirm || this._visitorBusy) return
        this._visitorBusy = true
        wx.showLoading({ title: '收下中…', mask: true })
        try {
          // 定位可选：拿不到就先收下，之后在足迹页补地点
          const loc = await getCurrentPosition()
          const geo = loc ? blurCoordinate(loc.latitude, loc.longitude) : null
          const out = await api.adoptVisitor({
            visitId: visitor.id,
            source: visitor.source,
            geo,
            placeText: '我家门口'
          })
          wx.hideLoading()
          wx.showToast({ title: (out && out.toast) || '已收下', icon: 'none' })
          this.setData({ showVisitorMenu: false })
          this.refresh()
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: (err && err.message) || '没收成，请重试', icon: 'none' })
        } finally {
          this._visitorBusy = false
        }
      }
    })
  },

  onFrame() {
    if (!this.data.displayCardId) {
      wx.showToast({
        title: this.data.catAway ? outingCopy.outTap : copy.tips.frameNeedCat,
        icon: 'none'
      })
      return
    }
    if (String(this.data.displayCardId).indexOf('debug_') === 0) {
      wx.showToast({ title: '调试猫，无记忆角', icon: 'none' })
      return
    }
    nav.navigateTo(this, `/pages/memory/memory?id=${this.data.displayCardId}`)
  },

  onVisitLog() {
    nav.navigateTo(this, '/pages/visit-log/visit-log')
  },

  onChangeBg() {
    this.setData({
      showBgPanel: true,
      showRing: false,
      showVisitorMenu: false,
      showCareDetail: false
    })
  },

  closeBg() {
    this.setData({ showBgPanel: false })
  },

  async onPickBg(e) {
    const { id, unlocked, need } = e.currentTarget.dataset
    if (!unlocked) {
      const bg = (this.data.backgrounds || []).find((b) => b.id === id)
      wx.showToast({
        title: (bg && bg.lockText) || copy.tips.unlockBg(need),
        icon: 'none'
      })
      return
    }
    await api.updateProfile({ roomBackgroundId: id })
    this.setData({
      showBgPanel: false,
      currentBgId: id,
      sceneBg: sceneGradient(id, this.data.backgrounds)
    })
    wx.showToast({ title: copy.tips.switchBgOk, icon: 'none' })
  },

  async onToggleDecor() {
    const next = !this.data.decorMode
    if (!next && this._furnDirty) {
      this._persistFurniture()
    }
    this.setData(
      {
        decorMode: next,
        showRing: false,
        showVisitorMenu: false,
        showCareDetail: false,
        dragId: ''
      },
      () => this._syncCatAi()
    )
    if (next) {
      await this._measureScene()
      wx.showToast({ title: '拖一拖摆位置', icon: 'none' })
    }
  },

  _measureScene() {
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this)
        .select('.scene')
        .boundingClientRect((rect) => {
          this._sceneRect = rect || null
          resolve(rect)
        })
        .exec()
    })
  },

  onFurnTap(e) {
    if (!this.data.decorMode) return
    // 轻点未摆放的家具 → 摆上；已摆放则留给拖拽
    const id = e.currentTarget.dataset.id
    const item = (this.data.furniture || []).find((f) => f.id === id)
    if (!item || item.placed) return
    const furniture = (this.data.furniture || []).map((f) =>
      f.id === id ? { ...f, placed: true } : f
    )
    this._furnDirty = true
    this.setData({ furniture })
    wx.showToast({ title: `已摆上${item.name || ''}`, icon: 'none' })
  },

  async onFurnStart(e) {
    if (!this.data.decorMode) return
    const id = e.currentTarget.dataset.id
    const touch = e.touches && e.touches[0]
    if (!id || !touch) return
    const item = (this.data.furniture || []).find((f) => f.id === id)
    if (!item || !item.placed) return
    if (!this._sceneRect) await this._measureScene()
    this._furnStart = {
      id,
      x0: item.x || 0,
      y0: item.y || 0,
      tx: touch.clientX,
      ty: touch.clientY
    }
    this.setData({ dragId: id })
  },

  onFurnMove(e) {
    if (!this.data.decorMode || !this._furnStart) return
    const touch = e.touches && e.touches[0]
    const rect = this._sceneRect
    if (!touch || !rect || !rect.width || !rect.height) return
    const dx = ((touch.clientX - this._furnStart.tx) / rect.width) * 100
    const dy = ((touch.clientY - this._furnStart.ty) / rect.height) * 100
    let x = this._furnStart.x0 + dx
    let y = this._furnStart.y0 + dy
    x = Math.max(2, Math.min(88, x))
    y = Math.max(4, Math.min(78, y))
    const furniture = (this.data.furniture || []).map((f) =>
      f.id === this._furnStart.id ? { ...f, x, y } : f
    )
    this._furnDirty = true
    this.setData({ furniture })
  },

  onFurnEnd() {
    this._furnStart = null
    this.setData({ dragId: '' })
  },

  async _persistFurniture() {
    const furniture = serializeLayout(this.data.furniture)
    this._furnDirty = false
    try {
      await api.saveRoomFurniture({ furniture })
    } catch (e) {
      console.warn('[room] save furniture fail', e)
    }
  },

  async onDebugAdvance() {
    await api.debugAdvanceOuting()
    wx.showToast({ title: '已推进阶段', icon: 'none' })
    this.refresh()
  }
})
