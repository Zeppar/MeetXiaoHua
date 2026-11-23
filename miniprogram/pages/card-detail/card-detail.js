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
  },

  onUnload() {
    this.__mxhUnloaded = true
  },

  /** 分享猫卡 / 邀请好友接待它：好友打开后，这只猫会去好友的小屋串门 */
  onShareAppMessage(e) {
    const card = this.data.card || {}
    const name = this.data.displayName || '一只小猫'
    const place = String(card.placeText || '').trim()
    const imageUrl = /^(wxfile|https?):/.test(this.data.displayImage || '') ? this.data.displayImage : undefined
    const kind = e && e.target && e.target.dataset && e.target.dataset.kind
    const fallback = {
      title: place ? `我在${place}遇见了${name}` : `我遇见了${name}`,
      path: '/pages/home/home',
      imageUrl
    }
    if (kind !== 'invite') return fallback
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
        roomTag: isInRoom ? '在小屋里' : ''
      })
    })
  },

  onOutingHistory() {
    nav.navigateTo(this, `/pages/outing-history/outing-history?id=${this.cardId}`)
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
    cache.setCardName(this.cardId, name)
    try {
      const { card } = await api.updateCard(this.cardId, { name })
      const named = withSavedName(card)
      this.setData({
        card: named,
        displayName: cardDisplayName(named)
      })
    } catch (err) {
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
