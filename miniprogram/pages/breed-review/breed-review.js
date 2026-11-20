const api = require('../../services/api')
const copy = require('../../constants/copy')
const { formatDateTime } = require('../../utils/format')
const pageLoad = require('../../utils/page-load')
const { pickCardImage } = require('../../utils/card-media')

// 状态章：审核中 / 已通过 / 未通过（只做展示）
const STATUS_SEAL = {
  pending: { text: '审核中', cls: 'seal-blush' },
  approved: { text: '已通过', cls: 'seal-mint' },
  rejected: { text: '未通过', cls: 'seal-muted' }
}

Page({
  data: {
    list: [],
    empty: true,
    pageLoading: false,
    loadingText: copy.tips.pageLoading,
    ready: false
  },

  onUnload() {
    this.__mxhUnloaded = true
  },

  onShow() {
    this.load()
  },

  load() {
    return pageLoad.run(this, async () => {
      let list = []
      try {
        const res = await api.listBreedReviews({ status: 'pending' })
        list = (res && res.list) || []
      } catch (e) {
        console.warn('[breed-review] list fail', e)
      }
      // 兜底：从图鉴卡里扫 pending（含只有 pendingBreed 的）
      if (!list.length) {
        try {
          const { cards } = await api.listCards({})
          list = (cards || [])
            .filter((c) => c && (c.breedReviewStatus === 'pending' || c.pendingBreed))
            .map((c) => ({
              _id: c.breedReviewId || `card_${c._id}`,
              cardId: c._id,
              fromBreed: c.breed || '待识别',
              toBreed: c.pendingBreed || '',
              recognizedBreed: c.recognizedBreed || '',
              status: 'pending',
              createdAt: c.createdAt || Date.now(),
              image: pickCardImage(c) || ''
            }))
        } catch (e) {
          /* ignore */
        }
      }
      this.setData({
        list: list.map((r) => ({
          ...r,
          timeLabel: formatDateTime(r.createdAt),
          statusText: (STATUS_SEAL[r.status] || STATUS_SEAL.pending).text,
          statusCls: (STATUS_SEAL[r.status] || STATUS_SEAL.pending).cls
        })),
        empty: !list.length,
        ready: true
      })
    })
  },

  async onApprove(e) {
    const { id, cardid } = e.currentTarget.dataset
    await this._review(id, cardid, true)
  },

  async onReject(e) {
    const { id, cardid } = e.currentTarget.dataset
    await this._review(id, cardid, false)
  },

  async _review(reviewId, cardId, approve) {
    wx.showLoading({ title: approve ? '通过中…' : '驳回中…', mask: true })
    try {
      const res = await api.reviewBreedChange({ reviewId, cardId, approve })
      wx.hideLoading()
      wx.showToast({ title: (res && res.toast) || (approve ? '已通过' : '已驳回'), icon: 'none' })
      this.load()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
    }
  }
})
