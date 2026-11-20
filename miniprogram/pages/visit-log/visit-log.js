const api = require('../../services/api')
const copy = require('../../constants/copy')
const { COPY } = require('../../constants/outing')
const { formatDateTime } = require('../../utils/format')
const pageLoad = require('../../utils/page-load')

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
      timeLabel: formatDateTime(l.at || l.leaveAt || l.createdAt)
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
