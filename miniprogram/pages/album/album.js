const api = require('../../services/api')
const cache = require('../../services/storage-cache')
const copy = require('../../constants/copy')
const { CAT_BREEDS } = require('../../constants/breeds')
const { formatDateShort, cardDisplayName, isPlaceholderBreed } = require('../../utils/format')
const { pickCardImage } = require('../../utils/card-media')
const nav = require('../../utils/navigate')
const pageLoad = require('../../utils/page-load')
const { roomOccupancy } = require('../../utils/room-mates')

/** 图鉴收集进度：遇见过白名单里的几个猫品种 */
function collectionOf(cards) {
  const met = {}
  ;(cards || []).forEach((c) => {
    const b = c && String(c.breed || '').trim()
    if (b && CAT_BREEDS.indexOf(b) >= 0) met[b] = true
  })
  const have = Object.keys(met).length
  const total = CAT_BREEDS.length
  // 每个品种一个收集格：遇见过的亮名字，没遇见的放剪影
  const breeds = CAT_BREEDS.map((name) => ({ name, met: !!met[name] }))
  return { have, total, percent: Math.round((have / total) * 100), breeds }
}

/** 邮戳上的两行字：上「年份」，下「月.日」；没有拍摄时间就用 dateLabel */
function stampOf(c) {
  const d = c && c.shotAt ? new Date(c.shotAt) : null
  if (d && !Number.isNaN(d.getTime())) {
    const m = d.getMonth() + 1
    const day = d.getDate()
    return {
      stampK: String(d.getFullYear()),
      stampV: `${m < 10 ? '0' + m : m}.${day < 10 ? '0' + day : day}`
    }
  }
  return { stampK: '遇见', stampV: (c && c.dateLabel) || '某天' }
}

