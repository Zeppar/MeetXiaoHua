const api = require('../../services/api')
const cache = require('../../services/storage-cache')
const copy = require('../../constants/copy')
const { formatDateShort, cardDisplayName } = require('../../utils/format')
const { pickCardImage } = require('../../utils/card-media')
const { encounterSummary } = require('../../utils/encounters')
const onboarding = require('../../utils/onboarding')
const { resolveHomeCards } = require('../../utils/room-mates')
const nav = require('../../utils/navigate')

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/** 按时段打招呼 */
function greetingOf(d = new Date()) {
  const h = d.getHours()
  if (h < 5) return { title: '夜深了', sub: '街角的猫也在打盹吧' }
  if (h < 11) return { title: '早上好', sub: '出门的路上，留意一下街角' }
  if (h < 14) return { title: '中午好', sub: '午饭后散散步，也许会遇见它' }
  if (h < 18) return { title: '下午好', sub: '阳光正好，猫咪最爱晒太阳' }
  return { title: '晚上好', sub: '路灯下，常有猫咪在等人' }
}

function todayLabel(d = new Date()) {
  return `${d.getMonth() + 1}月${d.getDate()}日 · 星期${WEEK[d.getDay()]}`
}

function toRecent(c) {
  return {
    _id: c._id,
    image: pickCardImage(c),
    name: cardDisplayName(c),
    dateLabel: formatDateShort(c.shotAt)
  }
}

/** 「我的猫现在」：在家 / 出门 / 还没有 */
function myCatOf(room, cards) {
  if (!room) return { status: 'none' }
  const user = room.user || {}
  const outingCardId = room.outingCardId || (room.myCatStatus === 'away' &&
    ((user.outing && user.outing.cardId) || user.displayCardId))
  const { displayCard } = resolveHomeCards(user, cards, outingCardId, room.displayCard)
  if (displayCard) {
    const name = cache.getCardName(displayCard._id, displayCard.name || '')
    return { status: 'home', name: cardDisplayName({ ...displayCard, name }), image: pickCardImage(displayCard) }
  }
  if (outingCardId || room.myCatStatus === 'away') {
    const card = cards.find((item) => item._id === outingCardId)
    return {
      status: 'away',
      name: room.outingCatName || (card ? cardDisplayName(card) : '小猫'),
      image: card ? pickCardImage(card) : '',
      visiting: room.outingPhase === 'visiting'
    }
  }
  return { status: 'none' }
}

