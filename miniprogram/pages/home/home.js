const api = require('../../services/api')
const cache = require('../../services/storage-cache')
const copy = require('../../constants/copy')
const { formatDateShort } = require('../../utils/format')
const { pickCardImage } = require('../../utils/card-media')
const nav = require('../../utils/navigate')

Page({
  data: {
    statusBar: 20,
    navHeight: 32,
    emptyMain: copy.empty.homeMain,
    emptySub: copy.empty.homeSub,
    privacyTitle: copy.modals.privacyTitle,
    privacyBody: copy.modals.privacyBody,
    recent: [],
    recentCount: 0,
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
    if (showPrivacy !== this.data.showPrivacy) {
      this.setData({ showPrivacy })
    }
    this.loadRecent()
  },

  noop() {},

  onAgreePrivacy() {
    cache.setPrivacyAgreed()
    api.updateProfile({ privacyAgreedAt: Date.now() }).catch(() => {})
    getApp().globalData.privacyAgreed = true
    this.setData({ showPrivacy: false })
  },

  async loadRecent() {
    try {
      const res = await api.listCards({ limit: 20 })
      const all = res.cards || []
      const recent = all.slice(0, 3).map((c) => ({
        ...c,
        displayImage: pickCardImage(c),
        dateLabel: formatDateShort(c.shotAt)
      }))
      this.setData({ recent, recentCount: all.length })
      if (res.fromCache) {
        wx.showToast({ title: copy.tips.networkCache, icon: 'none' })
      }
    } catch (e) {
      const cards = cache.getCachedCards()
      this.setData({
        recent: cards.slice(0, 3).map((c) => ({
          ...c,
          displayImage: pickCardImage(c),
          dateLabel: formatDateShort(c.shotAt)
        })),
        recentCount: cards.length
      })
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
    const id = e.detail.cardId
    if (!id) return
    nav.navigateTo(this, `/pages/card-detail/card-detail?id=${id}`)
  }
})
