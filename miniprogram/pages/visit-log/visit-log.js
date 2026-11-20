const api = require('../../services/api')
const copy = require('../../constants/copy')
const { COPY } = require('../../constants/outing')
const { formatDateTime } = require('../../utils/format')
const pageLoad = require('../../utils/page-load')

/** 展示用：从「3.2 千米外的小屋」里取出数字，放进距离邮戳；关了距离则为空 */
function pickKm(label) {
  const m = String(label || '').match(/\d+(\.\d+)?/)
  return m ? m[0] : ''
}

/** 展示用：自己猫出门用自己的图；来访猫只用云端 / 网络图，避免别人设备上的本地路径 */
function pickLogImage(l) {
  const p = (l && l.cutoutPath) || ''
  if (!p) return ''
  if (l.direction === 'outbound') return p
  return /^(cloud:|https?:)/.test(p) ? p : ''
}

Page({
  data: {
    tab: 'all',
    logs: [],
    empty: true,
    pageLoading: false,
    loadingText: copy.tips.pageLoading,
    ready: false,
    settingsOpen: false,
    allowMyCatOut: true,
    allowVisitors: true,
    showDistance: true,
    outLabel: COPY.settingsOut,
    visitLabel: COPY.settingsVisit,
    distLabel: COPY.settingsDist,
    distTip: COPY.settingsDistTip
  },

  onUnload() {
    this.__mxhUnloaded = true
  },

  onShow() {
    this.load()
  },

  onToggleSettings() {
    this.setData({ settingsOpen: !this.data.settingsOpen })
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.tab || 'all'
    if (tab === this.data.tab) return
    this.setData({ tab }, () => this.loadLogs())
  },

  load() {
    return pageLoad.run(this, async () => {
      await Promise.all([this.loadSettings(), this.loadLogs()])
    })
  },

  async loadSettings() {
    try {
      const { user } = await api.getProfile()
      const s = (user && user.settings) || {}
      this.setData({
        allowMyCatOut: s.allowMyCatOut !== false,
        allowVisitors: s.allowVisitors !== false,
        showDistance: s.showDistance !== false
      })
    } catch (e) {
      console.warn('[visit-log] settings', e)
    }
  },

  async loadLogs() {
    const tab = this.data.tab
    const direction = tab === 'all' ? undefined : tab
    const { logs } = await api.listVisitLogs({ direction })
    const mapped = (logs || []).map((l) => ({
      ...l,
      timeLabel: formatDateTime(l.at || l.leaveAt || l.createdAt),
      distKm: pickKm(l.distanceLabel),
      catImage: pickLogImage(l)
    }))
    this.setData({
      logs: mapped,
      empty: !mapped.length,
      ready: true
    })
  },

  async saveSetting(patch) {
    await api.updateProfile({ settings: patch })
    this.setData(patch)
  },

  onToggleOut(e) {
    this.saveSetting({ allowMyCatOut: !!e.detail.value })
  },

  onToggleVisit(e) {
    this.saveSetting({ allowVisitors: !!e.detail.value })
  },

  onToggleDist(e) {
    this.saveSetting({ showDistance: !!e.detail.value })
  }
})
