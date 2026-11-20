const api = require('../../services/api')
const { COPY } = require('../../constants/outing')
const { formatDateTime } = require('../../utils/format')
const copy = require('../../constants/copy')
const pageLoad = require('../../utils/page-load')

Page({
  data: {
    logs: [],
    empty: COPY.historyEmpty,
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
      const { logs } = await api.listOutingLogs({ cardId: this.cardId })
      this.setData({
        logs: (logs || []).map((l) => ({
          ...l,
          timeLabel: formatDateTime(l.returnedAt || l.leftAt)
        })),
        ready: true
      })
    })
  }
})
