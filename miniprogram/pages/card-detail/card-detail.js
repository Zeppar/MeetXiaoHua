const api = require('../../services/api')
const cache = require('../../services/storage-cache')
const copy = require('../../constants/copy')
const { COPY: outingCopy } = require('../../constants/outing')
const { CAT_BREEDS } = require('../../constants/breeds')
const { formatDateTime, cardDisplayName } = require('../../utils/format')
const { pickCardImage } = require('../../utils/card-media')
const { intimacyView } = require('../../services/care-engine')
const { roomOccupancy } = require('../../utils/room-mates')
const { encounterCountOf, knownDaysOf, lastSeenOf, territoryOf } = require('../../utils/encounters')
const onboarding = require('../../utils/onboarding')
const {
  normalizeGeo,
  blurCoordinate,
  getCurrentPosition,
  getLocationAuthState,
  chooseMeetPlace,
  openLocationSetting
} = require('../../utils/geo-blur')

const { drawPoster, drawShareCover, writeBase64Png } = require('../../utils/poster')
const { formatDateShort } = require('../../utils/format')

/** 拍完多久内「记下这里」还算准：人大概率还在遇见它的地方 */
const PLACE_HERE_WINDOW_MS = 30 * 60 * 1000
const nav = require('../../utils/navigate')
const pageLoad = require('../../utils/page-load')

function withSavedName(card) {
  if (!card) return card
  const name = cache.getCardName(card._id, card.name || '')
  return { ...card, name }
}

function isPendingBreed(breed) {
  const b = String(breed || '').trim()
  return !b || b === '待识别' || b === '识别中…' || b === '未知小动物'
}

/** 亲密度画成一排 5 个爪印：每 20 点亮一个 */
const PAW_COUNT = 5
function pawsOf(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0))
  // 有一点亲密度就亮第一只爪，之后每 20 点再亮一只
  const lit = v > 0 ? Math.ceil(v / (100 / PAW_COUNT)) : 0
  const out = []
  for (let i = 0; i < PAW_COUNT; i++) out.push({ i, on: i < lit })
  return out
}

/** 邮戳两行：上「年份」，下「月.日」 */
function stampOf(shotAt) {
  const d = shotAt ? new Date(shotAt) : null
  if (!d || Number.isNaN(d.getTime())) return { stampK: '遇见', stampV: '某天' }
  const m = d.getMonth() + 1
  const day = d.getDate()
  return {
    stampK: String(d.getFullYear()),
    stampV: `${m < 10 ? '0' + m : m}.${day < 10 ? '0' + day : day}`
  }
}

