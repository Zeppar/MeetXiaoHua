const api = require('../../services/api')
const cache = require('../../services/storage-cache')
const copy = require('../../constants/copy')
const { COPY: outingCopy } = require('../../constants/outing')
const { CAT_BREEDS } = require('../../constants/breeds')
const { formatDateTime, cardDisplayName } = require('../../utils/format')
const { pickCardImage } = require('../../utils/card-media')
const { intimacyView } = require('../../services/care-engine')
const { roomOccupancy } = require('../../utils/room-mates')
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

Page({
  data: {
    card: null,
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
      const breedPending = named.breedReviewStatus === 'pending' || !!named.pendingBreed
      const bond = intimacyView(named)
      const cachedUser = cache.getCachedUser && cache.getCachedUser()
      const user =
        (profileRes && profileRes.user) ||
        cachedUser ||
        {}
      const occ = roomOccupancy(user)
      const isInRoom = occ.isInRoom(this.cardId)
      this.setData({
        card: named,
        displayName: cardDisplayName(named),
        displayImage: pickCardImage(named),
        intimacyText: bond.text,
        intimacyValue: bond.value || 0,
        shotLabel: formatDateTime(named.shotAt),
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
    if (this.data.breedPending) {
      wx.showToast({ title: '审核中，暂时不能换品种', icon: 'none' })
      return
    }
    this.setData({ showBreedPicker: true })
  },

  onBreedCancel() {
    this.setData({ showBreedPicker: false })
  },

  async onPickBreed(e) {
    const breed = ((e && e.currentTarget && e.currentTarget.dataset.breed) || '').trim()
    if (!breed) return
    this.setData({ showBreedPicker: false })
    if (this.data.breedPending) {
      wx.showToast({ title: '审核中，暂时不能换品种', icon: 'none' })
      return
    }
    try {
      const res = await api.requestBreedChange(this.cardId, breed)
      const named = withSavedName(res.card || { ...(this.data.card || {}), breed })
      this.setData({
        card: named,
        displayName: cardDisplayName(named),
        needPickBreed: isPendingBreed(named.breed) && named.breedReviewStatus !== 'pending',
        breedPending: named.breedReviewStatus === 'pending',
        pendingBreed: named.pendingBreed || '',
        showConfidence: !isPendingBreed(named.breed)
      })
      wx.showToast({ title: (res && res.toast) || '已提交', icon: 'none' })
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
      wx.showToast({ title: '调试猫不能放生', icon: 'none' })
      return
    }
    if (this.data.breedPending) {
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
          const out = await api.releaseCard(this.cardId)
          wx.hideLoading()
          wx.showToast({ title: (out && out.toast) || copy.tips.releaseOk, icon: 'none' })
          setTimeout(() => {
            wx.navigateBack({ fail: () => nav.switchTab(this, '/pages/album/album') })
          }, 500)
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: (err && err.message) || '放生失败', icon: 'none' })
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
