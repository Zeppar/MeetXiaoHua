/**
 * 分享查看页：好友点开分享 / 扫海报小程序码 / 朋友圈打开，都落到这里。
 * 只读展示别人的一只猫（贴纸、名字、遇见次数），不显示地点、备注和任何账号信息。
 */
const api = require('../../services/api')
const { formatDateShort, cardDisplayName } = require('../../utils/format')

/** 朋友圈打开是「单页模式」（场景值 1154），很多能力受限 */
function isTimelineSinglePage() {
  try {
    return wx.getLaunchOptionsSync().scene === 1154
  } catch (e) {
    return false
  }
}

function shareIdOf(query) {
  if (!query) return ''
  if (query.s) return String(query.s)
  // 扫小程序码进来：scene 里放的就是分享 id
  if (query.scene) return decodeURIComponent(query.scene)
  return ''
}

Page({
  data: {
    ready: false,
    error: '',
    share: null,
    displayName: '',
    dateLabel: '',
    singlePage: false,
    fallbackName: ''
  },

  onLoad(query) {
    this.shareId = shareIdOf(query)
    const singlePage = isTimelineSinglePage()
    this.setData({
      singlePage,
      // 朋友圈里拉不到数据时，至少用链接里带的名字撑住页面
      fallbackName: query && query.n ? decodeURIComponent(query.n) : ''
    })
    try {
      wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    } catch (e) {
      /* 单页模式等环境不支持就算了 */
    }
    this.load()
  },

  async load() {
    if (!this.shareId) {
      this.setData({ ready: true, error: '分享链接不完整' })
      return
    }
    try {
      const { share } = await api.getSharedCard(this.shareId)
      const displayName = share.name || cardDisplayName({ name: share.name, breed: share.breed })
      this.setData({
        ready: true,
        error: '',
        share,
        displayName,
        dateLabel: share.shotAt ? formatDateShort(share.shotAt) : ''
      })
    } catch (err) {
      this.setData({
        ready: true,
        error: this.data.fallbackName ? '' : (err && err.message) || '没打开这只猫，稍后再试',
        share: null
      })
    }
  },

  onMeet() {
    if (this.data.singlePage) {
      wx.showToast({ title: '点右下角「前往小程序」就能拍猫', icon: 'none' })
      return
    }
    wx.reLaunch({ url: '/pages/home/home' })
  },

  onOpenMine() {
    const id = this.data.share && this.data.share.cardId
    if (id) wx.navigateTo({ url: `/pages/card-detail/card-detail?id=${encodeURIComponent(id)}` })
  },

  _title() {
    const share = this.data.share
    const name = this.data.displayName || this.data.fallbackName || '一只小猫'
    if (share && share.kind === 'postcard' && share.postcard && share.postcard.line) return share.postcard.line
    return `${share ? share.ownerName : '猫友'}在街角遇见了${name}`
  },

  onShareAppMessage() {
    const share = this.data.share
    return {
      title: this._title(),
      path: `/pages/share-card/share-card?s=${encodeURIComponent(this.shareId || '')}`,
      imageUrl: (share && share.image) || undefined
    }
  },

  /** 朋友圈：只能分享当前页，query 里顺带名字，单页模式拉不到数据时兜底 */
  onShareTimeline() {
    const share = this.data.share
    const name = this.data.displayName || this.data.fallbackName || ''
    return {
      title: this._title(),
      query: `s=${encodeURIComponent(this.shareId || '')}${name ? '&n=' + encodeURIComponent(name) : ''}`,
      imageUrl: (share && share.image) || undefined
    }
  }
})
