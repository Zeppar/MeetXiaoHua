const api = require('../../services/api')
const { COPY } = require('../../constants/outing')
const { formatDateTime } = require('../../utils/format')
const copy = require('../../constants/copy')
const pageLoad = require('../../utils/page-load')
const { formatOutingPostcard } = require('../../utils/outing-postcard')

/** 展示用：从「3.2 千米外的小屋」里取出数字，放进距离邮戳；关了距离则为空 */
function pickKm(label) {
  const m = String(label || '').match(/\d+(\.\d+)?/)
  return m ? m[0] : ''
}

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
          timeLabel: formatDateTime(l.returnedAt || l.leftAt),
          distKm: pickKm(l.distanceLabel),
          postcard: formatOutingPostcard(l)
        })),
        ready: true
      })
    })
  }
})