Page({
  data: {
    breedFilter: '',
    filters: [],
    cards: [],
    hasCats: false,
    collection: collectionOf([]),
    featuredId: '',
    featured: null,
    emptyTip: '暂无猫猫记录，去遇见一只吧',
    goFirst: '去找猫',
    pageLoading: false,
    loadingText: copy.tips.pageLoading,
    ready: false,
    showNameModal: false,
    editNameValue: '',
    nameTitle: copy.modals.nameTitle,
    namePlaceholder: copy.modals.namePlaceholder,
    nameMax: copy.limits.name,
    showBreedPicker: false,
    breedOptions: CAT_BREEDS.slice(),
    statusBar: 20,
    navHeight: 32,
    navBarHeight: 64,
    navPad: 64
  },

  onLoad() {
    try {
      const win = (wx.getWindowInfo && wx.getWindowInfo()) || {}
      const menu = wx.getMenuButtonBoundingClientRect()
      const statusBar = win.statusBarHeight || 20
      const navHeight = menu.height || 32
      const navBarHeight = (menu.bottom || statusBar + navHeight) + 8
      const navPad = navBarHeight + 8
      this.setData({ statusBar, navHeight, navBarHeight, navPad })
    } catch (e) {
      /* keep defaults */
    }
  },

  async resolveRoomUser() {
    const cached = cache.getCachedUser && cache.getCachedUser()
    if (cached && (cached.displayCardId || cached.roomMateIds)) return cached
    try {
      const res = await api.getProfile()
      return (res && res.user) || cached || {}
    } catch (e) {
      return cached || {}
    }
  },

  mapCard(c) {
    const name = cache.getCardName(c._id, c.name || '')
    const merged = { ...c, name }
    const displayImage = pickCardImage(merged)
    const hasFile = !!displayImage
    const occ = this._roomOcc
    const inRoom = !!(occ && occ.isInRoom && occ.isInRoom(c._id))
    const stamp = stampOf({ shotAt: c.shotAt, dateLabel: c.dateLabel || formatDateShort(c.shotAt) })
    return {
      ...merged,
      stampK: stamp.stampK,
      stampV: stamp.stampV,
      stickerImage: displayImage,
      isSticker: !!(c.cutoutFileId || (c.cutoutPath && displayImage)),
      displayImage,
      dateLabel: c.dateLabel || formatDateShort(c.shotAt),
      // 旧数据里把提示语「已记录当前位置」当成了地名，展示时去掉
      placeText: c.placeText === '已记录当前位置' ? '' : c.placeText || '',
      displayName: cardDisplayName(merged),
      hasName: !!String(merged.name || '').trim(),
      breedUnknown: isPlaceholderBreed(merged.breed),
      _hasMedia: hasFile,
      needMedia: !hasFile,
      breedPending: c.breedReviewStatus === 'pending' || !!c.pendingBreed,
      pendingBreed: c.pendingBreed || '',
      inRoom,
      isRoomMain: false,
      roomBadge: inRoom ? '在小屋' : ''
    }
  },

  pickFeatured(cards, preferredId) {
    if (!cards.length) return { featuredId: '', featured: null }
    const hit = preferredId && cards.find((c) => c._id === preferredId)
    if (hit) return { featuredId: hit._id, featured: hit }
    const inRoom = cards.find((c) => c.inRoom)
    if (inRoom) return { featuredId: inRoom._id, featured: inRoom }
    // 默认优先挑有抠图白边的那只
    const sticker = cards.find((c) => c.stickerImage)
    const featured = sticker || cards[0]
    return { featuredId: featured._id, featured }
  },

  noop() {},

  /** 临时图 127.0.0.1/__tmp__ 过期时清掉，避免渲染层刷屏 */
  onMediaError(e) {
    const id = e.currentTarget.dataset.id
    const field = e.currentTarget.dataset.field
    if (field === 'featured' && this.data.featured && this.data.featured._id === id) {
      this.setData({
        'featured.stickerImage': '',
        'featured.displayImage': '',
        'featured._hasMedia': false
      })
    }
    if (field === 'grid' && id) {
      const cards = (this.data.cards || []).map((c) =>
        c._id === id ? { ...c, displayImage: '', stickerImage: '', _hasMedia: false } : c
      )
      this.setData({ cards })
    }
  },

  onUnload() {
    this.__mxhUnloaded = true
    this.setTabBarHidden(false)
  },

  onHide() {
    this.setTabBarHidden(false)
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1, hidden: false })
    }
    this.load()
  },

  load() {
    return pageLoad.run(this, () => this._loadInner())
  },

  async _loadInner() {
    const request = (this._albumLoadRequest || 0) + 1
    this._albumLoadRequest = request
    const roomUser = await this.resolveRoomUser()
    if (this.__mxhUnloaded || request !== this._albumLoadRequest) return
    this._roomOcc = roomOccupancy(roomUser || {})

    // 先用缓存秒开，再拉最新
    const cached = cache.getCachedCards() || []
    if (cached.length && !this.data.ready) {
      this._setAlbumCards(cached)
      this.setData({ pageLoading: false })
    }

    const { cards } = await api.listCards()
    if (this.__mxhUnloaded || request !== this._albumLoadRequest) return
    this._setAlbumCards(cards || [])
  },

  _setAlbumCards(cards) {
    this._allCards = cards
    const breeds = api.filtersFromCards(cards).filter((item) => item.breed !== '全部')
    const selected = this.data.breedFilter
    const breedFilter = breeds.some((item) => item.breed === selected) ? selected : ''
    this.setData({
      ...this._albumSelection(breedFilter),
      filters: [{ breed: '全部', count: cards.length }, ...breeds],
      hasCats: cards.length > 0,
      collection: collectionOf(cards),
      ready: true
    })
  },

  _albumSelection(breedFilter) {
    const allCards = this._allCards || []
    const cards = (breedFilter
      ? allCards.filter((card) => (card.breed || '待识别') === breedFilter)
      : allCards
    ).map((card) => this.mapCard(card))
    return { breedFilter, cards, ...this.pickFeatured(cards, this.data.featuredId) }
  },

  onFilter(e) {
    const breed = e.currentTarget.dataset.breed
    const breedFilter = !breed || breed === '全部' ? '' : breed
    if (breedFilter === this.data.breedFilter) return
    this.setData(this._albumSelection(breedFilter))
  },

  onPick(e) {
    const id = e.currentTarget.dataset.id
    const featured = (this.data.cards || []).find((c) => c._id === id)
    if (!featured) return
    this.setData({ featuredId: id, featured })
    // 主展示在页顶，点了下面的格子要能看到换了哪只
    wx.pageScrollTo({ scrollTop: 0, duration: 260 })
  },

  onRelease() {
    const featured = this.data.featured
    if (!featured || !featured._id) return
    if (String(featured._id).indexOf('debug_') === 0) {
      wx.showToast({ title: '调试猫不能放生', icon: 'none' })
      return
    }
    if (featured.breedPending) {
      wx.showToast({ title: '审核中不能放生', icon: 'none' })
      return
    }
    wx.showModal({
      title: copy.tips.releaseConfirmTitle,
      content: copy.tips.releaseConfirmBody,
      confirmText: '放生',
      confirmColor: '#c45a38',
      success: async (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '送它离开…', mask: true })
        try {
          const out = await api.releaseCard(featured._id)
          wx.hideLoading()
          wx.showToast({ title: (out && out.toast) || copy.tips.releaseOk, icon: 'none' })
          this.setData({ featuredId: '', featured: null })
          this.load()
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: (err && err.message) || '放生失败', icon: 'none' })
        }
      }
    })
  },

  /** 临时图丢了：从相册/相机补一张 */
  onFixMedia(e) {
    const id = (e.currentTarget.dataset.id || (this.data.featured && this.data.featured._id) || '').trim()
    if (!id || String(id).indexOf('debug_') === 0) {
      wx.showToast({ title: '调试卡无需补图', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        const path = file && file.tempFilePath
        if (!path) return
        wx.showLoading({ title: '补图中…', mask: true })
        try {
          const { card } = await api.reattachCardImage(id, path)
          wx.hideLoading()
          wx.showToast({ title: '图片已补上', icon: 'none' })
          const mapped = this.mapCard(card || {})
          const cards = (this.data.cards || []).map((c) => (c._id === id ? mapped : c))
          const featured =
            this.data.featuredId === id ? mapped : this.data.featured
          this.setData({ cards, featured })
          this.load()
        } catch (err) {
          wx.hideLoading()
          console.warn('[album] reattach fail', err)
          const msg = (err && err.message) || '补图失败'
          wx.showToast({
            title: msg.indexOf('更新失败') >= 0 ? '补图失败，请重试' : msg,
            icon: 'none'
          })
        }
      }
    })
  },

  setTabBarHidden(hidden) {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setHidden(hidden)
    }
  },

  onEditName() {
    const featured = this.data.featured
    if (!featured) return
    this.setTabBarHidden(true)
    this.setData({
      showNameModal: true,
      editNameValue: (featured.name || featured.displayName || featured.breed || '').trim()
    })
  },

  onEditBreed() {
    const featured = this.data.featured
    if (!featured) return
    if (featured.breedPending) {
      wx.showToast({ title: '审核中，暂时不能换品种', icon: 'none' })
      return
    }
    this.setTabBarHidden(true)
    this.setData({ showBreedPicker: true })
  },

  onBreedCancel() {
    this.setTabBarHidden(false)
    this.setData({ showBreedPicker: false })
  },

  async onPickBreed(e) {
    const breed = ((e && e.currentTarget && e.currentTarget.dataset.breed) || '').trim()
    const featured = this.data.featured
    this.setTabBarHidden(false)
    this.setData({ showBreedPicker: false })
    if (!breed || !featured || !featured._id) return
    if (featured.breedPending) {
      wx.showToast({ title: '审核中，暂时不能换品种', icon: 'none' })
      return
    }

    if (String(featured._id).indexOf('debug_') === 0) {
      const mapped = this.mapCard({ ...featured, breed, confidence: 100 })
      const cards = (this.data.cards || []).map((c) => (c._id === featured._id ? mapped : c))
      this.setData({ featured: mapped, cards }, () => this.load())
      wx.showToast({ title: '品种已更新', icon: 'none' })
      return
    }

    try {
      const res = await api.requestBreedChange(featured._id, breed)
      const raw = res.card || {
        ...featured,
        pendingBreed: breed,
        breedReviewStatus: 'pending'
      }
      if (!raw.breedReviewStatus) raw.breedReviewStatus = 'pending'
      if (!raw.pendingBreed) raw.pendingBreed = breed
      const mapped = this.mapCard(raw)
      const cards = (this.data.cards || []).map((c) => (c._id === mapped._id ? mapped : c))
      this.setData({
        featured: mapped,
        featuredId: mapped._id,
        cards
      })
      this.load()
      wx.showToast({ title: (res && res.toast) || '已提交审核', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' })
    }
  },

  onNameCancel() {
    this.setTabBarHidden(false)
    this.setData({ showNameModal: false, editNameValue: '' })
  },

  async onNameConfirm(e) {
    const name = ((e && e.detail && e.detail.value) || '').trim()
    const featured = this.data.featured
    this.setTabBarHidden(false)
    this.setData({ showNameModal: false })
    if (!featured || !featured._id) return

    // 名字单独持久化，和品种分类解耦；切 Tab 重新 load 也不会丢
    cache.setCardName(featured._id, name)

    if (String(featured._id).indexOf('debug_') === 0) {
      const mapped = this.mapCard({ ...featured, name })
      const cards = (this.data.cards || []).map((c) => (c._id === featured._id ? mapped : c))
      this.setData({ featured: mapped, featuredId: mapped._id, cards })
      wx.showToast({ title: '名字已保存', icon: 'none' })
      return
    }

    try {
      const { card } = await api.updateCard(featured._id, { name })
      const mapped = this.mapCard(card)
      const cards = (this.data.cards || []).map((c) => (c._id === mapped._id ? mapped : c))
      this.setData({
        featured: mapped,
        featuredId: mapped._id,
        cards
      })
      wx.showToast({ title: '名字已保存', icon: 'none' })
    } catch (err) {
      // 本地名已写入，界面仍可用覆盖名
      const mapped = this.mapCard({ ...featured, name })
      const cards = (this.data.cards || []).map((c) => (c._id === featured._id ? mapped : c))
      this.setData({ featured: mapped, cards })
      wx.showToast({ title: '名字已保存', icon: 'none' })
    }
  },

  onOpenFeatured() {
    const id = this.data.featuredId
    if (!id) return
    if (String(id).indexOf('debug_') === 0) {
      wx.showToast({ title: '调试数据，无真实详情', icon: 'none' })
      return
    }
    nav.navigateTo(this, `/pages/card-detail/card-detail?id=${id}`)
  },

  onGoShoot() {
    nav.navigateTo(this, '/pages/camera/camera')
  },

  onMap() {
    nav.navigateTo(this, '/pages/map/map')
  },

  onReleased() {
    nav.navigateTo(this, '/pages/released/released')
  }
})
