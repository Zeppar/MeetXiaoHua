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
  const dateLabel = formatDateShort(r.releasedAt)
  const statusTone = r.statusTone || r.status || 'wandering'
  return {
    ...r,
    displayImage: pickCardImage(media),
    displayName: r.name || r.breed || '小猫',
    dateLabel,
    statusLabel: r.statusLabel || '流浪中',
    statusTone,
    adoptLabel: r.adoptedAt ? formatDateShort(r.adoptedAt) : '',
    // 以下仅用于展示：邮戳拆成「年 / 月.日」，状态章的颜色和一句话
    stampYear: dateLabel ? dateLabel.slice(0, 4) : '',
    stampDay: dateLabel ? dateLabel.slice(5) : '',
    sealClass: SEAL_CLASS[statusTone] || '',
    noteText: NOTE_TEXT[statusTone] || NOTE_TEXT.wandering
  }
}

const SEAL_CLASS = {
  adopted: 'seal-mint',
  visiting: 'seal-sky',
  wandering: ''
}

const NOTE_TEXT = {
  adopted: '它找到了一个新家，会被好好照顾的。',
  visiting: '它正在别人家的小屋里做客，过阵子再来看看。',
  wandering: '它在街上慢慢走着，也许下一站就是谁的窗台。'
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
