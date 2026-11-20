const api = require('../../services/api')
const copy = require('../../constants/copy')
const { formatDateShort } = require('../../utils/format')
const { pickCardImage } = require('../../utils/card-media')
const pageLoad = require('../../utils/page-load')

function mapItem(r) {
  const media = {
    cutoutPath: r.cutoutPath || '',
    cutoutFileId: r.cutoutFileId || '',
    originalPath: r.originalPath || '',
    originalFileId: r.originalFileId || ''
  }
  return {
    ...r,
    displayImage: pickCardImage(media),
    displayName: r.name || r.breed || '小猫',
    dateLabel: formatDateShort(r.releasedAt),
    statusLabel: r.statusLabel || '流浪中',
    statusTone: r.statusTone || r.status || 'wandering',
    adoptLabel: r.adoptedAt ? formatDateShort(r.adoptedAt) : ''
  }
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
      const { list } = await api.listMyReleased()
      const mapped = (list || []).map(mapItem)
      this.setData({
        list: mapped,
        empty: !mapped.length,
        ready: true
      })
    })
  }
})
