const api = require('../../services/api')
const cache = require('../../services/storage-cache')
const copy = require('../../constants/copy')
const { CAT_BREEDS } = require('../../constants/breeds')
const { formatDateShort, cardDisplayName, isPlaceholderBreed } = require('../../utils/format')
const { pickCardImage } = require('../../utils/card-media')
const nav = require('../../utils/navigate')
const pageLoad = require('../../utils/page-load')
const { roomOccupancy } = require('../../utils/room-mates')
const { isDevBuild } = require('../../utils/env')

const DEBUG_MOCK_CARDS = [
  {
    _id: 'debug_cat_1',
    breed: '中华田园猫',
    cutoutPath: '/assets/illus/cat-cutout-border.png',
    originalPath: '/assets/illus/mascot.jpg',
    dateLabel: '今天',
    placeText: '小区楼下',
    memoryCount: 2
  },
  {
    _id: 'debug_cat_2',
    breed: '英短',
    cutoutPath: '',
    originalPath: '/assets/illus/card-meet.jpg',
    dateLabel: '昨天',
    placeText: '公园长椅',
    memoryCount: 0
  },
  {
    _id: 'debug_cat_3',
    breed: '布偶猫',
    cutoutPath: '',
    originalPath: '/assets/illus/card-room.jpg',
    dateLabel: '3月2日',
    placeText: '咖啡店门口',
    memoryCount: 1
  },
  {
    _id: 'debug_cat_4',
    breed: '橘猫',
    cutoutPath: '',
    originalPath: '/assets/illus/mini-outing.jpg',
    dateLabel: '2月28日',
    placeText: '',
    memoryCount: 0
  },
  {
    _id: 'debug_cat_5',
    breed: '狸花猫',
    cutoutPath: '',
    originalPath: '/assets/illus/mini-map.jpg',
    dateLabel: '2月20日',
    placeText: '地铁口',
    memoryCount: 3
  },
  {
    _id: 'debug_cat_6',
    breed: '英短',
    cutoutPath: '',
    originalPath: '/assets/illus/card-meet.jpg',
    dateLabel: '2月11日',
    placeText: '',
    memoryCount: 0
  }
]

function buildMockFilters(cards) {
  const map = {}
  cards.forEach((c) => {
    map[c.breed] = (map[c.breed] || 0) + 1
  })
  return Object.keys(map).map((breed) => ({ breed, count: map[breed] }))
}

function withAllFilter(filters) {
  const list = (filters || []).filter((f) => f && f.breed && f.breed !== '全部')
  const total = list.reduce((sum, item) => sum + (item.count || 0), 0)
  return [{ breed: '全部', count: total }, ...list]
}

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
    // debug：null=真实数据，true=强制有猫，false=强制无猫
    debugForceHasCats: null,
    debugLabel: 'DEBUG 真实',
    showDebug: isDevBuild(),
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
    navPad: 64,
    debugTop: 48
  },

  onLoad() {
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
    // DEBUG「强制无猫」会让图鉴一直空，进页时自动切回真实数据
    if (this.data.debugForceHasCats === false) {
      this.setData({ debugForceHasCats: null, debugLabel: this.debugLabelOf(null) })
    }
    this.load()
  },

  debugLabelOf(force) {
    if (force === true) return 'DEBUG 有猫'
    if (force === false) return 'DEBUG 无猫'
    return 'DEBUG 真实'
  },

  load() {
    return pageLoad.run(this, () => this._loadInner())
  },

  async _loadInner() {
    const breedFilter = this.data.breedFilter
    const force = this.data.debugForceHasCats
    const roomUser = await this.resolveRoomUser()
    this._roomOcc = roomOccupancy(roomUser || {})

    // 强制无猫：只改展示，不动真实存储
    if (force === false) {
      this.setData({
        filters: [],
        cards: [],
        hasCats: false,
        featuredId: '',
        featured: null,
        debugLabel: this.debugLabelOf(force),
        ready: true
      })
      return
    }

    // 强制有猫：优先带抠图白边的真实卡；没有贴纸则用带白边的 mock 验收图
    if (force === true) {
      let cards = []
      try {
        const listRes = await api.listCards({ breed: breedFilter || undefined })
        cards = (listRes.cards || []).map((c) => this.mapCard(c))
      } catch (e) {
        cards = []
      }

      const hasSticker = cards.some((c) => c.isSticker)
      if (!cards.length || !hasSticker) {
        const allMock = DEBUG_MOCK_CARDS
        cards = (breedFilter ? allMock.filter((c) => c.breed === breedFilter) : allMock).map((c) =>
          this.mapCard(c)
        )
      }

      const filters = withAllFilter(buildMockFilters(cards))
      const { featuredId, featured } = this.pickFeatured(cards, this.data.featuredId)
      this.setData({
        filters,
        cards,
        hasCats: true,
        featuredId,
        featured,
        debugLabel: this.debugLabelOf(force),
        ready: true
      })
      return
    }

    // 真实数据：先用缓存秒开，再拉最新
    const cached = cache.getCachedCards() || []
    if (cached.length && !this.data.ready) {
      const warm = cached.map((c) => this.mapCard(c))
      const warmFilters = withAllFilter(buildMockFilters(cached).slice(0, 10))
      const { featuredId, featured } = this.pickFeatured(warm, this.data.featuredId)
      this.setData({
        filters: warmFilters,
        cards: warm,
        hasCats: true,
        featuredId,
        featured,
        ready: true,
        pageLoading: false
      })
    }

    const listRes = await api.listCards({ breed: breedFilter || undefined })
    const cards = (listRes.cards || []).map((c) => this.mapCard(c))
    // 筛选项直接用本次列表现算，不再二次 listCards
    const filterRes = await api.breedFilters(listRes.cards || [])
    let rawFilters = (filterRes && filterRes.filters) || []
    if (!rawFilters.length && cards.length) {
      rawFilters = buildMockFilters(listRes.cards || [])
    }
    const filters = withAllFilter(rawFilters.slice(0, 10))
    const total = filters.reduce((sum, item) => sum + (item.breed === '全部' ? 0 : item.count || 0), 0)
    const hasCats = cards.length > 0 || total > 0 || !!(filters[0] && filters[0].count > 0)

    if (breedFilter && !cards.length && hasCats) {
      this.setData({ breedFilter: '' }, () => this.load())
      return
    }

    // 收集进度只在「全部」视图下算（按品种筛选时列表不全）
    const collection = breedFilter ? this.data.collection : collectionOf(listRes.cards || [])
    const { featuredId, featured } = this.pickFeatured(cards, this.data.featuredId)
    this.setData({
      filters,
      cards,
      hasCats,
      collection,
      featuredId,
      featured,
      debugLabel: this.debugLabelOf(force),
      ready: true
    })
  },

  onToggleDebug() {
    const cur = this.data.debugForceHasCats
    // 真实 -> 有猫 -> 无猫 -> 真实
    let next = null
    if (cur === null) next = true
    else if (cur === true) next = false
    else next = null

    this.setData(
      {
        debugForceHasCats: next,
        debugLabel: this.debugLabelOf(next),
        breedFilter: '',
        featuredId: ''
      },
      () => this.load()
    )
  },

  onFilter(e) {
    const breed = e.currentTarget.dataset.breed
    const breedFilter = !breed || breed === '全部' ? '' : breed
    if (breedFilter === this.data.breedFilter) return
    this.setData({ breedFilter }, () => this.load())
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