Page({
  data: {
    card: null,
    intimacyPaws: pawsOf(0),
    stampK: '遇见',
    stampV: '某天',
    displayName: '',
    intimacyText: '',
    intimacyValue: 0,
    displayImage: '',
    shotLabel: '',
    showNoteModal: false,
    editNoteValue: '',
    showNameModal: false,
    editNameValue: '',
    showBreedPicker: false,
    breedOptions: CAT_BREEDS.slice(),
    needPickBreed: false,
    breedPending: false,
    pendingBreed: '',
    recognizedBreed: '',
    preview: false,
    outingEntry: outingCopy.historyEntry(0),
    mattingFailed: copy.tips.mattingFailed,
    editNote: copy.buttons.editNote,
    memoryBtn: copy.buttons.memoryCorner,
    setDisplay: copy.buttons.setDisplay,
    removeFromRoom: copy.buttons.removeFromRoom,
    isInRoom: false,
    isRoomMain: false,
    roomFull: false,
    roomTag: '',
    releaseCat: copy.buttons.releaseCat,
    nameTitle: copy.modals.nameTitle,
    namePlaceholder: copy.modals.namePlaceholder,
    nameMax: copy.limits.name,
    noteTitle: copy.modals.noteTitle,
    notePlaceholder: copy.modals.notePlaceholder,
    noteMax: copy.limits.note,
    saveText: copy.buttons.save,
    pageLoading: false,
    loadingText: copy.tips.pageLoading,
    showConfidence: false
  },

  cardId: '',

  onLoad(query) {
    this.cardId = query.id || ''
    // 第一只猫刚收下：高光时刻之后再请用户起名字
    this._askNameOnce = query.first === '1'
  },

  onUnload() {
    this.__mxhUnloaded = true
  },

  /** 分享猫卡 / 邀请好友接待它：好友打开后，这只猫会去好友的小屋串门 */
  onShareAppMessage(e) {
    const name = this.data.displayName || '一只小猫'
    // 分享封面：优先用画好的「手帐纸 + 贴纸」图，没画好再退回原图
    const imageUrl = this._shareCover ||
      (/^(wxfile|https?):/.test(this.data.displayImage || '') ? this.data.displayImage : undefined)
    const kind = e && e.target && e.target.dataset && e.target.dataset.kind
    const count = this.data.encounterCount || 1
    // 标题不带地点：分享出去的东西都不暴露相遇位置
    const fallback = {
      title: count > 1 ? `又遇见${name}了，这是第 ${count} 次` : `我遇见了${name}`,
      path: '/pages/home/home',
      imageUrl
    }
    if (kind !== 'invite') {
      // 分享猫卡：好友点开落到只读的分享查看页，能看到这只猫
      return {
        ...fallback,
        promise: api.createShare({ kind: 'card', cardId: this.cardId })
          .then((res) => (res && res.shareId
            ? { ...fallback, path: `/pages/share-card/share-card?s=${encodeURIComponent(res.shareId)}` }
            : fallback))
          .catch(() => fallback)
      }
    }
    const invite = {
      title: `${name}想去你家串门`,
      imageUrl,
      path: '/pages/home/home'
    }
    return {
      ...invite,
      promise: api.createVisitInvite(this.cardId)
        .then((res) => ({ ...invite, path: `/pages/room/room?invite=${encodeURIComponent(res.inviteId)}` }))
        .catch((err) => {
          wx.showToast({ title: (err && err.message) || '邀请没生成，先分享猫卡', icon: 'none' })
          return fallback
        })
    }
  },

  onShow() {
    this.load()
  },

  noop() {},

  load() {
    return pageLoad.run(this, async () => {
      if (!this.cardId) return
      const [{ card }, { logs }, profileRes] = await Promise.all([
        api.getCard(this.cardId),
        api.listOutingLogs({ cardId: this.cardId }),
        api.getProfile().catch(() => null)
      ])
      if (!card) {
        wx.showToast({ title: '卡牌不存在', icon: 'none' })
        return
      }
      const named = withSavedName(card)
      const conf = Number(named.confidence) || 0
      const pending = isPendingBreed(named.breed)
      // 品种不再审核：旧数据里残留的 pending 也当普通卡，重新选品种即可覆盖
      const breedPending = false
      const bond = intimacyView(named)
      const cachedUser = cache.getCachedUser && cache.getCachedUser()
      const user =
        (profileRes && profileRes.user) ||
        cachedUser ||
        {}
      const occ = roomOccupancy(user)
      const isInRoom = occ.isInRoom(this.cardId)
      const stamp = stampOf(named.shotAt)
      this.setData({
        intimacyPaws: pawsOf(bond.value),
        stampK: stamp.stampK,
        stampV: stamp.stampV,
        card: named,
        displayName: cardDisplayName(named),
        displayImage: pickCardImage(named),
        intimacyText: bond.text,
        intimacyValue: bond.value || 0,
        shotLabel: formatDateTime(named.shotAt),
        encounterCount: encounterCountOf(named),
        knownDays: knownDaysOf(named),
        lastSeenLabel: encounterCountOf(named) > 1 ? formatDateTime(lastSeenOf(named)) : '',
        territory: territoryOf(named),
        outingEntry: outingCopy.historyEntry((logs && logs.length) || 0),
        needPickBreed: pending && !breedPending,
        breedPending,
        pendingBreed: named.pendingBreed || '',
        recognizedBreed: named.recognizedBreed || '',
        showConfidence: !pending && conf > 0,
        isInRoom,
        isRoomMain: false,
        roomFull: occ.full,
        roomTag: isInRoom ? '在小屋里' : '',
        roomUnlocked: onboarding.isRoomUnlocked(),
        // 没有地点：不替用户猜，给两个补法；超过 30 分钟就不提供「记下这里」
        needPlace: !normalizeGeo(named.geo) && String(this.cardId).indexOf('debug_') !== 0,
        canPlaceHere: Date.now() - (Number(named.shotAt) || 0) <= PLACE_HERE_WINDOW_MS
      })
      this._shareCover = ''
      this._prepareShareCover()
      if (this._askNameOnce) {
        this._askNameOnce = false
        wx.showToast({ title: '收进手帐啦，给它起个名字吧', icon: 'none' })
        setTimeout(() => {
          if (!this.__mxhUnloaded && !this.data.showNameModal) this.onEditName()
        }, 900)
      }
    })
  },

  onOutingHistory() {
    nav.navigateTo(this, `/pages/outing-history/outing-history?id=${this.cardId}`)
  },

  /** 记下这里：用户点了才申请定位（拒绝过就引导去设置） */
  async onPlaceHere() {
    if (this._placing) return
    this._placing = true
    try {
      const state = await getLocationAuthState()
      if (state === 'denied' && !(await openLocationSetting())) return
      wx.showLoading({ title: '正在记下地点', mask: true })
      const loc = await getCurrentPosition()
      wx.hideLoading()
      if (!loc) {
        wx.showToast({ title: '没拿到定位，可以在地图上选', icon: 'none' })
        return
      }
      await this._savePlace(loc, '')
    } finally {
      this._placing = false
    }
  },

  /** 在地图上选：不需要定位授权，也能补很久以前遇到的猫 */
  async onPlacePick() {
    if (this._placing) return
    this._placing = true
    try {
      const picked = await chooseMeetPlace()
      if (picked) await this._savePlace(picked, picked.name)
    } finally {
      this._placing = false
    }
  },

  async _savePlace(loc, name) {
    const card = this.data.card || {}
    const placeText = String(card.placeText || '').trim() && card.placeText !== '已记录当前位置'
      ? card.placeText
      : String(name || '').slice(0, 30)
    try {
      // 走 api.updateCard：本地先写，云端同步，失败保留本地
      await api.updateCard(this.cardId, {
        geo: blurCoordinate(loc.latitude, loc.longitude),
        ...(placeText ? { placeText } : {})
      })
      wx.showToast({ title: '记下了，足迹地图上能看到它了', icon: 'none' })
      this.load()
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '没记上，请重试', icon: 'none' })
    }
  },

  _canvasNode(id) {
    return new Promise((resolve) => {
      wx.createSelectorQuery().in(this).select('#' + id).fields({ node: true }).exec((res) => {
        resolve((res && res[0] && res[0].node) || null)
      })
    })
  },

  _posterInfo() {
    const card = this.data.card || {}
    const count = this.data.encounterCount || 1
    return {
      image: this.data.displayImage,
      name: this.data.displayName || '一只小猫',
      line: `第 ${count} 次遇见 · 认识 ${this.data.knownDays || 1} 天`,
      sub: card.breed && card.breed !== '待识别' ? card.breed : '',
      dateLabel: card.shotAt ? formatDateShort(card.shotAt).slice(5) : ''
    }
  },

  /** 分享卡片封面：进页后后台画好，分享时直接用 */
  async _prepareShareCover() {
    if (this._coverDrawing || !this.data.displayImage) return
    this._coverDrawing = true
    try {
      const canvas = await this._canvasNode('coverCanvas')
      if (!canvas) return
      const count = this.data.encounterCount || 1
      const path = await drawShareCover(canvas, {
        image: this.data.displayImage,
        badge: count > 1 ? `第 ${count} 次遇见` : ''
      })
      if (path && !this.__mxhUnloaded) this._shareCover = path
    } catch (e) {
      console.warn('[card-detail] share cover fail', e)
    } finally {
      this._coverDrawing = false
    }
  },

  /** 生成海报：带小程序码（云端生成失败就写「微信搜索」），交给微信的分享图片菜单 */
  async onMakePoster() {
    if (this._postering || !this.data.card) return
    this._postering = true
    wx.showLoading({ title: '正在做海报', mask: true })
    try {
      const canvas = await this._canvasNode('posterCanvas')
      if (!canvas) throw new Error('这台手机暂时画不了海报')
      let qrPath = ''
      try {
        const share = await api.createShare({ kind: 'card', cardId: this.cardId })
        const qr = share && share.shareId ? await api.getShareQrCode(share.shareId) : null
        if (qr && qr.image) qrPath = await writeBase64Png(qr.image)
      } catch (e) {
        console.warn('[card-detail] poster qr fail', e)
      }
      const path = await drawPoster(canvas, { ...this._posterInfo(), qrPath })
      wx.hideLoading()
      if (typeof wx.showShareImageMenu === 'function') {
        wx.showShareImageMenu({ path })
      } else {
        wx.previewImage({ urls: [path] })
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: (err && err.message) || '海报没做成，请重试', icon: 'none' })
    } finally {
      this._postering = false
    }
  },

  onMoreActions() {
    wx.showActionSheet({
      itemList: ['分享到朋友圈', copy.buttons.releaseCat],
      success: (res) => {
        if (res.tapIndex === 0) this.onOpenSharePage()
        if (res.tapIndex === 1) this.onRelease()
      }
    })
  },

  /**
   * 朋友圈只能分享「当前页」，而详情页只有主人能看。
   * 所以先打开这只猫的只读分享页，再从右上角「…」分享到朋友圈。
   */
  async onOpenSharePage() {
    wx.showLoading({ title: '准备分享页', mask: true })
    try {
      const share = await api.createShare({ kind: 'card', cardId: this.cardId })
      wx.hideLoading()
      if (!share || !share.shareId) {
        wx.showToast({ title: '这只猫还没同步到云端，稍后再试', icon: 'none' })
        return
      }
      wx.navigateTo({
        url: `/pages/share-card/share-card?s=${encodeURIComponent(share.shareId)}&timeline=1`,
        success: () => wx.showToast({ title: '点右上角「…」分享到朋友圈', icon: 'none', duration: 2500 })
      })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: (err && err.message) || '没准备好，请重试', icon: 'none' })
    }
  },

  onEditName() {
    const card = this.data.card
    if (!card) return
    this.setData({
      showNameModal: true,
      editNameValue: (card.name || cardDisplayName(card) || '').trim()
    })
  },

  onEditBreed() {
    if (!this.data.card) return
    this.setData({ showBreedPicker: true })
  },

  onBreedCancel() {
    this.setData({ showBreedPicker: false })
  },

  async onPickBreed(e) {
    const breed = ((e && e.currentTarget && e.currentTarget.dataset.breed) || '').trim()
    if (!breed) return
    this.setData({ showBreedPicker: false })
    try {
      const res = await api.requestBreedChange(this.cardId, breed)
      const named = withSavedName(res.card || { ...(this.data.card || {}), breed })
      this.setData({
        card: named,
        displayName: cardDisplayName(named),
        needPickBreed: isPendingBreed(named.breed),
        breedPending: false,
        pendingBreed: '',
        showConfidence: !isPendingBreed(named.breed)
      })
      wx.showToast({ title: (res && res.toast) || '品种已更新', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' })
    }
  },

  async onApproveBreed() {
    const card = this.data.card
    if (!card || card.breedReviewStatus !== 'pending') return
    try {
      const res = await api.reviewBreedChange({
        reviewId: card.breedReviewId,
        cardId: card._id,
        approve: true
      })
      const named = withSavedName(res.card)
      this.setData({
        card: named,
        displayName: cardDisplayName(named),
        breedPending: false,
        pendingBreed: '',
        needPickBreed: isPendingBreed(named.breed)
      })
      wx.showToast({ title: (res && res.toast) || '已通过', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
    }
  },

  onNameCancel() {
    this.setData({ showNameModal: false })
  },

  async onNameConfirm(e) {
    const name = ((e && e.detail && e.detail.value) || '').trim()
    this.setData({ showNameModal: false })
    const previousName = (this.data.card && this.data.card.name) || ''
    cache.setCardName(this.cardId, name)
    try {
      const { card } = await api.updateCard(this.cardId, { name })
      const named = withSavedName(card)
      this.setData({
        card: named,
        displayName: cardDisplayName(named)
      })
    } catch (err) {
      // 名字没过内容安全：改回原来的名字并提示
      if (err && err.code === 'CONTENT_RISKY') {
        cache.setCardName(this.cardId, previousName)
        wx.showToast({ title: err.message, icon: 'none' })
        return
      }
      const named = withSavedName({ ...(this.data.card || {}), _id: this.cardId, name })
      this.setData({
        card: named,
        displayName: cardDisplayName(named)
      })
    }
    wx.showToast({ title: '名字已保存', icon: 'none' })
  },

  onEditNote() {
    this.setData({
      showNoteModal: true,
      editNoteValue: (this.data.card && this.data.card.note) || ''
    })
  },

  onNoteCancel() {
    this.setData({ showNoteModal: false })
  },

  async onNoteConfirm(e) {
    const note = e.detail.value || ''
    this.setData({ showNoteModal: false })
    const { card } = await api.updateCard(this.cardId, { note })
    this.setData({ card, displayName: cardDisplayName(card) })
    wx.showToast({ title: '已保存', icon: 'none' })
  },

  onMemory() {
    nav.navigateTo(this, `/pages/memory/memory?id=${this.cardId}`)
  },

  async onAddToRoom() {
    if (this.data.isInRoom || !this.cardId) return
    if (this.data.roomFull) {
      wx.showModal({
        title: '小屋已满',
        content: copy.tips.roomFull,
        showCancel: false
      })
      return
    }
    try {
      const res = await api.addCardToRoom(this.cardId, this.data.card)
      await getApp().refreshUser()
      const occ = (res && res.occupancy) || roomOccupancy((res && res.user) || {})
      this.setData({
        isInRoom: true,
        isRoomMain: false,
        roomFull: occ.full,
        roomTag: '在小屋里'
      })
      wx.showToast({ title: (res && res.toast) || copy.tips.setDisplayOk, icon: 'none' })
    } catch (err) {
      if (err && err.code === 'ROOM_FULL') {
        this.setData({ roomFull: true })
        wx.showModal({
          title: '小屋已满',
          content: copy.tips.roomFull,
          showCancel: false
        })
        return
      }
      wx.showToast({ title: (err && err.message) || '放入失败', icon: 'none' })
    }
  },

  async onRemoveFromRoom() {
    if (!this.data.isInRoom || !this.cardId) return
    try {
      const res = await api.removeCardFromRoom(this.cardId)
      await getApp().refreshUser()
      const occ = (res && res.occupancy) || roomOccupancy((res && res.user) || {})
      this.setData({
        isInRoom: false,
        isRoomMain: false,
        roomFull: occ.full,
        roomTag: ''
      })
      wx.showToast({ title: (res && res.toast) || copy.tips.removeFromRoomOk, icon: 'none' })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '移出失败', icon: 'none' })
    }
  },

  onRelease() {
    if (!this.cardId || String(this.cardId).indexOf('debug_') === 0) {
      wx.showToast({ title: '调试猫不能送去流浪', icon: 'none' })
      return
    }
    wx.showModal({
      title: copy.tips.releaseConfirmTitle,
      content: copy.tips.releaseConfirmBody,
      confirmText: '送去流浪',
      confirmColor: '#c45a38',
      success: async (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '送它离开…', mask: true })
        try {
          const out = await api.releaseCard(this.cardId)
          wx.hideLoading()
          wx.showToast({ title: (out && out.toast) || copy.tips.releaseOk, icon: 'none' })
          setTimeout(() => {
            wx.navigateBack({ fail: () => nav.switchTab(this, '/pages/album/album') })
          }, 500)
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: (err && err.message) || '没送成，请重试', icon: 'none' })
        }
      }
    })
  },

  onLongPress() {
    if (!cache.isLongPressHintShown()) {
      cache.setLongPressHintShown()
      wx.showToast({ title: copy.tips.longPressSave, icon: 'none' })
    }
    this.setData({ preview: true })
  },

  closePreview() {
    this.setData({ preview: false })
  },

  onSaveAlbum() {
    const path = this.data.displayImage
    if (!path) return
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'none' }),
      fail: (err) => {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('auth') >= 0) {
          wx.openSetting({})
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' })
        }
      }
    })
  }
})