Page({
  data: {
    statusBar: 20,
    navHeight: 32,
    greeting: greetingOf(),
    today: todayLabel(),
    emptyMain: copy.empty.homeMain,
    emptySub: copy.empty.homeSub,
    privacyTitle: copy.modals.privacyTitle,
    privacyBody: copy.modals.privacyBody,
    recent: [],
    recentCount: 0,
    encounterTotal: 0,
    /** 0 只猫：首屏只留「拍一只猫」 */
    isNewbie: false,
    roomUnlocked: false,
    myCat: { status: 'loading' },
    hasReport: false,
    visitor: null,
    leftTrace: null,
    showPrivacy: false,
    pageLoading: false,
    loadingText: copy.tips.pageLoading
  },

  onLoad() {
    const win = (wx.getWindowInfo && wx.getWindowInfo()) || {}
    const menu = wx.getMenuButtonBoundingClientRect()
    const statusBar = win.statusBarHeight || 20
    // 与小程序胶囊同排，作为自定义导航标题
    this.setData({
      statusBar: menu.top || statusBar,
      navHeight: menu.height || 32
    })
  },

  onUnload() {
    this.__mxhUnloaded = true
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    const showPrivacy = !cache.isPrivacyAgreed()
    // 先用缓存判断，避免老用户进首页闪一下新手页；真实数量回来后再校正
    const cachedCount = onboarding.cachedCardCount()
    this.setData({
      showPrivacy,
      greeting: greetingOf(),
      today: todayLabel(),
      isNewbie: cachedCount === 0 && !this._everHadCats,
      roomUnlocked: onboarding.isRoomUnlocked(cachedCount)
    })
    this.loadRoom(this.loadRecent())
  },

  noop() {},

  onAgreePrivacy() {
    cache.setPrivacyAgreed()
    api.updateProfile({ privacyAgreedAt: Date.now() }).catch(() => {})
    getApp().globalData.privacyAgreed = true
    this.setData({ showPrivacy: false })
  },

  applyCards(all) {
    if (all.length) this._everHadCats = true
    // 升级前就有很多猫的老用户：不弹「小屋解锁了」
    if (all.length > onboarding.ROOM_UNLOCK_CATS) onboarding.skipUnlockCelebration()
    const roomUnlocked = onboarding.isRoomUnlocked(all.length)
    this.setData({
      recent: all.slice(0, 8).map(toRecent),
      recentCount: all.length,
      encounterTotal: encounterSummary(all).encounterTotal,
      isNewbie: all.length === 0,
      roomUnlocked
    })
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tabBar && tabBar.refreshLock) tabBar.refreshLock(all.length)
    if (onboarding.takeUnlockCelebration(all.length)) {
      wx.showModal({
        title: '小屋解锁了',
        content: '你已经认识两只猫了，给它们一个家吧。它们会在小屋里玩，偶尔还会出门串门。',
        confirmText: '去看看',
        cancelText: '等会儿',
        success: (r) => {
          if (r.confirm) nav.switchTab(this, '/pages/room/room')
        }
      })
    }
  },

  async loadRecent() {
    try {
      const res = await api.listCards({ limit: 50 })
      this.applyCards(res.cards || [])
      if (res.fromCache) {
        wx.showToast({ title: copy.tips.networkCache, icon: 'none' })
      }
      return res.cards || []
    } catch (e) {
      const cards = cache.getCachedCards() || []
      this.applyCards(cards)
      return cards
    }
  },

  async loadRoom(cardsPromise) {
    const request = (this._roomRequest || 0) + 1
    this._roomRequest = request
    try {
      const [room, cards] = await Promise.all([api.getRoomState(), cardsPromise])
      if (this.__mxhUnloaded || this._roomRequest !== request) return
      const myCat = myCatOf(room, cards)
      this.setData({
        myCat,
        hasReport: !!(room && room.unreadReport),
        visitor: room && room.visitor ? { breed: room.visitor.breed, distanceLabel: room.visitor.distanceLabel } : null,
        leftTrace: room && !room.visitor && room.leftTrace ? { breed: room.leftTrace.breed, distanceLabel: room.leftTrace.distanceLabel } : null
      })
    } catch (e) {
      console.warn('[home] loadRoom fail', e)
      if (!this.__mxhUnloaded && this._roomRequest === request && this.data.myCat.status === 'loading') {
        this.setData({ myCat: { status: 'unavailable' } })
      }
    }
  },

  ensurePrivacy() {
    if (!cache.isPrivacyAgreed()) {
      this.setData({ showPrivacy: true })
      return false
    }
    return true
  },

  onMeet() {
    if (!this.ensurePrivacy()) return
    nav.navigateTo(this, '/pages/camera/camera')
  },

  /** 身边没有猫时，从相册挑一张也能拿到第一张贴纸 */
  onMeetFromAlbum() {
    if (!this.ensurePrivacy()) return
    nav.navigateTo(this, '/pages/camera/camera?source=album')
  },

  onAlbum() {
    nav.switchTab(this, '/pages/album/album')
  },

  onRoom() {
    nav.switchTab(this, '/pages/room/room')
  },

  onMap() {
    if (!this.ensurePrivacy()) return
    nav.navigateTo(this, '/pages/map/map')
  },

  onOuting() {
    nav.navigateTo(this, '/pages/visit-log/visit-log')
  },

  onOpenCard(e) {
    const id = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) || (e.detail && e.detail.cardId)
    if (!id) return
    nav.navigateTo(this, `/pages/card-detail/card-detail?id=${id}`)
  }
})
