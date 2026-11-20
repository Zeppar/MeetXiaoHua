const api = require('../../services/api')
const copy = require('../../constants/copy')
const { formatDateTime } = require('../../utils/format')
const pageLoad = require('../../utils/page-load')

Page({
  data: {
    card: null,
    displayImage: '',
    memories: [],
    showAdd: false,
    draft: '',
    draftImage: '',
    emptyMain: copy.empty.memoryMain,
    emptySub: copy.empty.memorySub,
    addFirst: copy.buttons.addFirstMemory,
    addText: copy.buttons.addMemory,
    max: copy.limits.memory,
    pickImageText: '加一张图（可选）',
    pageLoading: false,
    loadingText: copy.tips.pageLoading,
    ready: false
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

  load() {
    return pageLoad.run(this, async () => {
      if (!this.cardId) {
        this.setData({ ready: true })
        return
      }
      const [{ card }, { memories }] = await Promise.all([
        api.getCard(this.cardId),
        api.listMemories(this.cardId)
      ])
      this.setData({
        card,
        displayImage: (card && (card.cutoutPath || card.originalPath)) || '',
        memories: (memories || []).map((m) => ({
          ...m,
          timeLabel: formatDateTime(m.createdAt)
        })),
        ready: true
      })
    })
  },

  onAdd() {
    this.setData({ showAdd: true, draft: '', draftImage: '' })
  },

  onCancelAdd() {
    this.setData({ showAdd: false, draft: '', draftImage: '' })
  },

  onDraftInput(e) {
    this.setData({ draft: e.detail.value })
  },

  onPickImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (file) {
          this.setData({ draftImage: file.tempFilePath })
          wx.showToast({ title: '已选择图片', icon: 'none' })
        }
      }
    })
  },

  async onConfirmAdd(e) {
    const text = (e.detail.value || '').trim()
    if (!text) {
      wx.showToast({ title: '请写一点文字', icon: 'none' })
      return
    }
    this.setData({ showAdd: false })
    await api.createMemory({
      cardId: this.cardId,
      text,
      imagePath: this.data.draftImage
    })
    this.setData({ draft: '', draftImage: '' })
    this.load()
  },

  onPreviewImg(e) {
    const src = e.currentTarget.dataset.src
    wx.previewImage({ urls: [src], current: src })
  },

  onLongDelete(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: copy.modals.deleteMemory,
      confirmColor: '#c45c26',
      success: async (res) => {
        if (!res.confirm) return
        await api.deleteMemory(id)
        this.load()
      }
    })
  }
})
